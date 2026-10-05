//! MCP P4 golden: scenario `expose=` publication control + `@{desc="..."}`
//! input descriptions.
//!
//! TEST-ONLY: hermetic golden catalog + `EmitOptions::test_only`, following
//! `mcp_p1.rs`. Covers the P4 contract:
//!
//! * `expose=` on user scenarios accepts sole `none` (excluded from
//!   publication) or omission (exposed, current behavior). Unknown
//!   selectors fail checking (`E3009`, closed set; the checker documents
//!   the extension point for future surfaces like `http`/`mcp`).
//! * `expose=` is rejected on trusted handlers (`E1200`, parser vocabulary).
//! * `@{desc="..."}` annotates scenario params and model fields. Literal
//!   text only: non-string values, unknown keys and empty annotations fail
//!   parsing (`E1214`, mirroring the `@{...}` message-suffix shape rules).
//! * P1 emission skips `expose=none` ops from `operations[]` (artifact
//!   envelope and `canApp()` registry alike — one `collect_operations`).
//! * Authored desc text threads verbatim into
//!   `operations[].inputs.fields[].description`; undescribed inputs carry
//!   no `description` key (additive: P1 goldens are byte-identical).

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::artifact::{self, CompileArtifact};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult, Severity};
use canlang_compiler::json::Json;
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::syntax::{SyntaxKind, SyntaxNode, parse_source};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

fn parse_text(text: &str) -> (SyntaxNode, Vec<Diagnostic>) {
    parse_source(SourceId(0), text)
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

/// Assert a clean parse with full byte coverage; return the tree.
fn assert_clean(text: &str) -> SyntaxNode {
    let (tree, diags) = parse_text(text);
    assert!(
        diags.is_empty(),
        "expected clean parse, got {diags:?}\n{text}"
    );
    assert!(tree.verify_coverage(text.len() as u32).is_ok());
    tree
}

/// Assert the exact diagnostic code sequence (already sorted by offset).
fn assert_codes(text: &str, expected: &[&str]) -> (SyntaxNode, Vec<Diagnostic>) {
    let (tree, diags) = parse_text(text);
    assert_eq!(codes(&diags), expected, "codes for {text:?}\n{diags:?}");
    assert!(tree.verify_coverage(text.len() as u32).is_ok());
    (tree, diags)
}

fn check_text(text: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("mcp-p4.can".to_string(), text.to_string());
    let (_program, diags) = check_program(&db, &[id], None);
    diags
}

fn assert_check_clean(text: &str) {
    let diags = check_text(text);
    let blocking: Vec<&Diagnostic> = diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(
        blocking.is_empty(),
        "expected clean check, got {diags:?}\n{text}"
    );
}

fn assert_check_codes(text: &str, expected: &[&str]) -> Vec<Diagnostic> {
    let diags = check_text(text);
    assert_eq!(codes(&diags), expected, "codes for {text:?}\n{diags:?}");
    diags
}

/// Hermetic golden catalog (mirrors `mcp_p1.rs`): availability is pinned
/// so `E6007` cannot fire. The path carries a per-call sequence so
/// parallel emission tests in one process never share a file.
fn golden_catalog() -> (Catalog, std::path::PathBuf) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let path =
        std::env::temp_dir().join(format!("mcp-p4-catalog-{}-{seq}.json", std::process::id()));
    std::fs::write(
        &path,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[
{"id":"count","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"first","kind":"builtin","signature":"first(domain:C<T>)->T?","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"sum","kind":"builtin","signature":"sum(domain:C<T>,currency:currency)->money","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"money","kind":"builtin","signature":"money(minor:int,currency:currency)->money","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"trim","kind":"builtin","signature":"trim(value:text)->text","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"format","kind":"builtin","signature":"format(descriptor:message)->text","effects":"pure","availability":"implemented","owner":"lane-02"}
]}"#,
    )
    .expect("write golden catalog");
    let primary = Span::new(SourceId(0), 0, 0);
    let cwd = std::env::temp_dir();
    let request = CatalogRequest {
        flag: Some(path.as_path()),
        env: None,
        cwd: cwd.as_path(),
        primary,
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "golden catalog loads: {diags:?}");
    (catalog.expect("catalog"), path)
}

fn compile_source(src: &str) -> (CompileArtifact, Vec<Diagnostic>, std::path::PathBuf) {
    let mut db = SourceDb::new();
    let id = db.add("mcp-p4.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (program, analysis_diags): (CheckedProgram, Vec<Diagnostic>) =
        check_program(&db, &[id], Some(&catalog));
    let blocking: Vec<&Diagnostic> = analysis_diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(blocking.is_empty(), "source analyzes cleanly: {blocking:?}");
    let mut result = DiagnosticResult::new("mcp-p4", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.diagnostics = analysis_diags;
    result.complete = false;
    result.finish();
    let sources = EmitSources {
        db: &db,
        result: &result,
        catalog: Some(&catalog),
        options: EmitOptions::test_only(),
    };
    let (artifact, emit_diags) = emit(&program, &sources);
    (artifact, emit_diags, path)
}

fn op_by_name<'a>(ops: &'a [Json], name: &str) -> &'a Json {
    ops.iter()
        .find(|op| op.get("name").and_then(Json::as_str) == Some(name))
        .unwrap_or_else(|| panic!("operations[] lacks {name}: {ops:?}"))
}

fn field_by_name<'a>(op: &'a Json, name: &str) -> &'a Json {
    let fields = op
        .get("inputs")
        .and_then(|i| i.get("fields"))
        .and_then(Json::as_arr)
        .unwrap_or_else(|| panic!("{op:?} lacks inputs.fields"));
    fields
        .iter()
        .find(|f| f.get("name").and_then(Json::as_str) == Some(name))
        .unwrap_or_else(|| panic!("inputs.fields lacks {name}: {fields:?}"))
}

fn operations_of(artifact: &CompileArtifact) -> Vec<Json> {
    let json = artifact::to_json(artifact);
    let parsed = canlang_compiler::json::parse(&json).expect("artifact JSON parses");
    parsed
        .get("operations")
        .and_then(Json::as_arr)
        .expect("operations is an array")
        .to_vec()
}

/// Slice the `operations:[...]` P1 member out of the entry module
/// (bracket matching with string awareness; the handler-map
/// `operations:{...}` registry is a different member and keeps
/// excluded ops as internal handlers).
fn canapp_operations(entry: &str) -> &str {
    let start = entry.find("operations:[").expect("canApp P1 member");
    let bytes = entry.as_bytes();
    let mut i = start + "operations:".len();
    assert_eq!(bytes[i], b'[');
    let mut depth = 0u32;
    let mut in_string = false;
    let mut escaped = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else if b == b'"' {
            in_string = true;
        } else if b == b'[' {
            depth += 1;
        } else if b == b']' {
            depth -= 1;
            if depth == 0 {
                return &entry[start..=i];
            }
        }
        i += 1;
    }
    panic!("unterminated operations member");
}

const SHOP_GIVEN: &str = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\n";
const SHOP_THEN: &str = "Then\n page / title=\"Shop\"\n  breadcrumbs\n";

fn scenario_src(header: &str) -> String {
    format!(
        "{SHOP_GIVEN}When\n scenario approve(gadget:Gadget) {header}\n  do set gadget {{title=\"x\"}}\n{SHOP_THEN}"
    )
}

// Parser: expose= ---------------------------------------------------------

#[test]
fn expose_none_parses_on_user_scenario() {
    let src = scenario_src("by=members expose=none");
    let tree = assert_clean(&src);
    let scenario = tree
        .descendants()
        .find(|n| n.kind == SyntaxKind::Scenario)
        .expect("scenario node");
    let expose = scenario
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Attribute)
        .find(|attr| {
            attr.children.iter().any(|c| {
                c.kind == SyntaxKind::Name && c.token().is_some_and(|t| t.text(&src) == "expose")
            })
        });
    assert!(expose.is_some(), "expose= attribute survives parsing");
    let value = expose
        .and_then(|attr| {
            attr.children
                .iter()
                .find(|c| c.kind == SyntaxKind::Selectors)
        })
        .expect("expose= selectors value");
    assert!(
        value.descendants().any(
            |n| n.kind == SyntaxKind::Name && n.token().is_some_and(|t| t.text(&src) == "none")
        ),
        "sole none selector survives parsing"
    );
}

#[test]
fn expose_bogus_parses_and_fails_checking() {
    // Selectors accept any word at parse level (mirroring CRUD
    // `expose=`); the closed set is a checking rule.
    assert_clean(&scenario_src("by=members expose=bogus"));
}

#[test]
fn expose_rejected_on_trusted_handler() {
    let src = format!(
        "{SHOP_GIVEN}When\n scenario audit on=teams.member_removed expose=none\n  do\n   let x = 1\n{SHOP_THEN}"
    );
    let (_tree, diags) = assert_codes(&src, &["E1200"]);
    assert!(
        diags[0].message.contains("expose"),
        "names the attribute: {}",
        diags[0].message
    );
}

// Parser: @{desc} ----------------------------------------------------------

const DESC_PARAM: &str = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\n scenario approve(gadget:Gadget @{desc=\"The gadget to approve.\"},note:text? @{desc=\"Optional note.\"}) by=members\n  do set gadget {title=\"x\"}\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";

const DESC_FIELD: &str = "app Shop\nGiven\n Gadget { title:text @{desc=\"Display title.\"}, stock:int=0 @{desc=\"Units on hand.\"} }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,stock\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";

#[test]
fn desc_parses_on_param_and_field() {
    for src in [DESC_PARAM, DESC_FIELD] {
        let tree = assert_clean(src);
        let count = tree
            .descendants()
            .filter(|n| n.kind == SyntaxKind::Annotation)
            .count();
        assert_eq!(count, 2, "both annotations survive parsing");
    }
}

#[test]
fn desc_parses_after_label() {
    let src = "app Shop\nGiven\n Gadget { title:text label=\"Title\" @{desc=\"Display title.\"} }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    assert_clean(src);
    let src = scenario_src("by=members").replace(
        "scenario approve(gadget:Gadget)",
        "scenario approve(gadget:Gadget label=\"Gadget\" @{desc=\"The gadget.\"})",
    );
    assert_clean(&src);
}

#[test]
fn desc_non_literal_rejected() {
    let src = "app Shop\nGiven\n Gadget { title:text @{desc=42} }\n policy Gadget read=members\nWhen\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (_tree, diags) = assert_codes(src, &["E1214"]);
    assert!(
        diags[0].message.contains("desc"),
        "names the key: {}",
        diags[0].message
    );
}

#[test]
fn desc_unknown_key_rejected() {
    let src = "app Shop\nGiven\n Gadget { title:text @{nl=\"Titel\"} }\n policy Gadget read=members\nWhen\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (_tree, diags) = assert_codes(src, &["E1214"]);
    assert!(
        diags[0].message.contains("nl"),
        "names the key: {}",
        diags[0].message
    );
}

#[test]
fn desc_empty_rejected() {
    let src = "app Shop\nGiven\n Gadget { title:text @{} }\n policy Gadget read=members\nWhen\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    assert_codes(src, &["E1214"]);
}

#[test]
fn desc_marker_must_be_contiguous() {
    let src = "app Shop\nGiven\n Gadget { title:text @ {desc=\"x\"} }\n policy Gadget read=members\nWhen\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    assert_codes(src, &["E1214"]);
}

// Checker: expose= ----------------------------------------------------------

#[test]
fn expose_none_checks_clean() {
    assert_check_clean(&scenario_src("by=members expose=none"));
}

#[test]
fn expose_bogus_rejected() {
    let diags = assert_check_codes(&scenario_src("by=members expose=bogus"), &["E3009"]);
    assert!(
        diags[0].message.contains("unknown exposed surface 'bogus'"),
        "precise diagnostic: {}",
        diags[0].message
    );
}

#[test]
fn expose_none_duplicate_rejected() {
    let diags = assert_check_codes(&scenario_src("by=members expose=none,none"), &["E3009"]);
    assert!(
        diags[0].message.contains("duplicate"),
        "precise diagnostic: {}",
        diags[0].message
    );
}

#[test]
fn desc_checks_clean_on_param_and_field() {
    assert_check_clean(DESC_PARAM);
    assert_check_clean(DESC_FIELD);
}

// Emission -------------------------------------------------------------------

#[test]
fn expose_none_skipped_from_operations() {
    let src = format!(
        "{SHOP_GIVEN}When\n scenario approve(gadget:Gadget) by=members\n  do set gadget {{title=\"x\"}}\n scenario internal(gadget:Gadget) by=members expose=none\n  do set gadget {{title=\"y\"}}\n{SHOP_THEN}"
    );
    let (artifact, diags, catalog_path) = compile_source(&src);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "fixture emits clean: {diags:?}");
    let ops = operations_of(&artifact);
    let names: Vec<&str> = ops
        .iter()
        .filter_map(|op| op.get("name").and_then(Json::as_str))
        .collect();
    assert_eq!(
        names,
        ["Shop.Gadget.read", "Shop.approve"],
        "expose=none op is absent (policy read op stays)"
    );
    let p1 = canapp_operations(&artifact.modules[0].js);
    assert!(
        !p1.contains("Shop.internal"),
        "canApp() P1 member skips the excluded op"
    );
    assert!(
        p1.contains("Shop.approve"),
        "canApp() P1 member keeps the exposed op"
    );
}

#[test]
fn desc_verbatim_in_field_descriptors() {
    let src = "app Shop\nGiven\n Gadget { title:text @{desc=\"Display title.\"}, stock:int=0 }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,stock\n scenario approve(gadget:Gadget @{desc=\"The gadget to approve.\"},note:text?) by=members\n  do set gadget {title=\"x\"}\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (artifact, diags, catalog_path) = compile_source(src);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "fixture emits clean: {diags:?}");
    let ops = operations_of(&artifact);

    let approve = op_by_name(&ops, "Shop.approve");
    let gadget = field_by_name(approve, "gadget");
    assert_eq!(
        gadget.get("description").and_then(Json::as_str),
        Some("The gadget to approve."),
        "param desc is verbatim"
    );
    let note = field_by_name(approve, "note");
    assert_eq!(
        note.get("description"),
        None,
        "undescribed params carry no description key"
    );

    let create = op_by_name(&ops, "Shop.Gadget.create");
    let title = field_by_name(create, "title");
    assert_eq!(
        title.get("description").and_then(Json::as_str),
        Some("Display title."),
        "model-field desc flattens verbatim into CRUD inputs"
    );
    let stock = field_by_name(create, "stock");
    assert_eq!(
        stock.get("description"),
        None,
        "undescribed fields carry no description key"
    );

    // The canApp() registry carries the same descriptors verbatim.
    let entry = &artifact.modules[0].js;
    for verbatim in ["The gadget to approve.", "Display title."] {
        assert!(
            entry.contains(verbatim),
            "canApp() carries the verbatim field description {verbatim:?}"
        );
    }
}

// Follow-up: CRUD caption inheritance, policy read ops, CRUD expose ------

#[test]
fn crud_op_inherits_label_caption_for_description() {
    let src = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title label={create=\"Add\"}\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (artifact, diags, catalog_path) = compile_source(src);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "fixture emits clean: {diags:?}");
    let ops = operations_of(&artifact);
    let create = op_by_name(&ops, "Shop.Gadget.create");
    assert_eq!(
        create.get("description").and_then(Json::as_str),
        Some("Add"),
        "create inherits its label= caption"
    );
    let update = op_by_name(&ops, "Shop.Gadget.update");
    assert_eq!(
        update.get("description").and_then(Json::as_str),
        Some(""),
        "uncaptioned ops keep an empty description"
    );
}

#[test]
fn policy_emits_no_input_read_op() {
    let src = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\n Vault { code:text }\nWhen\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (artifact, diags, catalog_path) = compile_source(src);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "fixture emits clean: {diags:?}");
    let ops = operations_of(&artifact);
    let names: Vec<&str> = ops
        .iter()
        .filter_map(|op| op.get("name").and_then(Json::as_str))
        .collect();
    assert_eq!(
        names,
        ["Shop.Gadget.read"],
        "one read op per policy-bearing model, none without a policy"
    );
    let read = op_by_name(&ops, "Shop.Gadget.read");
    assert_eq!(read.get("kind").and_then(Json::as_str), Some("read"));
    assert_eq!(
        read.get("description").and_then(Json::as_str),
        Some(""),
        "policies carry no caption source"
    );
    assert_eq!(
        read.get("inputs")
            .and_then(|i| i.get("fields"))
            .and_then(Json::as_arr)
            .map(|f| f.len()),
        Some(0),
        "policy read ops take no inputs"
    );
}

#[test]
fn crud_expose_allowlist_skips_unlisted_ops() {
    let src = format!(
        "{SHOP_GIVEN}When\n crud Gadget by=members fields=title expose=create\n{SHOP_THEN}"
    );
    let (artifact, diags, catalog_path) = compile_source(&src);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "fixture emits clean: {diags:?}");
    let ops = operations_of(&artifact);
    let names: Vec<&str> = ops
        .iter()
        .filter_map(|op| op.get("name").and_then(Json::as_str))
        .collect();
    assert!(
        names.contains(&"Shop.Gadget.create"),
        "listed op is published: {names:?}"
    );
    assert!(
        !names.contains(&"Shop.Gadget.update") && !names.contains(&"Shop.Gadget.delete"),
        "unlisted ops are skipped: {names:?}"
    );
    // `expose=none` publishes no generated operations at all.
    let src =
        format!("{SHOP_GIVEN}When\n crud Gadget by=members fields=title expose=none\n{SHOP_THEN}");
    let (artifact, diags, catalog_path) = compile_source(&src);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "fixture emits clean: {diags:?}");
    let ops = operations_of(&artifact);
    let names: Vec<&str> = ops
        .iter()
        .filter_map(|op| op.get("name").and_then(Json::as_str))
        .collect();
    assert!(
        !names
            .iter()
            .any(|n| n.ends_with(".create") || n.ends_with(".update") || n.ends_with(".delete")),
        "expose=none publishes no CRUD ops: {names:?}"
    );
}
