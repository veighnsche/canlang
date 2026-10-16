//! Outcome 9 family E: `read=true scope=authority` reports are explicit
//! information grants to `by` (DESIGN §522), with body reads in DECISION
//! mode at the resolved storage owner (DESIGN §442) and ordinary `read=true`
//! staying viewer-filtered.
//!
//! Probe premises (verified against base `3e9e1952` before implementation):
//! an authority-shaped, described report is CHECK-clean and lowers with
//! exactly one `E6008` (no §13 emission yet). The fail-closed slice adds:
//! (a) checker enforcement of the DESIGN-522 description requirement
//! (`E3001` when a `scope=authority` report is undescribed); (b) an IR
//! marker on the scenario carrying the checked source fact; (c) a JS
//! `scope:"authority"` marker published fail-closed (descriptor marker
//! plus a throwing handler stub, `E6008` intact, no MCP tool advertisement)
//! until the decision-mode runtime boundary lands.
//!
//! Lane-A emission half: the stub and the MCP omission are removed
//! together once the State decision-mode boundary lands (body reads run
//! in decision mode at the host, helpers keep decision mode only when
//! consumed by the decision per DESIGN §442). The §13 marker, the
//! description/result correspondence and `E6008` stay until the host seam
//! adopts the runtime boundary (parallel Lane-C slice).

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
/// host seam adopts the runtime boundary; the diagnostic names that gap.
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
            && diags[0].message.contains("decision-mode body")
            && diags[0].message.contains("grant advertisement"),
        "names the scoped scenario and its pending host-seam boundary: {diags:?}"
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

/// Lane-A emission: the §13 operations descriptor keeps the
/// `scope:"authority"` marker beside the granted result, the handler
/// lowers the real decision-mode body (no throwing stub), and MCP
/// advertises the grant with its DESIGN-522 description. `E6008` stays
/// until the host seam adopts the runtime boundary.
#[test]
fn js_emits_decision_body_and_advertises_grant() {
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
        !js.contains("has no runtime authority boundary"),
        "throwing stub is removed: {js}"
    );
    assert!(
        js.contains("async \"T.totals\"(c,{}){"),
        "decision-mode body is lowered: {js}"
    );
    let op = js_out
        .operations
        .iter()
        .find(|op| op.name == "T.totals")
        .expect("MCP advertises the grant");
    assert!(
        matches!(op.kind, js::JsOperationKind::Read),
        "grant advertises as a read: {:?}",
        op.kind
    );
    assert_eq!(
        op.description, "Confidential totals granted to members.",
        "grant carries its identifying description"
    );
    assert!(
        op.result.as_deref().is_some_and(|result| result.contains("T.Total")),
        "grant carries its typed result: {:?}",
        op.result
    );
}

/// An authority report is never emitted as an ordinary viewer handler:
/// its §13 descriptor always carries the marker, so every host path can
/// tell the grant boundary apart from viewer-filtered reads.
#[test]
fn authority_descriptor_always_marks_scope() {
    let mut db = SourceDb::new();
    let id = db.add(
        "scope-authority-probe.can".to_string(),
        AUTHORITY_SOURCE.to_string(),
    );
    let (program, diags) = check_program(&db, &[id], None);
    assert!(diags.is_empty(), "{diags:?}");
    let (ir, _) = ir::build(&program, &db, None);
    let js_out = js::emit_program(&ir);
    assert_eq!(
        js_out.entry.js.matches("scope:\"authority\"").count(),
        1,
        "exactly the authority report is marked"
    );
}

/// A pure helper consumed by both an authority body and a viewer body:
/// the authority call resolves to an actually emitted variant (never a
/// dangling decision reference), and the viewer call is identical, so
/// decision mode is retained only where it is consumed.
#[test]
fn authority_body_helper_call_resolves_to_existing_variant() {
    let mut db = SourceDb::new();
    let id = db.add(
        "scope-authority-helper-probe.can".to_string(),
        HELPER_SOURCE.to_string(),
    );
    let (program, diags) = check_program(&db, &[id], None);
    assert!(diags.is_empty(), "{diags:?}");
    let (ir, _) = ir::build(&program, &db, None);
    let js_out = js::emit_program(&ir);
    let js = &js_out.entry.js;
    // Hex-encoded helper identity shared by every call site.
    let helper_hex: String = "T.bump".bytes().map(|byte| format!("{byte:02x}")).collect();
    let viewer_call = format!("$can$s${helper_hex}");
    let decision_call = format!("$can$b${helper_hex}");
    let authority_handler = handler_body(js, "T.totals").expect("authority handler lowers");
    let viewer_handler = handler_body(js, "T.summarize").expect("viewer handler lowers");
    assert!(
        authority_handler.contains(&viewer_call),
        "authority body calls the emitted helper variant: {authority_handler}"
    );
    assert!(
        !authority_handler.contains(&decision_call),
        "no dangling decision-only reference without a dual-emitted helper: {authority_handler}"
    );
    assert!(
        viewer_handler.contains(&viewer_call),
        "viewer body keeps its exact call: {viewer_handler}"
    );
}

/// Authority-shaped report plus an ordinary read sharing one pure
/// helper: both bodies stay CHECK-clean without builtins.
const HELPER_SOURCE: &str = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\n derive bump(x:int):int = x + 1\nWhen\n # Confidential totals granted to members.\n scenario totals() read=true scope=authority -> Total by=members\n  do\n   return Total {count=bump(1)}\n scenario summarize() read=true -> Total by=members\n  do\n   return Total {count=bump(1)}\nThen\n";

/// The emitted handler body between its opening `{` and the closing
/// `},` of the `async "canonical"(...)` entry.
fn handler_body<'a>(js: &'a str, canonical: &str) -> Option<&'a str> {
    let open = format!("async \"{canonical}\"(");
    let start = js.find(&open)?;
    // Handler signatures never contain `)`: the first `"){` after the
    // open closes the `(c,{...})` signature and opens the body.
    let body_start = js[start..].find("){")? + start + 1;
    let tail = &js[body_start..];
    let mut depth = 0usize;
    for (index, ch) in tail.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&tail[..=index]);
                }
            }
            _ => {}
        }
    }
    None
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
