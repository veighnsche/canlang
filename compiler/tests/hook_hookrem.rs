//! CAN18-v1 HOOKREM remainder pins: the 11 exact hook spans from the
//! authoritative read-only capture
//! `/Users/vince/Projects/canlang/evidence/original24-main-20261016.json`
//! (298 E6008; do NOT merge into inputs) stay loudly refused with the exact
//! missing prerequisite named.
//!
//! Coverage determination (read against the landed scope-2 stack at the
//! defining owners — compiler emission in `codegen/js.rs`, State
//! `loadParent` in `packages/state/src/mutation/pipeline.ts`, host
//! `transitive.load` bridge in `packages/cloudflare/src/runtime/invoke.ts`
//! — under accepted DESIGN 434/442, which admits hook reads over the
//! trigger's exact containment ancestry classified by consuming site):
//!
//! * parent-content x5 (file 19 `event.after.parent.parent.location.timezone`
//!   11789..11832 + 12187..12230; file 20
//!   `event.after.parent.location.timezone` 14464..14500 + 14962..14998 +
//!   15223..15259): every chain ends in a STORED-REFERENCE hop
//!   (`Agreement.location`, `Asset.location`) outside trigger containment.
//!   State `loadParent` serves ancestors only and refuses non-ancestors at
//!   its containment bound (pinned by retained
//!   `non-ancestor reads refuse without distinguishing the miss`); the
//!   compiler gaps the outermost access with `hook parent content: ...
//!   parent field reads need the transitive load and have no hook lowering`.
//!   Implementation gap (not a language prohibition): no transitive
//!   reference-load owner exists yet. A future owner must carry the exact
//!   committed-vs-staged snapshot and caller grants on referenced rows;
//!   until such a mechanism lands, these stay refused. See 2139 correction.
//! * reference-traversal x4 (file 6 `event.after.plan.months` 30244..30267;
//!   file 14 `event.after.location.timezone` 8978..9007 + 9331..9360;
//!   file 20 `event.after.location.timezone` 15653..15682): reads through
//!   event references (`Membership.plan`, `Account.location`,
//!   top-level `Asset.location`) — non-ancestry under the CURRENT ancestor
//!   fence. Same missing prerequisite: `reads through event references need
//!   the transitive load and have no hook lowering`. Stays refused until a
//!   reference-load owner lands (C27 scope is not a prohibition).
//! * staged x2 (file 8 `policy_snapshot_1.sequence` 59122..59148 +
//!   59519..59545): staged bindings carry identity only (`{id}`); no
//!   staged-content loader exists at any owner yet. Missing prerequisite:
//!   `staged field reads have no hook lowering` — needs the exact
//!   created-record/source association and current staged view. Stays
//!   refused until then.
//!
//! Each test below compiles a check-clean synthetic app with the exact
//! remainder shape and pins the loud E6008 plus the fail-closed
//! placeholder. The covered depth-1 prefix (`event.after.parent.zone`)
//! keeps lowering through the landed stack — proved inside the `??`
//! composition test. Retained suites (joint 12/12, State 14/14,
//! hook_lowering 26/26, consumer 7/7) are NOT touched by this file.
//!
//! TEST-ONLY: same explicit test-only incomplete-analysis acknowledgment
//! with a hermetic catalog as `hook_lowering.rs`. Nothing here claims
//! runtime success.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::path::PathBuf;

fn unique_temp_path(stem: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("can-hookrem-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    dir.join(format!("{stem}-{n}.json"))
}

/// Hermetic catalog matching `hook_lowering.rs`: golden builtins plus the
/// pure temporal builtins the recorded hooks use.
fn hookrem_catalog() -> (Catalog, PathBuf) {
    let path = unique_temp_path("hookrem-catalog");
    let dir = path.parent().expect("temp dir").to_path_buf();
    std::fs::write(
        &path,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[
{"id":"count","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"first","kind":"builtin","signature":"first(domain:C<T>)->T?","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"max","kind":"builtin","signature":"max(domain:C<O>)->O?; max(domain:nonempty C<O>)->O","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"local_instant","kind":"builtin","signature":"local_instant(date:date,time:text,zone:timezone,fold:enum(earlier,later))->datetime","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"local_date","kind":"builtin","signature":"local_date(value:datetime,zone:timezone)->date","effects":"pure","availability":"implemented","owner":"lane-02"}
]}"#,
    )
    .expect("write hookrem catalog");
    let primary = Span::new(SourceId(0), 0, 0);
    let request = CatalogRequest {
        flag: Some(path.as_path()),
        env: None,
        cwd: dir.as_path(),
        primary,
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "hookrem catalog loads: {diags:?}");
    (catalog.expect("catalog"), path)
}

fn check_hookrem(src: &str, catalog: &Catalog) -> (SourceDb, CheckedProgram, DiagnosticResult) {
    let mut db = SourceDb::new();
    let id = db.add("hookrem.can".to_string(), src.to_string());
    let (program, diags) = check_program(&db, &[id], Some(catalog));
    let mut result = DiagnosticResult::new("test", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.diagnostics = diags;
    result.complete = false;
    result.finish();
    (db, program, result)
}

fn emit_hookrem(
    program: &CheckedProgram,
    db: &SourceDb,
    result: &DiagnosticResult,
    catalog: &Catalog,
) -> (canlang_compiler::codegen::artifact::CompileArtifact, Vec<Diagnostic>) {
    let sources = EmitSources {
        db,
        result,
        catalog: Some(catalog),
        options: EmitOptions::test_only(),
    };
    emit(program, &sources)
}

fn hookrem_js(src: &str) -> (String, Vec<Diagnostic>, PathBuf) {
    let (catalog, path) = hookrem_catalog();
    let (db, program, result) = check_hookrem(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hookrem source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hookrem(&program, &db, &result, &catalog);
    let js = artifact.modules[0].js.clone();
    (js, diags, path)
}

fn codes(diags: &[Diagnostic]) -> Vec<String> {
    diags
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect()
}

/// File 19 shape (spans 11789..11832, 12187..12230):
/// `event.after.parent.parent.location.timezone` — grandparent ancestry
/// prefix (`Obligation -> Term -> Agreement`) followed by the stored
/// reference hop (`Agreement.location`) and the leaf read. The outermost
/// access gaps with the exact transitive-load prerequisite; no inner hop
/// lowers.
#[test]
fn hookrem_grandparent_reference_tail_refused() {
    let src = "app T\nGiven\n L { tz:text }\n A { loc:L }\n M in A { zone:text }\n C in M { t:text }\nWhen\n scenario arm on=C.create\n  do\n   let z=event.after.parent.parent.loc.tz\n   set event.after {t=z}\nThen\n";
    let (js, diags, path) = hookrem_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook parent content")
            && d.message.contains("need the transitive load")),
        "grandparent reference tail refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(js.contains("has no lowering"), "fail-closed placeholder:\n{js}");
    assert!(
        !js.contains("transitive.load"),
        "no partial transitive load for the refused chain:\n{js}"
    );
}

/// File 20 shape (spans 14464..14500, 14962..14998, 15223..15259):
/// `event.after.parent.location.timezone` — direct-parent prefix
/// (`Plan -> Asset`) followed by the stored reference hop
/// (`Asset.location`). Same missing prerequisite as the file-19 tail.
#[test]
fn hookrem_parent_reference_tail_refused() {
    let src = "app T\nGiven\n L { tz:text }\n A { loc:L }\n P in A { n:text, t:text }\nWhen\n scenario arm on=P.create\n  do\n   let z=event.after.parent.loc.tz\n   set event.after {t=z}\nThen\n";
    let (js, diags, path) = hookrem_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook parent content")
            && d.message.contains("need the transitive load")),
        "parent reference tail refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(js.contains("has no lowering"), "fail-closed placeholder:\n{js}");
}

/// File 19 exact composition (`event.after.parent.timezone ??
/// event.after.parent.parent.location.timezone`): the covered depth-1
/// prefix lowers through the landed scope-2 stack (decision/value
/// transitive load over the declared `timezone?` field) while the
/// uncovered tail refuses loud in the same hook. One E6008 only.
#[test]
fn hookrem_covered_prefix_lowers_while_tail_refuses() {
    let src = "app T\nGiven\n L { tz:timezone }\n A { loc:L }\n M in A { zone:timezone? }\n C in M { t:text, tz:timezone }\nWhen\n scenario arm on=C.create\n  do\n   let z=event.after.parent.zone ?? event.after.parent.parent.loc.tz\n   set event.after {tz=z}\nThen\n";
    let (js, diags, path) = hookrem_js(src);
    let _ = std::fs::remove_file(&path);
    let tails: Vec<&Diagnostic> = diags
        .iter()
        .filter(|d| {
            d.code == "E6008"
                && d.message.contains("hook parent content")
                && d.message.contains("need the transitive load")
        })
        .collect();
    assert_eq!(
        tails.len(),
        1,
        "exactly the tail refuses: {}",
        codes(&diags).join("\n")
    );
    assert!(
        js.contains("transitive.load($hookScope,\"T.M\","),
        "covered direct-parent prefix still loads:\n{js}"
    );
    assert!(
        js.contains("has no lowering"),
        "uncovered tail stays fail-closed:\n{js}"
    );
}

/// File 6 shape (span 30244..30267): `event.after.plan.months` — read
/// through the stored `Membership.plan` reference into `Plan.months`.
/// Non-ancestry by construction; needs the transitive reference load.
#[test]
fn hookrem_plan_reference_traversal_refused() {
    let src = "app T\nGiven\n P { months:int }\n M { plan:P, months:int }\nWhen\n scenario snap on=M.create\n  do set event.after {months=event.after.plan.months}\nThen\n";
    let (js, diags, path) = hookrem_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook reference traversal")
            && d.message.contains("need the transitive load")),
        "plan reference traversal refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(js.contains("has no lowering"), "fail-closed placeholder:\n{js}");
}

/// File 14 shape (spans 8978..9007, 9331..9360):
/// `event.after.location.timezone` on the child trigger (`Account in
/// Customer`) — read through the stored `Account.location` reference.
#[test]
fn hookrem_child_location_reference_refused() {
    let src = "app T\nGiven\n L { tz:text }\n K { name:text }\n M in K { loc:L, note:text }\nWhen\n scenario arm on=M.create\n  do\n   let z=event.after.loc.tz\n   set event.after {note=z}\nThen\n";
    let (js, diags, path) = hookrem_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook reference traversal")
            && d.message.contains("need the transitive load")),
        "child location traversal refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(js.contains("has no lowering"), "fail-closed placeholder:\n{js}");
}

/// File 20 retire_asset shape (span 15653..15682):
/// `event.after.location.timezone` where the trigger itself is top-level
/// (`Asset`, no parent) — the first hop is already a stored reference.
#[test]
fn hookrem_toplevel_location_reference_refused() {
    let src = "app T\nGiven\n L { tz:text }\n A { loc:L, note:text }\nWhen\n scenario arm on=A.create\n  do\n   let z=event.after.loc.tz\n   set event.after {note=z}\nThen\n";
    let (js, diags, path) = hookrem_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook reference traversal")
            && d.message.contains("need the transitive load")),
        "top-level location traversal refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(js.contains("has no lowering"), "fail-closed placeholder:\n{js}");
}

/// File 8 shape (spans 59122..59148, 59519..59545):
/// `policy_snapshot_1.sequence` — field read off a hook-staged binding
/// (`create ResourcePolicy {...} as policy_snapshot_1`). Staged bindings
/// carry identity only (`{id}`); no staged-content loader exists at any
/// owner, so the read refuses loud instead of reading `undefined`.
#[test]
fn hookrem_staged_binding_field_refused() {
    let src = "app T\nGiven\n M { seq:text }\n C in M { t:text }\nWhen\n scenario arm on=C.create\n  do\n   create M {seq=\"s1\"} as snap\n   let s=snap.seq\n   set event.after {t=s}\nThen\n";
    let (js, diags, path) = hookrem_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook staged content")
            && d.message.contains("staged field reads have no hook lowering")),
        "staged binding field refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(js.contains("has no lowering"), "fail-closed placeholder:\n{js}");
}
