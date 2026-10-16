//! Outcome 9 family E: `read=true scope=authority` reports are explicit
//! information grants to `by` (DESIGN §522), with body reads in DECISION
//! mode at the resolved storage owner (DESIGN §442) and ordinary `read=true`
//! staying viewer-filtered.
//!
//! Probe premises (verified against base `3e9e1952` before implementation):
//! an authority-shaped, described report is CHECK-clean and lowers with
//! zero `E6008` after the host-seam runtime boundary landed (State
//! decision mode + host read seam + helper-consumer proof). The
//! fail-closed slice adds: (a) checker enforcement of the DESIGN-522
//! description requirement (`E3001` when a `scope=authority` report is
//! undescribed); (b) an IR marker on the scenario carrying the checked
//! source fact; (c) a JS `scope:"authority"` marker with the lowered
//! decision-mode body and MCP grant advertisement.
//!
//! Lane-A emission half: the stub and the MCP omission were removed
//! together once the State decision-mode boundary landed (body reads run
//! in decision mode at the host, helpers keep decision mode only when
//! consumed by the decision per DESIGN §442). The §13 marker, the
//! description/result correspondence, the decision-mode body and the MCP
//! advertisement stay; the authority-report `E6008` is removed now that
//! the host seam adopted the runtime boundary (parallel Lane-C slice
//! landed and proven).

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir::{self, IrItemKind};
use canlang_compiler::codegen::js;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

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

/// The authority report lowers with zero `E6008` now that the host seam
/// adopted the runtime boundary; the report lowers and advertises.
#[test]
fn authority_scope_lowers_without_e6008_after_host_seam() {
    let diags = check(AUTHORITY_SOURCE);
    assert!(diags.is_empty(), "{diags:?}");
    let mut db = SourceDb::new();
    let id = db.add(
        "scope-authority-probe.can".to_string(),
        AUTHORITY_SOURCE.to_string(),
    );
    let (program, _) = check_program(&db, &[id], None);
    let (ir, diags) = ir::build(&program, &db, None);
    assert!(diags.is_empty(), "authority report lowers: {diags:?}");
    let item = ir
        .items
        .iter()
        .find(|item| item.canonical == "T.totals")
        .expect("authority report lowers");
    let IrItemKind::Scenario {
        scope_authority, ..
    } = &item.kind
    else {
        panic!("authority report stays a scenario");
    };
    assert!(*scope_authority, "IR keeps the checked authority fact");
    let js_out = js::emit_program(&ir);
    assert!(js_out.diagnostics.is_empty(), "{:?}", js_out.diagnostics);
    assert!(
        js_out.entry.js.contains("scope:\"authority\""),
        "§13 marker is published: {}",
        js_out.entry.js
    );
    assert!(
        js_out
            .operations
            .iter()
            .any(|op| op.name == "T.totals"),
        "grant is advertised: {:?}",
        js_out.operations.iter().map(|op| &op.name).collect::<Vec<_>>()
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
/// advertises the grant with its DESIGN-522 description. No
/// authority-report `E6008` remains after the host seam landed.
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
    let body = handler_body(js, "T.totals").expect("authority handler lowers");
    assert!(
        body.contains("return") && body.contains("count"),
        "lowered body computes the granted result: {body}"
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

/// REVIEW-9 gap 3: a data-only filter in an authority body lowers to the
/// `QueryPredicate` AST decision mode serves — never a callback.
const FILTERED_AUTHORITY_SOURCE: &str = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\nWhen\n # Confidential totals granted to members.\n scenario totals() read=true scope=authority -> Total by=members\n  do\n   return Total {count=count(Expense as e where e.amount > 0)}\nThen\n";

/// Same filter in an ordinary viewer body: keeps the callback emission.
const FILTERED_ORDINARY_SOURCE: &str = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\nWhen\n scenario summarize() read=true -> Total by=members\n  do\n   return Total {count=count(Expense as e where e.amount > 0)}\nThen\n";

/// Workspace root for the built native catalog (same dependency the other
/// compiler suites use for std builtins such as `count`).
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_catalog() -> PathBuf {
    root().join("packages/cloudflare/dist/native-catalog.json")
}

fn load(db: &SourceDb, path: &Path) -> Catalog {
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(path),
        env: None,
        cwd: &root(),
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

/// Emit one source to its entry JS (native catalog: queries use std
/// builtins such as `count`).
fn emit(src: &str, path: &str) -> String {
    let mut db = SourceDb::new();
    let id = db.add(path.to_string(), src.to_string());
    let catalog = load(&db, &native_catalog());
    let (program, diags) = check_program(&db, &[id], Some(&catalog));
    assert!(diags.is_empty(), "{diags:?}");
    let (ir, _) = ir::build(&program, &db, Some(&catalog));
    js::emit_program(&ir).entry.js
}

/// A filtered authority query emits the data-only AST decision mode
/// accepts — no callback for the host to refuse.
#[test]
fn authority_filtered_query_emits_data_only_ast() {
    let js = emit(FILTERED_AUTHORITY_SOURCE, "scope-authority-filtered.can");
    let body = handler_body(&js, "T.totals").expect("authority handler lowers");
    assert!(
        body.contains("where:{op:\"gt\",field:\"amount\",value:\"0\"}"),
        "data-only AST selection on the canonical int wire: {body}"
    );
    assert!(
        !body.contains("=>"),
        "no callback predicate remains: {body}"
    );
}

/// Text equality and conjunctions compose in the AST.
#[test]
fn authority_text_and_composed_filters_emit_ast() {
    let src = "app T\nGiven\n Gadget { title:text, stock:int=0 }\n policy Gadget read=members\n contract Total { count:int }\nWhen\n # Confidential totals granted to members.\n scenario totals() read=true scope=authority -> Total by=members\n  do\n   return Total {count=count(Gadget as g where g.title == \"x\" and g.stock < 10)}\nThen\n";
    let js = emit(src, "scope-authority-text.can");
    let body = handler_body(&js, "T.totals").expect("authority handler lowers");
    assert!(
        body.contains("where:{op:\"and\",args:[{op:\"eq\",field:\"title\",value:\"x\"},{op:\"lt\",field:\"stock\",value:\"10\"}]}"),
        "composed data-only AST: {body}"
    );
    assert!(
        !body.contains("=>"),
        "no callback predicate remains: {body}"
    );
}

/// The unfiltered count keeps its servable selection shape.
#[test]
fn authority_unfiltered_count_stays_servable() {
    let src = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\nWhen\n # Confidential totals granted to members.\n scenario totals() read=true scope=authority -> Total by=members\n  do\n   return Total {count=count(Expense)}\nThen\n";
    let js = emit(src, "scope-authority-unfiltered.can");
    let body = handler_body(&js, "T.totals").expect("authority handler lowers");
    assert!(
        body.contains("records(c,\"T.Expense\",{})"),
        "servable empty selection: {body}"
    );
    assert!(!body.contains("where"), "no selection at all: {body}");
}

/// A non-data-only filter (helper-valued) keeps the callback emission:
/// decision mode still refuses it fail-closed, never silently served.
#[test]
fn authority_helper_valued_filter_keeps_callback() {
    let src = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\n derive bump(x:int):int = x + 1\nWhen\n # Confidential totals granted to members.\n scenario totals() read=true scope=authority -> Total by=members\n  do\n   return Total {count=count(Expense as e where e.amount > bump(1))}\nThen\n";
    let js = emit(src, "scope-authority-fallback.can");
    let body = handler_body(&js, "T.totals").expect("authority handler lowers");
    assert!(
        body.contains("where:") && body.contains("=>"),
        "callback preserved for refusal: {body}"
    );
    assert!(!body.contains("where:{op:"), "no AST claimed: {body}");
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

/// The same filter in an ordinary viewer body keeps the exact callback
/// emission it always had: byte-identical, no AST.
#[test]
fn ordinary_filtered_query_keeps_callback_byte_identical() {
    let js = emit(FILTERED_ORDINARY_SOURCE, "ordinary-filtered.can");
    let body = handler_body(&js, "T.summarize").expect("viewer handler lowers");
    assert!(
        body.contains("records(c,\"T.Expense\",{where:(")
            && body.contains("=>")
            && body.contains(".amount > 0"),
        "callback emission preserved: {body}"
    );
    assert!(
        !body.contains("where:{op:"),
        "no AST in viewer output: {body}"
    );
    assert!(!js.contains("scope:\"authority\""), "no marker leaks: {js}");
}

/// Extract the `"canonical":{...}` operation descriptor object from the
/// emitted `operations:{...}` map.
fn operation_descriptor<'a>(js: &'a str, canonical: &str) -> Option<&'a str> {
    let open = format!("\"{canonical}\":{{");
    let start = js.find(&open)? + open.len() - 1;
    let tail = &js[start..];
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

/// REVIEW-9 gap 2: the authority descriptor carries its defining-source
/// origin as a checked fact — the declaring file's path and bytes hash
/// plus the owning module — for the host to verify against
/// `artifact.sources`.
#[test]
fn authority_descriptor_carries_defining_source_origin() {
    let js = emit(AUTHORITY_SOURCE, "scope-authority-probe.can");
    let descriptor = operation_descriptor(&js, "T.totals").expect("descriptor lowers");
    assert!(
        descriptor.contains("scope:\"authority\""),
        "marker stays: {descriptor}"
    );
    // The origin object carries path, bytes hash and owning module (key
    // order follows the envelope's sorted JSON map).
    assert!(
        descriptor.contains(
            "source:{\"module\":\"T\",\"path\":\"scope-authority-probe.can\",\"sha256\":\""
        ),
        "origin shape: {descriptor}"
    );
    let marker = "\"sha256\":\"";
    let at = descriptor.find(marker).expect("origin lowers") + marker.len();
    let sha256: String = descriptor[at..].chars().take(64).collect();
    assert!(
        sha256.len() == 64 && sha256.chars().all(|ch| ch.is_ascii_hexdigit()),
        "origin carries the bytes hash: {descriptor}"
    );
}

/// The origin names the declaring file, never the first source: helpers
/// are added first so a first-source guess would name the wrong file.
#[test]
fn authority_defining_source_names_declaring_file_not_first_source() {
    let helpers =
        "package helpers\n Given\n  export derive bump(x:int):int = x + 1\n When\n Then\n";
    let shop = "app Shop\nuse helpers {bump as importedBump}\nGiven\n Gadget { title:text, stock:int=0 }\n policy Gadget read=members fields=title\n contract Total { total:int }\n derive bump(x:int):int = x + 1\nWhen\n # Confidential totals granted to members.\n scenario totals() read=true scope=authority -> Total by=members\n  do\n   return Total {total=bump(count(Gadget))+importedBump(count(Gadget))}\nThen\n";
    let mut db = SourceDb::new();
    let helpers_id = db.add(
        "authority-report-helpers.can".to_string(),
        helpers.to_string(),
    );
    let shop_id = db.add("authority-report-shop.can".to_string(), shop.to_string());
    let catalog = load(&db, &native_catalog());
    let (program, diags) = check_program(&db, &[shop_id, helpers_id], Some(&catalog));
    assert!(diags.is_empty(), "{diags:?}");
    let (ir, _) = ir::build(&program, &db, Some(&catalog));
    let js = js::emit_program(&ir).entry.js;
    let descriptor = operation_descriptor(&js, "Shop.totals").expect("descriptor lowers");
    assert!(
        descriptor.contains("source:{\"module\":\"Shop\",\"path\":\"authority-report-shop.can\""),
        "origin names the declaring file: {descriptor}"
    );
    assert!(
        !descriptor.contains("authority-report-helpers.can"),
        "imported helper file is not the origin: {descriptor}"
    );
}

/// REVIEW-10 typed-int filter fix: the real `.can` fixture (local plus
/// imported equivalent helper) compiles through the actual pipeline; every
/// Int filter emits the canonical Values int wire (decimal strings, never
/// JSON numbers), so the host can compare stored-int strings numerically.
const INT_FILTER_SHOP: &str = include_str!("fixtures/scope-authority-int-filter.can");
const INT_FILTER_HELPERS: &str = include_str!("fixtures/scope-authority-int-filter-helpers.can");

/// Compile the two-file int-filter fixture exactly as checked sources
/// (helpers first, so a first-source guess would name the wrong file).
fn emit_int_filter_fixture() -> String {
    let mut db = SourceDb::new();
    let helpers_id = db.add(
        "scope-authority-int-filter-helpers.can".to_string(),
        INT_FILTER_HELPERS.to_string(),
    );
    let shop_id = db.add(
        "scope-authority-int-filter.can".to_string(),
        INT_FILTER_SHOP.to_string(),
    );
    let catalog = load(&db, &native_catalog());
    let (program, diags) = check_program(&db, &[shop_id, helpers_id], Some(&catalog));
    assert!(diags.is_empty(), "{diags:?}");
    let (ir, _) = ir::build(&program, &db, Some(&catalog));
    js::emit_program(&ir).entry.js
}

/// Equality, ordering (the 2-vs-10 discriminator), a negative bound, and
/// a beyond-safe-integer literal all emit int-wire strings; no callback
/// remains for decision mode to refuse.
#[test]
fn authority_int_filters_emit_canonical_string_wire() {
    let js = emit_int_filter_fixture();
    let body = handler_body(&js, "Shop.stockReport").expect("authority handler lowers");
    assert!(
        body.contains("where:{op:\"eq\",field:\"stock\",value:\"10\"}"),
        "equality on the int wire: {body}"
    );
    assert!(
        body.contains("where:{op:\"gt\",field:\"stock\",value:\"2\"}"),
        "ordering on the int wire: {body}"
    );
    assert!(
        body.contains("where:{op:\"lt\",field:\"stock\",value:\"0\"}"),
        "negative bound on the int wire: {body}"
    );
    assert!(
        body.contains("where:{op:\"eq\",field:\"stock\",value:\"9007199254740993\"}"),
        "beyond-safe-integer exact, never a JSON number: {body}"
    );
    assert!(
        !body.contains("=>"),
        "no callback predicate remains: {body}"
    );
}

/// The fixture origin still names the declaring file, never the imported
/// helper file.
#[test]
fn int_filter_fixture_origin_names_declaring_file() {
    let js = emit_int_filter_fixture();
    let descriptor = operation_descriptor(&js, "Shop.stockReport").expect("descriptor lowers");
    assert!(
        descriptor
            .contains("source:{\"module\":\"Shop\",\"path\":\"scope-authority-int-filter.can\""),
        "origin names the declaring file: {descriptor}"
    );
    assert!(
        !descriptor.contains("scope-authority-int-filter-helpers.can"),
        "imported helper file is not the origin: {descriptor}"
    );
}

/// Ordinary descriptors carry no origin: viewer emission is untouched.
#[test]
fn ordinary_descriptor_carries_no_source_origin() {
    let js = emit(ORDINARY_SOURCE, "ordinary-read-probe.can");
    let descriptor = operation_descriptor(&js, "T.summarize").expect("descriptor lowers");
    assert!(
        !descriptor.contains("source:{"),
        "no origin on ordinary output: {descriptor}"
    );
}
