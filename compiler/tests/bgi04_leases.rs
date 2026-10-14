//! BGI-04: write leases, snapshots and journal recovery.
//!
//! Each Done-when fault case is qualified once here: participating edit
//! conflicts, one immutable consumed closure, interruption at the
//! replacement/commit boundaries, unexpected-byte conflict retention,
//! idempotent recovery, and read gating over unresolved journals.
use canlang_compiler::leases::{
    CommitOutcome, JournalState, LeaseMode, LeaseToken, RecoveryOutcome, Replacement, acquire,
    apply_committed, canonical_order, commit_journal, escape_rel, group_files, mark_committed,
    new_token, platform_durability, read_journal, recover_journal, recover_stopped_writer, release,
    snapshot_inputs, stage_complete_journal, stage_journal, stage_journal_with_deletions,
    unresolved_journals, validate_rel, validate_run_id,
};
use canlang_compiler::source::snapshot_consumed_inputs;
use std::fs;
use std::path::{Path, PathBuf};

fn write_tree(root: &Path, files: &[(&str, &[u8])]) {
    for (rel, bytes) in files {
        let full = root.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, bytes).unwrap();
    }
}

fn read_tree(root: &Path, rel: &str) -> Vec<u8> {
    fs::read(root.join(rel)).unwrap()
}

fn write_group(root: &Path, unit: &str, files: &[(&str, &[u8])]) {
    let owned: Vec<(String, &[u8])> = files
        .iter()
        .map(|(rel, bytes)| (format!("can.generated/{unit}/{rel}"), *bytes))
        .collect();
    let refs: Vec<(&str, &[u8])> = owned
        .iter()
        .map(|(rel, bytes)| (rel.as_str(), *bytes))
        .collect();
    write_tree(root, &refs);
}

fn replacement(unit: &str, path: &str, bytes: &[u8]) -> Replacement {
    Replacement {
        unit: unit.to_string(),
        path: path.to_string(),
        bytes: bytes.to_vec(),
    }
}

// ## Lease scope notes: the capture closure below carries a `.can` source
// ## alongside its saved groups, so participating source edits fence the
// ## same run as participating unit edits.
const CAPTURE_SOURCE: &str =
    "app Tasks\n## Calm task workspace styling.\nThen\n style TaskSurface $\"Readable.\"\n";

#[test]
fn shared_protocol_vectors_match_both_hosts() {
    // Lock-file stem escaping is byte-identical across hosts.
    assert_eq!(
        escape_rel("can.generated/u1/style.css"),
        "can.generated%2Fu1%2Fstyle.css"
    );
    assert_eq!(escape_rel("app.can"), "app.can");
    assert_eq!(escape_rel("a b/c+d"), "a%20b%2Fc%2Bd");
    // Canonical lock order is byte-wise ascending.
    assert_eq!(
        canonical_order(&["can.generated/u2/x", "app.can", "can.generated/u1/x"]).unwrap(),
        vec!["app.can", "can.generated/u1/x", "can.generated/u2/x"]
    );
    // Token spelling is strict on both hosts.
    assert!(LeaseToken::parse("v1-0123456789abcdef").is_ok());
    assert!(LeaseToken::parse("v1-0123456789ABCDEF").is_err());
    assert!(LeaseToken::parse("v1-short").is_err());
    assert!(LeaseToken::parse("0123456789abcdef").is_err());
    assert!(LeaseToken::parse("v1-0123456789abcdef0").is_err());
    let minted = new_token();
    assert!(LeaseToken::parse(minted.as_str()).is_ok());
    assert_ne!(new_token().as_str(), minted.as_str());
    // Paths and run ids reject traversal on both hosts.
    assert!(validate_rel("can.generated/u1/style.css").is_ok());
    for bad in ["", "/abs", "a/../b", "a/./b", "a//b", "a\\b", ".", "a/.."] {
        assert!(validate_rel(bad).is_err(), "{bad}");
    }
    for bad in ["", "a/b", "a b", ".", ".."] {
        assert!(validate_run_id(bad).is_err(), "{bad}");
    }
    assert!(validate_run_id("r42").is_ok());
    // The durability statement never claims CAS.
    let durability = platform_durability();
    assert!(durability.contains("not filesystem CAS"), "{durability}");
    assert!(
        durability.contains("POSIX") || durability.contains("best-effort"),
        "{durability}"
    );
    // Read-lock files pin the shared admission shape too: exact filename and
    // byte-identical body, so the other host's locks arbitrate this host.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let reader = acquire(root, &["app.can"], LeaseMode::Read, "build").unwrap();
    let name = format!("app.can.read.{}.lock", reader.token.as_str());
    let lock_text = fs::read_to_string(root.join(".can/gen/locks").join(&name)).unwrap();
    assert_eq!(
        lock_text,
        format!(
            "{{\"version\":1,\"holder\":\"build\",\"token\":\"{}\",\"mode\":\"read\",\"path\":\"app.can\"}}",
            reader.token.as_str()
        )
    );
    release(root, &reader).unwrap();
}

#[test]
fn participating_source_and_unit_edits_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_tree(root, &[("app.can", CAPTURE_SOURCE.as_bytes())]);
    write_group(root, "u1", &[("style.css", b".old{}")]);
    // Capture holds brief write leases over source and unit paths together.
    let capture = acquire(
        root,
        &["app.can", "can.generated/u1/style.css"],
        LeaseMode::Write,
        "accept-r1",
    )
    .unwrap();
    assert_eq!(capture.paths, vec!["app.can", "can.generated/u1/style.css"]);
    // A participating direct edit on either path conflicts.
    let source_edit = acquire(root, &["app.can"], LeaseMode::Write, "edit-agent");
    assert_eq!(source_edit.unwrap_err().code, "conflict");
    let unit_edit = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Write,
        "edit-agent",
    );
    let conflict = unit_edit.unwrap_err();
    assert_eq!(conflict.code, "conflict");
    assert!(
        conflict.message.contains("can.generated/u1/style.css"),
        "{conflict}"
    );
    // An unrelated unit stays usable while the run holds its leases.
    let other = acquire(
        root,
        &["can.generated/u9/out.js"],
        LeaseMode::Write,
        "edit-agent",
    );
    assert!(other.is_ok());
    release(root, &other.unwrap()).unwrap();
    release(root, &capture).unwrap();
    // After release the participating edit proceeds.
    let edit = acquire(root, &["app.can"], LeaseMode::Write, "edit-agent").unwrap();
    release(root, &edit).unwrap();
    // Lock files carry the shared JSON shape on disk.
    let held = acquire(root, &["app.can"], LeaseMode::Write, "probe").unwrap();
    let lock_text = fs::read_to_string(root.join(".can/gen/locks/app.can.write.lock")).unwrap();
    // Byte-identical lock-file body with the Node host for the same token.
    assert_eq!(
        lock_text,
        format!(
            "{{\"version\":1,\"holder\":\"probe\",\"token\":\"{}\",\"mode\":\"write\",\"path\":\"app.can\"}}",
            held.token.as_str()
        )
    );
    let lock: serde_json::Value = serde_json::from_str(&lock_text).unwrap();
    assert_eq!(lock["version"], 1);
    assert_eq!(lock["holder"], "probe");
    assert_eq!(lock["token"], held.token.as_str());
    assert_eq!(lock["mode"], "write");
    assert_eq!(lock["path"], "app.can");
    release(root, &held).unwrap();
}

#[test]
fn read_leases_share_and_fence_writes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b".old{}")]);
    // Two build readers share one path.
    let reader_a = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Read,
        "build-a",
    );
    let reader_b = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Read,
        "build-b",
    );
    assert!(reader_a.is_ok());
    assert!(reader_b.is_ok());
    // A promotion write conflicts while any reader holds the path.
    let write = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Write,
        "accept",
    );
    assert_eq!(write.unwrap_err().code, "conflict");
    release(root, &reader_a.unwrap()).unwrap();
    release(root, &reader_b.unwrap()).unwrap();
    // A held write lease blocks readers in turn.
    let write = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Write,
        "accept",
    )
    .unwrap();
    let read = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Read,
        "build",
    );
    assert_eq!(read.unwrap_err().code, "conflict");
    release(root, &write).unwrap();
    let read = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Read,
        "build",
    )
    .unwrap();
    release(root, &read).unwrap();
    // Release is idempotent and never steals a re-acquired foreign lock.
    let first = acquire(root, &["app.can"], LeaseMode::Write, "holder-a").unwrap();
    release(root, &first).unwrap();
    release(root, &first).unwrap();
    let second = acquire(root, &["app.can"], LeaseMode::Write, "holder-b").unwrap();
    assert_eq!(release(root, &first).unwrap_err().code, "stale-token");
    assert!(root.join(".can/gen/locks/app.can.write.lock").exists());
    release(root, &second).unwrap();
}

#[test]
fn capture_build_uses_one_immutable_consumed_closure() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_tree(root, &[("app.can", CAPTURE_SOURCE.as_bytes())]);
    write_group(
        root,
        "u1",
        &[("style.css", b".old{}"), ("unit.json", b"{\"id\":\"u1\"}")],
    );
    // The source.rs reader hook snapshots source plus saved group together.
    let files = group_files(root, "u1").unwrap();
    assert_eq!(files, vec!["style.css", "unit.json"]);
    let snapshot = snapshot_consumed_inputs(
        root,
        "build",
        &[
            "app.can",
            "can.generated/u1/style.css",
            "can.generated/u1/unit.json",
        ],
    )
    .unwrap();
    assert_eq!(snapshot.len(), 3);
    assert!(snapshot.iter().all(|input| !input.sha256.is_empty()));
    // Later live edits cannot change the consumed closure.
    write_tree(
        root,
        &[
            ("app.can", b"app Tasks\nThen\n"),
            ("can.generated/u1/style.css", b".new{}"),
        ],
    );
    let css = snapshot
        .iter()
        .find(|i| i.path == "can.generated/u1/style.css")
        .unwrap();
    assert_eq!(css.bytes, b".old{}");
    let source = snapshot.iter().find(|i| i.path == "app.can").unwrap();
    assert_eq!(source.bytes, CAPTURE_SOURCE.as_bytes());
    // The direct leases hook agrees byte-for-byte.
    let direct = snapshot_inputs(root, "build", &["app.can"]).unwrap();
    assert_eq!(direct[0].bytes, b"app Tasks\nThen\n");
    // Read leases are brief: nothing lingers after the snapshot.
    assert!(
        fs::read_dir(root.join(".can/gen/locks"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn interruption_before_commit_restores_the_whole_old_group() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(
        root,
        "u1",
        &[("style.css", b".old{}"), ("unit.json", b"{\"id\":\"u1\"}")],
    );
    write_group(root, "u2", &[("server.js", b"old();")]);
    let journal = stage_journal(
        root,
        "r1",
        &["u1", "u2"],
        &[
            replacement("u1", "style.css", b".new{}"),
            replacement("u2", "server.js", b"new();"),
            replacement("u1", "extra.css", b".added{}"),
        ],
    )
    .unwrap();
    assert_eq!(journal.state, JournalState::Staged);
    assert_eq!(journal.scope, vec!["u1", "u2"]);
    assert_eq!(journal.entries.len(), 3);
    // Staging never touches current files, and the complete prior set waits
    // under the run directory.
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), b".old{}");
    assert_eq!(
        read_tree(root, ".can/gen/runs/r1/old/u1/style.css"),
        b".old{}"
    );
    assert_eq!(
        read_tree(root, ".can/gen/runs/r1/old/u1/unit.json"),
        b"{\"id\":\"u1\"}"
    );
    assert_eq!(
        read_tree(root, ".can/gen/runs/r1/new/u1/style.css"),
        b".new{}"
    );
    // A crash here (nothing further runs) recovers the whole old group with
    // zero writes to current files.
    assert_eq!(unresolved_journals(root), vec!["r1".to_string()]);
    assert_eq!(
        recover_journal(root, "r1").unwrap(),
        RecoveryOutcome::RestoredOld
    );
    assert!(unresolved_journals(root).is_empty());
    assert!(
        root.join(".can/gen/runs/r1/journal.resolved.json")
            .is_file()
    );
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), b".old{}");
    assert_eq!(read_tree(root, "can.generated/u2/server.js"), b"old();");
    assert!(!root.join("can.generated/u1/extra.css").exists());
    // Readers are unblocked once the journal resolves.
    assert!(snapshot_inputs(root, "build", &["can.generated/u1/style.css"]).is_ok());
}

#[test]
fn interruption_after_commit_finishes_the_whole_new_group() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b".old{}")]);
    write_group(root, "u2", &[("server.js", b"old();")]);
    stage_journal(
        root,
        "r2",
        &["u1", "u2"],
        &[
            replacement("u1", "style.css", b".new{}"),
            replacement("u2", "server.js", b"new();"),
        ],
    )
    .unwrap();
    // The flip lands, then the writer dies before any per-file rename.
    assert_eq!(
        read_journal(root, "r2").unwrap().state,
        JournalState::Staged
    );
    mark_committed(root, "r2").unwrap();
    assert_eq!(
        read_journal(root, "r2").unwrap().state,
        JournalState::Committed
    );
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), b".old{}");
    // Recovery finishes the whole new set together, never one unit alone.
    match recover_journal(root, "r2").unwrap() {
        RecoveryOutcome::CompletedNew { files } => assert_eq!(files, 2),
        other => panic!("expected CompletedNew, got {other:?}"),
    }
    assert!(unresolved_journals(root).is_empty());
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), b".new{}");
    assert_eq!(read_tree(root, "can.generated/u2/server.js"), b"new();");
    // The complete prior group is retained wholesale for rollback.
    assert_eq!(read_tree(root, ".can/gen/previous/u1/style.css"), b".old{}");
    assert_eq!(read_tree(root, ".can/gen/previous/u2/server.js"), b"old();");
}

#[test]
fn commit_applies_all_and_retains_one_previous_group() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(
        root,
        "u1",
        &[("style.css", b".old{}"), ("unit.json", b"{\"id\":\"u1\"}")],
    );
    stage_journal(
        root,
        "r3",
        &["u1"],
        &[replacement("u1", "style.css", b".new{}")],
    )
    .unwrap();
    match commit_journal(root, "r3").unwrap() {
        CommitOutcome::Committed { files } => assert_eq!(files, 1),
        other => panic!("expected Committed, got {other:?}"),
    }
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), b".new{}");
    // Untouched group files are preserved; the previous group is complete.
    assert_eq!(
        read_tree(root, "can.generated/u1/unit.json"),
        b"{\"id\":\"u1\"}"
    );
    assert_eq!(read_tree(root, ".can/gen/previous/u1/style.css"), b".old{}");
    assert_eq!(
        read_tree(root, ".can/gen/previous/u1/unit.json"),
        b"{\"id\":\"u1\"}"
    );
    // A second run replaces the retained group: exactly one is kept.
    stage_journal(
        root,
        "r4",
        &["u1"],
        &[replacement("u1", "style.css", b".newer{}")],
    )
    .unwrap();
    assert!(matches!(
        commit_journal(root, "r4").unwrap(),
        CommitOutcome::Committed { .. }
    ));
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), b".newer{}");
    assert_eq!(read_tree(root, ".can/gen/previous/u1/style.css"), b".new{}");
    // Applying a staged journal directly is refused; so is restaging a run.
    stage_journal(
        root,
        "r5",
        &["u1"],
        &[replacement("u1", "style.css", b".x{}")],
    )
    .unwrap();
    assert_eq!(
        apply_committed(root, "r5").unwrap_err().code,
        "not-committed"
    );
    assert!(stage_journal(root, "r5", &["u1"], &[]).is_err());
    let journal_text = fs::read_to_string(root.join(".can/gen/runs/r5/journal.json")).unwrap();
    let journal: serde_json::Value = serde_json::from_str(&journal_text).unwrap();
    assert_eq!(journal["version"], 2);
    assert_eq!(journal["state"], "staged");
    assert_eq!(journal["scope"], serde_json::json!(["u1"]));
}

#[test]
fn unexpected_bytes_retain_conflict_material() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(
        root,
        "u1",
        &[("a.css", b".a-old{}"), ("b.css", b".b-old{}")],
    );
    stage_journal(
        root,
        "r6",
        &["u1"],
        &[
            replacement("u1", "a.css", b".a-new{}"),
            replacement("u1", "b.css", b".b-new{}"),
        ],
    )
    .unwrap();
    mark_committed(root, "r6").unwrap();
    // A foreign write lands on b.css after the flip: neither old nor new.
    write_tree(root, &[("can.generated/u1/b.css", b".b-foreign{}")]);
    let outcome = recover_journal(root, "r6").unwrap();
    let (mismatches, conflict_path) = match outcome {
        RecoveryOutcome::Conflict {
            mismatches,
            conflict_path,
        } => (mismatches, conflict_path),
        other => panic!("expected Conflict, got {other:?}"),
    };
    assert_eq!(mismatches.len(), 1);
    assert_eq!(mismatches[0].unit, "u1");
    assert_eq!(mismatches[0].path, "b.css");
    // Nothing destructive ran: the foreign bytes stand, the staged payload
    // stands, entries apply in order so a.css (first) is new while the
    // journal stays unresolved for reconciliation.
    assert_eq!(read_tree(root, "can.generated/u1/a.css"), b".a-new{}");
    assert_eq!(read_tree(root, "can.generated/u1/b.css"), b".b-foreign{}");
    assert_eq!(
        read_tree(root, ".can/gen/runs/r6/new/u1/b.css"),
        b".b-new{}"
    );
    assert_eq!(
        read_tree(root, ".can/gen/runs/r6/old/u1/b.css"),
        b".b-old{}"
    );
    assert_eq!(unresolved_journals(root), vec!["r6".to_string()]);
    assert!(conflict_path.is_file());
    let report: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conflict_path).unwrap()).unwrap();
    // Committed recovery finishes through the apply mechanism, so the phase
    // names `apply`; the staged direction reports `recover`.
    assert_eq!(report["phase"], "apply");
    assert_eq!(report["mismatches"][0]["path"], "b.css");
    assert!(!report["retained"].as_array().unwrap().is_empty());
    // Reconciliation finishes the run: restoring the staged old bytes for
    // b.css lets recovery complete the whole new set.
    write_tree(root, &[("can.generated/u1/b.css", b".b-old{}")]);
    assert!(matches!(
        recover_journal(root, "r6").unwrap(),
        RecoveryOutcome::CompletedNew { files: 2 }
    ));
    assert_eq!(read_tree(root, "can.generated/u1/b.css"), b".b-new{}");
}

#[test]
fn staged_recovery_never_overwrites_participating_work() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b".old{}")]);
    stage_journal(
        root,
        "r7",
        &["u1"],
        &[replacement("u1", "style.css", b".new{}")],
    )
    .unwrap();
    // A participating edit lands before the flip; staged recovery must refuse
    // rather than restore old bytes over it.
    write_tree(root, &[("can.generated/u1/style.css", b".participating{}")]);
    assert!(matches!(
        recover_journal(root, "r7").unwrap(),
        RecoveryOutcome::Conflict { .. }
    ));
    assert_eq!(
        read_tree(root, "can.generated/u1/style.css"),
        b".participating{}"
    );
    assert_eq!(unresolved_journals(root), vec!["r7".to_string()]);
}

#[test]
fn unresolved_journals_never_serve_a_mixed_group() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b".old{}")]);
    write_group(root, "u2", &[("server.js", b"old();")]);
    stage_journal(
        root,
        "r8",
        &["u1", "u2"],
        &[
            replacement("u1", "style.css", b".new{}"),
            replacement("u2", "server.js", b"new();"),
        ],
    )
    .unwrap();
    mark_committed(root, "r8").unwrap();
    // Readers refuse every path — even uninvolved ones — while any journal
    // is unresolved, so no consumer can mix old and new bytes.
    let refused = snapshot_inputs(root, "build", &["can.generated/u1/style.css"]).unwrap_err();
    assert_eq!(refused.code, "unresolved-journal");
    assert!(refused.message.contains("r8"), "{refused}");
    assert_eq!(
        snapshot_consumed_inputs(root, "build", &["can.generated/u2/server.js"])
            .unwrap_err()
            .code,
        "unresolved-journal"
    );
    assert!(matches!(
        recover_journal(root, "r8").unwrap(),
        RecoveryOutcome::CompletedNew { .. }
    ));
    let snapshot = snapshot_inputs(
        root,
        "build",
        &["can.generated/u1/style.css", "can.generated/u2/server.js"],
    )
    .unwrap();
    assert_eq!(snapshot[0].bytes, b".new{}");
    assert_eq!(snapshot[1].bytes, b"new();");
}

#[test]
fn repeated_recovery_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b".old{}")]);
    // Staged direction: resolve once, then no-op forever.
    stage_journal(
        root,
        "r9",
        &["u1"],
        &[replacement("u1", "style.css", b".new{}")],
    )
    .unwrap();
    assert_eq!(
        recover_journal(root, "r9").unwrap(),
        RecoveryOutcome::RestoredOld
    );
    assert_eq!(
        recover_journal(root, "r9").unwrap(),
        RecoveryOutcome::AlreadyResolved
    );
    assert_eq!(
        recover_journal(root, "r9").unwrap(),
        RecoveryOutcome::AlreadyResolved
    );
    // Committed direction: complete once, then no-op; current is untouched
    // by the repeats.
    stage_journal(
        root,
        "r10",
        &["u1"],
        &[replacement("u1", "style.css", b".new{}")],
    )
    .unwrap();
    mark_committed(root, "r10").unwrap();
    assert!(matches!(
        recover_journal(root, "r10").unwrap(),
        RecoveryOutcome::CompletedNew { .. }
    ));
    let after_first = read_tree(root, "can.generated/u1/style.css");
    assert_eq!(
        recover_journal(root, "r10").unwrap(),
        RecoveryOutcome::AlreadyResolved
    );
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), after_first);
    // Unknown runs are already resolved too: nothing to do is not an error.
    assert_eq!(
        recover_journal(root, "r-missing").unwrap(),
        RecoveryOutcome::AlreadyResolved
    );
}

#[test]
fn stopped_writer_recovery_needs_confirmation_and_never_steals() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b".old{}")]);
    let crashed = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Write,
        "crashed",
    );
    let crashed = crashed.unwrap();
    let live = acquire(root, &["app.can"], LeaseMode::Write, "live").unwrap();
    // Leases never expire: the crashed writer's lock still blocks.
    assert_eq!(
        acquire(
            root,
            &["can.generated/u1/style.css"],
            LeaseMode::Write,
            "next"
        )
        .unwrap_err()
        .code,
        "conflict"
    );
    // Recovery without stopped confirmation is refused outright.
    assert_eq!(
        recover_stopped_writer(root, "crashed", &crashed.token, false)
            .unwrap_err()
            .code,
        "not-confirmed"
    );
    assert!(
        root.join(".can/gen/locks/can.generated%2Fu1%2Fstyle.css.write.lock")
            .exists()
    );
    // Confirmed recovery removes only that holder's locks.
    let recovered = recover_stopped_writer(root, "crashed", &crashed.token, true).unwrap();
    assert_eq!(recovered, vec!["can.generated/u1/style.css".to_string()]);
    assert!(root.join(".can/gen/locks/app.can.write.lock").exists());
    let next = acquire(
        root,
        &["can.generated/u1/style.css"],
        LeaseMode::Write,
        "next",
    )
    .unwrap();
    release(root, &next).unwrap();
    release(root, &live).unwrap();
}

#[test]
fn journal_scope_and_replacements_are_validated() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b".old{}")]);
    // Empty scope, out-of-scope units, duplicate entries and bad paths fail.
    assert!(stage_journal(root, "rv", &[], &[]).is_err());
    assert!(stage_journal(root, "rv", &["u1"], &[replacement("u2", "x", b"y")]).is_err());
    assert!(
        stage_journal(
            root,
            "rv",
            &["u1"],
            &[
                replacement("u1", "style.css", b"a"),
                replacement("u1", "style.css", b"b")
            ]
        )
        .is_err()
    );
    assert!(stage_journal(root, "rv", &["u1"], &[replacement("u1", "../escape", b"y")]).is_err());
    assert!(stage_journal(root, "bad/run", &["u1"], &[]).is_err());
    // A failed staging leaves no half-run behind for readers to trip on.
    assert!(unresolved_journals(root).is_empty());
    assert!(read_journal(root, "rv").is_err());
    assert_eq!(commit_journal(root, "rv").unwrap_err().code, "no-journal");
    assert!(snapshot_inputs(root, "build", &["can.generated/u1/style.css"]).is_ok());
    // Cross-check the helper path type is actually used.
    let _: PathBuf = root.join(".can/gen");
}

#[test]
fn simultaneous_incompatible_acquire_cannot_both_admit() {
    // Barrier-aligned read/write racers on one exact path share one atomic
    // admission step: in every round, no held read coexists with a held
    // write, and every loser reports `conflict`.
    for _ in 0..50 {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let barrier = std::sync::Barrier::new(16);
        std::thread::scope(|s| {
            let mut handles = Vec::new();
            for i in 0..8 {
                let gate = &barrier;
                handles.push(s.spawn(move || {
                    gate.wait();
                    acquire(root, &["app.can"], LeaseMode::Read, &format!("build-{i}"))
                }));
            }
            for i in 0..8 {
                let gate = &barrier;
                handles.push(s.spawn(move || {
                    gate.wait();
                    acquire(root, &["app.can"], LeaseMode::Write, &format!("accept-{i}"))
                }));
            }
            // Hold every admitted set until after the assert: sequential
            // admission after release is legal, only co-holding is not.
            let mut held_sets = Vec::new();
            let mut read_held = 0;
            let mut write_held = 0;
            for (index, handle) in handles.into_iter().enumerate() {
                match handle.join().unwrap() {
                    Ok(set) => {
                        if index < 8 {
                            read_held += 1;
                        } else {
                            write_held += 1;
                        }
                        held_sets.push(set);
                    }
                    Err(error) => assert_eq!(error.code, "conflict", "{error}"),
                }
            }
            assert!(
                read_held == 0 || write_held == 0,
                "incompatible leases co-admitted: {read_held} reads with {write_held} writes"
            );
            for set in &held_sets {
                release(root, set).unwrap();
            }
        });
    }
}

#[test]
fn foreign_lock_files_arbitrate_admission() {
    // Hand-write the exact bytes the Node host emits; this host must honor
    // them (shared admission interoperability across hosts).
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join(".can/gen/locks")).unwrap();
    fs::write(
        root.join(".can/gen/locks/app.can.read.v1-0123456789abcdef.lock"),
        r#"{"version":1,"holder":"node-build","token":"v1-0123456789abcdef","mode":"read","path":"app.can"}"#,
    )
    .unwrap();
    // A foreign read blocks writes and shares reads.
    assert_eq!(
        acquire(root, &["app.can"], LeaseMode::Write, "accept")
            .unwrap_err()
            .code,
        "conflict"
    );
    let reader = acquire(root, &["app.can"], LeaseMode::Read, "build").unwrap();
    release(root, &reader).unwrap();
    // Stopped-writer recovery removes the foreign lock by holder and token.
    let token = LeaseToken::parse("v1-0123456789abcdef").unwrap();
    assert_eq!(
        recover_stopped_writer(root, "node-build", &token, true).unwrap(),
        vec!["app.can".to_string()]
    );
    // A foreign write lock blocks both modes.
    fs::write(
        root.join(".can/gen/locks/app.can.write.lock"),
        r#"{"version":1,"holder":"node-accept","token":"v1-fedcba9876543210","mode":"write","path":"app.can"}"#,
    )
    .unwrap();
    assert_eq!(
        acquire(root, &["app.can"], LeaseMode::Write, "next")
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(
        acquire(root, &["app.can"], LeaseMode::Read, "build")
            .unwrap_err()
            .code,
        "conflict"
    );
}

#[test]
fn read_gate_runs_while_leases_cover_the_consumed_closure() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("a.css", b"a-old")]);
    write_group(root, "u2", &[("b.css", b"b-old")]);
    // A writer holds the path while a journal is unresolved: acquisition runs
    // first, so the reader reports the lease conflict — proving the gate is
    // evaluated only while acquired leases cover the closure, not before.
    let writer = acquire(
        root,
        &["can.generated/u1/a.css"],
        LeaseMode::Write,
        "accept",
    )
    .unwrap();
    stage_journal(
        root,
        "rg",
        &["u1", "u2"],
        &[
            replacement("u1", "a.css", b"a-new"),
            replacement("u2", "b.css", b"b-new"),
        ],
    )
    .unwrap();
    let refused = snapshot_inputs(root, "build", &["can.generated/u1/a.css"]).unwrap_err();
    assert_eq!(refused.code, "conflict");
    release(root, &writer).unwrap();
    // With leases acquirable again, the gate still refuses the unresolved run.
    let refused = snapshot_inputs(root, "build", &["can.generated/u1/a.css"]).unwrap_err();
    assert_eq!(refused.code, "unresolved-journal");
    // Emulate the stopped-writer state: committed, first entry applied, then
    // interrupted with leases recovered. The gate refuses; never [a-new,
    // b-old]. Whole-set recovery then finishes the new group together.
    mark_committed(root, "rg").unwrap();
    write_tree(root, &[("can.generated/u1/a.css", b"a-new")]);
    let refused = snapshot_inputs(
        root,
        "build",
        &["can.generated/u1/a.css", "can.generated/u2/b.css"],
    )
    .unwrap_err();
    assert_eq!(refused.code, "unresolved-journal");
    assert!(matches!(
        recover_journal(root, "rg").unwrap(),
        RecoveryOutcome::CompletedNew { files: 2 }
    ));
    let snapshot = snapshot_inputs(
        root,
        "build",
        &["can.generated/u1/a.css", "can.generated/u2/b.css"],
    )
    .unwrap();
    assert_eq!(snapshot[0].bytes, b"a-new");
    assert_eq!(snapshot[1].bytes, b"b-new");
}

#[test]
fn replacement_temp_never_touches_an_unrequested_sibling() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(
        root,
        "u1",
        &[("a.css", b"a-old"), ("a.css.can-new", b"saved-helper")],
    );
    let held = acquire(
        root,
        &["can.generated/u1/a.css", "can.generated/u1/a.css.can-new"],
        LeaseMode::Write,
        "accept",
    )
    .unwrap();
    stage_journal(root, "rt", &["u1"], &[replacement("u1", "a.css", b"a-new")]).unwrap();
    assert!(matches!(
        commit_journal(root, "rt").unwrap(),
        CommitOutcome::Committed { files: 1 }
    ));
    // The admitted path changed; the untouched sibling is byte-identical and
    // no stray temp litters the group.
    assert_eq!(read_tree(root, "can.generated/u1/a.css"), b"a-new");
    assert_eq!(
        read_tree(root, "can.generated/u1/a.css.can-new"),
        b"saved-helper"
    );
    assert_eq!(
        group_files(root, "u1").unwrap(),
        vec!["a.css".to_string(), "a.css.can-new".to_string()]
    );
    assert_eq!(
        read_tree(root, ".can/gen/previous/u1/a.css.can-new"),
        b"saved-helper"
    );
    release(root, &held).unwrap();
}

#[test]
fn complete_replacement_recovers_deletions_and_exact_binary_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let old_binary = [0, 255, 128, 13, 10];
    let new_binary = [255, 0, 129, 10];
    write_group(
        root,
        "u1",
        &[
            ("style.css", b"old"),
            ("obsolete.js", b"helper"),
            ("image.bin", &old_binary),
        ],
    );
    let journal = stage_complete_journal(
        root,
        "complete",
        &["u1"],
        &[
            replacement("u1", "style.css", b"new"),
            replacement("u1", "image.bin", &new_binary),
        ],
    )
    .unwrap();
    assert_eq!(journal.version, 2);
    let deletion = journal
        .entries
        .iter()
        .find(|e| e.path == "obsolete.js")
        .unwrap();
    assert_eq!(deletion.staged, None);
    assert_eq!(deletion.new_sha256, None);
    mark_committed(root, "complete").unwrap();
    fs::remove_file(root.join("can.generated/u1/obsolete.js")).unwrap();
    assert!(matches!(
        recover_journal(root, "complete").unwrap(),
        RecoveryOutcome::CompletedNew { files: 3 }
    ));
    assert_eq!(
        group_files(root, "u1").unwrap(),
        vec!["image.bin", "style.css"]
    );
    assert_eq!(read_tree(root, "can.generated/u1/image.bin"), new_binary);
    assert_eq!(
        read_tree(root, ".can/gen/previous/u1/image.bin"),
        old_binary
    );
    assert_eq!(
        read_tree(root, ".can/gen/previous/u1/obsolete.js"),
        b"helper"
    );
    assert!(matches!(
        recover_journal(root, "complete").unwrap(),
        RecoveryOutcome::AlreadyResolved
    ));
}

#[test]
fn precommit_complete_recovery_preserves_old_membership() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("old.bin", b"old")]);
    stage_complete_journal(
        root,
        "before-delete",
        &["u1"],
        &[replacement("u1", "new.bin", b"new")],
    )
    .unwrap();
    assert!(matches!(
        recover_journal(root, "before-delete").unwrap(),
        RecoveryOutcome::RestoredOld
    ));
    assert_eq!(group_files(root, "u1").unwrap(), vec!["old.bin"]);
    assert_eq!(read_tree(root, "can.generated/u1/old.bin"), b"old");
}

#[test]
fn explicit_patch_deletion_preserves_untouched_files_and_changed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("keep.bin", b"keep"), ("remove.bin", b"old")]);
    stage_journal_with_deletions(root, "patch-delete", &["u1"], &[], &[("u1", "remove.bin")])
        .unwrap();
    mark_committed(root, "patch-delete").unwrap();
    write_group(root, "u1", &[("remove.bin", b"foreign")]);
    assert!(matches!(
        recover_journal(root, "patch-delete").unwrap(),
        RecoveryOutcome::Conflict { .. }
    ));
    assert_eq!(read_tree(root, "can.generated/u1/remove.bin"), b"foreign");
    write_group(root, "u1", &[("remove.bin", b"old")]);
    assert!(matches!(
        recover_journal(root, "patch-delete").unwrap(),
        RecoveryOutcome::CompletedNew { files: 1 }
    ));
    assert_eq!(group_files(root, "u1").unwrap(), vec!["keep.bin"]);
}

#[test]
fn complete_replacement_refuses_unexpected_membership() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("style.css", b"old")]);
    stage_complete_journal(
        root,
        "extra-file",
        &["u1"],
        &[replacement("u1", "style.css", b"new")],
    )
    .unwrap();
    mark_committed(root, "extra-file").unwrap();
    write_group(root, "u1", &[("foreign.bin", b"foreign")]);
    assert!(matches!(
        recover_journal(root, "extra-file").unwrap(),
        RecoveryOutcome::Conflict { .. }
    ));
    assert_eq!(read_tree(root, "can.generated/u1/style.css"), b"old");
    assert_eq!(read_tree(root, "can.generated/u1/foreign.bin"), b"foreign");
}

#[test]
fn complete_replacement_supports_file_directory_transitions_and_v1() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_group(root, "u1", &[("asset", b"old")]);
    stage_complete_journal(
        root,
        "to-dir",
        &["u1"],
        &[replacement("u1", "asset/part.bin", b"nested")],
    )
    .unwrap();
    commit_journal(root, "to-dir").unwrap();
    assert_eq!(group_files(root, "u1").unwrap(), vec!["asset/part.bin"]);
    stage_complete_journal(
        root,
        "to-file",
        &["u1"],
        &[replacement("u1", "asset", b"flat")],
    )
    .unwrap();
    commit_journal(root, "to-file").unwrap();
    assert_eq!(group_files(root, "u1").unwrap(), vec!["asset"]);
    stage_journal(
        root,
        "legacy",
        &["u1"],
        &[replacement("u1", "asset", b"legacy")],
    )
    .unwrap();
    let path = root.join(".can/gen/runs/legacy/journal.json");
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    journal["version"] = serde_json::json!(1);
    journal.as_object_mut().unwrap().remove("mode");
    fs::write(path, serde_json::to_vec(&journal).unwrap()).unwrap();
    mark_committed(root, "legacy").unwrap();
    assert!(matches!(
        recover_journal(root, "legacy").unwrap(),
        RecoveryOutcome::CompletedNew { files: 1 }
    ));
}
