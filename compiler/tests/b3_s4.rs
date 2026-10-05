//! B3 S4: compact agent fix-JSON + stale-edit rejection through the real binary.
//!
//! * Fix JSON from `can lint --fix --format=json` is byte-identical across reruns.
//! * `can lint --format=json` (no `--fix`) carries no `fixes` key.
//! * Re-applying a fix to changed bytes is refused as `Stale` with both
//!   hashes, and the refusal renders as explicit JSON.
//! * The shared stdio LSP driver ([`lsp_driver`]) drives the REAL `can lsp`
//!   binary: `initialize -> didOpen -> codeAction` shows the fix, and after
//!   `didChange` to the fixed text the same range shows none.
//!
//! Hermetic CI has no real catalog: without
//! `packages/values/dist/catalog.json` the binary legs SKIP loudly (no
//! fixture fallback — B1-style), while the in-process stale unit still runs.

#[path = "common/lsp_driver.rs"]
mod lsp_driver;

use canlang_compiler::analysis;
use canlang_compiler::lint::driver::{
    FixRejected, LintConfig, RuleSet, apply_fix, collect_fixes, fix_to_json, fixes_to_json,
    rejected_to_json,
};
use canlang_compiler::source::{SourceDb, sha256_hex};
use std::path::PathBuf;
use std::process::Command;

/// Repo root (`compiler/../`).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Path of the real `can` binary (built by `cargo build`/`cargo test`).
fn can_binary() -> PathBuf {
    option_env!("CARGO_BIN_EXE_can")
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/can"))
}

/// Real catalog path, or `None` when hermetic (caller skips loudly).
fn real_catalog(root: &std::path::Path) -> Option<PathBuf> {
    let path = root
        .join("packages")
        .join("values")
        .join("dist")
        .join("catalog.json");
    path.exists().then_some(path)
}

fn fixture_text() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/s4_fix.can");
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The one I1002 `?.` span in the fixture as an LSP `(line, character)`
/// start/end range.
fn fix_range() -> ((u32, u32), (u32, u32)) {
    let text = fixture_text();
    let offset = text.find("?.").expect("fixture keeps one `?.` site") as u32;
    let mut line = 0u32;
    let mut line_start = 0u32;
    for (i, byte) in text.bytes().enumerate() {
        if i as u32 >= offset {
            break;
        }
        if byte == b'\n' {
            line += 1;
            line_start = i as u32 + 1;
        }
    }
    let character = offset - line_start;
    ((line, character), (line, character + 2))
}

#[test]
fn fix_json_is_deterministic_across_reruns() {
    let root = repo_root();
    let Some(catalog) = real_catalog(&root) else {
        eprintln!(
            "SKIP fix_json_is_deterministic_across_reruns: no packages/values/dist/catalog.json"
        );
        return;
    };
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/s4_fix.can");
    let run = || {
        Command::new(can_binary())
            .args([
                "lint",
                "--fix",
                "--format=json",
                &format!("--catalog={}", catalog.display()),
                &fixture.to_string_lossy(),
            ])
            .output()
            .expect("spawn can lint --fix")
    };
    let first = run();
    let second = run();
    assert_eq!(
        first.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(
        first.stdout, second.stdout,
        "fix JSON must be byte-identical"
    );
    let stdout = String::from_utf8_lossy(&first.stdout);
    assert!(stdout.contains("\"fixes\":["), "{stdout}");
    assert!(
        stdout.contains("\"rule\":\"redundant-null-marker\""),
        "{stdout}"
    );
    assert!(stdout.contains("\"expected_sha256\":"), "{stdout}");
    assert!(stdout.contains("\"replacement\":\".\""), "{stdout}");
    assert_eq!(stdout.lines().count(), 1, "single-line envelope: {stdout}");
}

#[test]
fn lint_without_fix_has_no_fixes_key() {
    let root = repo_root();
    let Some(catalog) = real_catalog(&root) else {
        eprintln!("SKIP lint_without_fix_has_no_fixes_key: no packages/values/dist/catalog.json");
        return;
    };
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/s4_fix.can");
    let output = Command::new(can_binary())
        .args([
            "lint",
            "--format=json",
            &format!("--catalog={}", catalog.display()),
            &fixture.to_string_lossy(),
        ])
        .output()
        .expect("spawn can lint");
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("\"fixes\""),
        "no --fix means no fixes key: {stdout}"
    );
    assert!(stdout.contains("\"code\":\"I1002\""), "{stdout}");
}

#[test]
fn stale_reapply_reports_both_hashes_as_json() {
    // In-process contract gate (no catalog needed): the fixture's fix,
    // computed against the original bytes, is stale against changed bytes.
    let text = fixture_text();
    assert_eq!(
        text.matches("?.").count(),
        1,
        "fixture keeps exactly one `?.` site"
    );
    let mut db = SourceDb::new();
    let id = db.add("s4_fix.can".to_string(), text.clone());
    let (program, check_diags) = analysis::check_program(&db, &[id], None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let config = LintConfig {
        enabled: RuleSet::recommended(),
        fix: true,
        deprecated: None,
    };
    let fixes = collect_fixes(&program, &db, &config);
    assert_eq!(fixes.len(), 1, "{fixes:?}");
    let fix = &fixes[0];
    assert_eq!(fix.rule, "redundant-null-marker");
    assert_eq!(fix.replacement, ".");

    // Fix JSON shape: fixed key order, single line.
    let json = fix_to_json(fix);
    let keys = [
        "\"rule\"",
        "\"title\"",
        "\"file\"",
        "\"span\"",
        "\"expected_sha256\"",
        "\"replacement\"",
    ];
    let mut last = 0;
    for key in keys {
        let at = json
            .find(key)
            .unwrap_or_else(|| panic!("missing {key}: {json}"));
        assert!(at > last, "key order violated at {key}: {json}");
        last = at;
    }
    assert!(!json.contains('\n'), "{json}");
    assert_eq!(fixes_to_json(&fixes), format!("[{json}]"));

    // Stale re-apply: changed bytes refuse with expected + found hashes.
    let changed = text.replace("?.", ".");
    let changed_sha = sha256_hex(changed.as_bytes());
    let err = apply_fix(&changed, &changed_sha, fix).expect_err("stale bytes must refuse");
    assert_eq!(
        err,
        FixRejected::Stale {
            expected: fix.expected_sha256.clone(),
            found: changed_sha.clone(),
        }
    );
    let stale_json = rejected_to_json(&err);
    assert!(stale_json.contains("\"reason\":\"stale\""), "{stale_json}");
    assert!(stale_json.contains(&fix.expected_sha256), "{stale_json}");
    assert!(stale_json.contains(&changed_sha), "{stale_json}");
    assert_ne!(fix.expected_sha256, changed_sha);
    assert!(!stale_json.contains('\n'), "{stale_json}");
}

#[test]
fn lsp_driver_code_action_roundtrip_through_real_binary() {
    let text = fixture_text();
    let uri = "file:///s4_fix.can";
    let mut driver = lsp_driver::LspDriver::spawn().expect("spawn can lsp");
    let init = driver.initialize().expect("initialize");
    assert!(init.contains("capabilities"), "{init}");
    driver.did_open(uri, 1, &text).expect("didOpen");

    let (start, end) = fix_range();
    let before = driver.code_action(uri, start, end).expect("codeAction");
    assert!(before.contains("redundant"), "{before}");
    assert!(before.contains("\"newText\":\".\""), "{before}");
    // The open's publishDiagnostics burst was buffered aside, never
    // mistaken for the response.
    assert!(
        driver
            .take_notifications()
            .iter()
            .any(|n| n.contains("publishDiagnostics")),
        "expected buffered diagnostics"
    );

    // Apply the fix client-side, notify the server, and re-request: the
    // same range now has no actions.
    let fixed = text.replace("?.", ".");
    driver.did_change(uri, 2, &fixed).expect("didChange");
    let after = driver.code_action(uri, start, end).expect("codeAction");
    assert!(after.contains("\"result\":[]"), "{after}");

    // Rename + completion helpers stay usable through the same driver.
    // `task` param use sits on line 6 (`   let p=task?.title` -> fixed).
    let rename = driver.rename(uri, 6, 10, "job").expect("rename");
    assert!(rename.contains("\"result\""), "{rename}");
    assert!(rename.contains("\"newText\":\"job\""), "{rename}");
    let completion = driver.completion(uri, 6, 12).expect("completion");
    assert!(completion.contains("\"result\""), "{completion}");

    driver.shutdown().expect("shutdown");
}
