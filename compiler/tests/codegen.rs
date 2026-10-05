//! Codegen golden and per-construct tests (lane-01 codegen, PR6).
//!
//! TEST-ONLY: every artifact asserted here is produced under the explicit
//! test-only incomplete-analysis acknowledgment (`EmitOptions::test_only`)
//! with a hermetic golden catalog, so `E6007` cannot fire and availability
//! is pinned, not discovered. Goldens run over the complete PR5+ analysis
//! (effects, examples, UI shape rules, handler sources); remaining `E6006`
//! gaps and `E6008` unlowered positions are pinned per golden with their
//! fail-closed placeholders (throwing stubs). NOTHING HERE CLAIMS RUNTIME
//! SUCCESS: no emitted module is executed, no stdlib/UI binding is linked,
//! and no artifact ships until the B1 join re-verifies it over a complete
//! analysis with the real catalog. Golden expectations are inline strings
//! (no `.snap` files).
//!
//! Oracle correspondence: per-construct tests pin the DESIGN §13 lowering
//! against the handwritten `draft/*.mjs` oracles. Where oracles disagree
//! with each other or with §13, the test documents the drift and follows
//! the normative text.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::resolve::{ModuleId, ModuleKind, SymbolId};
use canlang_compiler::analysis::types::{ResolvedType, Scalar};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::artifact::{self, CompileArtifact};
use canlang_compiler::codegen::bdd::{self, BddSuite, IrExampleImport};
use canlang_compiler::codegen::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrDeleteMode, IrExpr, IrFixture, IrFixtureKind, IrGuard,
    IrItem, IrItemKind, IrMessage, IrMessageParam, IrModifiers, IrModule, IrOrder, IrOwner, IrPage,
    IrProgram, IrQuery, IrQueryDomain, IrSequence, IrServer, IrStep, IrStmt, IrTable, IrTableRow,
    IrType, IrUi, IrUnOp, TypedExpr,
};
use canlang_compiler::codegen::js::{self, Emitter};
use canlang_compiler::codegen::sourcemap;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{DiagnosticResult, Severity};
use canlang_compiler::json::Json;
use canlang_compiler::source::{LineIndex, SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::path::PathBuf;

// --- Helpers ---------------------------------------------------------------

/// Span in the single fixture source.
fn sp(start: u32, end: u32) -> Span {
    Span::new(SourceId(0), start, end)
}

/// Load one `examples/*.can` file into a fresh database.
fn load_example(name: &str) -> (SourceDb, SourceId) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("examples")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let mut db = SourceDb::new();
    let id = db.add(format!("examples/{name}"), text);
    (db, id)
}

/// Analyze one example with `catalog` (hermetic goldens pass `None`) and
/// wrap the outcome in an explicit incomplete result (PR4 reality).
fn check_example(
    db: &SourceDb,
    id: SourceId,
    catalog: Option<&Catalog>,
) -> (CheckedProgram, DiagnosticResult) {
    let (program, diags) = check_program(db, &[id], catalog);
    let mut result = DiagnosticResult::new("test", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(db);
    result.diagnostics = diags;
    result.complete = false;
    result.finish();
    (program, result)
}

/// Emit under the test-only acknowledgment. TEST-ONLY: see module docs.
fn emit_test_only<'a>(
    program: &CheckedProgram,
    db: &'a SourceDb,
    result: &'a DiagnosticResult,
    catalog: Option<&'a Catalog>,
) -> (
    CompileArtifact,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
) {
    let sources = EmitSources {
        db,
        result,
        catalog,
        options: EmitOptions::test_only(),
    };
    emit(program, &sources)
}

/// Assert every `from "..."` import source is in the §13 allowlist.
fn assert_imports_allowlisted(js: &str, module: &str) {
    for line in js.lines() {
        let Some(rest) = line.trim().strip_prefix("import ") else {
            continue;
        };
        let source = rest
            .rsplit("from ")
            .next()
            .unwrap()
            .trim()
            .trim_end_matches(';');
        let source = source.trim_matches('"');
        assert!(
            source == "@canlang/stdlib" || source == "@canlang/ui" || source.starts_with("./"),
            "{module}: import source outside the allowlist: {source}"
        );
    }
}

/// Assert one module's source map is valid: mappings decode, line counts
/// match, and every segment resolves to a real span in `db`.
fn assert_sourcemap_valid(
    artifact: &CompileArtifact,
    module_index: usize,
    db: &SourceDb,
    module: &str,
) {
    let m = &artifact.modules[module_index];
    let lines = sourcemap::decode_mappings(&m.map.mappings).expect("mappings decode");
    assert_eq!(
        lines.len(),
        m.js.matches('\n').count(),
        "{module}: line count"
    );
    assert_eq!(m.map.file, m.path, "{module}: map file");
    assert_eq!(m.map.sources.len(), db.len(), "{module}: sources cover db");
    for (i, segments) in lines.iter().enumerate() {
        assert_eq!(segments.len(), 1, "{module} line {i}: one segment");
        let seg = &segments[0];
        let src = seg.src.expect("src") as usize;
        assert!(src < m.map.sources.len(), "{module} line {i}: src range");
        let source = db.get(SourceId(src as u32)).expect("source id");
        let index = LineIndex::new(&source.text);
        let line = seg.src_line.expect("src line") as usize;
        assert!(
            line < source.text.lines().count() + 1,
            "{module} line {i}: line range"
        );
        let _ = (index, seg.src_col);
    }
}

/// Minimal IR host for lowering fixtures: one package plus model,
/// contract, capability-op and field items for canonical lookups.
fn fixture_ir() -> IrProgram {
    let span = sp(0, 1);
    IrProgram {
        modules: vec![IrModule {
            id: ModuleId(0),
            name: "demo".to_string(),
            kind: ModuleKind::Package,
            file: SourceId(0),
            span,
            imports: Vec::new(),
            uses: Vec::new(),
            uses_resolved: Vec::new(),
            pages: Vec::new(),
            description: None,
        }],
        items: vec![
            IrItem {
                id: SymbolId(0),
                canonical: "demo.Widget".to_string(),
                name: "Widget".to_string(),
                module: ModuleId(0),
                span,
                exported: true,
                kind: IrItemKind::Model {
                    fields: vec![SymbolId(1), SymbolId(2)],
                    owner: IrOwner::Team,
                    crud: None,
                    label: None,
                    grants: Vec::new(),
                    invariants: Vec::new(),
                    locks: Vec::new(),
                    uniques: Vec::new(),
                    retain: None,
                },
            },
            IrItem {
                id: SymbolId(1),
                canonical: "demo.Widget.title".to_string(),
                name: "title".to_string(),
                module: ModuleId(0),
                span,
                exported: false,
                kind: IrItemKind::Field {
                    owner: SymbolId(0),
                    ty: IrType::Known(ResolvedType::Scalar(Scalar::Text)),
                    default: None,
                    server: None,
                    modifiers: IrModifiers::default(),
                    label: None,
                },
            },
            IrItem {
                id: SymbolId(2),
                canonical: "demo.Widget.count".to_string(),
                name: "count".to_string(),
                module: ModuleId(0),
                span,
                exported: false,
                kind: IrItemKind::Field {
                    owner: SymbolId(0),
                    ty: IrType::Known(ResolvedType::Scalar(Scalar::Int)),
                    default: None,
                    server: None,
                    modifiers: IrModifiers::default(),
                    label: None,
                },
            },
            IrItem {
                id: SymbolId(3),
                canonical: "demo.Summary".to_string(),
                name: "Summary".to_string(),
                module: ModuleId(0),
                span,
                exported: false,
                kind: IrItemKind::Contract {
                    fields: vec![],
                    label: None,
                },
            },
            IrItem {
                id: SymbolId(4),
                canonical: "demo.Svc.ping".to_string(),
                name: "ping".to_string(),
                module: ModuleId(0),
                span,
                exported: false,
                kind: IrItemKind::CapabilityOp {
                    params: vec![],
                    result: IrType::Known(ResolvedType::Scalar(Scalar::Bool)),
                },
            },
        ],
        catalog_version: String::new(),
        referenced_builtins: Vec::new(),
        read_rules: Vec::new(),
        invariants: Vec::new(),
        locks: Vec::new(),
        retention: Vec::new(),
        crud_when: Vec::new(),
        preferences_valid: Vec::new(),
        suites: Vec::new(),
    }
}

/// Lower one expression with a fresh emitter, returning text, import lines
/// and diagnostics.
fn lower(
    ir: &IrProgram,
    expr: &TypedExpr,
) -> (
    String,
    Vec<String>,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
) {
    let mut emitter = Emitter::new(ir);
    let text = emitter.lower_expr(expr);
    let imports = emitter.import_lines();
    let (diags, _, _, _) = emitter.finish();
    (text, imports, diags)
}

fn typed(expr: IrExpr, ty: ResolvedType) -> TypedExpr {
    TypedExpr::new(expr, ty, sp(0, 1))
}

fn int_lit(value: i128) -> TypedExpr {
    typed(IrExpr::Int(value), ResolvedType::Scalar(Scalar::Int))
}

fn text_lit(value: &str) -> TypedExpr {
    typed(
        IrExpr::Text(value.to_string()),
        ResolvedType::Scalar(Scalar::Text),
    )
}

fn money(value: TypedExpr, other: TypedExpr, op: IrBinOp) -> TypedExpr {
    typed(
        IrExpr::Binary {
            op,
            left: Box::new(value),
            right: Box::new(other),
        },
        ResolvedType::Scalar(Scalar::Money),
    )
}

// --- Golden: TeamTasks -------------------------------------------------------
// TEST-ONLY artifact: see module docs. No runtime-success claims.

#[test]
fn golden_teamtasks_structure() {
    let (db, id) = load_example("TeamTasks.can");
    // Production-like: the golden catalog implements every builtin the
    // example calls, so availability verifies and requires pins.
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);

    // Envelope: version 1, sources with real hashes.
    assert_eq!(artifact.language_version, LANGUAGE_VERSION);
    assert_eq!(artifact.sources.len(), 1);
    assert_eq!(artifact.sources[0].path, "examples/TeamTasks.can");
    assert_eq!(artifact.sources[0].sha256, db.get(id).unwrap().sha256);
    let json = artifact::to_json(&artifact);
    assert!(
        json.starts_with("{\"artifact_version\":1,"),
        "artifact_version 1"
    );
    let parsed = canlang_compiler::json::parse(&json).expect("artifact JSON parses");
    assert_eq!(
        parsed.get("artifact_version").and_then(|v| v.as_i64()),
        Some(1)
    );
    // F1: every callable carries an explicit `member` path (non-empty
    // array of non-empty strings) into the module's `canApp()` object.
    match parsed.get("callables") {
        Some(Json::Arr(items)) => {
            assert!(!items.is_empty(), "callables non-empty in JSON");
            for item in items {
                match item.get("member") {
                    Some(Json::Arr(segments)) => {
                        assert!(!segments.is_empty(), "member non-empty in JSON");
                        for segment in segments {
                            assert!(
                                matches!(segment, Json::Str(s) if !s.is_empty()),
                                "member segments are non-empty strings in JSON"
                            );
                        }
                    }
                    other => panic!("callable member must be a string array, got {other:?}"),
                }
            }
        }
        other => panic!("callables must be an array, got {other:?}"),
    }

    // Modules: entrypoint (composed assembly) first, then packages in
    // source order.
    let paths: Vec<&str> = artifact.modules.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["teamoffice.mjs", "teamtasks.mjs", "teamnotes.mjs"]
    );
    let entry = &artifact.modules[0].js;
    assert!(entry.contains("id:\"TeamOffice\""), "app id");
    assert!(entry.contains("compositions:{"), "compositions");
    assert!(
        entry.contains("\"TeamTasks\":{uses:[]}"),
        "TeamTasks assembly"
    );
    assert!(
        entry.contains("\"TeamNotes\":{uses:[]}"),
        "TeamNotes assembly"
    );
    // Bridge per-family report (TeamTasks):
    // - G1 scenarios: none declared (CRUD-only example).
    // - G2 CRUD: guards, allowlists and labels lowered; no `when=`, no
    //   `expose`, default archive deletion.
    // - G3 models: labels, read grants/rules, field modifiers, defaults
    //   and captions lowered. No invariants/locks/uniques/retains, no
    //   derived fields.
    // - G4 contracts/events: none declared. Preferences lowered (enum
    //   captions); no validators.
    // - G5 roles: none declared.
    // - G6 capabilities: none declared.
    // - G7 messages: descriptors lowered inline at label and call sites.
    // - G8 derives: none declared.
    // - G9 modules: page descriptors/functions, app/package/page
    //   descriptions; `disabled` computed (empty: full CRUD everywhere).
    //   Catalog UI factories `breadcrumbs`/`input`/`textarea`/
    //   `pagination` lower; `tooltip`/`delete`/`collapse` have no §13
    //   lowering (3 E6008, each pinned below).
    // - G10 examples: the update table (fixture recipe, common inputs,
    //   selectors, observations, rows with errors) lowered.
    // - G12 awaited: `count` is catalog state-read, so calls await.
    // - G13 builtins: `count` (entry + suite) and `format` (suite)
    //   referenced with true call-site spans.
    //
    // G3 models: labels, read grants, field modifiers/defaults/captions.
    assert!(
        entry.contains("\"TeamTasks.Todo\":{label:message(\"Task\",{nl:\"Taak\"})"),
        "Todo label"
    );
    assert!(
        entry.contains("readGrants:[{rule:\"Todo.read.1\"}]"),
        "Todo read grant"
    );
    assert!(
        entry.contains("read:{\"Todo.read.1\":(c,row)=>hasRole(c,\"members\")"),
        "Todo read rule"
    );
    assert!(
        entry.contains("title:{type:\"text\",trim:true,max:200n"),
        "Todo.title modifiers"
    );
    assert!(
        entry.contains("done:{type:\"bool\",default:false"),
        "Todo.done default"
    );
    assert!(
        entry.contains("values:{true:message(\"Done\""),
        "Todo.done case captions"
    );
    assert!(entry.contains("\"TeamNotes.Note\":{"), "Note model");
    assert!(!entry.contains("invariants:"), "no invariants member");
    assert!(!entry.contains("locks:"), "no locks member");
    // G4 preferences: enum captions; no validators.
    assert!(
        entry.contains(
            "view:{type:\"enum\",cases:[\"all\",\"unfinished\",\"finished\"],default:\"all\""
        ),
        "view enum"
    );
    assert!(
        entry.contains("values:{all:message(\"All tasks\""),
        "view case captions"
    );
    assert!(!entry.contains("validate:"), "no preferences validator");
    assert!(entry.contains("capabilities:{}"), "no capabilities");
    // G2 CRUD entries: guards, allowlists, labels.
    assert!(entry.contains("\"TeamTasks.Todo.create\":"), "crud create");
    assert!(entry.contains("\"TeamTasks.Todo.update\":"), "crud update");
    assert!(entry.contains("\"TeamTasks.Todo.delete\":"), "crud delete");
    assert!(entry.contains("kind:\"create\""), "crud kind");
    assert!(
        entry.contains("fields:[\"title\",\"done\",\"assignee\"]"),
        "crud allowlist"
    );
    assert!(entry.contains("by:\"members\""), "crud gate");
    assert!(
        entry.contains("label:message(\"Add\",{nl:\"Toevoegen\"})"),
        "crud create label"
    );
    assert!(!entry.contains("when:"), "no crud admission");
    assert!(!entry.contains("expose:false"), "no expose exclusion");
    // G9 pages and descriptions.
    assert!(
        entry.contains("pages:[TeamTasksPageDescriptor,TeamNotesNotesPageDescriptor]"),
        "page descriptors"
    );
    assert!(entry.contains("disabled:[]"), "nothing disabled");
    assert!(
        entry.contains("description:message(\"Manage tasks and notes together.\""),
        "app description"
    );
    assert!(
        entry.contains("selector:\"TeamTasks.view\""),
        "tabs selector"
    );
    assert!(
        entry.contains("form({context:c,operation:\"TeamTasks.Todo.create\",fields:[\"title\",\"assignee\"],display:\"inline\""),
        "form operation"
    );
    // Field-placement controls lower to `field` selector strings;
    // breadcrumbs and pagination lower bare (ancestry/collection state
    // comes from the render context). No-recurse rule: children of an
    // *unlowered* factory are swallowed by its placeholder (one E6008
    // for the factory, none for the absorbed children).
    assert!(entry.contains("breadcrumbs({context:c})"), "breadcrumbs");
    assert!(
        entry.contains("children:[input({context:c,field:\"title\"})]"),
        "form children"
    );
    assert!(
        entry.contains(
            "children:[input({context:c,field:\"title\"}),textarea({context:c,field:\"content\"})]"
        ),
        "textarea child"
    );
    assert!(
        entry.contains("pagination({context:rowView})"),
        "collection pagination"
    );
    assert!(
        entry.contains("where:(task)=>(preferences.view === \"all\")"),
        "list predicate lambda"
    );
    assert!(
        entry.contains("order:[\"-created\"],search:[\"title\"],filter:[\"done\"]"),
        "list props"
    );
    assert!(entry.contains("renderRow:(row,rowView)=>"), "row scope");
    assert!(
        entry.contains("edit({context:rowView,operation:\"TeamTasks.Todo.update\",record:row})"),
        "inferred edit"
    );
    // G12: state-read builtins await; the bare model domain lowers
    // through the shared query contract.
    assert!(
        entry.contains("await count(await records(c,\"TeamTasks.Todo\",{}))"),
        "awaited count over domain"
    );
    // Registry: callable factory with handlers only, no metadata spread.
    assert!(entry.contains("export function canApp()"), "canApp factory");
    assert!(!entry.contains("...appDefinition"), "no metadata spread");
    assert!(
        entry.contains("async createTodo(c,input)"),
        "create handler"
    );
    assert!(
        entry.contains("async updateTodo(c,{record,changes})"),
        "update handler"
    );
    assert!(
        entry.contains("async deleteTodo(c,{record})"),
        "delete handler destructures"
    );
    assert!(
        entry.contains("await set(c,record,changes);"),
        "update body"
    );
    assert!(
        entry.contains("await deleteRecord(c,record,{mode:'archive'});"),
        "delete body"
    );
    assert!(
        entry.contains("check(hasRole(c,\"members\"),\"forbidden\");"),
        "handler gate"
    );
    // Identity constants: registry holds implementations.
    assert!(
        entry.contains("export const TeamTasks_create=\"TeamTasks.Todo.create\";"),
        "identity const for crud op"
    );
    // Callables reference the entrypoint module and real exports.
    assert!(!artifact.callables.is_empty(), "callables non-empty");
    for callable in &artifact.callables {
        assert_eq!(callable.module, "teamoffice.mjs");
        assert!(
            entry.contains(&callable.export),
            "export {} present",
            callable.export
        );
        assert!(
            ["operation", "pure", "rule", "handler", "migration"].contains(&callable.kind.as_str()),
            "known kind"
        );
        // F1: the explicit `member` path is non-empty and every segment
        // resolves against the emitted `canApp()` registry text.
        assert!(
            !callable.member.is_empty(),
            "member non-empty for {}",
            callable.id
        );
        for segment in &callable.member {
            assert!(
                !segment.is_empty(),
                "member segment non-empty for {}",
                callable.id
            );
            assert!(
                entry.contains(segment),
                "member segment {segment:?} of {} resolvable in entry",
                callable.id
            );
        }
    }
    // G9 page registry: both pages with descriptor exports.
    assert_eq!(artifact.pages.len(), 2, "two pages");
    assert_eq!(artifact.pages[0].path, "/");
    assert_eq!(artifact.pages[0].export, "TeamTasksPageDescriptor");
    assert_eq!(artifact.pages[1].path, "/notes");
    assert_eq!(artifact.pages[1].export, "TeamNotesNotesPageDescriptor");
    // G13 requires: the catalog pins, plus the state family for the
    // state-read `count` (entry) and text family for messages.
    let requires: Vec<(&str, u64)> = artifact
        .requires
        .iter()
        .map(|r| (r.capability.as_str(), r.min_version))
        .collect();
    assert!(
        requires.contains(&("canlang.builtins", 2)),
        "builtins pin, got {requires:?}"
    );
    assert!(
        requires.contains(&("state", 1)),
        "state pin, got {requires:?}"
    );
    // G10: one suite for the update table; the `task` recipe is claimed
    // (no orphan shell). Production never imports test artifacts.
    assert_eq!(artifact.tests.len(), 1, "one suite");
    assert_eq!(artifact.tests[0].scope, "TeamTasks.Todo.update");
    assert_eq!(
        artifact.tests[0].fixtures,
        vec!["TeamTasks.task".to_string()]
    );
    let suite = &artifact.tests[0].module.js;
    assert!(
        suite.contains("const task={model:\"TeamTasks.Todo\",dependencies:[],value:async(c,s)=>({title:\"Ship prototype\"})};"),
        "task recipe:\n{suite}"
    );
    assert!(
        suite.contains("operation:\"TeamTasks.Todo.update\""),
        "table operation"
    );
    assert!(
        suite.contains("inputs:async(c,s)=>({record:s.task})"),
        "common inputs"
    );
    assert!(
        suite.contains("selectors:[\"as\",\"changes.done\",\"request.record.version\"]"),
        "selectors"
    );
    assert!(
        suite.contains("observations:[async(c,s)=>s.task.done,async(c,s)=>format("),
        "observations"
    );
    assert!(suite.contains("{locale:\"nl\"})"), "format locale");
    assert!(
        suite.contains("values:async(c,s)=>([\"members\",true,1n])"),
        "first row values:\n{suite}"
    );
    assert!(
        suite.contains("expected:async(c,s)=>([true,\"1 taak\"])"),
        "first row expected"
    );
    assert!(suite.contains("error:\"conflict\""), "conflict row");
    assert!(suite.contains("error:\"forbidden\""), "forbidden row");
    for module in &artifact.modules {
        assert!(
            !module.js.contains("exampleFixtures"),
            "{}: production has no test factory",
            module.path
        );
        assert!(
            !module.js.contains("tests/"),
            "{}: production never imports tests",
            module.path
        );
        assert_imports_allowlisted(&module.js, &module.path);
    }
    for test in &artifact.tests {
        assert_imports_allowlisted(&test.module.js, &test.module.path);
    }
    // Source maps resolve to real spans.
    for (i, module) in artifact.modules.iter().enumerate() {
        assert_sourcemap_valid(&artifact, i, &db, &module.path);
    }
    // Codegen diagnostics: zero E6006 (every emission-needed position
    // is checked and bridged), zero E6007 (the golden catalog verifies
    // every referenced builtin), and three E6008 for catalog UI
    // factories with no §13 lowering (`tooltip`/`delete`/`collapse`;
    // `breadcrumbs`/`input`/`textarea`/`pagination` lower now).
    for diag in &diags {
        assert!(
            diag.code == "E6006" || diag.code == "E6007" || diag.code == "E6008",
            "unexpected codegen code {}: {}",
            diag.code,
            diag.message
        );
        assert_eq!(diag.severity, Severity::Error);
    }
    assert_eq!(
        diags.iter().filter(|d| d.code == "E6006").count(),
        0,
        "gap count: {:?}",
        diags
            .iter()
            .filter(|d| d.code == "E6006")
            .collect::<Vec<_>>()
    );
    assert_eq!(
        diags.iter().filter(|d| d.code == "E6007").count(),
        0,
        "availability count"
    );
    assert_eq!(
        diags.iter().filter(|d| d.code == "E6008").count(),
        3,
        "unsupported count"
    );
    for (word, n) in [("tooltip", 1), ("delete", 1), ("collapse", 1)] {
        assert_eq!(
            diags
                .iter()
                .filter(|d| d.code == "E6008" && d.message.contains(word))
                .count(),
            n,
            "{word} factory"
        );
    }
    if let Some(node) = find_node() {
        for module in &artifact.modules {
            node_check(&node, &module.js, &module.path);
        }
        node_check(
            &node,
            &artifact.tests[0].module.js,
            &artifact.tests[0].module.path,
        );
    }
}

/// G12: `awaited` follows the catalog `Effects` shape exactly — a
/// builtin call awaits if and only if its catalog effects are
/// `state-read`. Without a catalog the call is unverifiable (`E6007`)
/// and lowers synchronously.
#[test]
fn awaited_follows_catalog_effects() {
    let (db, id) = load_example("TeamTasks.can");
    let (catalog, catalog_path) = golden_catalog();
    assert_eq!(
        catalog.lookup("count").and_then(|entry| entry.effects),
        Some(canlang_compiler::analysis::catalog::Effects::StateRead),
        "count is catalog state-read"
    );
    assert_eq!(
        catalog.lookup("format").and_then(|entry| entry.effects),
        Some(canlang_compiler::analysis::catalog::Effects::Pure),
        "format is catalog pure"
    );
    // With the catalog, `count` awaits.
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    assert!(
        artifact.modules[0].js.contains("await count("),
        "state-read awaits"
    );
    assert!(
        diags.iter().all(|d| d.code != "E6007"),
        "catalog verifies every builtin"
    );
    // Without a catalog the same call lowers synchronously and loud.
    let (program, result) = check_example(&db, id, None);
    let (artifact, diags) = emit_test_only(&program, &db, &result, None);
    assert!(
        !artifact.modules[0].js.contains("await count("),
        "unverifiable calls stay sync"
    );
    assert!(
        artifact.modules[0].js.contains("count("),
        "call still emits"
    );
    assert!(
        diags
            .iter()
            .any(|d| d.code == "E6007" && d.message.contains("'count'")),
        "unverifiable count is a loud E6007"
    );
    let _ = std::fs::remove_file(&catalog_path);
}

/// Locate a `node` binary for parse-only checks, if installed.
fn find_node() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join("node"))
            .find(|candidate| candidate.is_file())
    })
}

/// Parse-check emitted JS without executing it (`node --check` resolves
/// no imports and runs no code).
fn node_check(node: &PathBuf, js: &str, module: &str) {
    // Unique per call: parallel goldens may check same-named modules.
    let file = unique_temp_path(&format!("nodecheck-{}", module.replace('/', "_")));
    std::fs::write(&file, js).expect("write probe js");
    let output = std::process::Command::new(node)
        .arg("--check")
        .arg(&file)
        .output()
        .expect("run node --check");
    assert!(
        output.status.success(),
        "{module}: node --check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_file(&file);
}

// --- Golden: ExpenseFlow -----------------------------------------------------
// TEST-ONLY artifact: see module docs. No runtime-success claims.

#[test]
fn golden_expenseflow_structure() {
    let (db, id) = load_example("ExpenseFlow.can");
    // Production-like: the golden catalog implements every builtin the
    // example calls, so availability verifies and requires pins.
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);

    assert_eq!(artifact.sources.len(), 1);
    assert_eq!(artifact.sources[0].sha256, db.get(id).unwrap().sha256);
    let paths: Vec<&str> = artifact.modules.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["expenseflow.mjs", "expenses.mjs", "reporting.mjs"]
    );
    let entry = &artifact.modules[0].js;
    assert!(entry.contains("id:\"ExpenseFlow\""), "app id");
    assert!(
        entry.contains("uses:[\"expenses\",\"reporting\"]"),
        "uses expansion"
    );
    assert!(
        !entry.contains("compositions"),
        "single app, no compositions"
    );
    // Bridge per-family report (ExpenseFlow):
    // - G1 scenarios: gates, `read`, captions, require guards and effect
    //   bodies lowered; no `scope=authority`, no `on=` triggers.
    // - G2 CRUD: `by`/`when`/allowlists lowered; `delete=none` omits the
    //   delete op (loud in `disabled`).
    // - G3 models: label, grants, invariant, locks, retention-less rules
    //   plus registry bodies lowered. No uniques/retains/derives.
    // - G4 contracts: Summary label/fields lowered. Preferences lowered;
    //   no validators.
    // - G5 roles: reviewer label lowered.
    // - G6 capabilities: none declared.
    // - G7 messages: decision-note descriptor inlined at label sites.
    // - G8 derives: none declared.
    // - G9 modules: pages, descriptions; `disabled` names the missing
    //   delete. Catalog UI factories lower: `breadcrumbs`, `input`,
    //   `textarea`, `badge`, `alert` (gated), `divider`, `join`,
    //   `button`, `modal`/`slot`, `pagination`, `stat`.
    // - G10 examples: three table suites lowered; the approve suite also
    //   carries the causal sequence (`call`/`let`/assertion steps with
    //   §13 type ids). Value-domain queries lower through array
    //   combinators (`.filter`/`.map`); `select` appends one `.map`.
    // - G12 awaited: `count`/`sum`/`first` await (state-read);
    //   `money`/`trim` stay sync (pure).
    //
    // G5 roles carry canonical ids plus labels.
    assert!(
        entry.contains(
            "reviewer:{id:\"expenses.reviewer\",label:message(\"Reviewer\",{nl:\"Beoordelaar\"})}"
        ),
        "role label"
    );
    // G3 models: invariant/lock references, grants, full fields.
    assert!(
        entry.contains("status:{type:\"enum\",cases:[\"draft\",\"submitted\",\"approved\",\"rejected\"],default:\"draft\""),
        "status enum"
    );
    assert!(
        entry.contains("submitted_by:{type:\"user\",server:\"actor\""),
        "server actor"
    );
    assert!(
        entry
            .contains("decision_note:{type:\"text\",nullable:true,label:message(\"Decision note\""),
        "referenced caption"
    );
    assert!(
        entry.contains("invariants:[\"Expense.require.1\"]"),
        "invariant refs"
    );
    assert!(
        entry.contains("locks:[\"Expense.lock.1\",\"Expense.lock.2\"]"),
        "lock refs"
    );
    assert!(
        entry.contains("readGrants:[{rule:\"Expense.read.1\"},{rule:\"Expense.read.2\"}]"),
        "grant refs"
    );
    // Rule registry bodies: conjunctions, comparisons, `in` membership.
    assert!(
        entry.contains("const crudWhen={Expense:(c,row)=>(same(row.submitted_by,c.actor)) && (row.status === \"draft\")};"),
        "crudWhen"
    );
    assert!(
        entry.contains("read:{\"Expense.read.1\":(c,row)=>hasRole(c,\"members\") && (same(row.submitted_by,c.actor)),\"Expense.read.2\":(c,row)=>hasRole(c,\"expenses.reviewer\")}"),
        "read rules"
    );
    assert!(
        entry.contains("invariants:{\"Expense.require.1\":(c,row)=>row.amount.minor > 0n}"),
        "invariant rule"
    );
    assert!(
        entry.contains("locks:{\"Expense.lock.1\":{fields:[\"purpose\",\"amount\",\"submitted_by\"],when:(c,row)=>row.status !== \"draft\"}"),
        "lock rule"
    );
    assert!(
        entry.contains("[\"approved\",\"rejected\"].includes(row.status)"),
        "in membership"
    );
    // G4 contracts and preferences.
    assert!(
        entry.contains("\"reporting.Summary\":{label:message(\"Expense totals\""),
        "contract label"
    );
    assert!(
        entry.contains("count:{type:\"int\"},total:{type:\"money\"}"),
        "contract fields"
    );
    assert!(entry.contains("reporting:{fields:{"), "preferences");
    // G1 scenarios: gates, read/result descriptors, captions.
    assert!(entry.contains("\"expenses.submit\":"), "submit op");
    assert!(entry.contains("handler:\"submit\""), "submit handler");
    assert!(
        entry.contains("expense:{type:\"expenses.Expense\"}"),
        "submit input"
    );
    assert!(entry.contains("\"expenses.approve\":"), "approve op");
    assert!(
        entry.contains("note:{type:\"text\",nullable:true,label:message(\"Decision note\""),
        "approve input"
    );
    assert!(entry.contains("by:\"expenses.reviewer\""), "reviewer gate");
    assert!(
        entry.contains("\"reporting.summarize\":{handler:\"summarize\",inputs:{currency:{type:\"currency\"},status:{type:\"enum\""),
        "summarize op"
    );
    assert!(
        entry.contains("read:true,result:{type:\"reporting.Summary\"}"),
        "summarize result descriptor"
    );
    // G2 CRUD entries: `delete=none` yields no delete operation.
    assert!(
        entry.contains("\"expenses.Expense.create\":{handler:\"createExpense\",kind:\"create\",model:\"expenses.Expense\",read:false,inputs:{fields:[\"purpose\",\"amount\"]},by:\"members\",when:\"Expense\"}"),
        "crud create"
    );
    assert!(
        entry.contains("\"expenses.Expense.update\":"),
        "crud update"
    );
    assert!(
        !entry.contains("\"expenses.Expense.delete\":"),
        "delete=none omits the delete operation"
    );
    assert!(
        entry.contains("disabled:[\"expenses.Expense.delete\"]"),
        "missing delete is loud"
    );
    assert!(entry.contains("read:false"), "crud mutation");
    // Registry handlers with real bodies.
    assert!(entry.contains("export function canApp()"), "canApp factory");
    assert!(entry.contains("async submit(c,{expense}){"), "submit body");
    assert!(
        entry.contains(
            "check((same(expense.submitted_by,c.actor)) && (expense.status === \"draft\"));"
        ),
        "submit guard"
    );
    assert!(
        entry.contains("await set(c,expense,{status:\"submitted\"},{when:crudWhen.Expense});"),
        "submit effect"
    );
    assert!(
        entry.contains("async approve(c,{expense,note}){"),
        "approve body"
    );
    assert!(
        entry.contains("await set(c,expense,{status:\"approved\",decision_note:note,decided_by:c.actor,decided_at:c.now},{when:crudWhen.Expense});"),
        "approve effect"
    );
    assert!(entry.contains("note.trim() !== \"\""), "reject trim guard");
    assert!(
        entry.contains("async summarize(c,{currency,status}){"),
        "summarize body"
    );
    assert!(
        entry.contains("const selected = await records(c,\"expenses.Expense\",{where:(row)=>(row.amount.currency === currency) && (row.status === status)});"),
        "summarize query"
    );
    // G12: `count`/`sum` await; the value-domain query lowers
    // through `.map` with its alias-scoped projection.
    assert!(
        entry.contains("return {count:await count(selected),total:await sum(selected.map((expense)=>expense.amount),currency)};"),
        "summarize return"
    );
    assert!(entry.contains("async createExpense(c,input){"), "crud body");
    assert!(
        entry.contains("await create(c,\"expenses.Expense\",input,{when:crudWhen.Expense});"),
        "create admission"
    );
    // G9 pages: collections, actions, history, catalog factories,
    // arguments. Every catalog word on the pages lowers; nothing throws.
    assert!(
        entry
            .contains("action({context:rowView,operations:[\"expenses.submit\"],boundArgs:{row}})"),
        "row actions"
    );
    assert!(
        entry.contains("history({context:rowView,record:row})"),
        "row history"
    );
    assert!(
        entry.contains("breadcrumbs({context:c})"),
        "page breadcrumbs"
    );
    assert!(
        entry.contains(
            "children:[input({context:c,field:\"purpose\"}),input({context:c,field:\"amount\"})]"
        ),
        "create-form field controls"
    );
    assert!(
        entry.contains("badge({context:rowView,value:row.status})"),
        "row badge"
    );
    assert!(
        entry.contains("row.status === \"rejected\" ? alert({context:rowView,children:[text({context:rowView,values:[row.decision_note]})]}) : null"),
        "gated alert"
    );
    assert!(
        entry.contains("divider({context:rowView,caption:message(\"Review decision\",{nl:\"Beoordelingsbesluit\"})})"),
        "divider caption"
    );
    assert!(
        entry.contains("join({context:rowView,children:[button({context:rowView,opens:\"approve_expense\"}),button({context:rowView,opens:\"reject_expense\"})]})"),
        "join with opener buttons"
    );
    assert!(
        entry.contains("modal({context:rowView,caption:message(\"Approve expense\",{nl:\"Onkost goedkeuren\"}),id:\"approve_expense\",children:[slot({context:rowView,name:\"content\",children:[form({context:rowView,operation:\"expenses.approve\",arguments:{expense:row},display:\"inline\",fields:[\"expense\",\"note\"],children:[textarea({context:rowView,field:\"note\"})]})]})]})"),
        "approve modal with content slot"
    );
    assert!(
        entry.contains("modal({context:rowView,caption:message(\"Reject expense\""),
        "reject modal"
    );
    assert!(
        entry.contains("pagination({context:rowView})"),
        "collection pagination"
    );
    assert!(
        entry.contains("stat({context:c,values:[result.count,result.total]})"),
        "stat metric values"
    );
    assert!(
        !entry.contains("unknown UI factory"),
        "every factory lowered"
    );
    assert!(
        entry.contains("arguments:{status:preferences.status}"),
        "form arguments"
    );
    assert!(
        entry.contains("defaults:{status:preferences.status}"),
        "list defaults"
    );
    assert!(
        entry.contains("tabs({context:c,selector:\"reporting.status\",value:preferences.status})"),
        "tabs selector"
    );
    // Callables cover scenarios and generated CRUD ops (no delete).
    let callable_ids: Vec<&str> = artifact.callables.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        callable_ids,
        vec![
            "expenses.Expense.create",
            "expenses.Expense.update",
            "expenses.submit",
            "expenses.approve",
            "expenses.reject",
            "reporting.summarize",
        ]
    );
    for callable in &artifact.callables {
        assert_eq!(callable.module, "expenseflow.mjs");
        assert!(
            entry.contains(&callable.export),
            "export {} present",
            callable.export
        );
        // F1: the explicit `member` path is non-empty and every segment
        // resolves against the emitted `canApp()` registry text.
        assert!(
            !callable.member.is_empty(),
            "member non-empty for {}",
            callable.id
        );
        for segment in &callable.member {
            assert!(
                !segment.is_empty(),
                "member segment non-empty for {}",
                callable.id
            );
            assert!(
                entry.contains(segment),
                "member segment {segment:?} of {} resolvable in entry",
                callable.id
            );
        }
    }
    // G10 suites: one per operation with tables, in operation
    // declaration order; every fixture is claimed (no orphan shells).
    let scopes: Vec<&str> = artifact.tests.iter().map(|t| t.scope.as_str()).collect();
    assert_eq!(
        scopes,
        vec!["expenses.submit", "expenses.approve", "reporting.summarize",]
    );
    let submit = &artifact.tests[0].module.js;
    assert!(
        submit.contains("const reviewer_one={dependencies:[],user:async(c,s)=>({roles:[\"expenses.reviewer\"]})};"),
        "reviewer recipe:\n{submit}"
    );
    assert!(
        submit.contains("const pending={model:\"expenses.Expense\",dependencies:[],value:async(c,s)=>({purpose:\"Travel\",amount:money(25n,\"EUR\"),submitted_by:other,status:\"submitted\"})};"),
        "pending recipe"
    );
    assert!(
        submit.contains("operation:\"expenses.submit\""),
        "submit table"
    );
    assert!(
        submit.contains("inputs:async(c,s)=>({expense:s.pending})"),
        "submit inputs"
    );
    assert!(
        submit.contains("async(c,s)=>hasRole(c,\"expenses.reviewer\",s.reviewer_one)"),
        "role predicate observation"
    );
    assert!(
        submit.contains("async(c,s)=>!same(s.reviewer_one,s.reviewer_two)"),
        "fixture inequality"
    );
    assert!(
        submit.contains("async(c,s)=>!same(s.pending.submitted_by,s.reviewer_one)"),
        "member inequality"
    );
    assert!(
        submit.contains("values:async(c,s)=>([other,\"draft\"])"),
        "submit row"
    );
    // G12 in suites: `money` is pure, so recipe values stay synchronous.
    assert!(!submit.contains("await money("), "money stays sync");
    let approve = &artifact.tests[1].module.js;
    assert!(
        approve.contains("operation:\"expenses.approve\""),
        "approve table"
    );
    // The causal sequence lowers beside the tables: call steps with
    // caller/inputs/request/error, `let` bindings through `b`, and
    // assertions with §13 type ids.
    assert!(
        approve.contains("{operation:\"expenses.Expense.create\",by:async(c,s,b)=>(other),inputs:async(c,s,b)=>({purpose:\"Travel\",amount:money(25n,\"EUR\")})}"),
        "sequence create call"
    );
    assert!(
        approve.contains("{let:\"draft_claim\",value:async(c,s,b)=>(await first(await records(c,\"expenses.Expense\",{where:(row)=>same(row.submitted_by,other)})))}"),
        "sequence binding"
    );
    assert!(
        approve.contains("{operation:\"expenses.submit\",by:async(c,s,b)=>(other),inputs:async(c,s,b)=>({expense:b.draft_claim})}"),
        "sequence submit call"
    );
    assert!(
        approve.contains(
            "request:async(c,s,b)=>({expense:{version:b.original_version}}),error:\"conflict\""
        ),
        "sequence request override with exact error"
    );
    assert!(
        approve.contains("{observations:async(c,s,b)=>([b.submitted_claim?.status]),expected:async(c,s,b)=>([\"submitted\"]),types:[\"expenses.Expense.status\"]}"),
        "sequence enum assertion"
    );
    assert!(
        approve.contains("types:[\"expenses.Expense.status\",\"user?\"]"),
        "sequence tuple assertion types"
    );
    assert!(
        approve.contains("dependencies:[reviewer_one,reviewer_two],sequence:["),
        "sequence dependencies"
    );
    let summarize = &artifact.tests[2].module.js;
    assert!(
        summarize.contains("operation:\"reporting.summarize\""),
        "summarize table"
    );
    assert!(
        summarize.contains("inputs:async(c,s)=>({currency:\"EUR\"})"),
        "summarize inputs"
    );
    assert!(
        summarize.contains("selectors:[\"status\"]"),
        "summarize selectors"
    );
    assert!(
        summarize.contains("async(c,s)=>result.count"),
        "result observation"
    );
    assert!(
        summarize.contains("values:async(c,s)=>([\"submitted\"])"),
        "summarize row"
    );
    // Imports, maps, separation.
    for module in &artifact.modules {
        assert_imports_allowlisted(&module.js, &module.path);
        assert!(!module.js.contains("exampleFixtures"), "no test factory");
        assert!(!module.js.contains("tests/"), "no test imports");
    }
    for test in &artifact.tests {
        assert_imports_allowlisted(&test.module.js, &test.module.path);
    }
    for (i, module) in artifact.modules.iter().enumerate() {
        assert_sourcemap_valid(&artifact, i, &db, &module.path);
    }
    for diag in &diags {
        assert!(
            diag.code == "E6006" || diag.code == "E6007" || diag.code == "E6008",
            "unexpected codegen code {}: {}",
            diag.code,
            diag.message
        );
        assert_eq!(diag.severity, Severity::Error);
    }
    // Zero E6006 (tables and the approve sequence all bridge), zero
    // E6007 (the golden catalog verifies every referenced builtin),
    // zero E6008 (every catalog factory, gate, slot and the value
    // query lower).
    assert_eq!(
        diags.iter().filter(|d| d.code == "E6006").count(),
        0,
        "gap count: {:?}",
        diags
            .iter()
            .filter(|d| d.code == "E6006")
            .collect::<Vec<_>>()
    );
    assert_eq!(
        diags.iter().filter(|d| d.code == "E6007").count(),
        0,
        "availability count"
    );
    assert_eq!(
        diags.iter().filter(|d| d.code == "E6008").count(),
        0,
        "unsupported count: {diags:?}"
    );
    if let Some(node) = find_node() {
        for module in &artifact.modules {
            node_check(&node, &module.js, &module.path);
        }
        for test in &artifact.tests {
            node_check(&node, &test.module.js, &test.module.path);
        }
    }
}

// --- Per-construct correspondence (DESIGN §13 vs draft/*.mjs) ----------------
// Fixture-driven: PR5 will populate these positions end-to-end.

/// Models/grants: typed schemas per §13 with fail-closed rule arrays.
/// Oracle: `CanExpense.mjs` models (`readGrants:[{rule,fields?}]`,
/// `invariants`/`locks` id arrays, `exported` metadata, pure schemas).
#[test]
fn construct_models_and_grants() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    // Scalar, enum, record, array, nullable and delivery schemas.
    let cases = [
        (ResolvedType::Scalar(Scalar::Text), "{type:\"text\"}"),
        (ResolvedType::Scalar(Scalar::Member), "{type:\"member\"}"),
        (
            ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Member))),
            "{type:\"member\",nullable:true}",
        ),
        (
            ResolvedType::Enum {
                cases: vec!["draft".to_string(), "submitted".to_string()],
                owner: None,
            },
            "{type:\"enum\",cases:[\"draft\",\"submitted\"]}",
        ),
        (
            ResolvedType::Record {
                symbol: SymbolId(0),
                stored: true,
            },
            "{type:\"demo.Widget\"}",
        ),
        (
            ResolvedType::Array {
                element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                ordered: true,
                nonempty: false,
            },
            "{type:\"text\",array:true,requiredArray:true}",
        ),
        (
            ResolvedType::Nullable(Box::new(ResolvedType::Array {
                element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                ordered: true,
                nonempty: false,
            })),
            "{type:\"text\",array:true,nullable:true}",
        ),
        (
            ResolvedType::Delivery { op: SymbolId(4) },
            "{type:\"delivery\",operation:\"demo.Svc.ping\"}",
        ),
        (
            ResolvedType::Nullable(Box::new(ResolvedType::Delivery { op: SymbolId(4) })),
            "{type:\"delivery\",operation:\"demo.Svc.ping\",nullable:true}",
        ),
    ];
    for (ty, want) in cases {
        assert_eq!(emitter.field_schema(&ty, sp(0, 1)), want);
    }
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty(), "schemas lower cleanly: {diags:?}");

    // Model member: export flag, ownership, labels, rule references
    // (`readGrants` always present and fail-closed; `invariants`/`locks`
    // omitted when empty), then fields.
    let out = js::emit_program(&ir);
    assert!(out.diagnostics.is_empty(), "fixture lowers cleanly");
    assert!(out.entry.js.contains(
        "\"demo.Widget\":{exported:true,readGrants:[],fields:{title:{type:\"text\"},count:{type:\"int\"}}}"
    ), "model member shape:\n{}", out.entry.js);
    assert!(
        out.entry.js.contains("\"demo.Summary\":{fields:{}}"),
        "contract member"
    );
    assert!(out.pages.is_empty(), "no pages without PR5 tables");
}

/// Defaults: literal `default` values, `default(c,{parent})` callables and
/// `server` initializers. Oracles: `CanExpense.mjs` (`default:0n`,
/// `default:"draft"`, `server:"actor"`, `server:"now"`); §13 for the
/// `default:(c,{parent})=>parent.parent.user` computed form.
#[test]
fn construct_defaults() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let user_ty = ResolvedType::Scalar(Scalar::User);
    let enum_ty = ResolvedType::Enum {
        cases: vec!["draft".to_string(), "submitted".to_string()],
        owner: None,
    };
    // Literal defaults stay literal (BigInt for integers).
    assert_eq!(
        emitter.lower_field_full(
            &int_ty,
            Some(&IrDefault::Literal(int_lit(0))),
            None,
            sp(0, 1)
        ),
        "{type:\"int\",default:0n}"
    );
    assert_eq!(
        emitter.lower_field_full(
            &enum_ty,
            Some(&IrDefault::Literal(text_lit("draft"))),
            None,
            sp(0, 1)
        ),
        "{type:\"enum\",cases:[\"draft\",\"submitted\"],default:\"draft\"}"
    );
    // Nonliteral defaults use the typed callable; the second argument
    // carries only the resolved parent when containment exists.
    let parent_user = typed(
        IrExpr::Member {
            base: Box::new(typed(
                IrExpr::Member {
                    base: Box::new(typed(
                        IrExpr::Name("parent".to_string()),
                        ResolvedType::Record {
                            symbol: SymbolId(0),
                            stored: true,
                        },
                    )),
                    field: "parent".to_string(),
                },
                ResolvedType::Record {
                    symbol: SymbolId(0),
                    stored: true,
                },
            )),
            field: "user".to_string(),
        },
        user_ty.clone(),
    );
    assert_eq!(
        emitter.lower_field_full(
            &user_ty,
            Some(&IrDefault::Computed {
                expr: parent_user,
                has_parent: true
            }),
            None,
            sp(0, 1)
        ),
        "{type:\"user\",default:(c,{parent})=>parent.parent.user}"
    );
    // Fixed server initializers are unchanged metadata.
    assert_eq!(
        emitter.lower_field_full(&user_ty, None, Some(&IrServer::Actor), sp(0, 1)),
        "{type:\"user\",server:\"actor\"}"
    );
    let datetime_ty = ResolvedType::Scalar(Scalar::Datetime);
    assert_eq!(
        emitter.lower_field_full(&datetime_ty, None, Some(&IrServer::Now), sp(0, 1)),
        "{type:\"datetime\",server:\"now\"}"
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty(), "defaults lower cleanly: {diags:?}");
}

/// Scalars, one import name per operation. Oracles: `CanTime.mjs` and
/// `CanPurchase.mjs` (`compareMoney(a,b) > 0`, `equalMoney`,
/// `durationBetween`, `multiplyMoney(money(30n,"EUR"),divideDecimal(...))`),
/// `CanCheck.mjs` (`int64(job.revision + 1n)`, `addDuration(c.now,300000n)`).
#[test]
fn construct_scalars_per_op() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let money_ty = ResolvedType::Scalar(Scalar::Money);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let duration_ty = ResolvedType::Scalar(Scalar::Duration);
    let datetime_ty = ResolvedType::Scalar(Scalar::Datetime);
    let date_ty = ResolvedType::Scalar(Scalar::Date);
    let text_ty = ResolvedType::Scalar(Scalar::Text);
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);
    let user_ty = ResolvedType::Scalar(Scalar::User);
    let secret_ty = ResolvedType::Scalar(Scalar::Secret);
    let money_lit = |minor: i128| {
        typed(
            IrExpr::Money {
                minor,
                currency: "EUR".to_string(),
            },
            money_ty.clone(),
        )
    };
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    let binary = |op: IrBinOp, l: TypedExpr, r: TypedExpr, ty: ResolvedType| {
        typed(
            IrExpr::Binary {
                op,
                left: Box::new(l),
                right: Box::new(r),
            },
            ty,
        )
    };

    // Literals: exact integers/durations are BigInt; money/date/datetime
    // use their constructors.
    let (text, imports, diags) = lower(&ir, &int_lit(25));
    assert_eq!(text, "25n");
    assert!(imports.is_empty() && diags.is_empty());
    let (text, _, _) = lower(&ir, &typed(IrExpr::DurationMs(300000), duration_ty.clone()));
    assert_eq!(text, "300000n");
    let (text, imports, _) = lower(&ir, &money_lit(25));
    assert_eq!(text, "money(25n,\"EUR\")");
    assert!(imports.iter().any(|i| i.contains("money")));

    // Checked integer arithmetic wraps in int64.
    let (text, imports, diags) = lower(
        &ir,
        &binary(IrBinOp::Add, int_lit(1), int_lit(2), int_ty.clone()),
    );
    assert_eq!(text, "int64(1n + 2n)");
    assert!(imports.iter().any(|i| i.contains("int64")));
    assert!(diags.is_empty());
    // Integer/boolean/text/enum equality compares directly.
    let (text, _, _) = lower(
        &ir,
        &binary(IrBinOp::Eq, int_lit(1), int_lit(2), bool_ty.clone()),
    );
    assert_eq!(text, "1n === 2n");
    let (text, _, _) = lower(
        &ir,
        &binary(IrBinOp::Ne, text_lit("a"), text_lit("b"), bool_ty.clone()),
    );
    assert_eq!(text, "\"a\" !== \"b\"");

    // Money: addMoney/subtractMoney/multiplyMoney, equalMoney, and
    // compareMoney against zero.
    let (text, imports, _) = lower(&ir, &money(money_lit(100), money_lit(25), IrBinOp::Add));
    assert_eq!(text, "addMoney(money(100n,\"EUR\"),money(25n,\"EUR\"))");
    assert!(imports.iter().any(|i| i.contains("addMoney")));
    let (text, _, _) = lower(
        &ir,
        &typed(
            IrExpr::Binary {
                op: IrBinOp::Eq,
                left: Box::new(money_lit(100)),
                right: Box::new(money_lit(25)),
            },
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "equalMoney(money(100n,\"EUR\"),money(25n,\"EUR\"))");
    let (text, _, _) = lower(
        &ir,
        &typed(
            IrExpr::Binary {
                op: IrBinOp::Gt,
                left: Box::new(money_lit(100)),
                right: Box::new(money_lit(25)),
            },
            bool_ty.clone(),
        ),
    );
    assert_eq!(
        text,
        "compareMoney(money(100n,\"EUR\"),money(25n,\"EUR\")) > 0"
    );
    let (text, _, _) = lower(
        &ir,
        &typed(
            IrExpr::Unary {
                op: IrUnOp::Neg,
                operand: Box::new(money_lit(100)),
            },
            money_ty.clone(),
        ),
    );
    assert_eq!(text, "negateMoney(money(100n,\"EUR\"))");

    // Decimals: addDecimal/subtractDecimal/multiplyDecimal/divideDecimal
    // and compareDecimal against zero; equality is structural (equalValue).
    let dec = |text: &str| typed(IrExpr::Decimal(text.to_string()), decimal_ty.clone());
    let (text, imports, diags) = lower(
        &ir,
        &binary(IrBinOp::Div, dec("1.5"), dec("0.5"), decimal_ty.clone()),
    );
    assert_eq!(
        text,
        "divideDecimal((() => { throw new Error(\"decimal literal has no lowering\"); })(),(() => { throw new Error(\"decimal literal has no lowering\"); })())"
    );
    assert!(imports.iter().any(|i| i.contains("divideDecimal")));
    assert!(
        diags.iter().any(|d| d.code == "E6008"),
        "decimal literal is E6008"
    );
    let (text, _, _) = lower(
        &ir,
        &binary(IrBinOp::Eq, dec("1.5"), dec("1.5"), bool_ty.clone()),
    );
    assert!(
        text.starts_with("equalValue(c,\"decimal\","),
        "decimal equality: {text}"
    );

    // Durations/instants/dates.
    let (text, imports, diags) = lower(
        &ir,
        &binary(
            IrBinOp::Add,
            name("due", datetime_ty.clone()),
            typed(IrExpr::DurationMs(300000), duration_ty.clone()),
            datetime_ty.clone(),
        ),
    );
    assert_eq!(text, "addDuration(due,300000n)");
    assert!(imports.iter().any(|i| i.contains("addDuration")));
    assert!(diags.is_empty());
    let (text, _, _) = lower(
        &ir,
        &binary(
            IrBinOp::Sub,
            name("until", datetime_ty.clone()),
            name("from", datetime_ty.clone()),
            duration_ty.clone(),
        ),
    );
    assert_eq!(text, "durationBetween(until,from)");
    let (text, _, _) = lower(
        &ir,
        &binary(
            IrBinOp::Le,
            name("paid", date_ty.clone()),
            name("today", date_ty.clone()),
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "compareDate(paid,today) <= 0");

    // References use same; secrets use secretEqual; arrays/contracts use
    // equalValue with canonical type ids.
    let (text, imports, _) = lower(
        &ir,
        &binary(
            IrBinOp::Eq,
            name("a", user_ty.clone()),
            name("b", user_ty.clone()),
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "same(a,b)");
    assert!(imports.iter().any(|i| i.contains("same")));
    let (text, _, _) = lower(
        &ir,
        &binary(
            IrBinOp::Ne,
            name("a", user_ty.clone()),
            name("b", user_ty.clone()),
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "!same(a,b)");
    let (text, _, _) = lower(
        &ir,
        &binary(
            IrBinOp::Eq,
            name("a", secret_ty.clone()),
            name("b", secret_ty),
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "secretEqual(a,b)");
    let text_array = ResolvedType::Array {
        element: Box::new(text_ty.clone()),
        ordered: true,
        nonempty: false,
    };
    let (text, _, _) = lower(
        &ir,
        &binary(
            IrBinOp::Eq,
            name("a", text_array.clone()),
            name("b", text_array),
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "equalValue(c,\"text[]\", a,b)");
    let widget = ResolvedType::Record {
        symbol: SymbolId(0),
        stored: true,
    };
    let (text, _, _) = lower(
        &ir,
        &binary(
            IrBinOp::Eq,
            name("a", widget.clone()),
            name("b", widget.clone()),
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "same(a,b)");
    let summary = ResolvedType::Record {
        symbol: SymbolId(3),
        stored: false,
    };
    let (text, _, _) = lower(
        &ir,
        &binary(
            IrBinOp::Eq,
            name("a", summary.clone()),
            name("b", summary),
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "equalValue(c,\"demo.Summary\", a,b)");

    // Membership, coalescing, logic, trim.
    let (text, _, _) = lower(
        &ir,
        &typed(
            IrExpr::Binary {
                op: IrBinOp::In,
                left: Box::new(text_lit("a")),
                right: Box::new(typed(
                    IrExpr::Array(vec![text_lit("a"), text_lit("b")]),
                    ResolvedType::Array {
                        element: Box::new(text_ty.clone()),
                        ordered: true,
                        nonempty: true,
                    },
                )),
            },
            bool_ty.clone(),
        ),
    );
    assert_eq!(text, "[\"a\",\"b\"].includes(\"a\")");
    let (text, _, _) = lower(
        &ir,
        &typed(
            IrExpr::Call {
                target: IrCallTarget::Builtin {
                    id: "trim".to_string(),
                    awaited: false,
                },
                args: vec![name("note", text_ty.clone())],
            },
            text_ty.clone(),
        ),
    );
    assert_eq!(text, "note.trim()");
    // Awaited builtins record their catalog reference for E6007 checks.
    let mut emitter = Emitter::new(&ir);
    let call = emitter.lower_expr(&typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "count".to_string(),
                awaited: true,
            },
            args: vec![name(
                "rows",
                ResolvedType::Array {
                    element: Box::new(int_ty.clone()),
                    ordered: true,
                    nonempty: false,
                },
            )],
        },
        int_ty.clone(),
    ));
    assert_eq!(call, "await count(rows)");
    let (diags, builtins, _, _) = emitter.finish();
    assert!(diags.is_empty());
    assert_eq!(builtins.len(), 1);
    assert_eq!(builtins[0].id, "count");
    // Capability operations import from their owning package module.
    let mut emitter = Emitter::new(&ir);
    let call = emitter.lower_expr(&typed(
        IrExpr::Call {
            target: IrCallTarget::CapabilityOp("demo.Svc.ping".to_string()),
            args: vec![],
        },
        ResolvedType::Scalar(Scalar::Bool),
    ));
    assert_eq!(call, "await ping(c)");
    assert!(
        emitter
            .import_lines()
            .iter()
            .any(|i| i.contains("./demo.mjs")),
        "owning-package import"
    );
    // Queries lower to records() with viewer grants applied first.
    let query = typed(
        IrExpr::Query(IrQuery {
            domain: IrQueryDomain::Model("demo.Widget".to_string()),
            parent: None,
            where_pred: Some(Box::new(binary(
                IrBinOp::Eq,
                typed(
                    IrExpr::Member {
                        base: Box::new(name("row", widget.clone())),
                        field: "count".to_string(),
                    },
                    int_ty.clone(),
                ),
                int_lit(1),
                bool_ty.clone(),
            ))),
            where_async: false,
            order: vec![IrOrder {
                field: "count".to_string(),
                descending: true,
            }],
            limit: Some(Box::new(int_lit(10))),
            archived: None,
            select: None,
            select_param: None,
        }),
        ResolvedType::Array {
            element: Box::new(widget.clone()),
            ordered: true,
            nonempty: false,
        },
    );
    let (text, _, diags) = lower(&ir, &query);
    assert_eq!(
        text,
        "await records(c,\"demo.Widget\",{where:(row)=>row.count === 1n,order:[\"-count\"],limit:10n})"
    );
    assert!(diags.is_empty());
}

/// Gap-helper join: decimal `+` lowers to `addDecimal`, decimal/decimal
/// and exact int/decimal mixes alike.
#[test]
fn gap_helper_add_decimal() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    let add = |l: TypedExpr, r: TypedExpr| {
        typed(
            IrExpr::Binary {
                op: IrBinOp::Add,
                left: Box::new(l),
                right: Box::new(r),
            },
            decimal_ty.clone(),
        )
    };
    let (text, imports, diags) = lower(
        &ir,
        &add(
            name("price", decimal_ty.clone()),
            name("fee", decimal_ty.clone()),
        ),
    );
    assert_eq!(text, "addDecimal(price,fee)");
    assert_eq!(
        imports,
        vec!["import { addDecimal } from \"@canlang/stdlib\";"]
    );
    assert!(diags.is_empty());
    // Exact int promotion inside the operator lowers the same way.
    let (text, _, diags) = lower(
        &ir,
        &add(
            name("units", int_ty.clone()),
            name("fee", decimal_ty.clone()),
        ),
    );
    assert_eq!(text, "addDecimal(units,fee)");
    assert!(diags.is_empty());
}

/// Gap-helper join: decimal `-` lowers to `subtractDecimal`, mixes alike.
#[test]
fn gap_helper_subtract_decimal() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    let sub = |l: TypedExpr, r: TypedExpr| {
        typed(
            IrExpr::Binary {
                op: IrBinOp::Sub,
                left: Box::new(l),
                right: Box::new(r),
            },
            decimal_ty.clone(),
        )
    };
    let (text, imports, diags) = lower(
        &ir,
        &sub(
            name("price", decimal_ty.clone()),
            name("fee", decimal_ty.clone()),
        ),
    );
    assert_eq!(text, "subtractDecimal(price,fee)");
    assert_eq!(
        imports,
        vec!["import { subtractDecimal } from \"@canlang/stdlib\";"]
    );
    assert!(diags.is_empty());
    let (text, _, diags) = lower(
        &ir,
        &sub(
            name("price", decimal_ty.clone()),
            name("units", int_ty.clone()),
        ),
    );
    assert_eq!(text, "subtractDecimal(price,units)");
    assert!(diags.is_empty());
}

/// Gap-helper join: decimal `*` lowers to `multiplyDecimal`, mixes alike.
#[test]
fn gap_helper_multiply_decimal() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    let mul = |l: TypedExpr, r: TypedExpr| {
        typed(
            IrExpr::Binary {
                op: IrBinOp::Mul,
                left: Box::new(l),
                right: Box::new(r),
            },
            decimal_ty.clone(),
        )
    };
    let (text, imports, diags) = lower(
        &ir,
        &mul(
            name("price", decimal_ty.clone()),
            name("rate", decimal_ty.clone()),
        ),
    );
    assert_eq!(text, "multiplyDecimal(price,rate)");
    assert_eq!(
        imports,
        vec!["import { multiplyDecimal } from \"@canlang/stdlib\";"]
    );
    assert!(diags.is_empty());
    let (text, _, diags) = lower(
        &ir,
        &mul(
            name("units", int_ty.clone()),
            name("price", decimal_ty.clone()),
        ),
    );
    assert_eq!(text, "multiplyDecimal(units,price)");
    assert!(diags.is_empty());
}

/// Gap-helper join: decimal unary `-` lowers to `negateDecimal`.
#[test]
fn gap_helper_negate_decimal() {
    let ir = fixture_ir();
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let (text, imports, diags) = lower(
        &ir,
        &typed(
            IrExpr::Unary {
                op: IrUnOp::Neg,
                operand: Box::new(typed(IrExpr::Name("price".to_string()), decimal_ty.clone())),
            },
            decimal_ty,
        ),
    );
    assert_eq!(text, "negateDecimal(price)");
    assert_eq!(
        imports,
        vec!["import { negateDecimal } from \"@canlang/stdlib\";"]
    );
    assert!(diags.is_empty());
}

/// Gap-helper join: `money / int|decimal` lowers to `divideMoney`.
#[test]
fn gap_helper_divide_money() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let money_ty = ResolvedType::Scalar(Scalar::Money);
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    let div = |l: TypedExpr, r: TypedExpr| {
        typed(
            IrExpr::Binary {
                op: IrBinOp::Div,
                left: Box::new(l),
                right: Box::new(r),
            },
            money_ty.clone(),
        )
    };
    let (text, imports, diags) = lower(
        &ir,
        &div(name("budget", money_ty.clone()), name("parts", int_ty)),
    );
    assert_eq!(text, "divideMoney(budget,parts)");
    assert_eq!(
        imports,
        vec!["import { divideMoney } from \"@canlang/stdlib\";"]
    );
    assert!(diags.is_empty());
    let (text, _, diags) = lower(
        &ir,
        &div(
            name("budget", money_ty.clone()),
            name("ratio", decimal_ty.clone()),
        ),
    );
    assert_eq!(text, "divideMoney(budget,ratio)");
    assert!(diags.is_empty());
}

/// Gap-helper join: joined `divideDecimal` shapes — int/decimal mixed
/// division and the money/money ratio (no currency unit, decimal
/// rounding) both lower to `divideDecimal`.
#[test]
fn gap_helper_divide_decimal_shapes() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let money_ty = ResolvedType::Scalar(Scalar::Money);
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    let div = |l: TypedExpr, r: TypedExpr| {
        typed(
            IrExpr::Binary {
                op: IrBinOp::Div,
                left: Box::new(l),
                right: Box::new(r),
            },
            decimal_ty.clone(),
        )
    };
    let (text, imports, diags) = lower(
        &ir,
        &div(
            name("units", int_ty.clone()),
            name("price", decimal_ty.clone()),
        ),
    );
    assert_eq!(text, "divideDecimal(units,price)");
    assert_eq!(
        imports,
        vec!["import { divideDecimal } from \"@canlang/stdlib\";"]
    );
    assert!(diags.is_empty());
    let (text, _, diags) = lower(
        &ir,
        &div(
            name("paid", money_ty.clone()),
            name("due", money_ty.clone()),
        ),
    );
    assert_eq!(text, "divideDecimal(paid,due)");
    assert!(diags.is_empty());
}

/// Gap-helper join: scalar-first money products normalize money-first
/// (`multiplyMoney(money, factor)` per lane-02).
#[test]
fn gap_helper_scalar_money_product() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let money_ty = ResolvedType::Scalar(Scalar::Money);
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    let mul = |l: TypedExpr, r: TypedExpr| {
        typed(
            IrExpr::Binary {
                op: IrBinOp::Mul,
                left: Box::new(l),
                right: Box::new(r),
            },
            money_ty.clone(),
        )
    };
    let (text, imports, diags) = lower(
        &ir,
        &mul(
            name("units", int_ty.clone()),
            name("budget", money_ty.clone()),
        ),
    );
    assert_eq!(text, "multiplyMoney(budget,units)");
    assert_eq!(
        imports,
        vec!["import { multiplyMoney } from \"@canlang/stdlib\";"]
    );
    assert!(diags.is_empty());
    let (text, _, diags) = lower(
        &ir,
        &mul(
            name("ratio", decimal_ty.clone()),
            name("budget", money_ty.clone()),
        ),
    );
    assert_eq!(text, "multiplyMoney(budget,ratio)");
    assert!(diags.is_empty());
}

/// Delivery: the sole observation helper with compiler-resolved
/// provenance and a static property list. Oracle: `CanCheck.mjs`
/// (`(await delivery(c,{record:row,field:"delivery"},["status"]))?.status ?? null`).
#[test]
fn construct_delivery() {
    let ir = fixture_ir();
    let widget = ResolvedType::Record {
        symbol: SymbolId(0),
        stored: true,
    };
    let read = typed(
        IrExpr::DeliveryRead {
            record: Box::new(typed(IrExpr::Name("row".to_string()), widget)),
            field: "delivery".to_string(),
            props: vec!["status".to_string()],
        },
        ResolvedType::Nullable(Box::new(ResolvedType::Object(vec![]))),
    );
    let (text, imports, diags) = lower(&ir, &read);
    assert_eq!(
        text,
        "await delivery(c,{record:row,field:\"delivery\"},[\"status\"])"
    );
    assert!(imports.iter().any(|i| i.contains("delivery")));
    assert!(diags.is_empty());
    // Nullable access reads the checked locator first, then selects.
    let selected = typed(
        IrExpr::Member {
            base: Box::new(read),
            field: "status".to_string(),
        },
        ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text))),
    );
    let (text, _, _) = lower(&ir, &selected);
    assert_eq!(
        text,
        "(await delivery(c,{record:row,field:\"delivery\"},[\"status\"]))?.status"
    );
}

/// Guards: `by` lowers to `check(hasRole(...) || ..., "forbidden")`;
/// subject predicates pass the person third. Oracle: the §13 Expense
/// review gate (`reviewer or finance`).
#[test]
fn construct_guards() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    // `by=reviewer or finance` is one disjunctive guard clause.
    let gate = emitter.lower_admission(&[IrGuard::Or(vec![
        IrGuard::Role("expense.reviewer".to_string()),
        IrGuard::Role("expense.finance".to_string()),
    ])]);
    assert_eq!(
        gate,
        "check(hasRole(c,\"expense.reviewer\") || hasRole(c,\"expense.finance\"),\"forbidden\")"
    );
    // Independent clauses conjoin in source order.
    let both = emitter.lower_admission(&[
        IrGuard::Role("members".to_string()),
        IrGuard::Role("expense.reviewer".to_string()),
    ]);
    assert_eq!(
        both,
        "check(hasRole(c,\"members\") && hasRole(c,\"expense.reviewer\"),\"forbidden\")"
    );
    let subject = emitter.lower_guard_bool(&IrGuard::Subject {
        role: "expense.reviewer".to_string(),
        person: Box::new(typed(
            IrExpr::Name("candidate".to_string()),
            ResolvedType::Scalar(Scalar::User),
        )),
    });
    assert_eq!(subject, "hasRole(c,\"expense.reviewer\",candidate)");
    let members = emitter.lower_guard_bool(&IrGuard::Role("members".to_string()));
    assert_eq!(members, "hasRole(c,\"members\")");
    assert!(
        emitter
            .import_lines()
            .iter()
            .any(|i| i.contains("hasRole") && i.contains("require as check")),
        "guard imports: {:?}",
        emitter.import_lines()
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty());
}

/// Effects: deleteRecord modes, bound send, schedule/cancel/emit, CRUD
/// create/set with when, require/let/if/for. Call effects have no §13
/// lowering and are loud E6008.
#[test]
fn construct_effects() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let widget = ResolvedType::Record {
        symbol: SymbolId(0),
        stored: true,
    };
    let row = typed(IrExpr::Name("row".to_string()), widget.clone());
    let mut all = Vec::new();
    for stmt in [
        IrStmt::Delete {
            record: row.clone(),
            mode: IrDeleteMode::Archive,
            span: sp(0, 1),
        },
        IrStmt::Delete {
            record: row.clone(),
            mode: IrDeleteMode::Remove,
            span: sp(0, 1),
        },
        IrStmt::Set {
            record: row.clone(),
            changes: typed(
                IrExpr::Object(vec![(
                    "done".to_string(),
                    typed(IrExpr::Bool(true), ResolvedType::Scalar(Scalar::Bool)),
                )]),
                widget.clone(),
            ),
            when: Some("Widget".to_string()),
            span: sp(0, 1),
        },
        IrStmt::Create {
            model: "demo.Widget".to_string(),
            input: typed(
                IrExpr::Object(vec![("title".to_string(), text_lit("t"))]),
                widget.clone(),
            ),
            when: Some("Widget".to_string()),
            binding: Some("created".to_string()),
            span: sp(0, 1),
        },
        IrStmt::Send {
            operation: "demo.Svc.ping".to_string(),
            args: typed(IrExpr::Object(vec![]), widget.clone()),
            when: Some(typed(
                IrExpr::Bool(true),
                ResolvedType::Scalar(Scalar::Bool),
            )),
            binding: Some("attempt".to_string()),
            span: sp(0, 1),
        },
        IrStmt::Schedule {
            key: int_lit(1),
            at: typed(
                IrExpr::Name("due".to_string()),
                ResolvedType::Scalar(Scalar::Datetime),
            ),
            event: "demo.Due".to_string(),
            payload: typed(IrExpr::Object(vec![]), widget.clone()),
            span: sp(0, 1),
        },
        IrStmt::Cancel {
            key: int_lit(1),
            span: sp(0, 1),
        },
        IrStmt::Emit {
            event: "demo.Due".to_string(),
            payload: typed(IrExpr::Object(vec![]), widget.clone()),
            span: sp(0, 1),
        },
    ] {
        all.extend(emitter.lower_stmt(&stmt, 1));
    }
    let text: Vec<&str> = all.iter().map(|(line, _)| line.as_str()).collect();
    assert_eq!(text[0], "  await deleteRecord(c,row,{mode:'archive'});");
    assert_eq!(text[1], "  await deleteRecord(c,row,{mode:'remove'});");
    assert_eq!(
        text[2],
        "  await set(c,row,{done:true},{when:crudWhen.Widget});"
    );
    assert_eq!(
        text[3],
        "  const created = await create(c,\"demo.Widget\",{title:\"t\"},{when:crudWhen.Widget});"
    );
    assert_eq!(
        text[4],
        "  const attempt = await send(c,\"demo.Svc.ping\", {},{when:()=>true});"
    );
    assert_eq!(text[5], "  await schedule(c,1n,due,\"demo.Due\",{});");
    assert_eq!(text[6], "  await cancel(c,1n);");
    assert_eq!(text[7], "  await emit(c,\"demo.Due\",{});");
    // Guard/effect order is source order.
    let modes: Vec<&str> = text.iter().take(2).copied().collect();
    assert!(
        modes[0].contains("archive") && modes[1].contains("remove"),
        "order preserved"
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty(), "effects lower cleanly: {diags:?}");

    // Call effects have no canonical-invocation lowering.
    let mut emitter = Emitter::new(&ir);
    let lines = emitter.lower_stmt(
        &IrStmt::Call {
            operation: "demo.other".to_string(),
            inputs: typed(IrExpr::Object(vec![]), widget),
            binding: None,
            span: sp(0, 1),
        },
        0,
    );
    assert!(lines[0].0.contains("throw new Error"), "call throws loudly");
    let (diags, _, _, _) = emitter.finish();
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6008");
    assert!(diags[0].message.contains("demo.other"));
}

/// Messages: static `message(source,{locales})` and parameterized
/// three-argument forms; `format(c,descriptor,{locale})`. Oracles:
/// `CanCheck.mjs` captions and `format(c,message(...),{locale:null})`.
#[test]
fn construct_messages_and_format() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let static_message = IrMessage {
        source: "Expense review".to_string(),
        variants: vec![("nl".to_string(), Some("Onkostenbeoordeling".to_string()))],
        params: vec![],
    };
    assert_eq!(
        emitter.lower_message(&static_message),
        "message(\"Expense review\",{nl:\"Onkostenbeoordeling\"})"
    );
    let count_param = IrMessage {
        source: "{n} tasks".to_string(),
        variants: vec![],
        params: vec![IrMessageParam {
            name: "n".to_string(),
            type_id: "int".to_string(),
            value: int_lit(3),
        }],
    };
    assert_eq!(
        emitter.lower_message(&count_param),
        "message(\"{n} tasks\",{},{n:{type:\"int\",value:3n}})"
    );
    let formatted = typed(
        IrExpr::Format {
            descriptor: Box::new(typed(
                IrExpr::Message(static_message),
                ResolvedType::Message(SymbolId(0)),
            )),
            locale: None,
        },
        ResolvedType::Scalar(Scalar::Text),
    );
    assert_eq!(
        emitter.lower_expr(&formatted),
        "format(c,message(\"Expense review\",{nl:\"Onkostenbeoordeling\"}),{locale:null})"
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty());
}

/// UI: lowercase server factories with one props object plus children
/// arrays. No `h`, HTML, hydration or stores. Oracles: `CanCheck.mjs`
/// `table({context,model,columns})`, `details({context,caption,children})`.
#[test]
fn construct_ui_factories() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let text_ty = ResolvedType::Scalar(Scalar::Text);
    let table = IrUi {
        factory: "table".to_string(),
        props: vec![
            ("model".to_string(), text_lit("demo.Widget")),
            (
                "columns".to_string(),
                typed(
                    IrExpr::Array(vec![text_lit("title"), text_lit("count")]),
                    ResolvedType::Array {
                        element: Box::new(text_ty.clone()),
                        ordered: true,
                        nonempty: true,
                    },
                ),
            ),
        ],
        children: vec![],
        row_scope: None,
        gate: None,
        span: sp(0, 1),
    };
    assert_eq!(
        emitter.lower_ui(&table),
        "table({context:c,model:\"demo.Widget\",columns:[\"title\",\"count\"]})"
    );
    let card = IrUi {
        factory: "card".to_string(),
        props: vec![("title".to_string(), text_lit("Work"))],
        children: vec![table],
        row_scope: None,
        gate: None,
        span: sp(0, 1),
    };
    assert_eq!(
        emitter.lower_ui(&card),
        "card({context:c,title:\"Work\",children:[table({context:c,model:\"demo.Widget\",columns:[\"title\",\"count\"]})]})"
    );
    // Unknown factories (h, native elements) are loud E6008.
    let bad = IrUi {
        factory: "h".to_string(),
        props: vec![],
        children: vec![],
        row_scope: None,
        gate: None,
        span: sp(0, 1),
    };
    let lowered = emitter.lower_ui(&bad);
    assert!(
        lowered.contains("throw new Error"),
        "unknown factory throws"
    );
    let (diags, _, _, _) = emitter.finish();
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6008");
}

/// Pages: descriptors `{owner,path,title,description?,order?,group?,nav?,
/// admit,render}` in source order plus named page functions sharing the
/// descriptor. Oracle: the §13 Expense review page.
#[test]
fn construct_pages_admit_render() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let mut out = canlang_compiler::codegen::js::JsWriter::new();
    let review = IrPage {
        owner: "expense".to_string(),
        path: "/expenses/review".to_string(),
        title: IrMessage {
            source: "Expense review".to_string(),
            variants: vec![("nl".to_string(), Some("Onkostenbeoordeling".to_string()))],
            params: vec![],
        },
        description: None,
        order: None,
        group: None,
        nav_none: false,
        admit: vec![IrGuard::Role("expense.reviewer".to_string())],
        render: vec![IrUi {
            factory: "table".to_string(),
            props: vec![("model".to_string(), text_lit("expense.Expense"))],
            children: vec![],
            row_scope: None,
            gate: None,
            span: sp(0, 1),
        }],
        fn_name: "reviewPage".to_string(),
        descriptor_name: "reviewPageDescriptor".to_string(),
        span: sp(0, 1),
    };
    let mine = IrPage {
        owner: "expense".to_string(),
        path: "/expenses/mine".to_string(),
        title: IrMessage {
            source: "Mine".to_string(),
            variants: vec![],
            params: vec![],
        },
        description: None,
        order: Some(2),
        group: Some("personal".to_string()),
        nav_none: true,
        admit: vec![],
        render: vec![],
        fn_name: "minePage".to_string(),
        descriptor_name: "minePageDescriptor".to_string(),
        span: sp(1, 2),
    };
    // Source order is declaration order (review first).
    emitter.lower_page(&review, &mut out);
    emitter.lower_page(&mine, &mut out);
    let module = out.finish("test.mjs".to_string());
    assert!(
        // Descriptors are exported: artifact.pages[].export names an
        // importable binding (B1 loadability).
        module.js.contains("export const reviewPageDescriptor={owner:\"expense\",path:\"/expenses/review\",title:message(\"Expense review\",{nl:\"Onkostenbeoordeling\"}),admit:async(c,routeBindings={})=>{check(hasRole(c,\"expense.reviewer\"),\"forbidden\");return {};},render:reviewPage};"),
        "review descriptor:\n{}",
        module.js
    );
    assert!(
        module.js.contains("export async function reviewPage(c,bindings){return renderPage(c,reviewPageDescriptor,()=>[table({context:c,model:\"expense.Expense\"})]);}"),
        "review function:\n{}",
        module.js
    );
    assert!(
        module
            .js
            .contains("order:2n,group:\"personal\",nav:\"none\""),
        "order/group/nav slots:\n{}",
        module.js
    );
    let review_pos = module.js.find("reviewPageDescriptor").unwrap();
    let mine_pos = module.js.find("minePageDescriptor").unwrap();
    assert!(review_pos < mine_pos, "descriptors in source order");
    let (diags, _, _, pages) = emitter.finish();
    assert!(diags.is_empty());
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].path, "/expenses/review");
    assert_eq!(pages[1].path, "/expenses/mine");
}

/// Preferences preamble: a page reading `preferences` binds the per-app
/// record from admit() `bindings`, never from the presentation context
/// (which has no `preferences` field). Oracle: F2.
#[test]
fn construct_page_preferences_preamble_reads_bindings() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let mut out = canlang_compiler::codegen::js::JsWriter::new();
    let text_ty = ResolvedType::Scalar(Scalar::Text);
    let page = IrPage {
        owner: "expense".to_string(),
        path: "/expenses/prefs".to_string(),
        title: IrMessage {
            source: "Prefs".to_string(),
            variants: vec![],
            params: vec![],
        },
        description: None,
        order: None,
        group: None,
        nav_none: false,
        admit: vec![],
        render: vec![IrUi {
            factory: "text".to_string(),
            props: vec![(
                "value".to_string(),
                typed(
                    IrExpr::Member {
                        base: Box::new(typed(
                            IrExpr::Name("preferences".to_string()),
                            text_ty.clone(),
                        )),
                        field: "view".to_string(),
                    },
                    text_ty.clone(),
                ),
            )],
            children: vec![],
            row_scope: None,
            gate: None,
            span: sp(0, 1),
        }],
        fn_name: "prefsPage".to_string(),
        descriptor_name: "prefsPageDescriptor".to_string(),
        span: sp(0, 1),
    };
    emitter.lower_page(&page, &mut out);
    let module = out.finish("test.mjs".to_string());
    assert!(
        module.js.contains("export async function prefsPage(c,bindings){const preferences=bindings.preferences.expense;return renderPage(c,prefsPageDescriptor,()=>[text({context:c,value:preferences.view})]);}"),
        "preamble reads bindings:\n{}",
        module.js
    );
    assert!(
        !module.js.contains("c.preferences"),
        "no pctx preferences read:\n{}",
        module.js
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty());
}

/// Admit write side: admit() returns authoring preference defaults inside
/// bindings, matching the preamble read (`bindings.preferences.<App>`).
/// A write-side regression crashes prefs pages at runtime. Oracle: F2.
#[test]
fn construct_page_admit_returns_preference_defaults() {
    let mut ir = fixture_ir();
    let span = sp(0, 1);
    let next = ir.items.len() as u32;
    ir.items.push(IrItem {
        id: SymbolId(next),
        canonical: "demo.Preferences".to_string(),
        name: "Preferences".to_string(),
        module: ModuleId(0),
        span,
        exported: false,
        kind: IrItemKind::Preferences {
            fields: vec![SymbolId(next + 1)],
            validate: None,
        },
    });
    ir.items.push(IrItem {
        id: SymbolId(next + 1),
        canonical: "demo.Preferences.view".to_string(),
        name: "view".to_string(),
        module: ModuleId(0),
        span,
        exported: false,
        kind: IrItemKind::Field {
            owner: SymbolId(next),
            ty: IrType::Known(ResolvedType::Scalar(Scalar::Text)),
            default: Some(IrDefault::Literal(text_lit("all"))),
            server: None,
            modifiers: IrModifiers::default(),
            label: None,
        },
    });
    let mut emitter = Emitter::new(&ir);
    let mut out = canlang_compiler::codegen::js::JsWriter::new();
    let page = IrPage {
        owner: "demo".to_string(),
        path: "/prefs".to_string(),
        title: IrMessage {
            source: "Prefs".to_string(),
            variants: vec![],
            params: vec![],
        },
        description: None,
        order: None,
        group: None,
        nav_none: false,
        admit: vec![],
        render: vec![],
        fn_name: "prefsPage".to_string(),
        descriptor_name: "prefsPageDescriptor".to_string(),
        span,
    };
    emitter.lower_page(&page, &mut out);
    let module = out.finish("test.mjs".to_string());
    assert!(
        module.js.contains(
            "admit:async(c,routeBindings={})=>{return {preferences:{demo:{view:\"all\"}},};}"
        ),
        "admit returns prefs:\\n{}",
        module.js
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty());
}

/// Fixtures/recipes: model, user, file and delivery recipe shapes.
/// Oracles: `CanCheck.mjs` `exampleFixtures` (heartbeat model recipe,
/// worker user recipe, attempt delivery recipe).
#[test]
fn construct_fixtures_and_recipes() {
    let ir = fixture_ir();
    let widget = ResolvedType::Record {
        symbol: SymbolId(0),
        stored: true,
    };
    let suite = BddSuite {
        scope: "demo.submit".to_string(),
        fixtures: vec![
            IrFixture {
                name: "job".to_string(),
                canonical: "demo.job".to_string(),
                kind: IrFixtureKind::Model {
                    model: "demo.Widget".to_string(),
                    fields: typed(
                        IrExpr::Object(vec![("title".to_string(), text_lit("Reconcile"))]),
                        widget.clone(),
                    ),
                },
                dependencies: vec![],
                span: sp(0, 1),
            },
            IrFixture {
                name: "worker".to_string(),
                canonical: "demo.worker".to_string(),
                kind: IrFixtureKind::User {
                    roles: vec!["demo.operations".to_string()],
                },
                dependencies: vec![],
                span: sp(0, 1),
            },
            IrFixture {
                name: "attempt".to_string(),
                canonical: "demo.attempt".to_string(),
                kind: IrFixtureKind::Delivery {
                    operation: "demo.Svc.ping".to_string(),
                    request: Box::new(typed(
                        IrExpr::Object(vec![("to".to_string(), text_lit("ops"))]),
                        widget.clone(),
                    )),
                    status: Some(Box::new(text_lit("failed"))),
                    result: None,
                    error: None,
                },
                dependencies: vec!["job".to_string()],
                span: sp(0, 1),
            },
        ],
        imported: vec![IrExampleImport {
            provider: "employee".to_string(),
            member: "test_worker".to_string(),
            alias: "test_worker".to_string(),
        }],
        tables: vec![],
        sequences: vec![],
        span: sp(0, 1),
    };
    let (module, diags, _) = bdd::emit_suite(&ir, &suite);
    assert!(diags.is_empty(), "recipes lower cleanly: {diags:?}");
    assert_eq!(module.scope, "demo.submit");
    assert_eq!(module.module.path, "tests/demo_submit.mjs");
    let js = &module.module.js;
    assert!(
        js.contains("Test-only example artifact"),
        "test-only marker"
    );
    assert!(
        js.contains("export const exampleImports=[{provider:\"employee\",member:\"test_worker\",alias:\"test_worker\"}];"),
        "example imports:\n{js}"
    );
    assert!(
        js.contains("export function exampleFixtures({self,other,imported}){"),
        "factory"
    );
    assert!(
        js.contains("const job={model:\"demo.Widget\",dependencies:[],value:async(c,s)=>({title:\"Reconcile\"})};"),
        "model recipe:\n{js}"
    );
    assert!(
        js.contains(
            "const worker={dependencies:[],user:async(c,s)=>({roles:[\"demo.operations\"]})};"
        ),
        "user recipe:\n{js}"
    );
    assert!(
        js.contains("const attempt={dependencies:[job],delivery:\"demo.Svc.ping\",values:async(c,s)=>({request:{to:\"ops\"},status:\"failed\"})};"),
        "delivery recipe:\n{js}"
    );
    // DESIGN §13 normative: exactly `{fixtures:{...},examples:[...]}`;
    // recipes never share the top-level namespace with example metadata.
    // (CanCheck.mjs oracle is flat here; per the file rule above the
    // normative text wins.)
    assert!(
        js.contains("return {fixtures:{job,worker,attempt},examples:[]};"),
        "return shape:\n{js}"
    );
}

/// Tables: common dependencies/inputs plus rows with expected values or
/// exact errors. Oracle: `CanCheck.mjs` pause/resume tables.
#[test]
fn construct_tables() {
    let ir = fixture_ir();
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);
    let widget = ResolvedType::Record {
        symbol: SymbolId(0),
        stored: true,
    };
    let row_state = |value: bool| IrTableRow {
        dependencies: vec![],
        values: typed(
            IrExpr::Array(vec![typed(IrExpr::Bool(value), bool_ty.clone())]),
            ResolvedType::Array {
                element: Box::new(bool_ty.clone()),
                ordered: true,
                nonempty: true,
            },
        ),
        expected: Some(typed(
            IrExpr::Array(vec![typed(IrExpr::Bool(!value), bool_ty.clone())]),
            ResolvedType::Array {
                element: Box::new(bool_ty.clone()),
                ordered: true,
                nonempty: true,
            },
        )),
        error: None,
        span: sp(0, 1),
    };
    let row_error = IrTableRow {
        dependencies: vec![],
        values: typed(
            IrExpr::Array(vec![typed(IrExpr::Bool(true), bool_ty.clone())]),
            ResolvedType::Array {
                element: Box::new(bool_ty.clone()),
                ordered: true,
                nonempty: true,
            },
        ),
        expected: None,
        error: Some("forbidden".to_string()),
        span: sp(0, 1),
    };
    let suite = BddSuite {
        scope: "demo.submit".to_string(),
        fixtures: vec![],
        imported: vec![],
        tables: vec![IrTable {
            operation: "demo.submit".to_string(),
            dependencies: vec!["job".to_string()],
            inputs: typed(
                IrExpr::Object(vec![(
                    "check".to_string(),
                    typed(IrExpr::Name("s_job".to_string()), widget.clone()),
                )]),
                widget.clone(),
            ),
            selectors: vec!["as".to_string(), "check.enabled".to_string()],
            observations: vec![typed(
                IrExpr::Member {
                    base: Box::new(typed(IrExpr::Name("s_check".to_string()), widget.clone())),
                    field: "enabled".to_string(),
                },
                bool_ty.clone(),
            )],
            rows: vec![row_state(true), row_error],
            span: sp(0, 1),
        }],
        sequences: vec![],
        span: sp(0, 1),
    };
    let (module, diags, _) = bdd::emit_suite(&ir, &suite);
    assert!(diags.is_empty(), "tables lower cleanly: {diags:?}");
    let js = &module.module.js;
    assert!(
        js.contains("{operation:\"demo.submit\",dependencies:[job],inputs:async(c,s)=>({check:s_job}),selectors:[\"as\",\"check.enabled\"],observations:[async(c,s)=>s_check.enabled],rows:["),
        "table shape:\n{js}"
    );
    assert!(
        js.contains("{dependencies:[],values:async(c,s)=>([true]),expected:async(c,s)=>([false])}"),
        "passing row:\n{js}"
    );
    assert!(
        js.contains("{dependencies:[],values:async(c,s)=>([true]),error:\"forbidden\"}"),
        "error row:\n{js}"
    );
}

/// Sequences: call/binding/assertion steps with canonical type ids.
/// Oracle: `CanApprove.mjs` submit sequences.
#[test]
fn construct_sequences() {
    let ir = fixture_ir();
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);
    let widget = ResolvedType::Record {
        symbol: SymbolId(0),
        stored: true,
    };
    let suite = BddSuite {
        scope: "demo.submit".to_string(),
        fixtures: vec![],
        imported: vec![],
        tables: vec![],
        sequences: vec![IrSequence {
            operation: "demo.submit".to_string(),
            dependencies: vec!["job".to_string()],
            steps: vec![
                IrStep::Call {
                    operation: "demo.Widget.create".to_string(),
                    by: typed(
                        IrExpr::Name("s_self".to_string()),
                        ResolvedType::Scalar(Scalar::User),
                    ),
                    inputs: typed(
                        IrExpr::Object(vec![("title".to_string(), text_lit("t"))]),
                        widget.clone(),
                    ),
                    request: None,
                    bind: Some("created".to_string()),
                    error: None,
                },
                IrStep::Binding {
                    name: "ok".to_string(),
                    value: typed(IrExpr::Bool(true), bool_ty.clone()),
                },
                IrStep::Assertion {
                    observations: typed(
                        IrExpr::Array(vec![typed(IrExpr::Bool(true), bool_ty.clone())]),
                        ResolvedType::Array {
                            element: Box::new(bool_ty.clone()),
                            ordered: true,
                            nonempty: true,
                        },
                    ),
                    expected: typed(
                        IrExpr::Array(vec![typed(IrExpr::Bool(true), bool_ty.clone())]),
                        ResolvedType::Array {
                            element: Box::new(bool_ty.clone()),
                            ordered: true,
                            nonempty: true,
                        },
                    ),
                    types: vec!["bool".to_string()],
                },
            ],
            span: sp(0, 1),
        }],
        span: sp(0, 1),
    };
    let (module, diags, _) = bdd::emit_suite(&ir, &suite);
    assert!(diags.is_empty(), "sequences lower cleanly: {diags:?}");
    let js = &module.module.js;
    assert!(
        js.contains("{operation:\"demo.submit\",dependencies:[job],sequence:["),
        "sequence shape:\n{js}"
    );
    assert!(
        js.contains("{operation:\"demo.Widget.create\",by:async(c,s,b)=>(s_self),inputs:async(c,s,b)=>({title:\"t\"}),bind:\"created\"}"),
        "call step:\n{js}"
    );
    assert!(
        js.contains("{let:\"ok\",value:async(c,s,b)=>(true)}"),
        "binding step:\n{js}"
    );
    assert!(
        js.contains(concat!(
            "{observations:async(c,s,b)=>([true]),",
            "expected:async(c,s,b)=>([true]),",
            "types:[\"bool\"]}"
        )),
        "assertion step:\n{js}"
    );
}

// --- Driver errors and link checks -------------------------------------------

/// Incomplete analyses are refused with a precise E6005 unless the
/// caller passes the explicit test-only acknowledgment.
#[test]
fn refuses_incomplete_analysis_without_ack() {
    let (db, id) = load_example("TeamTasks.can");
    let (program, result) = check_example(&db, id, None);
    assert!(!result.complete);
    let sources = EmitSources {
        db: &db,
        result: &result,
        catalog: None,
        options: EmitOptions::new(),
    };
    let (artifact, diags) = emit(&program, &sources);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6005");
    assert!(diags[0].message.contains("test-only acknowledgment"));
    assert!(artifact.modules.is_empty(), "refusal emits no modules");
    assert_eq!(artifact.sources.len(), 1, "refusal keeps sources");
}

/// C3: derived-function results resolve from `symbol_results` (the
/// types pass publishes the declared `: type` there), not
/// `symbol_types` — no spurious E6006.
#[test]
fn derive_result_resolves_from_symbol_results() {
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive n(): int = count(Todo)\nWhen\nThen\n";
    let mut db = SourceDb::new();
    let id = db.add("derive.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (_artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "derive result is published: {diags:?}"
    );
}

/// Hermetic fixture catalog with implemented/planned/external entries.
/// Unique temp file per call: tests run in parallel threads under one
/// process id, so a fixed filename races (write/remove vs read).
fn unique_temp_path(stem: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("can-codegen-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    dir.join(format!("{stem}-{n}.json"))
}

fn fixture_catalog() -> (Catalog, PathBuf) {
    let path = unique_temp_path("fixture-catalog");
    let dir = path.parent().expect("temp dir").to_path_buf();
    std::fs::write(
        &path,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[
{"id":"count","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"sum","kind":"builtin","signature":"sum(domain:C<int>)->int","effects":"pure","availability":"planned","owner":"lane-02"},
{"id":"active_member","kind":"builtin","signature":"active_member(person:user,team:Team)->bool","effects":"state-read","availability":"external","owner":"lane-03"}
]}"#,
    )
    .expect("write fixture catalog");
    let primary = Span::new(SourceId(0), 0, 0);
    let request = CatalogRequest {
        flag: Some(path.as_path()),
        env: None,
        cwd: dir.as_path(),
        primary,
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "fixture catalog loads: {diags:?}");
    (catalog.expect("catalog"), path)
}

/// Golden catalog: every builtin the golden examples call, all
/// implemented, with production effects (`count`/`first`/`sum` are
/// state-read; `money`/`trim`/`format` are pure). Overloads accept the
/// golden call shapes (see the G12/awaited assertions in the goldens).
fn golden_catalog() -> (Catalog, PathBuf) {
    let path = unique_temp_path("golden-catalog");
    let dir = path.parent().expect("temp dir").to_path_buf();
    std::fs::write(
        &path,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[
{"id":"count","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"first","kind":"builtin","signature":"first(domain:C<T>)->T?","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"sum","kind":"builtin","signature":"sum(domain:C<T>,currency:currency)->money","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"money","kind":"builtin","signature":"money(minor:int,currency:currency)->money","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"trim","kind":"builtin","signature":"trim(value:text)->text","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"format","kind":"builtin","signature":"format(descriptor:message)->text","effects":"pure","availability":"implemented","owner":"lane-02"}
]}"#,
    )
    .expect("write golden catalog");
    let primary = Span::new(SourceId(0), 0, 0);
    let request = CatalogRequest {
        flag: Some(path.as_path()),
        env: None,
        cwd: dir.as_path(),
        primary,
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "golden catalog loads: {diags:?}");
    (catalog.expect("catalog"), path)
}

/// Unavailable capabilities are precise E6007 naming producer and
/// availability — never silent emission.
#[test]
fn unavailable_capability_errors() {
    use canlang_compiler::codegen::ir::ReferencedBuiltin;
    let (catalog, path) = fixture_catalog();
    let refs = ["count", "sum", "active_member", "missing_op"]
        .iter()
        .map(|id| ReferencedBuiltin {
            id: id.to_string(),
            span: sp(0, 1),
        })
        .collect::<Vec<_>>();
    let diags = artifact::check_builtin_availability(&refs, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    // Implemented passes; planned/external/missing fail loudly.
    assert_eq!(diags.len(), 3, "planned/external/missing fail: {diags:?}");
    for diag in &diags {
        assert_eq!(diag.code, "E6007");
    }
    let messages: Vec<&str> = diags.iter().map(|d| d.message.as_str()).collect();
    assert!(
        messages
            .iter()
            .any(|m| m.contains("'sum'") && m.contains("planned") && m.contains("lane-02")),
        "planned names producer: {messages:?}"
    );
    assert!(
        messages.iter().any(|m| m.contains("'active_member'")
            && m.contains("external")
            && m.contains("lane-03")),
        "external names producer: {messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|m| m.contains("'missing_op'") && m.contains("not in producer catalog")),
        "missing names catalog: {messages:?}"
    );
    // Without a catalog, references cannot be verified at all.
    let diags = artifact::check_builtin_availability(&refs[..1], None);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6007");
    assert!(
        diags[0]
            .message
            .contains("no producer catalog was provided")
    );
    // Duplicate references report once (first use-site wins).
    let dupes = vec![
        ReferencedBuiltin {
            id: "sum".to_string(),
            span: sp(0, 1),
        },
        ReferencedBuiltin {
            id: "sum".to_string(),
            span: sp(2, 3),
        },
    ];
    let diags = artifact::check_builtin_availability(&dupes, Some(&catalog));
    assert_eq!(diags.len(), 1);
}

/// Requires pins the consumed builtin catalog major and the scalar/state
/// families the entrypoint actually imports.
#[test]
fn requires_pins_catalog_and_families() {
    let (catalog, path) = fixture_catalog();
    assert_eq!(catalog.version(), "2.5.0-test");
    let mut ir = fixture_ir();
    ir.catalog_version = catalog.version().to_string();
    let js_out = js::emit_program(&ir);
    let db = SourceDb::new();
    let (artifact, diags) = artifact::assemble(&ir, &js_out, &[], &[], &db, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "pinned requires are clean: {diags:?}");
    assert_eq!(artifact.requires.len(), 1);
    assert_eq!(artifact.requires[0].capability, "canlang.builtins");
    assert_eq!(artifact.requires[0].min_version, 2);
    // Empty catalog version cannot pin and is a loud E6007.
    let mut ir = fixture_ir();
    ir.catalog_version = String::new();
    let js_out = js::emit_program(&ir);
    let (artifact, diags) = artifact::assemble(&ir, &js_out, &[], &[], &db, Some(&catalog));
    assert!(artifact.requires.is_empty());
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6007");
    assert!(diags[0].message.contains("catalog_version is empty"));
}

/// Checked-but-unlowerable schema positions are loud E6008 (union field
/// types have no §13 field-schema lowering).
#[test]
fn unsupported_schema_positions_error() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let union = ResolvedType::Union(vec![SymbolId(0), SymbolId(3)]);
    let schema = emitter.field_schema(&union, sp(0, 1));
    assert!(
        schema.contains("demo.Widget|demo.Summary"),
        "best-effort id: {schema}"
    );
    let (diags, _, _, _) = emitter.finish();
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6008");
}

/// Source-map mappings round-trip through VLQ with exact segments.
#[test]
fn sourcemap_mappings_round_trip() {
    use canlang_compiler::codegen::js::{JsLine, JsWriter};
    let mut db = SourceDb::new();
    db.add("a.can".into(), "app A\nGiven\n".into());
    let mut writer = JsWriter::new();
    writer.push(
        Span::new(SourceId(0), 0, 5),
        Some("appDefinition".to_string()),
        "const x=1;",
    );
    writer.push(Span::new(SourceId(0), 6, 11), None, "const y=2;");
    let module = writer.finish("a.mjs".to_string());
    let map = sourcemap::build("a.mjs", &db, &module.lines);
    assert_eq!(map.file, "a.mjs");
    assert_eq!(map.sources, vec!["a.can".to_string()]);
    assert_eq!(map.sources_content.len(), 1);
    assert_eq!(map.names, vec!["appDefinition".to_string()]);
    let lines = sourcemap::decode_mappings(&map.mappings).expect("decode");
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].len(), 1);
    assert_eq!(lines[0][0].src, Some(0));
    assert_eq!(lines[0][0].src_line, Some(0));
    assert_eq!(lines[0][0].src_col, Some(0));
    assert_eq!(lines[0][0].name, Some(0));
    assert_eq!(lines[1][0].src_line, Some(1));
    assert_eq!(lines[1][0].name, None);
    assert_eq!(
        JsLine {
            line: 1,
            span: sp(0, 0),
            name: None
        }
        .line,
        1
    );
    // Malformed mappings fail loudly instead of misresolving.
    assert!(sourcemap::decode_mappings(";;;,,,").is_err());
    assert!(sourcemap::decode_mappings("!").is_err());
}

/// F3 forms: a `form` without `fields=` defaults to the target model's
/// stored field names in schema order — the same array the explicit-all
/// spelling would emit. Explicit `fields=` wins (pinned by the TeamTasks
/// golden's `fields:["title","assignee"]` assertion above).
#[test]
fn form_fields_default_to_model_schema() {
    let (db, id) = load_example("TeamTasks.can");
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, _diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);
    let entry = &artifact.modules[0].js;
    // `form Note.create display=inline` (examples/TeamTasks.can:50) has no
    // `fields=`: it defaults to every stored Note field in schema order,
    // exactly the explicit `fields=title,content` array.
    assert!(
        entry.contains(
            "operation:\"TeamNotes.Note.create\",display:\"inline\",fields:[\"title\",\"content\"]"
        ),
        "defaulted form fields:\n{entry}"
    );
}

/// F3 forms: a `form` whose operation is unresolvable still omits
/// `fields` (loud path preserved — no silent empty default).
#[test]
fn form_fields_unknown_op_stays_loud() {
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\nThen\n page / title=\"T\"\n  card \"C\"\n   form Nope.nope display=inline\n";
    let mut db = SourceDb::new();
    let id = db.add("unknown-op-form.can".to_string(), src.to_string());
    let (program, result) = check_example(&db, id, None);
    let (artifact, _diags) = emit_test_only(&program, &db, &result, None);
    let entry = &artifact.modules[0].js;
    // No operation prop (unresolvable) and crucially no `fields` prop:
    // ui fails loudly on the missing required prop, as before.
    assert!(
        entry.contains("form({context:c,display:\"inline\"})"),
        "loud form without fields:\n{entry}"
    );
}

// --- B2a: catalog factories, gates, slots, value queries, sequences ------
// Oracle correspondence: `stat`/`input`/`breadcrumbs`/`pagination`/
// `badge`/`button`/`modal`+`slot`/`divider` shapes follow the handwritten
// `draft/*.mjs` targets; the gated `cond ? node : null` follows the
// `CanBoard.mjs` alert precedent. Where the drafts disagree with the
// implemented stdlib (projection-lambda `sum`), the test follows the
// stdlib: `select` lowers to `.map` on the lowered domain.

/// Catalog factories lower from source: selectors stay selector strings,
/// captions stay messages, slots stay named suites, gates become
/// ternaries.
#[test]
fn catalog_factories_lower_from_source() {
    let src = "app Probe uses=[shop]\npackage shop\n Given\n  export Item { name:text label=\"Item\"@{nl=\"Artikel\"} }\n  policy Item read=members\n When\n  crud Item by=members fields=name delete=none\n Then\n  page / title=\"Shop\"@{nl=\"Winkel\"}\n   breadcrumbs\n   card \"Sell\"@{nl=\"Verkopen\"}\n    form Item.create\n     input name\n    list Item\n     badge row.name\n     alert\n      require row.name != \"\"\n      text row.name\n     divider \"More\"@{nl=\"Meer\"}\n     join\n      button opens=dlg\n     modal \"Dialog\"@{nl=\"Dialoog\"} id=dlg\n      slot content\n       text row.name\n     pagination\n    stat 1,2\n";
    let mut db = SourceDb::new();
    let id = db.add("probe-ui.can".to_string(), src.to_string());
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "clean lowerings: {diags:?}");
    let entry = &artifact.modules[0].js;
    for marker in [
        "breadcrumbs({context:c})",
        "input({context:c,field:\"name\"})",
        "badge({context:rowView,value:row.name})",
        "row.name !== \"\" ? alert({context:rowView,children:[text({context:rowView,values:[row.name]})]}) : null",
        "divider({context:rowView,caption:message(\"More\",{nl:\"Meer\"})})",
        "join({context:rowView,children:[button({context:rowView,opens:\"dlg\"})]})",
        "modal({context:rowView,caption:message(\"Dialog\",{nl:\"Dialoog\"}),id:\"dlg\",children:[slot({context:rowView,name:\"content\",children:[text({context:rowView,values:[row.name]})]})]})",
        "pagination({context:rowView})",
        "stat({context:c,values:[1n,2n]})",
    ] {
        assert!(entry.contains(marker), "missing {marker}:\n{entry}");
    }
    assert!(
        !entry.contains("throw new Error"),
        "nothing throws:\n{entry}"
    );
}

/// Catalog profile violations stay loud `E6008`, one precise diagnostic
/// per violated position (never a silent drop or an invented default).
#[test]
fn catalog_profile_violations_stay_loud() {
    let src = "app Probe uses=[shop]\npackage shop\n Given\n  export Item { name:text label=\"Item\"@{nl=\"Artikel\"} }\n  policy Item read=members\n When\n  crud Item by=members fields=name delete=none\n Then\n  page / title=\"Shop\"@{nl=\"Winkel\"}\n   pagination\n   card \"Sell\"@{nl=\"Verkopen\"}\n    button\n    modal \"No slots\"@{nl=\"Geen\"}\n    badge \"x\"\n     text \"y\"\n    input\n    stat\n    divider 42\n";
    let mut db = SourceDb::new();
    let id = db.add("probe-bad-ui.can".to_string(), src.to_string());
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (_artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);
    let messages: Vec<&str> = diags.iter().map(|d| d.message.as_str()).collect();
    for marker in [
        "cannot lower pagination: pagination is valid only inside a collection",
        "cannot lower button: bound controls need one binding",
        "cannot lower modal: activated panels need a content slot",
        "cannot lower badge: badges take no content suite",
        "cannot lower input: field controls need an owning form",
        "cannot lower input: field controls take an input selector",
        "cannot lower stat: stat needs observations or a value slot",
        "cannot lower divider: dividers take a text caption",
    ] {
        assert!(
            messages.iter().any(|m| m.contains(marker)),
            "missing {marker}: {messages:?}"
        );
    }
    assert!(
        diags.iter().all(|d| d.code == "E6008"),
        "only E6008: {diags:?}"
    );
}

/// Value-domain queries lower through array combinators; `select`
/// appends one alias-scoped `.map` on either domain. The model `where`
/// keeps the `row` rewrite while the projection binds the alias.
#[test]
fn value_queries_lower_from_source() {
    let src = "app Probe uses=[shop]\npackage shop\n Given\n  export Item { name:text, stock:int label=\"Item\"@{nl=\"Artikel\"} }\n  policy Item read=members\n When\n  crud Item by=members fields=name,stock delete=none\n  scenario restock(ids:int[]) by=members\n   do\n    let picked=ids as n where n > 1\n    let names=Item as item where item.stock > 0 select item.name\n Then\n  page / title=\"Shop\"@{nl=\"Winkel\"}\n   card \"Go\"@{nl=\"Gaan\"}\n    text \"hi\"\n";
    let mut db = SourceDb::new();
    let id = db.add("probe-query.can".to_string(), src.to_string());
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "clean lowerings: {diags:?}");
    let entry = &artifact.modules[0].js;
    assert!(
        entry.contains("const picked = ids.filter((n)=>n > 1n);"),
        "value where filters:\n{entry}"
    );
    assert!(
        entry.contains("const names = (await records(c,\"shop.Item\",{where:(row)=>row.stock > 0n})).map((item)=>item.name);"),
        "model select maps:\n{entry}"
    );
}

/// Sequence `as` bindings publish the call's declared result type, so
/// later member chains resolve (here `Receipt.n` to `int`).
#[test]
fn sequence_as_binding_decodes() {
    let src = "app Probe uses=[shop]\npackage shop\n Given\n  contract Receipt { n:int } label=\"Receipt\"@{nl=\"Bon\"}\n  export Item { name:text label=\"Item\"@{nl=\"Artikel\"} }\n  fixture one=Item {name=\"a\"}\n  policy Item read=members\n When\n  crud Item by=members fields=name delete=none\n  scenario pick(name:text) read=true -> Receipt by=members\n   do\n    return Receipt {n=1}\n   examples seed=[one]\n    do\n     call pick {name=\"a\"} by=other as r\n     r.n -> 1\n Then\n  page / title=\"Shop\"@{nl=\"Winkel\"}\n   card \"Go\"@{nl=\"Gaan\"}\n    text \"hi\"\n";
    let mut db = SourceDb::new();
    let id = db.add("probe-as.can".to_string(), src.to_string());
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "clean lowerings: {diags:?}");
    assert_eq!(artifact.tests.len(), 1);
    let suite = &artifact.tests[0].module.js;
    assert!(
        suite.contains("inputs:async(c,s,b)=>({name:\"a\"}),bind:\"r\""),
        "as binding:\n{suite}"
    );
    assert!(
        suite.contains(
            "{observations:async(c,s,b)=>([b.r.n]),expected:async(c,s,b)=>([1n]),types:[\"int\"]}"
        ),
        "bound member assertion:\n{suite}"
    );
}

/// Gated UI nodes lower as `cond ? node : null`; an async gate makes
/// the enclosing row scope async.
#[test]
fn construct_ui_gate_ternary() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);
    let gate = typed(
        IrExpr::Binary {
            op: IrBinOp::Ne,
            left: Box::new(typed(
                IrExpr::Member {
                    base: Box::new(typed(
                        IrExpr::Name("row".to_string()),
                        ResolvedType::Scalar(Scalar::Text),
                    )),
                    field: "status".to_string(),
                },
                ResolvedType::Scalar(Scalar::Text),
            )),
            right: Box::new(text_lit("draft")),
        },
        bool_ty,
    );
    let alert = IrUi {
        factory: "alert".to_string(),
        props: vec![],
        children: vec![],
        row_scope: None,
        gate: Some(gate),
        span: sp(0, 1),
    };
    assert_eq!(
        emitter.lower_ui(&alert),
        "row.status !== \"draft\" ? alert({context:c}) : null"
    );
    // An async gate forces the row lambda async, like an async child.
    let async_gate = typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "count".to_string(),
                awaited: true,
            },
            args: vec![],
        },
        ResolvedType::Scalar(Scalar::Int),
    );
    let gated = IrUi {
        factory: "text".to_string(),
        props: vec![],
        children: vec![],
        row_scope: None,
        gate: Some(async_gate),
        span: sp(0, 1),
    };
    let list = IrUi {
        factory: "list".to_string(),
        props: vec![("model".to_string(), text_lit("demo.Widget"))],
        children: vec![gated],
        row_scope: Some(("row".to_string(), "rowView".to_string())),
        gate: None,
        span: sp(0, 1),
    };
    assert!(
        emitter
            .lower_ui(&list)
            .contains("renderRow:async(row,rowView)=>["),
        "async gate propagates"
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty(), "clean: {diags:?}");
}

/// Value queries lower to filter/map chains; awaited bases parenthesize
/// so the combinator binds the awaited array, not the call.
#[test]
fn construct_value_query() {
    let ir = fixture_ir();
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);
    let name = |name: &str, ty: ResolvedType| typed(IrExpr::Name(name.to_string()), ty);
    // `selected as expense select expense.amount`: a bare-name base needs
    // no parens.
    let query = typed(
        IrExpr::Query(IrQuery {
            domain: IrQueryDomain::Value {
                base: Box::new(name(
                    "selected",
                    ResolvedType::Array {
                        element: Box::new(int_ty.clone()),
                        ordered: true,
                        nonempty: false,
                    },
                )),
                alias: "expense".to_string(),
            },
            parent: None,
            where_pred: None,
            where_async: false,
            order: vec![],
            limit: None,
            archived: None,
            select: Some(Box::new(name("expense", int_ty.clone()))),
            select_param: Some("expense".to_string()),
        }),
        int_ty.clone(),
    );
    let (text, _, diags) = lower(&ir, &query);
    assert_eq!(text, "selected.map((expense)=>expense)");
    assert!(diags.is_empty(), "clean: {diags:?}");
    // Awaiting bases parenthesize: `(await records(...)).map(...)`.
    let fetched = typed(
        IrExpr::Query(IrQuery {
            domain: IrQueryDomain::Model("demo.Widget".to_string()),
            parent: None,
            where_pred: None,
            where_async: false,
            order: vec![],
            limit: None,
            archived: None,
            select: None,
            select_param: None,
        }),
        int_ty.clone(),
    );
    let query = typed(
        IrExpr::Query(IrQuery {
            domain: IrQueryDomain::Value {
                base: Box::new(fetched),
                alias: "row".to_string(),
            },
            parent: None,
            where_pred: Some(Box::new(typed(
                IrExpr::Binary {
                    op: IrBinOp::Gt,
                    left: Box::new(name("row", int_ty.clone())),
                    right: Box::new(int_lit(1)),
                },
                bool_ty,
            ))),
            where_async: false,
            order: vec![],
            limit: None,
            archived: None,
            select: None,
            select_param: None,
        }),
        int_ty.clone(),
    );
    let (text, _, diags) = lower(&ir, &query);
    assert_eq!(
        text,
        "(await records(c,\"demo.Widget\",{})).filter((row)=>row > 1n)"
    );
    assert!(diags.is_empty(), "clean: {diags:?}");
}
