//! Outcome 9 family E: `read=true scope=authority` reports are explicit
//! information grants to `by` (DESIGN §522), with body reads in DECISION
//! mode at the resolved storage owner (DESIGN §442) and ordinary `read=true`
//! staying viewer-filtered.
//!
//! Probe premises (verified against base `3e9e1952` before implementation):
//! an authority-shaped, described report is CHECK-clean and lowers with
//! exactly one `E6008` (no §13 emission yet). The implementation adds:
//! (a) checker enforcement of the DESIGN-522 description requirement
//! (`E3001` when a `scope=authority` report is undescribed); (b) an IR
//! marker on the scenario carrying the checked source fact; (c) a JS
//! `scope:"authority"` marker published fail-closed (descriptor marker
//! plus a throwing handler stub, `E6008` intact, no MCP tool advertisement)
//! until the Lane-C decision-mode runtime boundary lands.

use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir::{self, IrItemKind};
use canlang_compiler::codegen::js;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

/// Authority-shaped report: pure body, declared result, `by` admission,
/// and the DESIGN-522 description identifying the information exposed.
const AUTHORITY_SOURCE: &str = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\nWhen\n # Confidential totals granted to members.\n scenario totals() read=true scope=authority -> Total by=members\n  do\n   return Total {count=1}\nThen\n";

/// Ordinary viewer-filtered read: same shape without the authority scope.
const ORDINARY_SOURCE: &str = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\nWhen\n scenario summarize() read=true -> Total by=members\n  do\n   return Total {count=1}\nThen\n";

/// Check one source through the full analysis pipeline (catalog-free:
/// authority reports need no builtins).
fn check(src: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("scope-authority-probe.can".to_string(), src.to_string());
    let (_program, mut diags) = check_program(&db, &[id], None);
    diags.sort_by(|a, b| {
        (a.primary.start, a.primary.end, &a.code).cmp(&(b.primary.start, b.primary.end, &b.code))
    });
    diags
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

/// The authority-shaped report is CHECK-clean: checking records and
/// validates `scope=authority` (`E3001` without `read=true`, fail-closed
/// disclosure exclusions) without refusing the described report itself.
#[test]
fn authority_shaped_report_is_check_clean() {
    let diags = check(AUTHORITY_SOURCE);
    assert!(diags.is_empty(), "{diags:?}");
}

/// Lowering reports exactly one `E6008` for the authority scope until the
/// decision-mode runtime boundary lands; the diagnostic names that gap.
#[test]
fn authority_scope_keeps_single_e6008_naming_runtime_boundary() {
    let diags = check(AUTHORITY_SOURCE);
    assert!(diags.is_empty(), "{diags:?}");
    let mut db = SourceDb::new();
    let id = db.add(
        "scope-authority-probe.can".to_string(),
        AUTHORITY_SOURCE.to_string(),
    );
    let (program, _) = check_program(&db, &[id], None);
    let (_ir, diags) = ir::build(&program, &db, None);
    assert_eq!(codes(&diags), vec!["E6008"], "{diags:?}");
    assert!(
        diags[0].message.contains("scope=authority")
            && diags[0].message.contains("T.totals")
            && diags[0].message.contains("runtime authority boundary")
            && diags[0].message.contains("fail-closed §13 marker"),
        "names the scoped scenario and its pending runtime boundary: {diags:?}"
    );
}

/// DESIGN-522: a source-scoped report must have a description identifying
/// the information exposed. The undescribed report refuses at check time.
#[test]
fn undescribed_authority_report_refuses() {
    let src = AUTHORITY_SOURCE.replace(" # Confidential totals granted to members.\n", "");
    let diags = check(&src);
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("description"),
        "names the missing description: {diags:?}"
    );
}

/// `scope=authority` still needs `read=true` (existing refusal, unchanged).
#[test]
fn authority_scope_without_read_still_refuses() {
    let src = AUTHORITY_SOURCE.replace(" read=true scope=authority", " scope=authority");
    let diags = check(&src);
    assert!(
        diags
            .iter()
            .any(|d| d.code == "E3001" && d.message.contains("scope=authority needs read=true")),
        "{diags:?}"
    );
}

/// The IR marker carries the checked source fact: true for the
/// authority report, so the §13 record and the checker agree.
#[test]
fn ir_marks_authority_scope_with_checked_correspondence() {
    let mut db = SourceDb::new();
    let id = db.add(
        "scope-authority-probe.can".to_string(),
        AUTHORITY_SOURCE.to_string(),
    );
    let (program, diags) = check_program(&db, &[id], None);
    assert!(diags.is_empty(), "{diags:?}");
    // The checked analysis fact reads the actual `scope` attribute.
    let scenario = program
        .effects
        .scenarios
        .values()
        .next()
        .expect("one checked scenario");
    assert!(
        scenario.scope_authority,
        "analysis records the authored scope"
    );
    let (ir, _) = ir::build(&program, &db, None);
    let item = ir
        .items
        .iter()
        .find(|item| item.canonical == "T.totals")
        .expect("authority report lowers");
    let IrItemKind::Scenario {
        read,
        scope_authority,
        description,
        result,
        ..
    } = &item.kind
    else {
        panic!("authority report stays a scenario");
    };
    assert!(*read, "report keeps its read flag");
    assert!(*scope_authority, "IR carries the checked authority fact");
    assert!(
        description.is_some(),
        "the required description lowers with the grant boundary"
    );
    assert!(result.is_some(), "the granted typed result lowers");
}

/// Fail-closed publication: the §13 operations descriptor carries the
/// `scope:"authority"` marker beside the granted result, while the
/// emitted handler refuses instead of running a viewer-mode body, and
/// no MCP tool advertises the grant.
#[test]
fn js_publishes_marker_with_refusing_handler() {
    let mut db = SourceDb::new();
    let id = db.add(
        "scope-authority-probe.can".to_string(),
        AUTHORITY_SOURCE.to_string(),
    );
    let (program, diags) = check_program(&db, &[id], None);
    assert!(diags.is_empty(), "{diags:?}");
    let (ir, _) = ir::build(&program, &db, None);
    let js_out = js::emit_program(&ir);
    let js = &js_out.entry.js;
    assert!(
        js.contains("scope:\"authority\""),
        "§13 marker is published: {js}"
    );
    assert!(
        js.contains("result:{type:\"T.Total\"}") || js.contains("result:{type:\"T.Total\","),
        "granted typed result stays beside the marker: {js}"
    );
    assert!(
        js.contains(
            "async \"T.totals\"(c,{}){throw new Error(\"scope=authority report T.totals has no runtime authority boundary\");}"
        ),
        "viewer-mode invocation refuses loudly: {js}"
    );
    assert!(
        !js_out.operations.iter().any(|op| op.name == "T.totals"),
        "no MCP tool advertises the grant before its runtime boundary"
    );
}

/// Ordinary `read=true` is unaffected: no new diagnostics, no marker.
#[test]
fn ordinary_read_is_unaffected() {
    let diags = check(ORDINARY_SOURCE);
    assert!(diags.is_empty(), "{diags:?}");
    let mut db = SourceDb::new();
    let id = db.add(
        "ordinary-read-probe.can".to_string(),
        ORDINARY_SOURCE.to_string(),
    );
    let (program, _) = check_program(&db, &[id], None);
    let (ir, diags) = ir::build(&program, &db, None);
    assert!(diags.is_empty(), "{diags:?}");
    let item = ir
        .items
        .iter()
        .find(|item| item.canonical == "T.summarize")
        .expect("ordinary read scenario lowers");
    let IrItemKind::Scenario {
        read,
        scope_authority,
        ..
    } = &item.kind
    else {
        panic!("ordinary read stays a scenario");
    };
    assert!(*read, "ordinary read flag preserved");
    assert!(
        !scope_authority,
        "ordinary read carries no authority marker"
    );
    let js_out = js::emit_program(&ir);
    assert!(js_out.diagnostics.is_empty(), "{:?}", js_out.diagnostics);
    assert!(
        !js_out.entry.js.contains("scope:\"authority\""),
        "no authority marker leaks into ordinary output"
    );
    assert!(
        js_out.entry.js.contains("async \"T.summarize\"(c,{}"),
        "ordinary read keeps its executable handler: {}",
        js_out.entry.js
    );
}
