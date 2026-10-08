//! Codegen golden and per-construct tests (lane-01 codegen, PR6).
//!
//! TEST-ONLY: every artifact asserted here is produced under the explicit
//! test-only incomplete-analysis acknowledgment (`EmitOptions::test_only`)
//! with a hermetic golden catalog, so `E6007` cannot fire and availability
//! is pinned, not discovered. Goldens run over the complete PR5+ analysis
//! (effects, examples, UI shape rules, handler sources); remaining `E6006`
//! gaps and `E6008` refused positions are pinned per golden with their
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

use canlang_compiler::analysis::catalog::{
    Catalog, CatalogRequest, StdOperation, load_catalog, std_operation,
};
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
            app_default_locale: None,
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
                    required_array: false,
                    default: None,
                    server: None,
                    modifiers: IrModifiers::default(),
                    label: None,
                    description: None,
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
                    required_array: false,
                    default: None,
                    server: None,
                    modifiers: IrModifiers::default(),
                    label: None,
                    description: None,
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
        migrations: Vec::new(),
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
        vec![
            "$can$m$5465616d4f6666696365.mjs",
            "$can$m$5465616d5461736b73.mjs",
            "$can$m$5465616d4e6f746573.mjs"
        ]
    );
    let entry = &artifact.modules[0].js;
    assert!(entry.contains("id:\"TeamOffice\""), "app id");
    assert!(entry.contains("compositions:{"), "compositions");
    assert!(
        entry.contains("\"TeamTasks\":{uses:[],appDefaultLocale:\"en\"}"),
        "TeamTasks assembly"
    );
    assert!(
        entry.contains("\"TeamNotes\":{uses:[],appDefaultLocale:\"en\"}"),
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
    //   Forms consume prepared field controls; unavailable navigation,
    //   list options and other owning profiles remain explicit E6008s.
    // - G10 examples: the update table (fixture recipe, common inputs,
    //   selectors, observations, rows with errors) lowered.
    // - G12 awaited: `count` is catalog state-read, so calls await.
    // - G13 builtins: `count` (entry + suite) and `format` (suite)
    //   referenced with true call-site spans.
    //
    // G3 models: labels, read grants, field modifiers/defaults/captions.
    assert!(
        entry.contains("\"TeamTasks.Todo\":{label:$can$u$6d657373616765(\"Task\",{nl:\"Taak\"})"),
        "Todo label"
    );
    assert!(
        entry.contains("readGrants:[{rule:\"Todo.read.1\",by:[\"members\"]}]"),
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
        entry.contains("values:{true:$can$u$6d657373616765(\"Done\""),
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
        entry.contains("values:{all:$can$u$6d657373616765(\"All tasks\""),
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
        entry.contains("label:$can$u$6d657373616765(\"Add\",{nl:\"Toevoegen\"})"),
        "crud create label"
    );
    assert!(!entry.contains("when:"), "no crud admission");
    assert!(!entry.contains("expose:false"), "no expose exclusion");
    // G9 pages and descriptions.
    assert!(
        entry.contains("pages:[$can$p$5465616d5461736b733a64657363726970746f723a2f,$can$p$5465616d4e6f7465733a64657363726970746f723a2f6e6f746573]"),
        "page descriptors"
    );
    assert!(entry.contains("disabled:[]"), "nothing disabled");
    assert!(
        entry.contains("description:$can$u$6d657373616765(\"Manage tasks and notes together.\""),
        "app description"
    );
    assert!(
        !entry.contains("selector:\"TeamTasks.view\""),
        "refused tabs selector is absent"
    );
    assert!(
        entry.contains("c.prepareForm({operation:\"TeamTasks.Todo.create\",fields:[\"title\",\"assignee\"],display:\"inline\",labels:{title:$can$u$6d657373616765(\"Title\",{nl:\"Titel\"}),assignee:$can$u$6d657373616765(\"Assignee\",{nl:\"Toegewezen aan\"})},authoredFields:[\"title\"]})"),
        "form operation"
    );
    // Field controls consume prepared props. Breadcrumbs and pagination
    // lack owning source carriers. No-recurse rule: children of an
    // *unlowered* factory are swallowed by its placeholder (one E6008
    // for the factory, none for the absorbed children).
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message
                .contains("cannot lower breadcrumbs: ancestry and label carriers")),
        "breadcrumbs carrier profile is refused"
    );
    assert!(
        entry.contains("$can$u$666f726d({...$can$f$666f726d.props,children:()=>[$can$u$696e707574({...$can$f$666f726d.field(\"title\")})]})"),
        "form children"
    );
    assert!(
        entry.contains(
            "children:()=>[$can$u$696e707574({...$can$f$666f726d.field(\"title\")}),$can$u$7465787461726561({...$can$f$666f726d.field(\"content\")})]"
        ),
        "textarea child"
    );
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message
                .contains("cannot lower pagination: cursor and label carriers")),
        "pagination carrier profile is refused"
    );
    assert!(
        entry.contains("where:($can$l$303a7461736b)=>(preferences.view === \"all\")"),
        "list predicate lambda"
    );
    assert!(
        !entry.contains("search:[\"title\"]")
            && !entry.contains("filter:[\"done\"]")
            && ["search", "filter"].iter().all(|option| {
                diags.iter().any(|d| {
                    d.code == "E6008"
                        && d.message
                            == format!(
                                "cannot lower list: option {option} has no consumed factory profile"
                            )
                })
            }),
        "unavailable list options are refused"
    );
    assert!(
        !entry.contains("order:[\"-created\"]"),
        "refused collection order is absent"
    );
    assert!(
        entry.contains("renderRow:($can$l$313a726f77,$can$l$323a726f7756696577)=>"),
        "row scope"
    );
    assert!(
        !entry.contains("$can$u$65646974({")
            && diags.iter().any(|d| d.code == "E6008" && d.message.contains("cannot lower edit: the bound edit profile has no complete owning form props")),
        "edit operation has no owning factory profile"
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
        entry.contains("async \"TeamTasks.Todo.create\"(c,input)"),
        "create handler"
    );
    assert!(
        entry.contains("async \"TeamTasks.Todo.update\"(c,{record,changes})"),
        "update handler"
    );
    assert!(
        entry.contains("async \"TeamTasks.Todo.delete\"(c,{record})"),
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
        entry.contains("export const $can$o$5465616d5461736b732e546f646f2e637265617465=\"TeamTasks.Todo.create\";"),
        "identity const for crud op"
    );
    // Callables reference the entrypoint module and real exports.
    assert!(!artifact.callables.is_empty(), "callables non-empty");
    for callable in &artifact.callables {
        assert_eq!(callable.module, "$can$m$5465616d4f6666696365.mjs");
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
    assert_eq!(
        artifact.pages[0].export,
        "$can$p$5465616d5461736b733a64657363726970746f723a2f"
    );
    assert_eq!(artifact.pages[1].path, "/notes");
    assert_eq!(
        artifact.pages[1].export,
        "$can$p$5465616d4e6f7465733a64657363726970746f723a2f6e6f746573"
    );
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
        suite.contains("const $can$f$7461736b={model:\"TeamTasks.Todo\",dependencies:[],value:async(c,s)=>({title:\"Ship prototype\"})};"),
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
        suite.contains("observations:[async(c,s)=>s.task.done,async(c,s)=>(() => { throw new Error(\"call has no lowering\"); })()"),
        "unchecked observation stays loud:\n{suite}"
    );
    let missing: Vec<_> = diags
        .iter()
        .filter(|d| {
            d.code == "E6008"
                && d.message == "cannot lower call: checked selected-call binding is not published"
        })
        .collect();
    assert_eq!(
        missing.len(),
        1,
        "untyped BDD format observation: {diags:?}"
    );
    let span = missing[0].primary;
    assert_eq!(
        &db.get(id).unwrap().text[span.start as usize..span.end as usize],
        "format(task_count(count(Todo)),locale=\"nl\")"
    );
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
    // every referenced builtin). The test-only partial artifact retains
    // admitted nodes alongside explicit E6008s for unavailable UI profiles.
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
        15,
        "unsupported count: {diags:?}"
    );
    for (word, n) in [("tooltip", 1), ("collapse", 1)] {
        assert_eq!(
            diags
                .iter()
                .filter(|d| d.code == "E6008" && d.message.contains(word))
                .count(),
            n,
            "{word} factory"
        );
    }
    for (profile, count) in [
        ("cannot lower breadcrumbs:", 2),
        ("cannot lower pagination:", 2),
        ("cannot lower edit:", 2),
        ("cannot lower list: option search", 2),
        ("cannot lower list: option filter", 1),
        ("cannot lower list: option display", 1),
    ] {
        assert_eq!(
            diags
                .iter()
                .filter(|d| d.code == "E6008" && d.message.starts_with(profile))
                .count(),
            count,
            "{profile} refusal"
        );
    }
    for word in ["bound tabs", "collection order"] {
        assert_eq!(
            diags
                .iter()
                .filter(|d| d.code == "E6008" && d.message.contains(word))
                .count(),
            1,
            "{word} refusal"
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
/// `state-read`. Without a catalog there is no selected overload; the
/// explicit incomplete emitter preserves an E6008 throwing stub.
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
    // Without a catalog no selected binding exists; lowering fails closed.
    let (program, result) = check_example(&db, id, None);
    let (artifact, diags) = emit_test_only(&program, &db, &result, None);
    assert!(
        !artifact.modules[0].js.contains("await count("),
        "unchecked target is never guessed"
    );
    assert!(
        artifact.modules[0]
            .js
            .contains("(() => { throw new Error(\"call has no lowering\"); })()"),
        "unchecked call emits a throwing stub"
    );
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message == "cannot lower call: checked selected-call binding is not published"
            && &db.get(id).unwrap().text[d.primary.start as usize..d.primary.end as usize]
                == "count(Todo)"),
        "unchecked count is a loud E6008 at the owning call"
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
        vec![
            "$can$m$457870656e7365466c6f77.mjs",
            "$can$m$657870656e736573.mjs",
            "$can$m$7265706f7274696e67.mjs"
        ]
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
    //   delete. Prepared form fields, badges, alerts, dividers, joins,
    //   buttons and modal content lower; unavailable profiles report E6008.
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
            "reviewer:{id:\"expenses.reviewer\",label:$can$u$6d657373616765(\"Reviewer\",{nl:\"Beoordelaar\"})}"
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
            .contains("decision_note:{type:\"text\",nullable:true,label:$can$u$6d657373616765(\"Decision note\""),
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
        entry.contains("readGrants:[{rule:\"Expense.read.1\"},{rule:\"Expense.read.2\",by:[\"expenses.reviewer\"]}]"),
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
        entry.contains("(($member,$collection)=>$collection.some($item=>equalValue(\"expenses.Expense.status\",$member,$item)))(row.status,[\"approved\",\"rejected\"])"),
        "in membership"
    );
    // G4 contracts and preferences.
    assert!(
        entry.contains("\"reporting.Summary\":{label:$can$u$6d657373616765(\"Expense totals\""),
        "contract label"
    );
    assert!(
        entry.contains("count:{type:\"int\"},total:{type:\"money\"}"),
        "contract fields"
    );
    assert!(entry.contains("reporting:{fields:{"), "preferences");
    // G1 scenarios: gates, read/result descriptors, captions.
    assert!(entry.contains("\"expenses.submit\":"), "submit op");
    assert!(
        entry.contains("handler:\"expenses.submit\""),
        "submit handler"
    );
    assert!(
        entry.contains("expense:{type:\"expenses.Expense\"}"),
        "submit input"
    );
    assert!(entry.contains("\"expenses.approve\":"), "approve op");
    assert!(
        entry.contains(
            "note:{type:\"text\",nullable:true,label:$can$u$6d657373616765(\"Decision note\""
        ),
        "approve input"
    );
    assert!(entry.contains("by:\"expenses.reviewer\""), "reviewer gate");
    assert!(
        entry.contains("\"reporting.summarize\":{handler:\"reporting.summarize\",inputs:{currency:{type:\"currency\"},status:{type:\"enum\""),
        "summarize op"
    );
    assert!(
        entry.contains("read:true,result:{type:\"reporting.Summary\"}"),
        "summarize result descriptor"
    );
    // G2 CRUD entries: `delete=none` yields no delete operation.
    assert!(
        entry.contains("\"expenses.Expense.create\":{handler:\"expenses.Expense.create\",kind:\"create\",model:\"expenses.Expense\",read:false,inputs:{fields:[\"purpose\",\"amount\"]},by:\"members\",when:\"Expense\"}"),
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
    assert!(
        entry.contains("async \"expenses.submit\"(c,{expense:$can$l$323a657870656e7365}){"),
        "submit body"
    );
    assert!(
        entry.contains(
            "check((same($can$l$323a657870656e7365.submitted_by,c.actor)) && ($can$l$323a657870656e7365.status === \"draft\"));"
        ),
        "submit guard"
    );
    assert!(
        entry.contains("await set(c,$can$l$323a657870656e7365,{status:\"submitted\"},{when:crudWhen[\"Expense\"]});"),
        "submit effect"
    );
    assert!(
        entry.contains("async \"expenses.approve\"(c,{expense:$can$l$333a657870656e7365,note:$can$l$343a6e6f7465}){"),
        "approve body"
    );
    assert!(
        entry.contains("await set(c,$can$l$333a657870656e7365,{status:\"approved\",decision_note:$can$l$343a6e6f7465,decided_by:c.actor,decided_at:c.now},{when:crudWhen[\"Expense\"]});"),
        "approve effect"
    );
    assert!(
        entry.contains("trim($can$l$363a6e6f7465) !== \"\""),
        "reject trim guard"
    );
    assert!(
        entry.contains("async \"reporting.summarize\"(c,{currency:$can$l$373a63757272656e6379,status:$can$l$383a737461747573}){"),
        "summarize body"
    );
    assert!(
        entry.contains("const $can$l$31303a73656c6563746564 = await records(c,\"expenses.Expense\",{where:($can$l$393a726f77)=>($can$l$393a726f77.amount.currency === $can$l$373a63757272656e6379) && ($can$l$393a726f77.status === $can$l$383a737461747573)});"),
        "summarize query"
    );
    // G12: `count`/`sum` await; the value-domain query lowers
    // through `.map` with its alias-scoped projection.
    assert!(
        entry.contains("return {count:await count($can$l$31303a73656c6563746564),total:await sum($can$l$31303a73656c6563746564.map(($can$l$31313a657870656e7365)=>$can$l$31313a657870656e7365.amount),\"money\",$can$l$373a63757272656e6379)};"),
        "summarize return"
    );
    assert!(
        entry.contains("async \"expenses.Expense.create\"(c,input){"),
        "crud body"
    );
    assert!(
        entry.contains("await create(c,\"expenses.Expense\",input,{when:crudWhen[\"Expense\"]});"),
        "create admission"
    );
    // G9 pages: admitted nodes remain visible in the test-only partial
    // artifact; refused owning profiles retain diagnostics and no usable call.
    assert!(
        !entry.contains("$can$u$616374696f6e({")
            && diags.iter().any(|d| d.code == "E6008" && d.message.contains("cannot lower action: the source profile has no complete owning factory payload")),
        "row actions lack an owning factory profile"
    );
    assert!(
        !entry.contains("$can$u$686973746f7279({")
            && diags.iter().any(|d| d.code == "E6008" && d.message.contains("cannot lower history: the source profile has no complete owning factory payload")),
        "row history lacks an owning factory profile"
    );
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message
                .contains("cannot lower breadcrumbs: ancestry and label carriers")),
        "page breadcrumbs carrier profile is refused"
    );
    assert!(
        entry.contains(
            "children:()=>[$can$u$696e707574({...$can$f$666f726d.field(\"purpose\")}),$can$u$696e707574({...$can$f$666f726d.field(\"amount\")})]"
        ),
        "create-form field controls"
    );
    assert!(
        entry.contains(
            "$can$u$6261646765({context:$can$l$313a726f7756696577,value:$can$l$303a726f77.status})"
        ),
        "row badge"
    );
    assert!(
        entry.contains("$can$l$303a726f77.status === \"rejected\" ? $can$u$616c657274({context:$can$l$313a726f7756696577,children:[$can$u$74657874({context:$can$l$313a726f7756696577,values:[$can$l$303a726f77.decision_note]})]}) : null"),
        "gated alert"
    );
    assert!(
        entry.contains("$can$u$64697669646572({context:$can$l$313a726f7756696577,caption:$can$u$6d657373616765(\"Review decision\",{nl:\"Beoordelingsbesluit\"})})"),
        "divider caption"
    );
    assert!(
        entry.contains("$can$u$6a6f696e({context:$can$l$313a726f7756696577,children:[$can$u$627574746f6e({context:$can$l$313a726f7756696577,opens:\"approve_expense\"}),$can$u$627574746f6e({context:$can$l$313a726f7756696577,opens:\"reject_expense\"})]})"),
        "join with opener buttons"
    );
    assert!(
        entry.contains("$can$u$6d6f64616c({context:$can$l$313a726f7756696577,caption:$can$u$6d657373616765(\"Approve expense\",{nl:\"Onkost goedkeuren\"}),id:\"approve_expense\",content:[(($can$f$666f726d)=>{if($can$f$666f726d.status!==\"ready\")return $can$u$74657874({context:$can$l$313a726f7756696577,values:[$can$f$666f726d.message]});return $can$u$666f726d({...$can$f$666f726d.props,children:()=>[$can$u$7465787461726561({...$can$f$666f726d.field(\"note\")})]});})(await $can$l$313a726f7756696577.prepareForm({operation:\"expenses.approve\",arguments:{expense:$can$l$303a726f77},display:\"inline\",fields:[\"expense\",\"note\"],labels:{note:$can$u$6d657373616765(\"Decision note\",{nl:\"Toelichting op het besluit\"})},authoredFields:[\"note\"]}))]})"),
        "approve modal with content slot"
    );
    assert!(
        entry.contains("$can$u$6d6f64616c({context:$can$l$313a726f7756696577,caption:$can$u$6d657373616765(\"Reject expense\""),
        "reject modal"
    );
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message
                .contains("cannot lower pagination: cursor and label carriers")),
        "pagination carrier profile is refused"
    );
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message
                .contains("cannot lower stat: only one value header")),
        "multi-value stat profile is refused"
    );
    assert!(
        !entry.contains("unknown UI factory"),
        "no unknown factory spelling in the partial artifact"
    );
    assert!(
        entry.contains("arguments:{status:preferences.status}"),
        "form arguments"
    );
    assert!(
        !entry.contains("defaults:{status:preferences.status}")
            && diags.iter().any(|d| d.code == "E6008"
                && d.message
                    == "cannot lower list: option defaults has no consumed factory profile"),
        "list defaults lack an owning factory profile"
    );
    assert!(
        !entry.contains("selector:\"reporting.status\""),
        "refused tabs selector is absent"
    );
    assert!(
        !entry.contains("order:"),
        "refused collection order is absent"
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
        assert_eq!(callable.module, "$can$m$457870656e7365466c6f77.mjs");
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
        submit.contains("const $can$f$72657669657765725f6f6e65={dependencies:[],user:async(c,s)=>({roles:[\"expenses.reviewer\"]})};"),
        "reviewer recipe:\n{submit}"
    );
    assert!(
        submit.contains("const $can$f$70656e64696e67={model:\"expenses.Expense\",dependencies:[],value:async(c,s)=>({purpose:\"Travel\",amount:money(25n,\"EUR\"),submitted_by:other,status:\"submitted\"})};"),
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
        "checked role observation:\n{submit}"
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
        "sequence create uses checked money call"
    );
    assert!(
        approve.contains("{let:\"draft_claim\",value:async(c,s,b)=>(await first(await records(c,\"expenses.Expense\",{where:($can$l$303a726f77)=>same($can$l$303a726f77.submitted_by,other)})))}"),
        "sequence binding consumes checked first/query facts:\n{approve}"
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
        "checked sequence assertion metadata"
    );
    assert!(
        approve.contains("types:[\"expenses.Expense.status\",\"user?\"]"),
        "checked sequence tuple metadata"
    );
    assert!(
        approve.contains("dependencies:[$can$f$72657669657765725f6f6e65,$can$f$72657669657765725f74776f],sequence:["),
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
    // BDD calls and dependent assertion types consume owning checked facts.
    // Bound tabs, authored collection order and the unavailable UI carrier
    // profiles are explicitly refused; this is a test-only partial artifact.
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
        12,
        "owning UI profile refusals: {diags:?}"
    );
    for (profile, count) in [
        ("cannot lower breadcrumbs:", 2),
        ("cannot lower pagination:", 1),
        ("cannot lower edit:", 1),
        ("cannot lower action:", 1),
        ("cannot lower history:", 1),
        ("cannot lower stat:", 1),
        ("cannot lower list: option filter", 1),
        ("cannot lower list: option defaults", 1),
        ("cannot lower list: option display", 1),
    ] {
        assert_eq!(
            diags
                .iter()
                .filter(|d| d.code == "E6008" && d.message.starts_with(profile))
                .count(),
            count,
            "{profile} refusal"
        );
    }
    for word in ["bound tabs", "collection order"] {
        assert_eq!(
            diags
                .iter()
                .filter(|d| d.code == "E6008" && d.message.contains(word))
                .count(),
            1,
            "{word} refusal"
        );
    }
    for test in &artifact.tests {
        assert!(
            !test.module.js.contains("throw new Error"),
            "no hidden BDD placeholder"
        );
        assert!(
            !test.module.js.contains("types:[\"unknown\""),
            "no unknown observation metadata"
        );
    }
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
        // T09 REPAIR (was `{type:"text",array:true,requiredArray:true}`):
        // the old pin agreed with the wrong side of R09 — every non-null
        // array emitted `requiredArray:true`, contradicting the declared
        // `T[]` omits-to-`[]` default. Independent values conformance
        // (frozen `applyArrayOmission`: ordinary yields the canonical
        // empty array, only `T[]!` rejects omission) agrees the marker
        // comes from the `!` spelling alone, so the unmarked entry point
        // emits a bare `array:true`. DESIGN L1023 pins this same shape
        // for `result:{type:"text",array:true}`.
        (
            ResolvedType::Array {
                element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                ordered: true,
                nonempty: false,
            },
            "{type:\"text\",array:true}",
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
    // T09 marked entry point: `requiredArray:true` exactly for the `!`
    // marker; nullability wins over a marker (GRAMMAR L192 forbids the
    // combination, so this pins the fail-closed stay-null choice).
    let text_array = ResolvedType::Array {
        element: Box::new(ResolvedType::Scalar(Scalar::Text)),
        ordered: true,
        nonempty: false,
    };
    assert_eq!(
        emitter.field_schema_marked(&text_array, true, sp(0, 1)),
        "{type:\"text\",array:true,requiredArray:true}"
    );
    assert_eq!(
        emitter.field_schema_marked(&text_array, false, sp(0, 1)),
        "{type:\"text\",array:true}"
    );
    let nullable_array = ResolvedType::Nullable(Box::new(text_array));
    assert_eq!(
        emitter.field_schema_marked(&nullable_array, true, sp(0, 1)),
        "{type:\"text\",array:true,nullable:true}"
    );
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
            false,
            Some(&IrDefault::Literal(int_lit(0))),
            None,
            sp(0, 1)
        ),
        "{type:\"int\",default:0n}"
    );
    assert_eq!(
        emitter.lower_field_full(
            &enum_ty,
            false,
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
            false,
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
        emitter.lower_field_full(&user_ty, false, None, Some(&IrServer::Actor), sp(0, 1)),
        "{type:\"user\",server:\"actor\"}"
    );
    let datetime_ty = ResolvedType::Scalar(Scalar::Datetime);
    assert_eq!(
        emitter.lower_field_full(&datetime_ty, false, None, Some(&IrServer::Now), sp(0, 1)),
        "{type:\"datetime\",server:\"now\"}"
    );
    // T09 omission through the full field lowering: ordinary arrays omit
    // the marker (omission evaluates to an equal-empty array); required
    // (`!`) arrays carry it (omission rejects). Agrees with the frozen
    // values `applyArrayOmission` oracle (ordinary→EMPTY_ARRAY,
    // required→throw).
    let tags_ty = ResolvedType::Array {
        element: Box::new(ResolvedType::Scalar(Scalar::Text)),
        ordered: true,
        nonempty: false,
    };
    assert_eq!(
        emitter.lower_field_full(&tags_ty, false, None, None, sp(0, 1)),
        "{type:\"text\",array:true}"
    );
    assert_eq!(
        emitter.lower_field_full(&tags_ty, true, None, None, sp(0, 1)),
        "{type:\"text\",array:true,requiredArray:true}"
    );
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty(), "defaults lower cleanly: {diags:?}");
}

/// T09 omission end to end: the `!` spelling (never nullability) flows
/// from effects through IR into the model field descriptors. Ordinary
/// `text[]` omits the marker (omission evaluates to an equal-empty
/// array, per the frozen values `applyArrayOmission` oracle); `text[]!`
/// carries `requiredArray:true` (omission rejects); `text[]?` stays
/// nullable without the marker (nullability wins).
/// TEST-ONLY artifact: see module docs.
#[test]
fn omission_marker_flows_from_spelling_to_descriptor() {
    let src = "app T\nGiven\n M { tags:text[], ids:text[]!, nick:text[]? }\n policy M read=members\nWhen\nThen\n";
    let mut db = SourceDb::new();
    let id = db.add("t09-omission.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "omission fields lower without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("tags:{type:\"text\",array:true}"),
        "ordinary array omits the marker:\n{js}"
    );
    assert!(
        js.contains("ids:{type:\"text\",array:true,requiredArray:true}"),
        "required (!) array carries the marker:\n{js}"
    );
    assert!(
        js.contains("nick:{type:\"text\",array:true,nullable:true}"),
        "nullable array stays null-wins without the marker:\n{js}"
    );
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
        "divideDecimal(parseDecimal(\"1.5\"),parseDecimal(\"0.5\"))"
    );
    assert!(imports.iter().any(|i| i.contains("divideDecimal")));
    assert!(imports.iter().any(|i| i.contains("parseDecimal")));
    assert!(
        diags.is_empty(),
        "decimal construction diagnostics: {diags:?}"
    );
    let (text, _, _) = lower(
        &ir,
        &binary(IrBinOp::Eq, dec("1.5"), dec("1.5"), bool_ty.clone()),
    );
    assert!(
        text.starts_with("equalValue(\"decimal\","),
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
    assert_eq!(text, "equalValue(\"text[]\", a,b)");
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
    assert_eq!(text, "equalValue(\"demo.Summary\", a,b)");

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
    assert_eq!(
        text,
        "(($member,$collection)=>$collection.some($item=>equalValue(\"text\",$member,$item)))(\"a\",[\"a\",\"b\"])"
    );
    let (text, imports, _) = lower(
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
    assert_eq!(text, "trim(note)");
    assert!(imports.iter().any(|i| i.contains("trim")));
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
    assert_eq!(call, "await $can$s$64656d6f2e5376632e70696e67(c)");
    assert!(
        emitter
            .import_lines()
            .iter()
            .any(|i| i.contains("./$can$m$64656d6f.mjs")),
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
        "await records(c,\"demo.Widget\",{where:($can$l$303a726f77)=>$can$l$303a726f77.count === 1n,order:[\"-count\"],limit:10n})"
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
        "  await set(c,row,{done:true},{when:crudWhen[\"Widget\"]});"
    );
    assert_eq!(
        text[3],
        "  const $can$l$303a63726561746564 = await create(c,\"demo.Widget\",{title:\"t\"},{when:crudWhen[\"Widget\"]});"
    );
    assert_eq!(
        text[4],
        "  const $can$l$313a617474656d7074 = await send(c,\"demo.Svc.ping\", {},{when:()=>true});"
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
/// three-argument UI forms and the localized adapter over the public
/// two-argument values formatter.
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
        "$can$u$6d657373616765(\"Expense review\",{nl:\"Onkostenbeoordeling\"})"
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
        "$can$u$6d657373616765(\"{n} tasks\",{},{n:{type:\"int\",value:3n}})"
    );
    let formatted = typed(
        IrExpr::Format {
            args: vec![
                typed(
                    IrExpr::Message(static_message),
                    ResolvedType::Message(SymbolId(0)),
                ),
                typed(IrExpr::Null, ResolvedType::Null),
            ],
            descriptor_index: 0,
            locale_index: 1,
            source_lang: "en".to_string(),
            param_types: vec![],
        },
        ResolvedType::Scalar(Scalar::Text),
    );
    let emitted = emitter.lower_expr(&formatted);
    assert!(emitted.contains("$can$h$6c6f63616c697a65645f666f726d6174(c,"));
    assert!(emitted.ends_with(
        "([$can$u$6d657373616765(\"Expense review\",{nl:\"Onkostenbeoordeling\"}),null])"
    ));
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
        "$can$u$7461626c65({context:c,model:\"demo.Widget\",columns:[\"title\",\"count\"]})"
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
        "$can$u$63617264({context:c,title:\"Work\",children:[$can$u$7461626c65({context:c,model:\"demo.Widget\",columns:[\"title\",\"count\"]})]})"
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
        poll: None,
        refresh: None,
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
        poll: None,
        refresh: None,
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
        module.js.contains("export const $can$p$657870656e73653a64657363726970746f723a2f657870656e7365732f726576696577={owner:\"expense\",path:\"/expenses/review\",title:$can$u$6d657373616765(\"Expense review\",{nl:\"Onkostenbeoordeling\"}),admit:async(c,routeBindings={})=>{if(!(hasRole(c,\"expense.reviewer\")))throw {code:\"forbidden\",message:\"forbidden\"};return {};},render:$can$p$657870656e73653a72656e6465723a2f657870656e7365732f726576696577};"),
        "review descriptor:\n{}",
        module.js
    );
    assert!(
        module.js.contains("export async function $can$p$657870656e73653a72656e6465723a2f657870656e7365732f726576696577(c,bindings){return (await Promise.all([$can$u$7461626c65({context:c,model:\"expense.Expense\"})])).filter(value=>value!=null).join('');}"),
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
    let review_pos = module
        .js
        .find("$can$p$657870656e73653a64657363726970746f723a2f657870656e7365732f726576696577")
        .unwrap();
    let mine_pos = module
        .js
        .find("$can$p$657870656e73653a64657363726970746f723a2f657870656e7365732f6d696e65")
        .unwrap();
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
        poll: None,
        refresh: None,
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
        module.js.contains("export async function $can$p$657870656e73653a72656e6465723a2f657870656e7365732f7072656673(c,bindings){const preferences=bindings.preferences[\"expense\"];return (await Promise.all([$can$u$74657874({context:c,value:preferences.view})])).filter(value=>value!=null).join('');}"),
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
            required_array: false,
            default: Some(IrDefault::Literal(text_lit("all"))),
            server: None,
            modifiers: IrModifiers::default(),
            label: None,
            description: None,
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
        poll: None,
        refresh: None,
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
    assert_eq!(
        module.module.path,
        "tests/$can$t$64656d6f2e7375626d6974.mjs"
    );
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
        js.contains("const $can$f$6a6f62={model:\"demo.Widget\",dependencies:[],value:async(c,s)=>({title:\"Reconcile\"})};"),
        "model recipe:\n{js}"
    );
    assert!(
        js.contains(
            "const $can$f$776f726b6572={dependencies:[],user:async(c,s)=>({roles:[\"demo.operations\"]})};"
        ),
        "user recipe:\n{js}"
    );
    assert!(
        js.contains("const $can$f$617474656d7074={dependencies:[$can$f$6a6f62],delivery:\"demo.Svc.ping\",values:async(c,s)=>({request:{to:\"ops\"},status:\"failed\"})};"),
        "delivery recipe:\n{js}"
    );
    // DESIGN §13 normative: exactly `{fixtures:{...},examples:[...]}`;
    // recipes never share the top-level namespace with example metadata.
    // (CanCheck.mjs oracle is flat here; per the file rule above the
    // normative text wins.)
    assert!(
        js.contains("return {fixtures:{[\"job\"]:$can$f$6a6f62,[\"worker\"]:$can$f$776f726b6572,[\"attempt\"]:$can$f$617474656d7074},examples:[]};"),
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
        js.contains("{operation:\"demo.submit\",dependencies:[$can$f$6a6f62],inputs:async(c,s)=>({check:s_job}),selectors:[\"as\",\"check.enabled\"],observations:[async(c,s)=>s_check.enabled],rows:["),
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
        js.contains("{operation:\"demo.submit\",dependencies:[$can$f$6a6f62],sequence:["),
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
{"id":"format","kind":"builtin","signature":"format(descriptor:message)->text","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"random_secret","kind":"builtin","signature":"random_secret()->secret","effects":"server-default-only","availability":"external","owner":"lane-03"}
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

/// F3 forms: a `form` without `fields=` defaults to the operation's
/// writable fields in schema order. Explicit `fields=` wins (pinned by the TeamTasks
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
    // `fields=`: both stored Note fields are writable, in schema order,
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
    // Preparation receives the unresolved request without a silent field default.
    assert!(
        entry.contains("(($can$f$666f726d)=>{if($can$f$666f726d.status!==\"ready\")return $can$u$74657874({context:c,values:[$can$f$666f726d.message]});return $can$u$666f726d($can$f$666f726d.props);})(await c.prepareForm({display:\"inline\"}))"),
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
    let src = "app Probe uses=[shop]\npackage shop\n Given\n  export Item { name:text label=\"Item\"@{nl=\"Artikel\"} }\n  policy Item read=members\n When\n  crud Item by=members fields=name delete=none\n Then\n  page / title=\"Shop\"@{nl=\"Winkel\"}\n   card \"Sell\"@{nl=\"Verkopen\"}\n    form Item.create\n     input name\n    list Item empty=\"No items yet\"\n     badge row.name\n     form Item.update arguments={record=row} display=inline\n      require row.name != \"\"\n      input name\n     alert\n      require row.name != \"\"\n      text row.name\n     divider \"More\"@{nl=\"Meer\"}\n     join\n      button opens=dlg\n     modal \"Dialog\"@{nl=\"Dialoog\"} id=dlg\n      slot content\n       text row.name\n    stat 1\n";
    let mut db = SourceDb::new();
    let id = db.add("probe-ui.can".to_string(), src.to_string());
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "clean lowerings: {diags:?}");
    let entry = &artifact.modules[0].js;
    for marker in [
        "$can$u$666f726d({...$can$f$666f726d.props,children:()=>[$can$u$696e707574({...$can$f$666f726d.field(\"name\")})]})",
        "$can$u$6261646765({context:$can$l$313a726f7756696577,value:$can$l$303a726f77.name})",
        "$can$l$303a726f77.name !== \"\" ? $can$u$616c657274({context:$can$l$313a726f7756696577,children:[$can$u$74657874({context:$can$l$313a726f7756696577,values:[$can$l$303a726f77.name]})]}) : null",
        "$can$u$64697669646572({context:$can$l$313a726f7756696577,caption:$can$u$6d657373616765(\"More\",{nl:\"Meer\"})})",
        "$can$u$6a6f696e({context:$can$l$313a726f7756696577,children:[$can$u$627574746f6e({context:$can$l$313a726f7756696577,opens:\"dlg\"})]})",
        "$can$u$6d6f64616c({context:$can$l$313a726f7756696577,caption:$can$u$6d657373616765(\"Dialog\",{nl:\"Dialoog\"}),id:\"dlg\",content:[$can$u$74657874({context:$can$l$313a726f7756696577,values:[$can$l$303a726f77.name]})]})",
        "$can$u$73746174({context:c,value:1n})",
    ] {
        assert!(entry.contains(marker), "missing {marker}:\n{entry}");
    }
    assert_eq!(entry.matches(".prepareForm(").count(), 2, "{entry}");
    assert_eq!(entry.matches("await c.prepareForm(").count(), 1, "{entry}");
    assert_eq!(
        entry
            .matches("await $can$l$313a726f7756696577.prepareForm(")
            .count(),
        1,
        "{entry}"
    );
    assert!(
        entry.contains("renderRow:async($can$l$303a726f77,$can$l$313a726f7756696577)=>"),
        "nested form preparation awaits inside the row callback:\n{entry}"
    );
    assert!(
        entry.contains("$can$l$303a726f77.name !== \"\" ? (($can$f$666f726d)=>")
            && entry.contains("await $can$l$313a726f7756696577.prepareForm({operation:\"shop.Item.update\",arguments:{record:$can$l$303a726f77},display:\"inline\",fields:[\"name\"],labels:{name:$can$u$6d657373616765(\"Item\",{nl:\"Artikel\"})},authoredFields:[\"name\"]})"),
        "row gate encloses preparation with source request properties in order:\n{entry}"
    );
    assert!(
        !entry.contains("throw new Error"),
        "nothing throws:\n{entry}"
    );
}

/// Catalog profile violations stay loud `E6008`, one precise diagnostic
/// per violated position (never a silent drop or an invented default).
#[test]
fn catalog_profile_violations_stay_loud() {
    let src = "app Probe uses=[shop]\npackage shop\n Given\n  export Item { name:text label=\"Item\"@{nl=\"Artikel\"} }\n  policy Item read=members\n When\n  crud Item by=members fields=name delete=none\n Then\n  page / title=\"Shop\"@{nl=\"Winkel\"}\n   breadcrumbs\n   pagination\n   card \"Sell\"@{nl=\"Verkopen\"}\n    button\n    modal \"No slots\"@{nl=\"Geen\"}\n    badge \"x\"\n     text \"y\"\n    input\n    stat\n    divider 42\n";
    let mut db = SourceDb::new();
    let id = db.add("probe-bad-ui.can".to_string(), src.to_string());
    let (catalog, catalog_path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (_artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&catalog_path);
    let messages: Vec<&str> = diags.iter().map(|d| d.message.as_str()).collect();
    for marker in [
        "cannot lower breadcrumbs: ancestry and label carriers are not implemented",
        "cannot lower pagination: cursor and label carriers are not implemented",
        "cannot lower pagination: pagination is valid only inside a collection",
        "cannot lower button: bound controls need one binding",
        "cannot lower modal: activated panels need a content slot",
        "cannot lower badge: badges take no content suite",
        "cannot lower input: field controls need an owning form",
        "cannot lower input: field controls take an input selector",
        "cannot lower stat: only one value header without a slotted suite has an owning factory profile",
        "cannot lower divider: caption has no checked text profile",
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
        entry.contains("const $can$l$323a7069636b6564 = $can$l$303a696473.filter(($can$l$313a6e)=>$can$l$313a6e > 1n);"),
        "value where filters:\n{entry}"
    );
    assert!(
        entry.contains("const $can$l$353a6e616d6573 = (await records(c,\"shop.Item\",{where:($can$l$333a726f77)=>$can$l$333a726f77.stock > 0n})).map(($can$l$343a6974656d)=>$can$l$343a6974656d.name);"),
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
        "row.status !== \"draft\" ? $can$u$616c657274({context:c}) : null"
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
        props: vec![
            ("model".to_string(), text_lit("demo.Widget")),
            ("empty".to_string(), text_lit("No widgets yet")),
        ],
        children: vec![gated],
        row_scope: Some(("row".to_string(), "rowView".to_string())),
        gate: None,
        span: sp(0, 1),
    };
    assert!(
        emitter
            .lower_ui(&list)
            .contains("renderRow:async($can$l$303a726f77,$can$l$313a726f7756696577)=>{"),
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
    assert_eq!(
        text,
        "selected.map(($can$l$303a657870656e7365)=>$can$l$303a657870656e7365)"
    );
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
        "(await records(c,\"demo.Widget\",{})).filter(($can$l$303a726f77)=>$can$l$303a726f77 > 1n)"
    );
    assert!(diags.is_empty(), "clean: {diags:?}");
}

/// B3 I2 emitted-map fixture: a plain `.can` snippet (no forms, no
/// policies) emits exact `mappings` bytes, and every decoded segment
/// resolves to its source line/col. Pins the encoder output the TS
/// `lookup` in `packages/cloudflare/src/runtime/sourcemap.ts` consumes.
#[test]
fn sourcemap_emitted_fixture_plain_snippet() {
    use canlang_compiler::codegen::js::JsWriter;
    let mut db = SourceDb::new();
    // Plain snippet: three source lines, no forms/policies.
    let text = "app Plain\nnote Note\nrule allow\n";
    db.add("plain.can".into(), text.into());
    let mut writer = JsWriter::new();
    writer.push(
        Span::new(SourceId(0), 0, 9),
        Some("appDefinition".to_string()),
        "const app=\"Plain\";",
    );
    writer.push(Span::new(SourceId(0), 10, 19), None, "const note=\"Note\";");
    writer.push(
        Span::new(SourceId(0), 20, 30),
        None,
        "const rule=\"allow\";",
    );
    let module = writer.finish("plain.mjs".to_string());
    assert_eq!(module.js.matches('\n').count(), 3, "one newline per line");
    let map = sourcemap::build("plain.mjs", &db, &module.lines);
    assert_eq!(map.file, "plain.mjs");
    assert_eq!(map.sources, vec!["plain.can".to_string()]);
    assert_eq!(map.sources_content, vec![Some(text.to_string())]);
    assert_eq!(map.names, vec!["appDefinition".to_string()]);
    // Exact bytes: L1 [0,0,0,0]+name0 -> AAAAA; L2/L3 line+1 -> AACA.
    assert_eq!(map.mappings, "AAAAA;AACA;AACA");
    let lines = sourcemap::decode_mappings(&map.mappings).expect("decode");
    assert_eq!(lines.len(), 3);
    for (i, segments) in lines.iter().enumerate() {
        assert_eq!(segments.len(), 1, "line {i}: one segment");
    }
    let expected: [(i64, i64); 3] = [(0, 0), (1, 0), (2, 0)];
    for (i, (line, col)) in expected.iter().enumerate() {
        let seg = &lines[i][0];
        assert_eq!(seg.gen_col, 0, "line {i} gen col");
        assert_eq!(seg.src, Some(0), "line {i} src");
        assert_eq!(seg.src_line, Some(*line), "line {i} src line");
        assert_eq!(seg.src_col, Some(*col), "line {i} src col");
    }
    assert_eq!(lines[0][0].name, Some(0));
    assert_eq!(lines[1][0].name, None);
    assert_eq!(lines[2][0].name, None);
    // JSON shape matches the contracts `SourceMap` subset.
    let json = sourcemap::to_json(&map);
    assert!(json.contains("\"version\":3"), "version: {json}");
    assert!(
        json.contains("\"sources\":[\"plain.can\"]"),
        "sources: {json}"
    );
    assert!(
        json.contains("\"mappings\":\"AAAAA;AACA;AACA\""),
        "mappings: {json}"
    );
}

// --- D03: checked descriptions lower to MCP source strings -------------------
//
// Inline `desc=`, legacy `@{desc}`, attached `#` and shared message
// references feed one checked slot per field/parameter (D02b); the IR
// projects its source text into the existing MCP source-string path
// with no artifact migration. Variants never leave the source in
// this delivery (localized MCP is deferred); undescribed and legacy
// shapes stay byte-compatible. TEST-ONLY: see module docs.

/// Analyze + emit one inline D03 source under the hermetic golden
/// catalog (pins `requires`, so clean lowerings stay `E6007`-free).
fn d03_emit(
    src: &str,
) -> (
    CheckedProgram,
    CompileArtifact,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
) {
    let mut db = SourceDb::new();
    let id = db.add("d03.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    (program, artifact, diags)
}

/// MCP operation descriptor by canonical name.
fn d03_operation<'a>(artifact: &'a CompileArtifact, name: &str) -> &'a js::JsOperation {
    artifact
        .operations
        .iter()
        .find(|op| op.name == name)
        .unwrap_or_else(|| {
            panic!(
                "operation {name} missing: {:?}",
                artifact
                    .operations
                    .iter()
                    .map(|op| &op.name)
                    .collect::<Vec<_>>()
            )
        })
}

/// MCP input description by input name within one operation.
fn d03_input<'a>(op: &'a js::JsOperation, name: &str) -> &'a js::JsOperationField {
    op.inputs
        .iter()
        .find(|input| input.name == name)
        .unwrap_or_else(|| {
            panic!(
                "input {name} missing in {}: {:?}",
                op.name,
                op.inputs
                    .iter()
                    .map(|input| &input.name)
                    .collect::<Vec<_>>()
            )
        })
}

/// (D03) Inline `desc=` on a scenario parameter reaches the MCP
/// operation input as its source string.
#[test]
fn d03_inline_param_desc_reaches_mcp_source() {
    let src = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\n scenario approve(note:text desc=\"Optional note.\") by=members\n  do\n   let x = 1\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(diags.is_empty(), "clean lowering: {diags:?}");
    let op = d03_operation(&artifact, "Shop.approve");
    assert_eq!(
        d03_input(op, "note").description.as_deref(),
        Some("Optional note.")
    );
}

/// (D03) Inline variants emit source-only into MCP: the descriptor
/// carries the source text, the translation appears nowhere in the
/// operations JSON, and the seam still retains the variant.
#[test]
fn d03_inline_field_variants_emit_source_only() {
    let src = "app Shop\nGiven\n Gadget { name:text desc=\"The name shown to customers.\"@{nl=\"De naam die klanten zien.\"} }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=name\nThen\n";
    let (program, artifact, diags) = d03_emit(src);
    assert!(diags.is_empty(), "clean lowering: {diags:?}");
    let op = d03_operation(&artifact, "Shop.Gadget.create");
    assert_eq!(
        d03_input(op, "name").description.as_deref(),
        Some("The name shown to customers.")
    );
    let json = js::operations_json(&artifact.operations);
    assert!(
        !json.contains("De naam die klanten zien."),
        "no variant leak: {json}"
    );
    let retained = program
        .effects
        .checked_descriptions
        .values()
        .find(|d| d.source == "The name shown to customers.")
        .expect("seam retains the checked value");
    assert_eq!(retained.variants.len(), 1);
    assert_eq!(retained.source_lang, "en");
}

/// (D03) A shared `desc= message` reference resolves to the message's
/// source wording in the MCP input; variants stay out.
#[test]
fn d03_message_reference_resolves_to_source() {
    let src = "app Shop\nGiven\n message title_msg = \"Display title.\"@{nl=\"Titel.\"}\n Gadget { title:text desc=title_msg }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(diags.is_empty(), "clean lowering: {diags:?}");
    let op = d03_operation(&artifact, "Shop.Gadget.create");
    assert_eq!(
        d03_input(op, "title").description.as_deref(),
        Some("Display title.")
    );
    let json = js::operations_json(&artifact.operations);
    assert!(!json.contains("Titel."), "no variant leak: {json}");
}

/// (D03) Attached `#` and legacy `@{desc}` feed the same slot: both
/// reach MCP inputs, and the legacy member renders byte-identical to
/// the established `@{desc}` shape.
#[test]
fn d03_attached_and_legacy_feed_same_slot() {
    let src = "app Shop\nGiven\n Gadget {\n  # Display title.\n  title:text,\n  stock:int @{desc=\"Units in stock.\"}\n }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,stock\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(diags.is_empty(), "clean lowering: {diags:?}");
    let op = d03_operation(&artifact, "Shop.Gadget.create");
    assert_eq!(
        d03_input(op, "title").description.as_deref(),
        Some("Display title.")
    );
    let stock = d03_input(op, "stock");
    assert_eq!(stock.description.as_deref(), Some("Units in stock."));
    assert!(
        stock
            .to_json()
            .contains("\"description\":\"Units in stock.\""),
        "legacy member shape: {}",
        stock.to_json()
    );
}

/// (D03) Undescribed inputs omit the member (byte-compatible shape):
/// no `description` key is rendered for absent slots.
#[test]
fn d03_undescribed_inputs_omit_member() {
    let src = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(diags.is_empty(), "clean lowering: {diags:?}");
    let op = d03_operation(&artifact, "Shop.Gadget.create");
    let title = d03_input(op, "title");
    assert!(title.description.is_none());
    assert!(
        !title.to_json().contains("description"),
        "omitted member: {}",
        title.to_json()
    );
}

/// (D03) Authored-empty `desc=""` stays present (absence-vs-empty
/// distinct): the member renders with an empty string.
#[test]
fn d03_empty_desc_stays_present() {
    let src = "app Shop\nGiven\n Gadget { nick:text desc=\"\" }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=nick\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(diags.is_empty(), "clean lowering: {diags:?}");
    let op = d03_operation(&artifact, "Shop.Gadget.create");
    let nick = d03_input(op, "nick");
    assert_eq!(nick.description.as_deref(), Some(""));
    assert!(
        nick.to_json().contains("\"description\":\"\""),
        "present empty: {}",
        nick.to_json()
    );
}

/// C01 witnesses have fixed decoded strings and JS literals, independent
/// of either the old decoder or the emitter. This traverses real source,
/// analysis, CST reparse, IR and emission under the test-only catalog;
/// it does not execute the module or claim production runtime acceptance.
#[test]
fn c01_lexer_strings_reach_literal_metadata_and_message_lowering() {
    let cases = [
        (
            r#""\b\f\uD83D\uDE00""#,
            "\u{8}\u{c}😀",
            r#""\u0008\u000c😀""#,
        ),
        (r#""\u00E9""#, "é", "\"é\""),
        (r#""\"\/\\""#, "\"/\\", r#""\"/\\""#),
        ("\"é😀\"", "é😀", "\"é😀\""),
        (r#""\n\r\t""#, "\n\r\t", r#""\n\r\t""#),
        ("\"\"", "", "\"\""),
    ];
    for (token, expected, emitted) in cases {
        let src = format!(
            "app Shop\nGiven\n Gadget {{ title:text={token} desc={token} label={token}@{{nl={token},fr=null}} }}\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title\nThen\n"
        );
        let mut db = SourceDb::new();
        let id = db.add("c01.can".to_string(), src);
        let (catalog, path) = golden_catalog();
        let (program, result) = check_example(&db, id, Some(&catalog));
        assert!(
            result
                .diagnostics
                .iter()
                .all(|d| d.severity != Severity::Error),
            "{token}: {:?}",
            result.diagnostics
        );
        let (ir, ir_diags) = canlang_compiler::codegen::ir::build(&program, &db, Some(&catalog));
        assert!(ir_diags.is_empty(), "{token}: {ir_diags:?}");
        let field = ir
            .items
            .iter()
            .find(|item| item.canonical == "Shop.Gadget.title")
            .unwrap();
        let IrItemKind::Field {
            default: Some(IrDefault::Literal(value)),
            label: Some(label),
            description,
            ..
        } = &field.kind
        else {
            panic!("{token}: missing literal/metadata: {:?}", field.kind);
        };
        let IrExpr::Text(text) = &value.expr else {
            panic!("{token}: {:?}", value.expr);
        };
        assert_eq!(text, expected, "literal payload for {token}");
        assert_eq!(label.text.source, expected);
        assert_eq!(
            label.text.variants,
            vec![
                ("nl".to_string(), Some(expected.to_string())),
                ("fr".to_string(), None)
            ]
        );
        assert_eq!(description.as_deref(), Some(expected));
        let (js, _, diags) = lower(&ir, value);
        assert_eq!(js, emitted, "literal emission for {token}");
        assert!(diags.is_empty(), "{diags:?}");
        let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
        let _ = std::fs::remove_file(path);
        assert!(diags.is_empty(), "{token}: {diags:?}");
        assert!(
            artifact.modules[0]
                .js
                .contains(&format!("default:{emitted}"))
        );
        assert!(artifact.modules[0].js.contains(&format!(
            "label:$can$u$6d657373616765({emitted},{{nl:{emitted},fr:null}})"
        )));
        assert_eq!(
            d03_input(d03_operation(&artifact, "Shop.Gadget.create"), "title")
                .description
                .as_deref(),
            Some(expected)
        );
    }
}

// --- T15a: canonical model/operation descriptors -------------------------------
// TEST-ONLY artifacts: see module docs. Descriptors never diagnose; these
// tests pin the T04a §3 vocabulary (closed input kinds, array markers,
// defaults, delete modes, unique keys) plus additive ownership, and the
// fail-closed omission rules for out-of-scope shapes.

/// T15a model descriptor by canonical name.
fn t15a_model<'a>(artifact: &'a CompileArtifact, name: &str) -> &'a js::JsModel {
    artifact
        .models
        .iter()
        .find(|model| model.name == name)
        .unwrap_or_else(|| {
            panic!(
                "model {name} missing: {:?}",
                artifact
                    .models
                    .iter()
                    .map(|model| &model.name)
                    .collect::<Vec<_>>()
            )
        })
}

/// T15a model field descriptor by field name.
fn t15a_field<'a>(model: &'a js::JsModel, name: &str) -> &'a js::JsModelField {
    model
        .fields
        .iter()
        .find(|field| field.name == name)
        .unwrap_or_else(|| {
            panic!(
                "field {name} missing in {}: {:?}",
                model.name,
                model.fields.iter().map(|f| &f.name).collect::<Vec<_>>()
            )
        })
}

/// (T15a) Literal defaults encode as wire-compatible JSON: ints, decimals
/// (authored spelling verbatim, scale preserved) and durations are
/// canonical decimal strings; money is `{minor, currency}`; structural
/// arrays/objects recurse; unary minus and the `money`/`date`/`datetime`
/// construct calls are recognized; non-literals map to `None`.
#[test]
fn t15a_literal_json_exactness() {
    let int_ty = ResolvedType::Scalar(Scalar::Int);
    let decimal_ty = ResolvedType::Scalar(Scalar::Decimal);
    let text_ty = ResolvedType::Scalar(Scalar::Text);
    let money_ty = ResolvedType::Scalar(Scalar::Money);
    let duration_ty = ResolvedType::Scalar(Scalar::Duration);
    let date_ty = ResolvedType::Scalar(Scalar::Date);
    let datetime_ty = ResolvedType::Scalar(Scalar::Datetime);
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);

    assert_eq!(js::literal_json(&int_lit(0)).as_deref(), Some("\"0\""));
    assert_eq!(
        js::literal_json(&int_lit(1_000_000_000_000_000_000)).as_deref(),
        Some("\"1000000000000000000\"")
    );
    let neg = typed(
        IrExpr::Unary {
            op: IrUnOp::Neg,
            operand: Box::new(int_lit(3)),
        },
        int_ty.clone(),
    );
    assert_eq!(js::literal_json(&neg).as_deref(), Some("\"-3\""));
    // Decimal scale survives verbatim (T11 exactness, never a Number).
    let dec = typed(IrExpr::Decimal("1.50".to_string()), decimal_ty.clone());
    assert_eq!(js::literal_json(&dec).as_deref(), Some("\"1.50\""));
    let neg_dec = typed(
        IrExpr::Unary {
            op: IrUnOp::Neg,
            operand: Box::new(typed(
                IrExpr::Decimal("0.5".to_string()),
                decimal_ty.clone(),
            )),
        },
        decimal_ty.clone(),
    );
    assert_eq!(js::literal_json(&neg_dec).as_deref(), Some("\"-0.5\""));
    assert_eq!(js::literal_json(&text_lit("a")).as_deref(), Some("\"a\""));
    assert_eq!(
        js::literal_json(&typed(IrExpr::Bool(true), bool_ty.clone())).as_deref(),
        Some("true")
    );
    assert_eq!(
        js::literal_json(&typed(IrExpr::Null, ResolvedType::Null)).as_deref(),
        Some("null")
    );
    let money = typed(
        IrExpr::Money {
            minor: 100,
            currency: "EUR".to_string(),
        },
        money_ty.clone(),
    );
    assert_eq!(
        js::literal_json(&money).as_deref(),
        Some("{\"minor\":\"100\",\"currency\":\"EUR\"}")
    );
    let duration = typed(IrExpr::DurationMs(30_000), duration_ty.clone());
    assert_eq!(js::literal_json(&duration).as_deref(), Some("\"30000\""));
    let date = typed(IrExpr::Date("2026-10-01".to_string()), date_ty.clone());
    assert_eq!(js::literal_json(&date).as_deref(), Some("\"2026-10-01\""));
    let datetime = typed(
        IrExpr::Datetime("2026-10-01T00:00:00.000Z".to_string()),
        datetime_ty.clone(),
    );
    assert_eq!(
        js::literal_json(&datetime).as_deref(),
        Some("\"2026-10-01T00:00:00.000Z\"")
    );
    // Structural literals recurse (T10 slice).
    let array = typed(
        IrExpr::Array(vec![int_lit(1), text_lit("b")]),
        ResolvedType::Array {
            element: Box::new(ResolvedType::Unknown),
            ordered: true,
            nonempty: true,
        },
    );
    assert_eq!(js::literal_json(&array).as_deref(), Some("[\"1\",\"b\"]"));
    let object = typed(
        IrExpr::Object(vec![
            ("a".to_string(), int_lit(1)),
            (
                "nested".to_string(),
                typed(
                    IrExpr::Object(vec![("b".to_string(), text_lit("x"))]),
                    ResolvedType::Object(vec![]),
                ),
            ),
        ]),
        ResolvedType::Object(vec![]),
    );
    assert_eq!(
        js::literal_json(&object).as_deref(),
        Some("{\"a\":\"1\",\"nested\":{\"b\":\"x\"}}")
    );
    // Construct calls with all-literal arguments are literals.
    let money_call = typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "money".to_string(),
                awaited: false,
            },
            args: vec![int_lit(25), text_lit("EUR")],
        },
        money_ty.clone(),
    );
    assert_eq!(
        js::literal_json(&money_call).as_deref(),
        Some("{\"minor\":\"2500\",\"currency\":\"EUR\"}")
    );
    let date_call = typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "date".to_string(),
                awaited: false,
            },
            args: vec![text_lit("2026-10-01")],
        },
        date_ty.clone(),
    );
    assert_eq!(
        js::literal_json(&date_call).as_deref(),
        Some("\"2026-10-01\"")
    );
    // Non-literals map to None (never a skewed literal).
    let name = typed(IrExpr::Name("pending".to_string()), text_ty.clone());
    assert_eq!(js::literal_json(&name), None);
    let member = typed(
        IrExpr::Member {
            base: Box::new(typed(
                IrExpr::Name("parent".to_string()),
                ResolvedType::Unknown,
            )),
            field: "owner".to_string(),
        },
        text_ty.clone(),
    );
    assert_eq!(js::literal_json(&member), None);
    let trim_call = typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "trim".to_string(),
                awaited: false,
            },
            args: vec![text_lit(" a ")],
        },
        text_ty.clone(),
    );
    assert_eq!(js::literal_json(&trim_call), None);
    let partial = typed(
        IrExpr::Array(vec![int_lit(1), name.clone()]),
        ResolvedType::Array {
            element: Box::new(ResolvedType::Unknown),
            ordered: true,
            nonempty: true,
        },
    );
    assert_eq!(js::literal_json(&partial), None);
}

/// (T15a) Parent defaults extract the dot path off the loaded parent row
/// (leading `parent.` stripped); bare `parent` and non-parent roots map
/// to `None`.
#[test]
fn t15a_parent_path_extraction() {
    let text_ty = ResolvedType::Scalar(Scalar::Text);
    let parent = || typed(IrExpr::Name("parent".to_string()), ResolvedType::Unknown);
    let member = |base: TypedExpr, field: &str| {
        typed(
            IrExpr::Member {
                base: Box::new(base),
                field: field.to_string(),
            },
            text_ty.clone(),
        )
    };
    assert_eq!(
        js::parent_path(&member(parent(), "owner")).as_deref(),
        Some("owner")
    );
    assert_eq!(
        js::parent_path(&member(member(parent(), "parent"), "user")).as_deref(),
        Some("parent.user")
    );
    assert_eq!(js::parent_path(&parent()), None);
    assert_eq!(
        js::parent_path(&typed(IrExpr::Name("c".to_string()), ResolvedType::Unknown)),
        None
    );
    let actor = typed(
        IrExpr::Member {
            base: Box::new(typed(IrExpr::Name("c".to_string()), ResolvedType::Unknown)),
            field: "actor".to_string(),
        },
        text_ty.clone(),
    );
    assert_eq!(js::parent_path(&actor), None);
}

/// (T15a) Default mapping: literals encode, parent paths map, `server=`
/// (any spelling) wins as `server`, and computed non-parent defaults map
/// to `None` (execution stays in the emitted callable; T04b vocabulary).
#[test]
fn t15a_field_default_mapping() {
    let text_ty = ResolvedType::Scalar(Scalar::Text);
    assert!(js::js_field_default(None, None).is_none());
    let literal =
        js::js_field_default(Some(&IrDefault::Literal(int_lit(7))), None).expect("literal maps");
    assert_eq!(literal.to_json(), "{\"kind\":\"literal\",\"value\":\"7\"}");
    let parent_expr = typed(
        IrExpr::Member {
            base: Box::new(typed(
                IrExpr::Name("parent".to_string()),
                ResolvedType::Unknown,
            )),
            field: "owner".to_string(),
        },
        text_ty.clone(),
    );
    let parent = js::js_field_default(
        Some(&IrDefault::Computed {
            expr: parent_expr,
            has_parent: true,
        }),
        None,
    )
    .expect("parent path maps");
    assert_eq!(parent.to_json(), "{\"kind\":\"parent\",\"path\":\"owner\"}");
    let computed = typed(IrExpr::Name("something".to_string()), text_ty.clone());
    assert!(
        js::js_field_default(
            Some(&IrDefault::Computed {
                expr: computed,
                has_parent: false,
            }),
            None,
        )
        .is_none(),
        "computed non-parent has no T04a vocabulary"
    );
    let server = js::js_field_default(None, Some(&IrServer::Actor)).expect("server maps");
    assert_eq!(server.to_json(), "{\"kind\":\"server\",\"init\":\"actor\"}");
    // Server wins over any default (spellings are mutually exclusive in
    // grammar; the descriptor stays total either way).
    let both = js::js_field_default(Some(&IrDefault::Literal(int_lit(1))), Some(&IrServer::Now))
        .expect("server wins");
    assert_eq!(both.to_json(), "{\"kind\":\"server\",\"init\":\"now\"}");
}

/// Build one synthetic model field item for tag tests.
fn t15a_field_item(id: u32, name: &str, ty: IrType) -> IrItem {
    IrItem {
        id: SymbolId(id),
        canonical: format!("demo.M.{name}"),
        name: name.to_string(),
        module: ModuleId(0),
        span: sp(0, 1),
        exported: false,
        kind: IrItemKind::Field {
            owner: SymbolId(0),
            ty,
            required_array: false,
            default: None,
            server: None,
            modifiers: IrModifiers::default(),
            label: None,
            description: None,
        },
    }
}

/// (T15a) Model field tags over a synthetic IR: pilot scalars use the
/// T04a spellings, text-like specializations collapse to `string`,
/// models map to `ref` by canonical name, and everything else is
/// source-exact T04b-preview or the honest `other` fallback — total,
/// diagnostic-free, never omitted.
#[test]
fn t15a_model_field_tags() {
    let span = sp(0, 1);
    let scalar = |s: Scalar| IrType::Known(ResolvedType::Scalar(s));
    let array_of = |element: ResolvedType| {
        IrType::Known(ResolvedType::Array {
            element: Box::new(element),
            ordered: true,
            nonempty: false,
        })
    };
    let mut items = vec![
        IrItem {
            id: SymbolId(0),
            canonical: "demo.M".to_string(),
            name: "M".to_string(),
            module: ModuleId(0),
            span,
            exported: true,
            kind: IrItemKind::Model {
                // Symbol ids are item indices (index parity): the four
                // header items occupy 0..4, fields follow from 4.
                fields: (4..34).map(SymbolId).collect(),
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
            canonical: "demo.N".to_string(),
            name: "N".to_string(),
            module: ModuleId(0),
            span,
            exported: true,
            kind: IrItemKind::Model {
                fields: Vec::new(),
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
            id: SymbolId(2),
            canonical: "demo.C".to_string(),
            name: "C".to_string(),
            module: ModuleId(0),
            span,
            exported: false,
            kind: IrItemKind::Contract {
                fields: vec![],
                label: None,
            },
        },
        IrItem {
            id: SymbolId(3),
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
    ];
    let record_n = ResolvedType::Record {
        symbol: SymbolId(1),
        stored: true,
    };
    let record_c = ResolvedType::Record {
        symbol: SymbolId(2),
        stored: false,
    };
    let enum_ba = ResolvedType::Enum {
        cases: vec!["b".to_string(), "a".to_string()],
        owner: None,
    };
    let field_types: Vec<(&str, IrType)> = vec![
        ("f_text", scalar(Scalar::Text)),
        ("f_email", scalar(Scalar::Email)),
        ("f_int", scalar(Scalar::Int)),
        ("f_dec", scalar(Scalar::Decimal)),
        ("f_money", scalar(Scalar::Money)),
        ("f_dt", scalar(Scalar::Datetime)),
        ("f_bool", scalar(Scalar::Bool)),
        ("f_file", scalar(Scalar::File)),
        ("f_enum", IrType::Known(enum_ba.clone())),
        ("f_ref", IrType::Known(record_n.clone())),
        ("f_contract", IrType::Known(record_c.clone())),
        ("f_date", scalar(Scalar::Date)),
        ("f_duration", scalar(Scalar::Duration)),
        ("f_secret", scalar(Scalar::Secret)),
        ("f_user", scalar(Scalar::User)),
        ("f_member", scalar(Scalar::Member)),
        ("f_json", scalar(Scalar::Json)),
        ("f_bytes", scalar(Scalar::Bytes)),
        ("f_arr", array_of(ResolvedType::Scalar(Scalar::Text))),
        ("f_arrenum", array_of(enum_ba.clone())),
        ("f_arrref", array_of(record_n.clone())),
        (
            "f_nullable",
            IrType::Known(ResolvedType::Nullable(Box::new(ResolvedType::Scalar(
                Scalar::Int,
            )))),
        ),
        (
            "f_nularr",
            IrType::Known(ResolvedType::Nullable(Box::new(ResolvedType::Array {
                element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                ordered: true,
                nonempty: false,
            }))),
        ),
        (
            "f_elnull",
            array_of(ResolvedType::Nullable(Box::new(ResolvedType::Scalar(
                Scalar::Text,
            )))),
        ),
        (
            "f_nested",
            array_of(ResolvedType::Array {
                element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                ordered: true,
                nonempty: false,
            }),
        ),
        (
            "f_delivery",
            IrType::Known(ResolvedType::Delivery { op: SymbolId(3) }),
        ),
        (
            "f_action",
            IrType::Known(ResolvedType::Action {
                targets: Vec::new(),
                bound: None,
                external: Vec::new(),
            }),
        ),
        (
            "f_union",
            IrType::Known(ResolvedType::Union(vec![SymbolId(1)])),
        ),
        (
            "f_object",
            IrType::Known(ResolvedType::Object(vec![(
                "a".to_string(),
                ResolvedType::Scalar(Scalar::Int),
            )])),
        ),
        (
            "f_opaque",
            IrType::Known(ResolvedType::Opaque("test-deferral")),
        ),
    ];
    for (index, (name, ty)) in field_types.into_iter().enumerate() {
        items.push(t15a_field_item(4 + index as u32, name, ty));
    }
    let ir = IrProgram {
        modules: vec![IrModule {
            id: ModuleId(0),
            name: "demo".to_string(),
            kind: ModuleKind::Package,
            file: SourceId(0),
            span,
            imports: Vec::new(),
            uses: Vec::new(),
            uses_resolved: Vec::new(),
            app_default_locale: None,
            pages: Vec::new(),
            description: None,
        }],
        items,
        catalog_version: String::new(),
        referenced_builtins: Vec::new(),
        read_rules: Vec::new(),
        invariants: Vec::new(),
        locks: Vec::new(),
        retention: Vec::new(),
        crud_when: Vec::new(),
        preferences_valid: Vec::new(),
        suites: Vec::new(),
        migrations: Vec::new(),
    };
    let models = Emitter::new(&ir).collect_models();
    assert_eq!(models.len(), 2, "both models emit");
    let model = models.iter().find(|m| m.name == "demo.M").unwrap();
    assert_eq!(model.delete_mode, "none", "no crud means none");
    let tag = |name: &str| t15a_field(model, name).field.clone();
    assert!(matches!(tag("f_text"), js::JsModelFieldType::String));
    assert!(matches!(tag("f_email"), js::JsModelFieldType::String));
    assert!(matches!(tag("f_int"), js::JsModelFieldType::Integer));
    assert!(matches!(tag("f_dec"), js::JsModelFieldType::Decimal));
    assert!(matches!(tag("f_money"), js::JsModelFieldType::Money));
    assert!(matches!(tag("f_dt"), js::JsModelFieldType::Datetime));
    assert!(matches!(tag("f_bool"), js::JsModelFieldType::Boolean));
    assert!(matches!(tag("f_file"), js::JsModelFieldType::File));
    match tag("f_enum") {
        js::JsModelFieldType::Enum { values } => {
            assert_eq!(values, vec!["b".to_string(), "a".to_string()]);
        }
        other => panic!("enum tag: {other:?}"),
    }
    match tag("f_ref") {
        js::JsModelFieldType::Ref { model } => assert_eq!(model, "demo.N"),
        other => panic!("ref tag: {other:?}"),
    }
    match tag("f_contract") {
        js::JsModelFieldType::Other { type_id } => assert_eq!(type_id, "demo.C"),
        other => panic!("contract tag: {other:?}"),
    }
    assert!(matches!(tag("f_date"), js::JsModelFieldType::Date));
    assert!(matches!(tag("f_duration"), js::JsModelFieldType::Duration));
    assert!(matches!(tag("f_secret"), js::JsModelFieldType::Secret));
    assert!(matches!(tag("f_user"), js::JsModelFieldType::User));
    assert!(matches!(tag("f_member"), js::JsModelFieldType::Member));
    assert!(matches!(tag("f_json"), js::JsModelFieldType::Json));
    assert!(matches!(tag("f_bytes"), js::JsModelFieldType::Bytes));
    // Arrays tag the element plus the marker.
    let arr = t15a_field(model, "f_arr");
    assert!(matches!(arr.field, js::JsModelFieldType::String));
    assert_eq!(arr.array_required, Some(false));
    assert!(!arr.required, "ordinary array omits to empty");
    let arrenum = t15a_field(model, "f_arrenum");
    assert!(matches!(arrenum.field, js::JsModelFieldType::Enum { .. }));
    assert_eq!(arrenum.array_required, Some(false));
    let arrref = t15a_field(model, "f_arrref");
    assert!(matches!(arrref.field, js::JsModelFieldType::Ref { .. }));
    assert_eq!(arrref.array_required, Some(false));
    // Nullability unwraps for the tag and clears required.
    let nullable = t15a_field(model, "f_nullable");
    assert!(matches!(nullable.field, js::JsModelFieldType::Integer));
    assert!(nullable.nullable && !nullable.required);
    let nularr = t15a_field(model, "f_nularr");
    assert!(matches!(nularr.field, js::JsModelFieldType::String));
    assert!(nularr.nullable && !nularr.required);
    assert_eq!(nularr.array_required, Some(false));
    let elnull = t15a_field(model, "f_elnull");
    assert!(matches!(elnull.field, js::JsModelFieldType::String));
    assert_eq!(elnull.array_required, Some(false));
    // Nested arrays keep the marker with an honest element tag.
    let nested = t15a_field(model, "f_nested");
    assert!(matches!(nested.field, js::JsModelFieldType::Other { .. }));
    assert_eq!(nested.array_required, Some(false));
    // Exotic shapes stay honest `other` (T15b refines deliveries).
    match tag("f_delivery") {
        js::JsModelFieldType::Other { type_id } => {
            assert_eq!(type_id, "delivery:demo.Svc.ping")
        }
        other => panic!("delivery tag: {other:?}"),
    }
    match tag("f_action") {
        js::JsModelFieldType::Other { type_id } => assert_eq!(type_id, "action"),
        other => panic!("action tag: {other:?}"),
    }
    match tag("f_union") {
        js::JsModelFieldType::Other { type_id } => assert_eq!(type_id, "union"),
        other => panic!("union tag: {other:?}"),
    }
    match tag("f_object") {
        js::JsModelFieldType::Other { type_id } => assert_eq!(type_id, "object"),
        other => panic!("object tag: {other:?}"),
    }
    match tag("f_opaque") {
        js::JsModelFieldType::Other { type_id } => assert_eq!(type_id, "test-deferral"),
        other => panic!("opaque tag: {other:?}"),
    }
    // Collection is diagnostic-free even for exotic shapes.
    let emitter = Emitter::new(&ir);
    let _ = emitter.collect_models();
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty(), "no descriptor diagnostics: {diags:?}");
}

/// (T15a) Model descriptors end to end: every pilot field kind emits with
/// its T09 requiredness/omission/server distinctions, T11 exact decimal
/// defaults (including integral 0/1 in decimal positions), field-level
/// unique keys only (composites shed to `uniques`, A2b), and the
/// default archive delete mode.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_models_shape_end_to_end() {
    let src = "app Shop\nGiven\n Gadget { title:text, stock:int=0, price:decimal=1.50, ratio:decimal=0, qty:decimal=1, active:bool=true, state:enum(draft,submitted)=draft, owner:Gadget?, tags:text[], ids:text[]!, nick:text[]?, by:user server=actor, code:text unique }\n policy Gadget read=members\n unique Gadget fields=title,stock\nWhen\n crud Gadget by=members fields=title,stock,price,ratio,qty,active,state,owner,tags,ids,nick,code\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let model = t15a_model(&artifact, "Shop.Gadget");
    assert_eq!(model.delete_mode, "archive");
    assert_eq!(model.unique_keys, vec!["code".to_string()]);
    assert!(
        model.parent.is_none() && !model.scope_app,
        "team scope default"
    );
    let title = t15a_field(model, "title");
    assert!(title.required && !title.server_only && !title.nullable);
    assert!(title.array_required.is_none() && title.default.is_none());
    let stock = t15a_field(model, "stock");
    assert!(!stock.required, "defaulted input fills its default");
    assert_eq!(
        stock.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":\"0\"}")
    );
    // T11: decimal defaults stay exact (scale preserved, never Number).
    let price = t15a_field(model, "price");
    assert_eq!(
        price.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":\"1.50\"}")
    );
    let ratio = t15a_field(model, "ratio");
    assert_eq!(
        ratio.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":\"0\"}")
    );
    let qty = t15a_field(model, "qty");
    assert_eq!(
        qty.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":\"1\"}")
    );
    let state = t15a_field(model, "state");
    assert_eq!(
        state.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":\"draft\"}")
    );
    // T09: ordinary arrays omit to empty, required arrays reject omission,
    // nullable arrays yield null; all keep their marker.
    let tags = t15a_field(model, "tags");
    assert_eq!(tags.array_required, Some(false));
    assert!(!tags.required && !tags.nullable);
    let ids = t15a_field(model, "ids");
    assert_eq!(ids.array_required, Some(true));
    assert!(ids.required);
    let nick = t15a_field(model, "nick");
    assert_eq!(nick.array_required, Some(false));
    assert!(nick.nullable && !nick.required);
    // Self-reference resolves by canonical name (recursion without
    // expansion).
    match &t15a_field(model, "owner").field {
        js::JsModelFieldType::Ref { model } => assert_eq!(model, "Shop.Gadget"),
        other => panic!("self-ref tag: {other:?}"),
    }
    // Server-owned fields reject caller values and leave the inputs.
    let by = t15a_field(model, "by");
    assert!(by.server_only && !by.required);
    assert_eq!(
        by.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"server\",\"init\":\"actor\"}")
    );
    let create = d03_operation(&artifact, "Shop.Gadget.create");
    assert!(
        create.inputs.iter().all(|input| input.name != "by"),
        "server fields never caller-provided: {:?}",
        create.inputs.iter().map(|i| &i.name).collect::<Vec<_>>()
    );
    // The envelope carries the models key per artifact.ts.
    let json = artifact::to_json(&artifact);
    assert!(json.contains("\"models\":[{"), "models key: {json}");
    assert!(json.contains("\"deleteMode\":\"archive\""), "mode: {json}");
    assert!(json.contains("\"uniqueKeys\":[\"code\"]"), "keys: {json}");
}

/// (T15a) Operation inputs end to end: array parameters map (ordinary,
/// omission fills empty) instead of omitting the operation, literal
/// parameter defaults carry, and nullable inputs flag — while CRUD
/// create keeps required-`!` arrays required and update stays partial
/// and default-less.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_operation_inputs_carry_arrays_defaults_nullable() {
    let src = "app Shop\nGiven\n Gadget { title:text, tags:text[], ids:text[]!, stock:int=0 }\n policy Gadget read=members\nWhen\n scenario review(notes:text[], limit:int=10, nick:text?) by=members\n  do\n   let x = 1\n crud Gadget by=members fields=title,tags,ids,stock\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    // The array-parameter scenario is present (T09: no omitted behavior).
    let review = d03_operation(&artifact, "Shop.review");
    let notes = d03_input(review, "notes");
    assert!(matches!(notes.field, js::JsMcpField::String));
    assert_eq!(notes.array_required, Some(false));
    assert!(!notes.required && !notes.nullable);
    let limit = d03_input(review, "limit");
    assert!(!limit.required && !limit.nullable);
    assert_eq!(
        limit.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":\"10\"}")
    );
    let nick = d03_input(review, "nick");
    assert!(nick.nullable && !nick.required);
    assert!(nick.default.is_none() && nick.array_required.is_none());
    // CRUD create: required `!` arrays stay required, ordinary arrays and
    // defaulted fields do not; field defaults carry.
    let create = d03_operation(&artifact, "Shop.Gadget.create");
    let ids = d03_input(create, "ids");
    assert_eq!(ids.array_required, Some(true));
    assert!(ids.required);
    let tags = d03_input(create, "tags");
    assert_eq!(tags.array_required, Some(false));
    assert!(!tags.required);
    let stock = d03_input(create, "stock");
    assert!(!stock.required);
    assert_eq!(
        stock.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":\"0\"}")
    );
    // CRUD update: partial (all optional, defaults never apply) beside
    // the versioned record; markers describe the value shape.
    let update = d03_operation(&artifact, "Shop.Gadget.update");
    let record = d03_input(update, "record");
    assert!(record.required);
    assert!(matches!(
        record.field,
        js::JsMcpField::Ref {
            require_version: true,
            ..
        }
    ));
    for input in update.inputs.iter().filter(|i| i.name != "record") {
        assert!(!input.required, "partial change: {}", input.name);
        assert!(
            input.default.is_none(),
            "no defaults on update: {}",
            input.name
        );
    }
    let update_ids = d03_input(update, "ids");
    assert_eq!(update_ids.array_required, Some(true));
}

/// (T15a) Ownership and recursion end to end: child models carry their
/// canonical parent, app-scoped models carry `scope: app`, team scope is
/// the default, and self/mutual references resolve by name.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_ownership_and_recursion() {
    let src = "app Shop\nGiven\n Org { name:text }\n Team in Org { name:text }\n Member in Team { name:text, lead:Member? }\n Log in app { msg:text }\n Left { other:Right? }\n Right { other:Left? }\n policy Org read=members\n policy Team read=members\n policy Member read=members\n policy Log read=members\n policy Left read=members\n policy Right read=members\nWhen\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let org = t15a_model(&artifact, "Shop.Org");
    assert!(org.parent.is_none() && !org.scope_app);
    let team = t15a_model(&artifact, "Shop.Team");
    assert_eq!(team.parent.as_deref(), Some("Shop.Org"));
    assert!(!team.scope_app);
    let member = t15a_model(&artifact, "Shop.Member");
    assert_eq!(member.parent.as_deref(), Some("Shop.Team"));
    match &t15a_field(member, "lead").field {
        js::JsModelFieldType::Ref { model } => assert_eq!(model, "Shop.Member"),
        other => panic!("self-ref tag: {other:?}"),
    }
    let log = t15a_model(&artifact, "Shop.Log");
    assert!(log.parent.is_none() && log.scope_app);
    // Mutual recursion resolves by name on both sides.
    match &t15a_field(t15a_model(&artifact, "Shop.Left"), "other").field {
        js::JsModelFieldType::Ref { model } => assert_eq!(model, "Shop.Right"),
        other => panic!("mutual-ref tag: {other:?}"),
    }
    match &t15a_field(t15a_model(&artifact, "Shop.Right"), "other").field {
        js::JsModelFieldType::Ref { model } => assert_eq!(model, "Shop.Left"),
        other => panic!("mutual-ref tag: {other:?}"),
    }
    let json = artifact::to_json(&artifact);
    assert!(json.contains("\"parent\":\"Shop.Org\""), "parent: {json}");
    assert!(json.contains("\"scope\":\"app\""), "scope: {json}");
}

/// (T15a) Parent defaults, delete modes and derived fields end to end:
/// `=parent.path` records the dot path, `delete=remove`/`delete=none`
/// map (none disables the delete operation), and derived fields render
/// with the `derived` marker while staying out of operation inputs.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_parent_defaults_delete_modes_derived() {
    let src = "app Shop\nGiven\n Team { name:text, owner:user }\n Member in Team { name:text, buddy:user=parent.owner }\n Doc { title:text }\n Archive { title:text }\n policy Team read=members\n policy Member read=members\n policy Doc read=members\n policy Archive read=members\n derive Member.shout:text = row.name\nWhen\n crud Member by=members fields=name,buddy\n crud Doc by=members fields=title delete=remove\n crud Archive by=members fields=title delete=none\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let member = t15a_model(&artifact, "Shop.Member");
    let buddy = t15a_field(member, "buddy");
    assert!(!buddy.required, "parent default fills omission");
    assert_eq!(
        buddy.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"parent\",\"path\":\"owner\"}")
    );
    let create = d03_operation(&artifact, "Shop.Member.create");
    let create_buddy = d03_input(create, "buddy");
    assert!(!create_buddy.required);
    assert_eq!(
        create_buddy
            .default
            .as_ref()
            .map(|d| d.to_json())
            .as_deref(),
        Some("{\"kind\":\"parent\",\"path\":\"owner\"}")
    );
    // Derived fields: present in the model, absent from inputs.
    let shout = t15a_field(member, "shout");
    assert!(shout.server_only && !shout.required);
    assert_eq!(
        shout.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"derived\"}")
    );
    assert!(
        create.inputs.iter().all(|input| input.name != "shout"),
        "derived never an input: {:?}",
        create.inputs.iter().map(|i| &i.name).collect::<Vec<_>>()
    );
    // Delete modes map; delete=none disables the delete operation.
    assert_eq!(t15a_model(&artifact, "Shop.Member").delete_mode, "archive");
    assert_eq!(t15a_model(&artifact, "Shop.Doc").delete_mode, "remove");
    assert_eq!(t15a_model(&artifact, "Shop.Archive").delete_mode, "none");
    assert!(
        artifact
            .operations
            .iter()
            .any(|op| op.name == "Shop.Doc.delete"),
        "remove keeps delete: {:?}",
        artifact
            .operations
            .iter()
            .map(|op| &op.name)
            .collect::<Vec<_>>()
    );
    assert!(
        artifact
            .operations
            .iter()
            .all(|op| op.name != "Shop.Archive.delete"),
        "none disables delete: {:?}",
        artifact
            .operations
            .iter()
            .map(|op| &op.name)
            .collect::<Vec<_>>()
    );
    assert!(
        artifact
            .operations
            .iter()
            .any(|op| op.name == "Shop.Archive.create"),
        "none keeps create/update"
    );
}

/// (T15a) Callable identity: every scenario and generated CRUD operation
/// descriptor links to exactly one callable registry entry with a valid
/// member path; policy-read descriptors (denied-not-unknown metadata)
/// intentionally have none.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_callable_identity() {
    let src = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\n scenario approve(note:text) by=members\n  do\n   let x = 1\n crud Gadget by=members fields=title\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    for name in [
        "Shop.approve",
        "Shop.Gadget.create",
        "Shop.Gadget.update",
        "Shop.Gadget.delete",
    ] {
        assert!(
            artifact.operations.iter().any(|op| op.name == name),
            "operation {name} present"
        );
        let linked: Vec<_> = artifact
            .callables
            .iter()
            .filter(|callable| callable.id == name)
            .collect();
        assert_eq!(linked.len(), 1, "one callable for {name}");
        let callable = linked[0];
        assert!(!callable.member.is_empty(), "{name} member path");
        assert!(
            callable.member.iter().all(|segment| !segment.is_empty()),
            "{name} segments: {:?}",
            callable.member
        );
        assert!(!callable.module.is_empty() && !callable.export.is_empty());
    }
    // Policy reads publish descriptors without callables (no handler).
    assert!(
        artifact
            .operations
            .iter()
            .any(|op| op.name == "Shop.Gadget.read"),
        "read descriptor present"
    );
    assert!(
        artifact
            .callables
            .iter()
            .all(|callable| callable.id != "Shop.Gadget.read"),
        "read descriptors link no callable"
    );
}

/// (T15a) Example separation: test artifacts live under `tests/` with
/// non-empty scopes, production modules never import them, and every
/// module (production and test) imports only allowlisted sources.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_example_separation() {
    let (db, id) = load_example("TeamTasks.can");
    let (catalog, path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let (artifact, _diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(!artifact.tests.is_empty(), "suites emit test artifacts");
    for test in &artifact.tests {
        assert!(!test.scope.is_empty(), "scope pins the operation");
        assert!(
            test.module.path.starts_with("tests/"),
            "test-only path: {}",
            test.module.path
        );
        assert_imports_allowlisted(&test.module.js, &test.module.path);
    }
    for (index, module) in artifact.modules.iter().enumerate() {
        assert!(
            !module.js.contains("exampleFixtures"),
            "production module {index} never references test factories"
        );
        assert!(
            !module.js.contains("tests/"),
            "production module {index} never imports tests"
        );
        assert_imports_allowlisted(&module.js, &module.path);
        assert_sourcemap_valid(&artifact, index, &db, &module.path);
    }
    // Scopes resolve to emitted operations or fixture identities (never
    // dangling anonymous scopes).
    for test in &artifact.tests {
        let known_operation = artifact.operations.iter().any(|op| op.name == test.scope);
        let known_fixture = test.fixtures.iter().any(|f| f == &test.scope);
        assert!(
            known_operation || known_fixture,
            "scope resolves: {} (fixtures: {:?})",
            test.scope,
            test.fixtures
        );
    }
}

/// (T15a) Fail-closed omission is surgical: a `duration`-typed scenario
/// input (T04b scope) omits only that operation — siblings, models (the
/// duration field keeps its source-exact tag) and duration-free CRUD
/// operations stay — while a CRUD allowlist naming the duration field
/// omits that operation (no partial closed schema).
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_negative_exotic_omits_operation_only() {
    let src = "app Shop\nGiven\n Gadget { title:text, window:duration }\n Timer { window:duration }\n policy Gadget read=members\n policy Timer read=members\nWhen\n scenario slow(wait:duration) by=members\n  do\n   let x = 1\n scenario fast(note:text) by=members\n  do\n   let x = 1\n crud Gadget by=members fields=title\n crud Timer by=members fields=window\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let names: Vec<_> = artifact.operations.iter().map(|op| &op.name).collect();
    assert!(
        !names.iter().any(|n| n.as_str() == "Shop.slow"),
        "exotic omitted: {names:?}"
    );
    assert!(
        names.iter().any(|n| n.as_str() == "Shop.fast"),
        "sibling kept: {names:?}"
    );
    assert!(
        names.iter().any(|n| n.as_str() == "Shop.Gadget.create"),
        "duration-free crud kept: {names:?}"
    );
    assert!(
        !names.iter().any(|n| n.as_str() == "Shop.Timer.create"),
        "exotic allowlist omits (no partial schema): {names:?}"
    );
    // Models stay complete: the duration field keeps its source-exact tag.
    let window = t15a_field(t15a_model(&artifact, "Shop.Gadget"), "window");
    assert!(matches!(window.field, js::JsModelFieldType::Duration));
}

/// (T15a) A model field literally named `record` collides with the
/// synthesized update ref: update omits (no ambiguous schema) while
/// create (flat inputs, no synthesis) and delete (bare ref) stay.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_negative_duplicate_record_name() {
    let src = "app Shop\nGiven\n Gadget { title:text, record:text }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,record\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let names: Vec<_> = artifact
        .operations
        .iter()
        .map(|op| op.name.as_str())
        .collect();
    assert!(
        names.contains(&"Shop.Gadget.create"),
        "create kept: {names:?}"
    );
    assert!(
        !names.contains(&"Shop.Gadget.update"),
        "update omits: {names:?}"
    );
    assert!(
        names.contains(&"Shop.Gadget.delete"),
        "delete kept: {names:?}"
    );
}

/// (T15a) The emitted envelope uses only closed descriptor kinds: every
/// operation input kind is one of the 9 L3-mirrored kinds, every model
/// field kind is one of the 17 `ArtifactModelFieldType` members, every
/// delete mode is `archive`/`remove`/`none`, and no unknown kind string
/// appears anywhere in the envelope.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_negative_kinds_closed() {
    let src = "app Shop\nGiven\n Team { name:text, owner:user }\n Member in Team { name:text, buddy:user=parent.owner, tags:text[] }\n Gadget { title:text, stock:int=0, state:enum(draft,submitted)=draft }\n policy Team read=members\n policy Member read=members\n policy Gadget read=members\n derive Member.shout:text = row.name\nWhen\n scenario review(notes:text[]) by=members\n  do\n   let x = 1\n crud Member by=members fields=name,buddy,tags\n crud Gadget by=members fields=title,stock,state delete=remove\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let json = artifact::to_json(&artifact);
    let parsed = canlang_compiler::json::parse(&json).expect("envelope parses");
    let closed_inputs = [
        "ref", "string", "integer", "decimal", "money", "datetime", "boolean", "file", "enum",
    ];
    let closed_model_kinds = [
        "ref", "string", "integer", "decimal", "money", "datetime", "boolean", "file", "enum",
        "date", "duration", "secret", "user", "member", "json", "bytes", "other",
    ];
    let operations = parsed
        .get("operations")
        .and_then(|v| v.as_arr())
        .expect("operations");
    assert!(!operations.is_empty(), "operations present");
    for op in operations {
        let kind = op.get("kind").and_then(|v| v.as_str()).expect("op kind");
        assert!(
            ["read", "create", "update", "delete", "scenario"].contains(&kind),
            "operation kind closed: {kind}"
        );
        let fields = op
            .get("inputs")
            .and_then(|v| v.get("fields"))
            .and_then(|v| v.as_arr())
            .expect("input fields");
        for input in fields {
            let field_kind = input
                .get("field")
                .and_then(|v| v.get("kind"))
                .and_then(|v| v.as_str())
                .expect("input kind");
            assert!(
                closed_inputs.contains(&field_kind),
                "input kind closed: {field_kind}"
            );
            assert!(
                input.get("required").and_then(|v| v.as_bool()).is_some(),
                "required always renders"
            );
        }
    }
    let models = parsed
        .get("models")
        .and_then(|v| v.as_arr())
        .expect("models");
    assert_eq!(models.len(), 3, "every model emits");
    for model in models {
        let mode = model
            .get("deleteMode")
            .and_then(|v| v.as_str())
            .expect("mode");
        assert!(
            ["archive", "remove", "none"].contains(&mode),
            "mode closed: {mode}"
        );
        let fields = model
            .get("fields")
            .and_then(|v| v.as_arr())
            .expect("fields");
        assert!(!fields.is_empty(), "model has fields");
        for field in fields {
            let field_kind = field
                .get("field")
                .and_then(|v| v.get("kind"))
                .and_then(|v| v.as_str())
                .expect("field kind");
            assert!(
                closed_model_kinds.contains(&field_kind),
                "model kind closed: {field_kind}"
            );
        }
    }
    // No unknown-kind leakage anywhere in the envelope.
    for marker in [
        "\"kind\":\"unknown\"",
        "\"kind\":\"delivery\"",
        "\"kind\":\"action\"",
    ] {
        assert!(!json.contains(marker), "no {marker} in envelope");
    }
}

/// (T15a) Structural literal defaults encode recursively: an array
/// literal default renders its exact elements (T10 slice through the
/// descriptor chain).
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15a_structural_literal_default() {
    let src = "app Shop\nGiven\n Gadget { title:text, tags:text[]=[\"a\",\"b\"] }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,tags\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let tags = t15a_field(t15a_model(&artifact, "Shop.Gadget"), "tags");
    assert_eq!(tags.array_required, Some(false));
    assert!(
        !tags.required,
        "defaulted array fills its default, marker kept"
    );
    assert_eq!(
        tags.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":[\"a\",\"b\"]}")
    );
    let create = d03_operation(&artifact, "Shop.Gadget.create");
    let input = d03_input(create, "tags");
    assert_eq!(
        input.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"literal\",\"value\":[\"a\",\"b\"]}")
    );
}

// --- T15b provider-descriptor join -------------------------------------------

/// T15b fake `std` operation with no T13c result nominal: drives the
/// fail-closed fallback (nothing fabricated for unjoined shapes).
static T15B_FAKE_OP: StdOperation = StdOperation {
    name: "nope",
    inputs: &[],
    result: "Nope",
};

/// One synthetic T14c typed `std` receipt over a REAL consumed T13
/// operation (never an invented schema).
fn t15b_std_delivery(capability: &'static str, op: &str) -> ResolvedType {
    ResolvedType::StdDelivery {
        capability,
        op: std_operation(capability, op).unwrap_or_else(|| panic!("T13 op {capability}.{op}")),
    }
}

/// (T15b) `delivery_descriptor` joins the frozen capability version
/// with the T13c result leaves in producer order, or fails closed on
/// either miss (callers keep today's omit/`other` behavior).
#[test]
fn t15b_delivery_descriptor_helper() {
    let send = std_operation("std.EmailV1", "send").expect("send schema");
    let descriptor = js::delivery_descriptor("std.EmailV1", send).expect("joined descriptor");
    assert_eq!(descriptor.capability, "std.EmailV1");
    assert_eq!(descriptor.operation, "send");
    assert_eq!(descriptor.version, 1);
    assert_eq!(descriptor.result.name, "EmailAccepted");
    assert_eq!(
        descriptor.to_json(),
        "{\"kind\":\"delivery\",\"capability\":\"std.EmailV1\",\"operation\":\"send\",\
         \"version\":1,\"result\":{\"name\":\"EmailAccepted\",\
         \"fields\":[{\"name\":\"reference\",\"type\":\"text\"}]}}"
    );
    assert!(
        js::delivery_descriptor("std.NopeV1", send).is_none(),
        "unknown capability stays unjoined"
    );
    assert!(
        js::delivery_descriptor("std.EmailV1", &T15B_FAKE_OP).is_none(),
        "unknown result nominal stays unjoined"
    );
}

/// (T15b) Model tags for typed `std` receipts over a synthetic IR:
/// Mail/Payments/Text/Images emit closed delivery descriptors with
/// verbatim T13c leaves; bound-local deliveries keep `other`;
/// unjoined shapes fall back exactly — total, diagnostic-free.
#[test]
fn t15b_std_delivery_model_tags() {
    let span = sp(0, 1);
    let mut items = vec![
        IrItem {
            id: SymbolId(0),
            canonical: "demo.M".to_string(),
            name: "M".to_string(),
            module: ModuleId(0),
            span,
            exported: true,
            kind: IrItemKind::Model {
                // Symbol ids are item indices (index parity): the two
                // header items occupy 0..2, fields follow from 2.
                fields: (2..9).map(SymbolId).collect(),
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
    ];
    let send = std_operation("std.EmailV1", "send").expect("send schema");
    let field_types: Vec<(&str, IrType)> = vec![
        (
            "f_mail",
            IrType::Known(t15b_std_delivery("std.EmailV1", "send")),
        ),
        (
            "f_pay",
            IrType::Known(t15b_std_delivery("std.PaymentsV1", "collect")),
        ),
        (
            "f_text",
            IrType::Known(t15b_std_delivery("std.TextGenerationV1", "generate")),
        ),
        (
            "f_img",
            IrType::Known(t15b_std_delivery("std.ImagesV1", "submit")),
        ),
        (
            "f_local",
            IrType::Known(ResolvedType::Delivery { op: SymbolId(1) }),
        ),
        (
            "f_bogus_result",
            IrType::Known(ResolvedType::StdDelivery {
                capability: "std.EmailV1",
                op: &T15B_FAKE_OP,
            }),
        ),
        (
            "f_bogus_cap",
            IrType::Known(ResolvedType::StdDelivery {
                capability: "std.FakeV1",
                op: send,
            }),
        ),
    ];
    for (index, (name, ty)) in field_types.into_iter().enumerate() {
        items.push(t15a_field_item(2 + index as u32, name, ty));
    }
    let ir = IrProgram {
        modules: vec![IrModule {
            id: ModuleId(0),
            name: "demo".to_string(),
            kind: ModuleKind::Package,
            file: SourceId(0),
            span,
            imports: Vec::new(),
            uses: Vec::new(),
            uses_resolved: Vec::new(),
            app_default_locale: None,
            pages: Vec::new(),
            description: None,
        }],
        items,
        catalog_version: String::new(),
        referenced_builtins: Vec::new(),
        read_rules: Vec::new(),
        invariants: Vec::new(),
        locks: Vec::new(),
        retention: Vec::new(),
        crud_when: Vec::new(),
        preferences_valid: Vec::new(),
        suites: Vec::new(),
        migrations: Vec::new(),
    };
    let models = Emitter::new(&ir).collect_models();
    assert_eq!(models.len(), 1, "one model emits");
    let model = &models[0];
    let tag = |name: &str| t15a_field(model, name).field.clone();
    // Mail: closed descriptor with the single `EmailAccepted` leaf.
    match tag("f_mail") {
        js::JsModelFieldType::Delivery(descriptor) => {
            assert_eq!(descriptor.capability, "std.EmailV1");
            assert_eq!(descriptor.operation, "send");
            assert_eq!(descriptor.version, 1);
            assert_eq!(
                descriptor.to_json(),
                "{\"kind\":\"delivery\",\"capability\":\"std.EmailV1\",\"operation\":\"send\",\
                 \"version\":1,\"result\":{\"name\":\"EmailAccepted\",\
                 \"fields\":[{\"name\":\"reference\",\"type\":\"text\"}]}}"
            );
        }
        other => panic!("mail tag: {other:?}"),
    }
    // Payments: all seven `PaymentState` leaves, verbatim, in order.
    match tag("f_pay") {
        js::JsModelFieldType::Delivery(descriptor) => {
            assert_eq!(
                descriptor.to_json(),
                "{\"kind\":\"delivery\",\"capability\":\"std.PaymentsV1\",\
                 \"operation\":\"collect\",\"version\":1,\
                 \"result\":{\"name\":\"PaymentState\",\"fields\":[\
                 {\"name\":\"reference\",\"type\":\"text\"},\
                 {\"name\":\"revision\",\"type\":\"int\"},\
                 {\"name\":\"provider_reference\",\"type\":\"text?\"},\
                 {\"name\":\"amount\",\"type\":\"money\"},\
                 {\"name\":\"status\",\"type\":\"enum(pending,unknown,succeeded,failed)\"},\
                 {\"name\":\"checkout_url\",\"type\":\"url?\"},\
                 {\"name\":\"failure\",\"type\":\"enum(transient,action_required,permanent,cancelled)?\"}\
                 ]}}"
            );
        }
        other => panic!("payments tag: {other:?}"),
    }
    // Text: all seven `TextRun` leaves, verbatim, in order.
    match tag("f_text") {
        js::JsModelFieldType::Delivery(descriptor) => {
            assert_eq!(descriptor.result.name, "TextRun");
            assert_eq!(
                descriptor.to_json(),
                "{\"kind\":\"delivery\",\"capability\":\"std.TextGenerationV1\",\
                 \"operation\":\"generate\",\"version\":1,\
                 \"result\":{\"name\":\"TextRun\",\"fields\":[\
                 {\"name\":\"source\",\"type\":\"text\"},\
                 {\"name\":\"revision\",\"type\":\"int\"},\
                 {\"name\":\"sequence\",\"type\":\"int\"},\
                 {\"name\":\"state\",\"type\":\"enum(queued,running,succeeded,failed,unknown,cancelled)\"},\
                 {\"name\":\"content\",\"type\":\"text\"},\
                 {\"name\":\"used_tokens\",\"type\":\"int?\"},\
                 {\"name\":\"detail\",\"type\":\"text?\"}\
                 ]}}"
            );
        }
        other => panic!("text tag: {other:?}"),
    }
    // Images: SOURCE names only (T13c ImageRun-vs-wire precedent).
    match tag("f_img") {
        js::JsModelFieldType::Delivery(descriptor) => {
            assert_eq!(descriptor.result.name, "ImageRun");
            let json = descriptor.to_json();
            assert_eq!(
                json,
                "{\"kind\":\"delivery\",\"capability\":\"std.ImagesV1\",\
                 \"operation\":\"submit\",\"version\":1,\
                 \"result\":{\"name\":\"ImageRun\",\"fields\":[\
                 {\"name\":\"source\",\"type\":\"text\"},\
                 {\"name\":\"revision\",\"type\":\"int\"},\
                 {\"name\":\"sequence\",\"type\":\"int\"},\
                 {\"name\":\"state\",\"type\":\"enum(queued,running,succeeded,failed,unknown,cancelled)\"},\
                 {\"name\":\"outputs\",\"type\":\"GeneratedImage[]\"},\
                 {\"name\":\"charged_jobs\",\"type\":\"int?\"},\
                 {\"name\":\"detail\",\"type\":\"text?\"}\
                 ]}}"
            );
            for wire in ["ImageRunProgress", "ImageFileOutput"] {
                assert!(!json.contains(wire), "no wire alias {wire}: {json}");
            }
        }
        other => panic!("images tag: {other:?}"),
    }
    // Bound-local deliveries keep the source-exact `other` tag.
    match tag("f_local") {
        js::JsModelFieldType::Other { type_id } => {
            assert_eq!(type_id, "delivery:demo.Svc.ping")
        }
        other => panic!("local tag: {other:?}"),
    }
    // Unjoined shapes fall back exactly, never fabricated.
    match tag("f_bogus_result") {
        js::JsModelFieldType::Other { type_id } => {
            assert_eq!(type_id, "delivery:std.EmailV1.nope")
        }
        other => panic!("bogus-result tag: {other:?}"),
    }
    match tag("f_bogus_cap") {
        js::JsModelFieldType::Other { type_id } => {
            assert_eq!(type_id, "delivery:std.FakeV1.send")
        }
        other => panic!("bogus-capability tag: {other:?}"),
    }
}

/// (T15b) Operation inputs for typed `std` receipts, end to end: a
/// scenario taking a nullable `delivery(Mail.send)` emits (not omits)
/// with a closed delivery input beside its ordinary T15a input.
/// The two `E6008`s are the pre-existing T14c fail-closed §13 schema
/// posture for `std` delivery values (runtime schema lowering, out
/// of this descriptor slice): pinned here so this slice proves it
/// changes no diagnostic.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15b_operation_input_delivery_end_to_end() {
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  Notice { recipient:email }\n  policy Notice read=members\n When\n  crud Notice by=members fields=recipient\n  scenario retry(note:text, attempt:delivery(Mail.send)?) by=members\n   do\n    let x = 1\n Then\n";
    let (_program, artifact, diags) = d03_emit(src);
    let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
    assert_eq!(
        codes,
        vec!["E6008", "E6008"],
        "T14c posture only: {diags:?}"
    );
    for diag in &diags {
        assert!(
            diag.message.contains("delivery"),
            "delivery-shaped E6008: {diag:?}"
        );
    }
    let op = d03_operation(&artifact, "p.retry");
    // Ordinary input renders exactly per T15a beside the delivery one.
    let note = d03_input(op, "note");
    assert_eq!(note.field.to_json(), "{\"kind\":\"string\"}");
    assert!(note.required);
    assert!(!note.nullable);
    // The delivery input is closed, nullable and optional.
    let attempt = d03_input(op, "attempt");
    match &attempt.field {
        js::JsMcpField::Delivery(descriptor) => {
            assert_eq!(descriptor.capability, "std.EmailV1");
            assert_eq!(descriptor.operation, "send");
            assert_eq!(descriptor.version, 1);
            assert_eq!(descriptor.result.name, "EmailAccepted");
            assert_eq!(
                descriptor.to_json(),
                "{\"kind\":\"delivery\",\"capability\":\"std.EmailV1\",\"operation\":\"send\",\
                 \"version\":1,\"result\":{\"name\":\"EmailAccepted\",\
                 \"fields\":[{\"name\":\"reference\",\"type\":\"text\"}]}}"
            );
        }
        other => panic!("attempt input: {other:?}"),
    }
    assert!(!attempt.required, "nullable delivery omits");
    assert!(attempt.nullable, "nullable delivery accepts null");
}

/// (T15b) Stored `std` delivery fields, end to end: the model tag is
/// the closed delivery descriptor with T15a nullability/requiredness
/// beside it. Same pinned T14c `E6008` posture as the input test.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15b_model_delivery_end_to_end() {
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  Notice { recipient:email, delivery:delivery(Mail.send)? }\n  policy Notice read=members\n When\n  crud Notice by=members fields=recipient\n Then\n";
    let (_program, artifact, diags) = d03_emit(src);
    let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
    assert_eq!(
        codes,
        vec!["E6008", "E6008"],
        "T14c posture only: {diags:?}"
    );
    let model = t15a_model(&artifact, "p.Notice");
    let recipient = t15a_field(model, "recipient");
    assert_eq!(recipient.field.to_json(), "{\"kind\":\"string\"}");
    assert!(recipient.required);
    let delivery = t15a_field(model, "delivery");
    match &delivery.field {
        js::JsModelFieldType::Delivery(descriptor) => {
            assert_eq!(descriptor.capability, "std.EmailV1");
            assert_eq!(descriptor.result.name, "EmailAccepted");
        }
        other => panic!("delivery tag: {other:?}"),
    }
    assert!(!delivery.required, "nullable delivery omits");
    assert!(delivery.nullable, "nullable delivery accepts null");
    assert!(!delivery.server_only);
}

/// (T15b) Recipe value shape join (seam 5), end to end: checker-validated
/// `std` fixtures lower as structured delivery recipes keyed by the
/// qualified T13 send target — no `E6006`, no throwing shell — for both
/// bound and unbound `std` imports. Values flow through the existing
/// delivery lowering unchanged (join, not rebuild).
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15b_recipe_join_std() {
    for import in [
        "use std {EmailV1 as Mail} from=deployment.mail",
        "use std {EmailV1 as Mail}",
    ] {
        let src = format!(
            "app T uses=[p]\npackage p\n {import}\n Given\n  \
             fixture attempt=Mail.send {{request={{to=\"a@b.test\",subject=\"Review\",body=\"Plan\"}}}}\n  \
             fixture detached=Mail.send {{request={{to=\"a@b.test\",subject=\"Review\",body=\"Plan\"}},\
             status=failed,error={{code=\"provider\",message=\"Delivery rejected\"}}}}\n \
             When\n Then\n"
        );
        let (_program, artifact, diags) = d03_emit(&src);
        assert!(diags.is_empty(), "{import}: clean join: {diags:?}");
        assert_eq!(artifact.tests.len(), 2, "{import}: orphan suites");
        let js: Vec<&str> = artifact
            .tests
            .iter()
            .map(|t| t.module.js.as_str())
            .collect();
        let attempt = artifact
            .tests
            .iter()
            .find(|t| t.scope == "p.attempt")
            .unwrap_or_else(|| panic!("{import}: attempt suite"));
        assert!(
            attempt.module.js.contains("delivery:\"std.EmailV1.send\""),
            "{import}: qualified target:\n{}",
            attempt.module.js
        );
        assert!(
            attempt
                .module
                .js
                .contains("request:{to:\"a@b.test\",subject:\"Review\",body:\"Plan\"}"),
            "{import}: request values:\n{}",
            attempt.module.js
        );
        let detached = artifact
            .tests
            .iter()
            .find(|t| t.scope == "p.detached")
            .unwrap_or_else(|| panic!("{import}: detached suite"));
        assert!(
            detached.module.js.contains("status:\"failed\""),
            "{import}: failed status:\n{}",
            detached.module.js
        );
        assert!(
            detached
                .module
                .js
                .contains("error:{code:\"provider\",message:\"Delivery rejected\"}"),
            "{import}: error values:\n{}",
            detached.module.js
        );
        for (index, module) in js.iter().enumerate() {
            assert!(
                !module.contains("throw new Error"),
                "{import}: module {index} is a real recipe:\n{module}"
            );
        }
    }
}

/// (T15b) Recipe join negatives: unresolvable heads and wrong `std`
/// operations keep the failing shell plus `E6006` — never joined,
/// never fabricated.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15b_recipe_join_negatives_stay_shelled() {
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  fixture ghost=Nope.send {request={to=\"a@b.test\"}}\n  fixture wrongop=Mail.bogus {request={to=\"a@b.test\"}}\n When\n Then\n";
    // Analysis level (pre-existing checker behavior): the unknown head
    // is `E2001` and the wrong `std` operation is `E3015`.
    let mut db = SourceDb::new();
    let id = db.add("d03.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    let mut analysis_codes: Vec<&str> = result.diagnostics.iter().map(|d| d.code).collect();
    analysis_codes.sort_unstable();
    assert_eq!(
        analysis_codes,
        vec!["E2001", "E3015"],
        "unresolved head + wrong op: {:?}",
        result.diagnostics
    );
    // Emission level: both keep the failing shell plus `E6006`.
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    let mut codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
    codes.sort_unstable();
    assert_eq!(codes, vec!["E6006", "E6006"], "two shells: {diags:?}");
    assert_eq!(artifact.tests.len(), 2, "two shells");
    for test in &artifact.tests {
        assert!(
            test.module.js.contains("throw new Error"),
            "shell throws: {}",
            test.scope
        );
        assert!(
            test.module.js.contains("unresolved fixture target"),
            "shell message: {}",
            test.scope
        );
        assert!(
            !test.module.js.contains("delivery:\"std."),
            "no provider join: {}",
            test.scope
        );
    }
}

/// (T15b) Envelope-wide closed kinds with deliveries: Mail, Payments,
/// Text and Images fields all tag `delivery` with exactly the shared
/// member set; nothing else in the kind vocabulary changes; source
/// nominal names only.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15b_closed_kinds_with_delivery() {
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n use std {PaymentsV1 as Payments} from=deployment.payments\n use std {TextGenerationV1 as LLM} from=deployment.llm\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  Notice { mail:delivery(Mail.send)?, pay:delivery(Payments.collect)?, text:delivery(LLM.generate)?, img:delivery(Images.submit)? }\n  policy Notice read=members\n When\n Then\n";
    let (_program, artifact, diags) = d03_emit(src);
    // Pre-existing T14c `E6008` posture only (two per delivery field:
    // the §13 field-schema and structural type-id positions); every
    // message matches a known T14c template, so this slice adds none.
    assert_eq!(diags.len(), 8, "two E6008 per field: {diags:?}");
    for diag in &diags {
        assert_eq!(diag.code, "E6008");
        assert!(
            diag.message.contains("std delivery type id")
                || diag.message.contains("std delivery values"),
            "known T14c template: {diag:?}"
        );
    }
    let json = artifact::to_json(&artifact);
    let parsed = canlang_compiler::json::parse(&json).expect("envelope parses");
    let models = parsed
        .get("models")
        .and_then(|v| v.as_arr())
        .expect("models");
    assert_eq!(models.len(), 1, "one model emits");
    let fields = models[0]
        .get("fields")
        .and_then(|v| v.as_arr())
        .expect("fields");
    assert_eq!(fields.len(), 4, "four delivery fields");
    let mut seen = Vec::new();
    for field in fields {
        let tag = field.get("field").expect("field tag");
        assert_eq!(
            tag.get("kind").and_then(|v| v.as_str()),
            Some("delivery"),
            "closed delivery kind: {field:?}"
        );
        let capability = tag
            .get("capability")
            .and_then(|v| v.as_str())
            .expect("capability");
        let operation = tag
            .get("operation")
            .and_then(|v| v.as_str())
            .expect("operation");
        seen.push(format!("{capability}.{operation}"));
        assert_eq!(
            tag.get("version").and_then(|v| v.as_i64()),
            Some(1),
            "version fenced: {field:?}"
        );
        let result = tag.get("result").expect("result nominal");
        assert!(
            result.get("name").and_then(|v| v.as_str()).is_some(),
            "result name: {field:?}"
        );
        let leaves = result
            .get("fields")
            .and_then(|v| v.as_arr())
            .expect("leaves");
        assert!(!leaves.is_empty(), "nonempty leaves: {field:?}");
        for leaf in leaves {
            assert!(
                leaf.get("name").and_then(|v| v.as_str()).is_some()
                    && leaf.get("type").and_then(|v| v.as_str()).is_some(),
                "leaf is exactly {{name,type}}: {leaf:?}"
            );
        }
    }
    seen.sort();
    assert_eq!(
        seen,
        vec![
            "std.EmailV1.send",
            "std.ImagesV1.submit",
            "std.PaymentsV1.collect",
            "std.TextGenerationV1.generate",
        ]
    );
    // Source nominal names only (T13c ImageRun-vs-wire precedent).
    assert!(
        json.contains("\"name\":\"ImageRun\""),
        "source name: {json}"
    );
    for wire in ["ImageRunProgress", "ImageFileOutput"] {
        assert!(!json.contains(wire), "no wire alias {wire}");
    }
    // No unknown-kind leakage anywhere in the envelope.
    for marker in ["\"kind\":\"unknown\"", "\"kind\":\"action\""] {
        assert!(!json.contains(marker), "no {marker} in envelope");
    }
}

/// (T15b) No-regression pins on T15a emission inside a mixed program:
/// ordinary model fields and operation inputs render byte-exact per
/// T15a beside joined deliveries and a joined recipe.
/// TEST-ONLY artifact: see module docs.
#[test]
fn t15b_no_regress_t15a_mixed() {
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  Gadget { title:text, stock:int=0, tags:text[], delivery:delivery(Mail.send)? }\n  policy Gadget read=members\n  fixture attempt=Mail.send {request={to=\"a@b.test\",subject=\"Hi\",body=\"Yo\"}}\n When\n  crud Gadget by=members fields=title,stock,tags\n  scenario ping(note:text) by=members\n   do\n    let x = 1\n Then\n";
    let (_program, artifact, diags) = d03_emit(src);
    // Only the stored delivery field's pre-existing T14c pair.
    assert_eq!(diags.len(), 2, "field E6008 pair only: {diags:?}");
    for diag in &diags {
        assert_eq!(diag.code, "E6008");
    }
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "recipe joined: {diags:?}"
    );
    // Ordinary model members, exactly per T15a.
    let model = t15a_model(&artifact, "p.Gadget");
    let title = t15a_field(model, "title");
    assert_eq!(title.field.to_json(), "{\"kind\":\"string\"}");
    assert!(title.required);
    let stock = t15a_field(model, "stock");
    assert_eq!(stock.field.to_json(), "{\"kind\":\"integer\"}");
    assert!(!stock.required, "defaulted");
    assert!(
        stock
            .default
            .as_ref()
            .is_some_and(|d| d.to_json().contains("\"literal\"")),
        "literal default kept"
    );
    let tags = t15a_field(model, "tags");
    assert_eq!(tags.array_required, Some(false), "ordinary marker");
    assert!(!tags.required, "ordinary omits");
    // Joined delivery beside them.
    let delivery = t15a_field(model, "delivery");
    assert!(
        matches!(delivery.field, js::JsModelFieldType::Delivery(_)),
        "delivery joined"
    );
    // Ordinary operation inputs, exactly per T15a.
    let create = d03_operation(&artifact, "p.Gadget.create");
    assert!(d03_input(create, "title").required);
    assert_eq!(d03_input(create, "tags").array_required, Some(false));
    let ping = d03_operation(&artifact, "p.ping");
    assert_eq!(
        d03_input(ping, "note").field.to_json(),
        "{\"kind\":\"string\"}"
    );
    // Joined recipe beside them.
    let attempt = artifact
        .tests
        .iter()
        .find(|t| t.scope == "p.attempt")
        .expect("attempt suite");
    assert!(
        attempt.module.js.contains("delivery:\"std.EmailV1.send\""),
        "recipe joined:\n{}",
        attempt.module.js
    );
}

// --- T31 staged-hook emission ------------------------------------------------
// TEST-ONLY artifacts: see module docs. The T31 tests pin the adopted Rule A
// (staged_flat) compiler remainder over the committed T31-core state engine:
// static staging bans with near-miss controls, hook-body emission calling
// the engine's stage/schedule/cancel surface, and end-to-end execution of
// emitted hooks against the real engine (bun driver over workspace sources).
// Failing-first: the E4052/E4053/E4054 ban tests fail until the effects pass
// grows the bans; every emission test fails until hook lowering lands.

/// Check one inline T31 source through the full pipeline with the golden
/// catalog (every builtin used below is implemented there).
fn t31_program(src: &str, catalog: &Catalog) -> (SourceDb, CheckedProgram, DiagnosticResult) {
    let mut db = SourceDb::new();
    let id = db.add("t31.can".to_string(), src.to_string());
    let (program, result) = check_example(&db, id, Some(catalog));
    (db, program, result)
}

fn t31_codes(result: &DiagnosticResult) -> Vec<&str> {
    result.diagnostics.iter().map(|d| d.code).collect()
}

/// (T31) Same-model staging is barred (NARROW bar, matching the engine):
/// a hook on M.create cannot stage a create of M, even though the
/// operation differs from the trigger.
#[test]
fn t31_same_model_create_barred() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.create\n  do\n   create M {t=\"x\"} as m\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4052"],
        "{:?}",
        result.diagnostics
    );
    assert!(
        result.diagnostics[0].message.contains("same-model"),
        "diagnostic names the bar: {}",
        result.diagnostics[0].message
    );
}

/// (T31) Same-model staging covers set: a hook on M.update cannot set an
/// M-typed row, even one it just staged (each statement reports once).
#[test]
fn t31_same_model_set_barred() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.update\n  do\n   create M {t=\"x\"} as m\n   set m {t=\"y\"}\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4052", "E4052"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) CONTROL: other-model staging stays legal, and the pending-record
/// adjustment (`set event.after`) is never same-model staging.
#[test]
fn t31_cross_model_staging_legal() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\n N { m:text }\nWhen\n scenario h on=M.create\n  do\n   set event.after {t=\"y\"}\n   create N {m=\"x\"} as n\n   set n {m=\"z\"}\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

/// (T31) Staged deletes are barred: a hook cannot delete, even an
/// other-model row it just staged.
#[test]
fn t31_staged_delete_barred() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\n N { m:text }\nWhen\n scenario h on=M.update\n  do\n   create N {m=\"x\"} as n\n   delete n\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4053"],
        "{:?}",
        result.diagnostics
    );
    assert!(
        result.diagnostics[0].message.contains("create/set only"),
        "diagnostic names the rule: {}",
        result.diagnostics[0].message
    );
}

/// (T31) CONTROL: `delete` outside hooks stays legal; the staged-delete
/// bar never leaks into ordinary scenarios.
#[test]
fn t31_delete_outside_hook_legal() {
    let (catalog, path) = golden_catalog();
    let src =
        "app T\nGiven\n N { m:text }\nWhen\n scenario s(n:N) by=members\n  do\n   delete n\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

/// (T31) Delete hooks cannot stage writes: a create in an on-delete hook
/// is rejected even for an other-model target.
#[test]
fn t31_delete_hook_create_barred() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\n N { m:text }\nWhen\n scenario h on=M.delete\n  do\n   create N {m=\"x\"} as n\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4054"],
        "{:?}",
        result.diagnostics
    );
    assert!(
        result.diagnostics[0].message.contains("cannot stage"),
        "diagnostic names the rule: {}",
        result.diagnostics[0].message
    );
}

/// (T31) Delete-hook staging covers set: each staged statement in a
/// delete hook reports once.
#[test]
fn t31_delete_hook_set_barred() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\n N { m:text }\nWhen\n scenario h on=M.delete\n  do\n   create N {m=\"x\"} as n\n   set n {m=\"y\"}\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4054", "E4054"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) Delete-hook staging covers timers: schedule in a delete hook is
/// rejected (the at= value reads the typed before side).
#[test]
fn t31_delete_hook_schedule_barred() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text, due:datetime }\n event Due { s:text }\nWhen\n scenario h on=M.delete\n  do\n   schedule \"k\" at=event.before.due event=Due {s=\"x\"}\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4054"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) Delete-hook staging covers cancel.
#[test]
fn t31_delete_hook_cancel_barred() {
    let (catalog, path) = golden_catalog();
    let src =
        "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.delete\n  do\n   cancel \"k\"\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4054"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) ORDER: in a delete hook the delete-hook rule wins over the
/// same-model rule, and each statement still reports exactly once.
#[test]
fn t31_delete_hook_same_model_order() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.delete\n  do\n   create M {t=\"x\"} as m\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4054"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) CONTROL: a delete hook may still read its before side and reject
/// by throwing (require); reads plus require stay clean.
#[test]
fn t31_delete_hook_require_read_legal() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.delete\n  require event.before.t!=\"x\"\n  do\n   let x = event.before.t\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

/// (T31) A delete hook cannot adjust its target (settled types rule): the
/// one E3009 stands alone — the new delete-hook ban must not double-fire
/// on the pending record.
#[test]
fn t31_delete_hook_after_adjust_rejected() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.delete\n  do\n   set event.after {t=\"x\"}\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E3009"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) The before snapshot is read-only (settled types rule): exactly
/// one E3009, never joined by a staging diagnostic.
#[test]
fn t31_before_snapshot_write_rejected() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.update\n  do\n   set event.before {t=\"x\"}\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E3009"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) The pending record cannot be deleted (settled types rule): the
/// E3009 owns the pending target, never joined by the staged-delete ban.
#[test]
fn t31_pending_delete_rejected_once() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.update\n  do\n   delete event.after\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E3009"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) The before snapshot cannot be deleted either: exactly one E3009,
/// never joined by the staged-delete ban.
#[test]
fn t31_before_delete_rejected_once() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.update\n  do\n   delete event.before\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E3009"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) CONTROL: before/after READS stay legal in hooks; only writes to
/// the snapshot side are barred.
#[test]
fn t31_before_after_reads_legal() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.update\n  do\n   let a = event.before.t\n   let b = event.after.t\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

/// (T31) CONTROL: verified declared-reference writes outside hooks stay
/// clean; the staging bans never leak past hook bodies.
#[test]
fn t31_verified_ref_set_outside_hook_legal() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n N { m:text }\n event Pk { item:N }\nWhen\n scenario h on=Pk\n  do\n   set event.item {m=\"x\"}\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

/// (T31) Bans apply at depth: a same-model create nested in an `if`
/// inside a hook is still barred.
#[test]
fn t31_nested_same_model_barred() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text, flag:bool }\nWhen\n scenario h on=M.create\n  do\n   if event.after.flag\n    create M {t=\"y\",flag=true} as m\nThen\n";
    let (_db, _program, result) = t31_program(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        t31_codes(&result),
        vec!["E4052"],
        "{:?}",
        result.diagnostics
    );
}

/// (T31) Hook run shape: the emitted run function adjusts the candidate,
/// stages a parented child plus timers through the hook context, and
/// registers under its trigger key with the scenario identity.
#[test]
fn t31_hook_run_shape() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text, flag:bool, due:datetime }\n C in M { m:text }\n event Due { s:text }\nWhen\n scenario h on=M.update\n  do\n   require event.after.t!=\"x\"\n   set event.after {t=\"done\"}\n   if event.after.flag\n    create C {parent=event.after,m=\"note\"} as c\n    schedule event.after.t at=event.after.due event=Due {s=\"done\"}\n   cancel \"deadline:old\"\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    // Registry entry: trigger key, scenario identity, engine op spelling.
    assert!(
        js.contains(
            "hooks:{\"T.M.update\":{name:\"T.h\",ops:[\"update\"],run:async function $can$s$542e68("
        ),
        "registry:\n{js}"
    );
    // Engine-shaped signature over the candidate and hook context.
    assert!(
        js.contains("run:async function $can$s$542e68($candidate,$hookCtx){"),
        "signature:\n{js}"
    );
    // Live event views: after aliases the candidate's fields plus trigger
    // identity and the reserved version; before is the frozen snapshot.
    assert!(
        js.contains("const event={after:{...$candidate,id:$hookCtx.triggerId"),
        "after view:\n{js}"
    );
    assert!(
        js.contains("version:($hookCtx.before?$hookCtx.before.version+1:1)"),
        "reserved version:\n{js}"
    );
    assert!(js.contains("let $stagedNext=0;"), "staged counter:\n{js}");
    assert!(js.contains("let $pending;"), "pending temp:\n{js}");
    // Pending adjustment assigns the same changes to both the candidate
    // the engine commits and the live after view later reads observe.
    assert!(
        js.contains(
            "$pending={t:\"done\"};Object.assign($candidate,$pending);Object.assign(event.after,$pending);"
        ),
        "pending adjustment:\n{js}"
    );
    // Guards reject by throwing, exactly like scenarios.
    assert!(
        js.contains("check(event.after.t !== \"x\");"),
        "guard:\n{js}"
    );
    // Parented child: deterministic trigger-derived id, triggerId parenting.
    assert!(
        js.contains("const $can$l$303a63={id:$hookCtx.triggerId+\"/staged/\"+($stagedNext++)};"),
        "staged id:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.stage({op:\"create\",model:\"T.C\",id:$can$l$303a63.id,parent:{model:\"T.M\",id:event.after.id},data:{m:\"note\"}});"),
        "staged create:\n{js}"
    );
    // Timers stage through the hook context with the canonical event.
    assert!(
        js.contains("$hookCtx.schedule({key:event.after.t,at:event.after.due,event:\"T.Due\",payload:{s:\"done\"}});"),
        "staged schedule:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.cancel(\"deadline:old\");"),
        "staged cancel:\n{js}"
    );
    assert!(js.contains("return $candidate;"), "candidate return:\n{js}");
    // Hooks are reactive, not operations: the operations member stays empty.
    assert!(js.contains("operations:{}"), "operations member:\n{js}");
    // Explicit callable linkage into the hooks registry.
    let callable = artifact
        .callables
        .iter()
        .find(|c| c.id == "T.h")
        .expect("T.h callable");
    assert_eq!(callable.kind, "handler");
    assert_eq!(callable.member, vec!["hooks", "T.M.update", "run"]);
    assert_sourcemap_valid(&artifact, 0, &db, "t31-hook");
    t31_assert_parses(js, "run-shape");
}

/// (T31) Delete-hook registry: a read/require-only delete hook emits with
/// the engine `remove` op spelling under its source trigger key.
#[test]
fn t31_hook_delete_op_registry() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario g on=M.delete\n  do\n   require event.before.t!=\"x\"\n   let x = event.before.t\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        js.contains(
            "hooks:{\"T.M.delete\":{name:\"T.g\",ops:[\"remove\"],run:async function $can$s$542e67("
        ),
        "registry:\n{js}"
    );
    assert!(
        js.contains("const $can$l$303a78 = event.before.t;"),
        "before read:\n{js}"
    );
    assert!(js.contains("return $candidate;"), "candidate return:\n{js}");
    t31_assert_parses(js, "delete-registry");
}

/// (B4-G/O2) Non-hook `operation.id` lowers through the ambient
/// context (`c.operation.id`), never as a free variable.
#[test]
fn b4g_operation_id_lowers_through_c() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text, source:text }\nWhen\n scenario s(note:text) by=members\n  do\n   create M {t=\"x\",source=operation.id} as m\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("source:c.operation.id"),
        "operation threads through c:\n{js}"
    );
    assert!(
        !js.contains("source:operation.id"),
        "no free operation:\n{js}"
    );
    t31_assert_parses(js, "b4g-operation");
}

/// (B4-G/O2) Non-hook `team.id` lowers through the ambient context
/// (`c.team.id`), never as a free variable.
#[test]
fn b4g_team_id_lowers_through_c() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario s(note:text) by=members\n  do\n   create M {t=team.id} as m\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    assert!(js.contains("{t:c.team.id"), "team threads through c:\n{js}");
    assert!(!js.contains("{t:team.id"), "no free team:\n{js}");
    t31_assert_parses(js, "b4g-team");
}

/// (B4-G/O2) Hook contextual values require an owning contract;
/// compilation refuses both unbound roots and incompatible carrier values.
#[test]
fn b4g_hook_context_requires_owning_contract() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.update\n  do\n   let a=actor\n   let n=now\n   set event.after {t=operation.id}\n   let g=team.id\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (_, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    for binding in ["actor", "now", "operation", "team"] {
        assert!(
            diags.iter().any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic
                    .message
                    .contains(&format!("hook contextual binding `{binding}`"))),
            "{binding}: {diags:?}"
        );
    }
}

/// (T31) Non-hook schedules lower (the payload decodes from the effect
/// arguments, not the unset value slot).
#[test]
fn t31_plain_schedule_lowers() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n N { m:text, due:datetime }\n event Due { s:text }\nWhen\n scenario s(n:N) by=members\n  do\n   schedule \"k-1\" at=n.due event=Due {s=\"x\"}\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("await schedule(c,\"k-1\",$can$l$303a6e.due,\"T.Due\",{s:\"x\"});"),
        "schedule lowering:\n{js}"
    );
    t31_assert_parses(js, "plain-schedule");
}

/// (T31) `emit` in hooks is checker-clean but has no hook lowering (Rule A
/// stages no outbox writes): loud E6008 with a fail-closed placeholder,
/// while the hook entry itself still registers.
#[test]
fn t31_hook_emit_unsupported() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\n event Due { s:text }\nWhen\n scenario h on=M.create\n  do\n   emit Due {s=\"x\"}\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(
        diags
            .iter()
            .any(|d| d.code == "E6008" && d.message.contains("emit")),
        "emit E6008: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("hooks:{\"T.M.create\""),
        "entry registers:\n{js}"
    );
    assert!(js.contains("has no lowering"), "placeholder:\n{js}");
}

/// (T31) Queries in hooks have no lowering: the engine hands hooks no
/// store, so a storage read fails loud instead of emitting a dangling `c`.
#[test]
fn t31_hook_query_unsupported() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text }\n N { m:text }\nWhen\n scenario h on=M.update\n  do\n   let n = count(N)\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (_artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(
        diags
            .iter()
            .any(|d| d.code == "E6008" && d.message.contains("hook")),
        "query E6008: {diags:?}"
    );
}

/// (T31) Decimal equality in hooks remains unsupported pending qualification
/// of the native hook carrier profile.
#[test]
fn t31_hook_decimal_eq_unsupported() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { d:decimal }\nWhen\n scenario h on=M.update\n  do\n   require event.after.d==event.before.d\n   set event.after {d=event.before.d}\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (_artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(
        diags
            .iter()
            .any(|d| d.code == "E6008" && d.message.contains("hook")),
        "equality E6008: {diags:?}"
    );
}

/// (T31) Hook statement backstops, lowered directly: delete, valued
/// return and send have no hook lowering (unreachable on clean programs —
/// the checker owns delete, the parser requires return values and the
/// types pass rejects them in void scenarios — but the lowering stays
/// total). A bare return exits early with the pending candidate. Exiting
/// hook mode restores scenario lowering.
#[test]
fn t31_hook_stmt_backstops() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    emitter.enter_hook(SymbolId(0));
    let delete = IrStmt::Delete {
        record: typed(
            IrExpr::Name("row".to_string()),
            ResolvedType::Scalar(Scalar::Text),
        ),
        mode: IrDeleteMode::Archive,
        span: sp(0, 1),
    };
    let returned = IrStmt::Return {
        value: Some(int_lit(1)),
        span: sp(0, 1),
    };
    let send = IrStmt::Send {
        operation: "x.y".to_string(),
        args: typed(IrExpr::Object(Vec::new()), ResolvedType::Unknown),
        when: None,
        binding: None,
        span: sp(0, 1),
    };
    for stmt in [&delete, &returned, &send] {
        let lines = emitter.lower_stmt(stmt, 0);
        assert!(
            lines[0].0.contains("throw new Error"),
            "hook placeholder: {:?}",
            lines[0].0
        );
    }
    let bare = IrStmt::Return {
        value: None,
        span: sp(0, 1),
    };
    let lines = emitter.lower_stmt(&bare, 0);
    assert!(
        lines[0].0.contains("return $candidate;"),
        "hook early return: {:?}",
        lines[0].0
    );
    emitter.exit_hook();
    let lines = emitter.lower_stmt(&delete, 0);
    assert!(
        lines[0].0.contains("deleteRecord"),
        "scenario lowering restored: {:?}",
        lines[0].0
    );
    let lines = emitter.lower_stmt(&returned, 0);
    assert!(
        lines[0].0.contains("return 1n;"),
        "scenario lowering restored: {:?}",
        lines[0].0
    );
    let (diags, _, _, _) = emitter.finish();
    let hook_diags: Vec<_> = diags.iter().filter(|d| d.code == "E6008").collect();
    assert_eq!(hook_diags.len(), 3, "{diags:?}");
    assert!(
        hook_diags.iter().all(|d| d.message.contains("hook")),
        "hook attribution: {diags:?}"
    );
}

/// (T31) Hook expression gaps, lowered directly: queries, delivery reads,
/// message formatting, role gates and capability calls all need the
/// ambient context hooks do not receive.
#[test]
fn t31_hook_expr_gaps() {
    let ir = fixture_ir();
    let mut emitter = Emitter::new(&ir);
    emitter.enter_hook(SymbolId(0));
    let query = typed(
        IrExpr::Query(IrQuery {
            domain: IrQueryDomain::Model("demo.Widget".to_string()),
            parent: None,
            where_pred: None,
            where_async: false,
            order: Vec::new(),
            limit: None,
            archived: None,
            select: None,
            select_param: None,
        }),
        ResolvedType::Unknown,
    );
    let delivery = typed(
        IrExpr::DeliveryRead {
            record: Box::new(text_lit("r")),
            field: "f".to_string(),
            props: vec!["status".to_string()],
        },
        ResolvedType::Unknown,
    );
    let format = typed(
        IrExpr::Format {
            args: vec![text_lit("m"), typed(IrExpr::Null, ResolvedType::Null)],
            descriptor_index: 0,
            locale_index: 1,
            source_lang: "en".to_string(),
            param_types: vec![],
        },
        ResolvedType::Scalar(Scalar::Text),
    );
    let role = typed(
        IrExpr::HasRole {
            role: "members".to_string(),
            person: None,
        },
        ResolvedType::Scalar(Scalar::Bool),
    );
    let call = typed(
        IrExpr::Call {
            target: IrCallTarget::CapabilityOp("demo.Svc.ping".to_string()),
            args: Vec::new(),
        },
        ResolvedType::Scalar(Scalar::Bool),
    );
    for expr in [&query, &delivery, &format, &role, &call] {
        assert!(
            emitter.lower_expr(expr).contains("throw"),
            "hook placeholder for {:?}",
            expr.expr
        );
    }
    let (diags, _, _, _) = emitter.finish();
    let hook_diags: Vec<_> = diags.iter().filter(|d| d.code == "E6008").collect();
    assert_eq!(hook_diags.len(), 5, "{diags:?}");
    assert!(
        hook_diags.iter().all(|d| d.message.contains("hook")),
        "hook attribution: {diags:?}"
    );
}

/// Fresh unique stage directory under the system temp dir for T31
/// engine drivers (emitted module plus driver script).
fn t31_stage_dir(stem: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "can-t31-{}-{}-{stem}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Workspace root above the compiler package under test.
fn t31_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf()
}

/// Assert emitted `js` parses as a module (node --check parses only, never
/// executes or resolves imports).
fn t31_assert_parses(js: &str, stem: &str) {
    let dir = t31_stage_dir(stem);
    std::fs::write(dir.join("check.mjs"), js).unwrap();
    let out = std::process::Command::new("node")
        .arg("--check")
        .arg("check.mjs")
        .current_dir(&dir)
        .output()
        .expect("spawn node --check");
    assert!(
        out.status.success(),
        "node --check failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// (T31) End to end: the emitted hook descriptor drives the REAL engine —
/// a parented child plus cancel/schedule through admit, pipeline and one
/// fenced commit, asserting receipt versions, history identity, the single
/// revision step and the committed timer set. The bun driver imports the
/// workspace engine sources directly (always current, no dist staleness)
/// plus the byte-verbatim emitted module, which must import nothing.
#[test]
fn t31_e2e_emitted_hook_drives_engine() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text, timer:text, due:datetime }\n C in M { m:text }\n event Due { s:text }\nWhen\n scenario h on=M.update\n  do\n   set event.after {t=\"done\"}\n   create C {parent=event.after,m=\"note\"} as c\n   cancel \"deadline:old\"\n   schedule event.after.timer at=event.after.due event=Due {s=\"done\"}\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    for line in js.lines() {
        assert!(
            !line.trim_start().starts_with("import "),
            "emitted hook must import nothing: {line}"
        );
    }
    let dir = t31_stage_dir("engine");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    let fixtures = t31_workspace_root().join("packages/state/test/mutation/fixtures.ts");
    assert!(fixtures.exists(), "engine fixtures: {}", fixtures.display());
    let driver = r##"
import { canApp } from './emitted.mjs';
import {
  setupMutation, modelDef, field, crudCreate, crudUpdate, mustLoad,
  readCrudReceipt, asModel, asId, FIXED_NOW,
} from '@@FIXTURES@@';
const verdict = {};
try {
  const desc = canApp().hooks['T.M.update'];
  verdict.hookName = desc.name;
  verdict.now = FIXED_NOW;
  const world = await setupMutation([
    modelDef('T.M', {
      fields: { t: field(), timer: field(), due: field() },
      hooks: [{ name: desc.name, ops: desc.ops, run: desc.run }],
    }),
    modelDef('T.C', { fields: { m: field() } }),
  ]);
  await crudCreate(world, 'T.M', {
    id: 'c-1', data: { t: 'new', timer: 'deadline:c-1', due: FIXED_NOW },
  });
  const fence = await world.store.readRevision();
  await world.store.commit({
    expectedRevision: fence, writes: [], history: [], receipt: null, outbox: [],
    schedules: [
      { op: 'replace', key: 'deadline:old', at: FIXED_NOW, event: 'T.Due', payload: {} },
    ],
    uniqueClaims: [], uniqueReleases: [],
  });
  const revSeeded = await world.store.readRevision();
  const { out, operationId } = await crudUpdate(
    world, 'T.M', 'c-1', { version: 1, patch: { t: 'go' } },
  );
  verdict.status = out.status;
  verdict.operationId = operationId;
  verdict.revisionDelta = (await world.store.readRevision()) - revSeeded;
  const m = await mustLoad(world.store, asModel('T.M'), 'c-1');
  verdict.mVersion = m.version;
  verdict.mData = m.data;
  const c = await mustLoad(world.store, asModel('T.C'), 'c-1/staged/0');
  verdict.childVersion = c.version;
  verdict.childParent = c.parent;
  verdict.childData = c.data;
  const receipt = await readCrudReceipt(world, { operation: 'T.M.update', operationId });
  verdict.receipt = receipt?.outcome.status === 'committed'
    ? receipt.outcome.recordVersions : null;
  const histM = await world.store.historyFor(asModel('T.M'), asId('c-1'));
  const histC = await world.store.historyFor(asModel('T.C'), asId('c-1/staged/0'));
  const lastM = histM[histM.length - 1];
  const lastC = histC[histC.length - 1];
  verdict.historyOps = [lastM?.operation, lastC?.operation];
  verdict.historyOpIds = [lastM?.operationId, lastC?.operationId];
  verdict.oldSchedule = await world.store.scheduleGet('deadline:old');
  verdict.newSchedule = await world.store.scheduleGet('deadline:c-1');
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@FIXTURES@@", &fixtures.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let bun = std::process::Command::new("bun").arg("--version").output();
    assert!(
        bun.is_ok_and(|o| o.status.success()),
        "t31 e2e needs bun (the repo packageManager)"
    );
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict = canlang_compiler::json::parse(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    let get = |key: &str| verdict.get(key).cloned().unwrap_or(Json::Null);
    assert_eq!(get("hookName").as_str(), Some("T.h"), "{stdout}");
    assert_eq!(get("status").as_str(), Some("committed"), "{stdout}");
    assert_eq!(get("revisionDelta").as_i64(), Some(1), "{stdout}");
    assert_eq!(get("mVersion").as_i64(), Some(2), "{stdout}");
    let data = get("mData");
    assert_eq!(
        data.get("t").and_then(|v| v.as_str()),
        Some("done"),
        "{stdout}"
    );
    assert_eq!(
        data.get("timer").and_then(|v| v.as_str()),
        Some("deadline:c-1"),
        "{stdout}"
    );
    assert_eq!(
        data.get("due").and_then(|v| v.as_i64()),
        get("now").as_i64(),
        "{stdout}"
    );
    assert_eq!(get("childVersion").as_i64(), Some(1), "{stdout}");
    let parent = get("childParent");
    assert_eq!(
        parent.get("model").and_then(|v| v.as_str()),
        Some("T.M"),
        "{stdout}"
    );
    assert_eq!(
        parent.get("id").and_then(|v| v.as_str()),
        Some("c-1"),
        "{stdout}"
    );
    assert_eq!(
        get("childData").get("m").and_then(|v| v.as_str()),
        Some("note"),
        "{stdout}"
    );
    match get("receipt") {
        Json::Arr(rows) => {
            assert_eq!(rows.len(), 2, "{stdout}");
            assert_eq!(rows[0].get("model").and_then(|v| v.as_str()), Some("T.M"));
            assert_eq!(rows[0].get("id").and_then(|v| v.as_str()), Some("c-1"));
            assert_eq!(rows[0].get("version").and_then(|v| v.as_i64()), Some(2));
            assert_eq!(rows[1].get("model").and_then(|v| v.as_str()), Some("T.C"));
            assert_eq!(
                rows[1].get("id").and_then(|v| v.as_str()),
                Some("c-1/staged/0")
            );
            assert_eq!(rows[1].get("version").and_then(|v| v.as_i64()), Some(1));
        }
        other => panic!("receipt versions: {other:?}"),
    }
    match get("historyOps") {
        Json::Arr(ops) => {
            assert_eq!(ops.len(), 2, "{stdout}");
            assert_eq!(ops[0].as_str(), Some("T.M.update"));
            assert_eq!(ops[1].as_str(), Some("T.M.update"));
        }
        other => panic!("history ops: {other:?}"),
    }
    match get("historyOpIds") {
        Json::Arr(ids) => {
            assert_eq!(ids.len(), 2, "{stdout}");
            assert_eq!(ids[0].as_str(), get("operationId").as_str());
            assert_eq!(ids[1].as_str(), get("operationId").as_str());
        }
        other => panic!("history op ids: {other:?}"),
    }
    assert_eq!(get("oldSchedule"), Json::Null, "{stdout}");
    let timer = get("newSchedule");
    assert_eq!(
        timer.get("key").and_then(|v| v.as_str()),
        Some("deadline:c-1"),
        "{stdout}"
    );
    assert_eq!(
        timer.get("at").and_then(|v| v.as_i64()),
        get("now").as_i64(),
        "{stdout}"
    );
    assert_eq!(
        timer.get("event").and_then(|v| v.as_str()),
        Some("T.Due"),
        "{stdout}"
    );
    assert_eq!(
        timer
            .get("payload")
            .and_then(|v| v.get("s"))
            .and_then(|v| v.as_str()),
        Some("done"),
        "{stdout}"
    );
}

/// (T31) Attribution: a staged-write failure names the staging hook. The
/// empty timer key is checker-clean (a value, never a type error) but the
/// engine rejects it, attributing to the emitted hook identity — the
/// scenario canonical threaded through emission.
#[test]
fn t31_e2e_staged_failure_names_hook() {
    let (catalog, path) = golden_catalog();
    let src = "app T\nGiven\n M { t:text, due:datetime }\n event Due { s:text }\nWhen\n scenario h2 on=M.create\n  do\n   schedule \"\" at=event.after.due event=Due {s=\"x\"}\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    let dir = t31_stage_dir("attribution");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    let fixtures = t31_workspace_root().join("packages/state/test/mutation/fixtures.ts");
    assert!(fixtures.exists(), "engine fixtures: {}", fixtures.display());
    let driver = r##"
import { canApp } from './emitted.mjs';
import {
  setupMutation, modelDef, field, crudCreate, captureStateError, FIXED_NOW,
} from '@@FIXTURES@@';
const verdict = {};
try {
  const desc = canApp().hooks['T.M.create'];
  verdict.hookName = desc.name;
  const world = await setupMutation([
    modelDef('T.M', {
      fields: { t: field(), due: field() },
      hooks: [{ name: desc.name, ops: desc.ops, run: desc.run }],
    }),
  ]);
  const error = await captureStateError(
    crudCreate(world, 'T.M', { id: 'c-9', data: { t: 'new', due: FIXED_NOW } }),
  );
  verdict.code = error.code;
  verdict.message = error.message;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@FIXTURES@@", &fixtures.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict = canlang_compiler::json::parse(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert_eq!(
        verdict.get("hookName").and_then(|v| v.as_str()),
        Some("T.h2"),
        "{stdout}"
    );
    assert_eq!(
        verdict.get("code").and_then(|v| v.as_str()),
        Some("validation"),
        "{stdout}"
    );
    let message = verdict
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        message.contains("\"T.h2\"") && message.contains("\"T.M\""),
        "hook attribution: {message}"
    );
}

// --- T21-L1 single-app entry emission ------------------------------------------
// The entry module of a single-app program used to emit bare identity
// consts (`export const create/update/delete`): `create` collided with
// the module's own stdlib import (duplicate declaration) and `delete`
// is a reserved word, so the entry module was unimportable JS. Exports
// use injective authored identities; this test follows artifact mappings,
// parses, imports and executes one op through the emitted handler.

/// Parse the local-vs-exported binding pairs out of one emitted
/// `import { ... } from "<source>";` line (`require as check` imports
/// `require` under the local name `check`).
fn t21l1_import_bindings(line: &str) -> Vec<(String, String)> {
    let Some(inner) = line
        .split('{')
        .nth(1)
        .and_then(|rest| rest.split('}').next())
    else {
        return Vec::new();
    };
    inner
        .split(',')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            if let Some((exported, local)) = part.split_once(" as ") {
                Some((exported.trim().to_string(), local.trim().to_string()))
            } else {
                Some((part.to_string(), part.to_string()))
            }
        })
        .collect()
}

/// (T21-L1) Single-app CRUD entry modules import and execute: the
/// entry parses (`node --check`), imports under node with a stub
/// `@canlang/stdlib` (every imported binding served), and the emitted
/// create handler executes with the real seams called (model id +
/// input mapping observed). Failing-first: on bare exports both the
/// parse and the artifact export assertions fail.
#[test]
fn t21l1_single_app_crud_entry_imports_and_executes() {
    let (catalog, path) = golden_catalog();
    let src = "app Shop\nGiven\n Gadget { title:text }\nWhen\n crud Gadget by=members fields=title\nThen\n";
    let (db, program, result) = t31_program(src, &catalog);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(artifact.modules.len(), 1, "single-app emits entry only");
    let js = &artifact.modules[0].js;
    assert_eq!(
        artifact.modules[0].path, "$can$m$53686f70.mjs",
        "entry path"
    );
    // Artifact mappings identify exports and callable registry paths.
    let callable_ids = [
        "Shop.Gadget.create",
        "Shop.Gadget.update",
        "Shop.Gadget.delete",
    ];
    let callables: Vec<_> = callable_ids
        .iter()
        .map(|id| {
            let callable = artifact
                .callables
                .iter()
                .find(|c| &c.id == id)
                .expect("CRUD callable mapping");
            assert_eq!(callable.module, artifact.modules[0].path);
            assert_eq!(callable.member, vec![id.to_string()]);
            assert!(js.contains(&format!("export const {}=\"{id}\";", callable.export)));
            callable
        })
        .collect();
    for bare in [
        "export const create=",
        "export const update=",
        "export const delete=",
    ] {
        assert!(!js.contains(bare), "bare export {bare} in:\n{js}");
    }
    t31_assert_parses(js, "t21l1");
    // Stage for import: the entry plus a stub `@canlang/stdlib` (and
    // `@canlang/ui` when imported) serving every imported binding.
    let dir = t31_stage_dir("t21l1-import");
    std::fs::write(dir.join("entry.mjs"), js).unwrap();
    let mut stdlib: Vec<(String, String)> = Vec::new();
    let mut ui: Vec<(String, String)> = Vec::new();
    for line in js.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("import ") {
            continue;
        }
        let bindings = t21l1_import_bindings(trimmed);
        if trimmed.contains("@canlang/stdlib") {
            stdlib.extend(bindings);
        } else if trimmed.contains("@canlang/ui") {
            ui.extend(bindings);
        } else {
            panic!("single-app entry imports outside stdlib/ui: {trimmed}");
        }
    }
    assert!(!stdlib.is_empty(), "crud entry imports stdlib");
    let stub = |bindings: &[(String, String)]| {
        let mut out = String::from("export const __calls = [];\n");
        out.push_str(
            "const rec = (name) => (...args) => { __calls.push([name, ...args]); return {}; };\n",
        );
        for (exported, _) in bindings {
            if exported == "require" {
                out.push_str("export const require = (cond, code) => { if (!cond) throw new Error(\"check:\" + code); };\n");
            } else if exported == "hasRole" {
                out.push_str("export const hasRole = () => true;\n");
            } else {
                out.push_str(&format!("export const {exported} = rec(\"{exported}\");\n"));
            }
        }
        out
    };
    for (package, bindings) in [("stdlib", &stdlib), ("ui", &ui)] {
        if bindings.is_empty() {
            continue;
        }
        let package_dir = dir.join("node_modules").join("@canlang").join(package);
        std::fs::create_dir_all(&package_dir).unwrap();
        std::fs::write(
            package_dir.join("package.json"),
            format!(
                "{{\"name\":\"@canlang/{package}\",\"version\":\"0.0.0-test\",\"type\":\"module\",\"main\":\"index.mjs\"}}"
            ),
        )
        .unwrap();
        std::fs::write(package_dir.join("index.mjs"), stub(bindings)).unwrap();
    }
    let driver = r##"
import * as entry from './entry.mjs';
const mappings = MAPPINGS;
import { __calls } from '@canlang/stdlib';
const verdict = {};
try {
  verdict.createId = entry[mappings[0].export];
  verdict.updateId = entry[mappings[1].export];
  verdict.deleteId = entry[mappings[2].export];
  const app = entry.canApp();
  const create = mappings[0].member.reduce((value, key) => value[key], app);
  const out = await create({}, { title: "widget" });
  verdict.result = out ?? null;
  verdict.calls = __calls;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##;
    let mappings = Json::Arr(
        callables
            .iter()
            .map(|c| {
                Json::Obj(vec![
                    ("export".to_string(), Json::Str(c.export.clone())),
                    (
                        "member".to_string(),
                        Json::Arr(c.member.iter().cloned().map(Json::Str).collect()),
                    ),
                ])
            })
            .collect(),
    );
    let driver = driver.replace("MAPPINGS", &canlang_compiler::json::render(&mappings));
    std::fs::write(dir.join("run.mjs"), driver).unwrap();
    let out = std::process::Command::new("node")
        .arg("run.mjs")
        .current_dir(&dir)
        .output()
        .expect("spawn node driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict = canlang_compiler::json::parse(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert_eq!(
        verdict.get("createId").and_then(|v| v.as_str()),
        Some("Shop.Gadget.create"),
        "{stdout}"
    );
    assert_eq!(
        verdict.get("updateId").and_then(|v| v.as_str()),
        Some("Shop.Gadget.update"),
        "{stdout}"
    );
    assert_eq!(
        verdict.get("deleteId").and_then(|v| v.as_str()),
        Some("Shop.Gadget.delete"),
        "{stdout}"
    );
    // The real emitted create path ran: admission passed and the
    // stdlib `create` seam received the model id plus the input.
    let calls = verdict.get("calls").cloned().unwrap_or(Json::Null);
    let Json::Arr(calls) = calls else {
        panic!("calls: {stdout}");
    };
    let create = calls.iter().find(|call| {
        matches!(call, Json::Arr(row) if row.first().and_then(|v| v.as_str()) == Some("create"))
    });
    let Some(Json::Arr(row)) = create else {
        panic!("no create call: {stdout}");
    };
    assert_eq!(
        row.get(2).and_then(|v| v.as_str()),
        Some("Shop.Gadget"),
        "{stdout}"
    );
    assert_eq!(
        row.get(3)
            .and_then(|v| v.get("title"))
            .and_then(|v| v.as_str()),
        Some("widget"),
        "{stdout}"
    );
}

/// (T18) Server-initializer mapping: `actor`/`now` map to their closed
/// tokens, exactly `random_secret()` maps to `random_secret`, and every
/// other computed spelling maps to opaque `computed` (the L3 loader
/// rejects those sets fail-closed; descriptors stay total).
#[test]
fn t18_server_init_mapping() {
    assert_eq!(
        js::js_server_init(&IrServer::Actor),
        js::JsServerInit::Actor
    );
    assert_eq!(js::js_server_init(&IrServer::Now), js::JsServerInit::Now);
    let secret_call = typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "random_secret".to_string(),
                awaited: false,
            },
            args: vec![],
        },
        ResolvedType::Unknown,
    );
    assert_eq!(
        js::js_server_init(&IrServer::Computed(Box::new(secret_call))),
        js::JsServerInit::RandomSecret
    );
    // Arity matters: `random_secret(x)` is not the closed spelling.
    let secret_arity = typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "random_secret".to_string(),
                awaited: false,
            },
            args: vec![int_lit(1)],
        },
        ResolvedType::Unknown,
    );
    assert_eq!(
        js::js_server_init(&IrServer::Computed(Box::new(secret_arity))),
        js::JsServerInit::Computed
    );
    // Non-call computed expressions (e.g. `now+1h`) are opaque too.
    let now_plus = typed(
        IrExpr::Binary {
            op: IrBinOp::Add,
            left: Box::new(typed(
                IrExpr::Name("now".to_string()),
                ResolvedType::Unknown,
            )),
            right: Box::new(typed(IrExpr::DurationMs(3_600_000), ResolvedType::Unknown)),
        },
        ResolvedType::Unknown,
    );
    assert_eq!(
        js::js_server_init(&IrServer::Computed(Box::new(now_plus))),
        js::JsServerInit::Computed
    );
    assert_eq!(
        js::js_field_default(None, Some(&IrServer::Now))
            .expect("now maps")
            .to_json(),
        "{\"kind\":\"server\",\"init\":\"now\"}"
    );
}

/// (T18) Server initializers end to end: the three closed spellings emit
/// their `init` tokens on the model descriptor and stay out of create
/// inputs (never caller-provided).
/// TEST-ONLY artifact: see module docs.
#[test]
fn t18_server_init_end_to_end() {
    let src = "app Shop\nGiven\n Token { name:text, value:secret server=random_secret() }\n Ping { label:text, by:user server=actor, at:datetime server=now }\n policy Token read=members\n policy Ping read=members\nWhen\n crud Token by=members fields=name\n crud Ping by=members fields=label\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    // T18: the external `random_secret` (lane-03 engine-executed) is not
    // a JS-link `E6007` dependency from server position.
    assert!(
        diags.iter().all(|d| d.code != "E6007"),
        "no link check on engine-executed inits: {diags:?}"
    );
    // The emitted schema slot is the link-free marker, never a callable
    // over an unlinked import.
    assert!(
        artifact
            .modules
            .iter()
            .any(|m| m.js.contains("server:\"random_secret\"")),
        "server slot marker"
    );
    let token = t15a_model(&artifact, "Shop.Token");
    let value = t15a_field(token, "value");
    assert!(value.server_only && !value.required);
    assert_eq!(
        value.default.as_ref().map(|d| d.to_json()).as_deref(),
        Some("{\"kind\":\"server\",\"init\":\"random_secret\"}")
    );
    let ping = t15a_model(&artifact, "Shop.Ping");
    assert_eq!(
        t15a_field(ping, "by")
            .default
            .as_ref()
            .map(|d| d.to_json())
            .as_deref(),
        Some("{\"kind\":\"server\",\"init\":\"actor\"}")
    );
    assert_eq!(
        t15a_field(ping, "at")
            .default
            .as_ref()
            .map(|d| d.to_json())
            .as_deref(),
        Some("{\"kind\":\"server\",\"init\":\"now\"}")
    );
    for op in ["Shop.Token.create", "Shop.Ping.create"] {
        let create = d03_operation(&artifact, op);
        assert!(
            create
                .inputs
                .iter()
                .all(|input| input.name != "value" && input.name != "by" && input.name != "at"),
            "server fields never caller-provided in {op}: {:?}",
            create.inputs.iter().map(|i| &i.name).collect::<Vec<_>>()
        );
    }
    // The envelope carries the init tokens per artifact.ts.
    let json = artifact::to_json(&artifact);
    assert!(
        json.contains("\"init\":\"random_secret\""),
        "random_secret init: {json}"
    );
    assert!(json.contains("\"init\":\"actor\""), "actor init: {json}");
    assert!(json.contains("\"init\":\"now\""), "now init: {json}");
}

/// (T18) Child-model creates synthesize the caller-required unversioned
/// `parent` linkage input; root creates, updates, and deletes carry
/// none (linkage is immutable after creation).
/// TEST-ONLY artifact: see module docs.
#[test]
fn t18_child_create_parent_input() {
    let src = "app Shop\nGiven\n Team { name:text }\n Member in Team { name:text }\n policy Team read=members\n policy Member read=members\nWhen\n crud Team by=members fields=name\n crud Member by=members fields=name\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006"),
        "no analysis gaps: {diags:?}"
    );
    let member = t15a_model(&artifact, "Shop.Member");
    assert_eq!(member.parent.as_deref(), Some("Shop.Team"));
    let create = d03_operation(&artifact, "Shop.Member.create");
    let parent = d03_input(create, "parent");
    assert!(parent.required && !parent.nullable, "parent required");
    match &parent.field {
        js::JsMcpField::Ref {
            model,
            require_version,
        } => {
            assert_eq!(model, "Shop.Team");
            assert!(!require_version, "parents are unversioned");
        }
        other => panic!("parent input is a ref: {other:?}"),
    }
    for op in ["Shop.Member.update", "Shop.Member.delete"] {
        let operation = d03_operation(&artifact, op);
        assert!(
            operation.inputs.iter().all(|input| input.name != "parent"),
            "no parent on {op}: {:?}",
            operation.inputs.iter().map(|i| &i.name).collect::<Vec<_>>()
        );
    }
    let root_create = d03_operation(&artifact, "Shop.Team.create");
    assert!(
        root_create
            .inputs
            .iter()
            .all(|input| input.name != "parent"),
        "no parent on root creates: {:?}",
        root_create
            .inputs
            .iter()
            .map(|i| &i.name)
            .collect::<Vec<_>>()
    );
    // The envelope carries the parent input per artifact.ts.
    let json = artifact::to_json(&artifact);
    assert!(json.contains("\"name\":\"parent\""), "parent input: {json}");
}

/// (T18/R27) Server-owned checker pin: an ordinary operation-body `set`
/// of a `server=` field rejects (`E3001`), while a hook adjusting its
/// pending record (`set event.after`) draws no diagnostic. The T18
/// engine matches: callers never supply server-owned values and only
/// hook adjustment rewrites them.
#[test]
fn t18_r27_server_owned_checker() {
    let src = "app T\nGiven\n M { t:text, armed:datetime server=now }\nWhen\n scenario fix(rec:M) by=members\n  do\n   set rec {armed=now}\n scenario h on=M.update\n  do\n   set event.after {armed=now}\nThen\n";
    // Analysis diagnostics (not emit): `d03_emit` drops them, so drive
    // `check_example` directly like the golden helpers do.
    let mut db = SourceDb::new();
    let id = db.add("t18.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (_program, result) = check_example(&db, id, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    let armed: Vec<_> = result
        .diagnostics
        .iter()
        .filter(|d| d.message.contains("armed"))
        .collect();
    assert_eq!(
        armed.len(),
        1,
        "one armed diagnostic: {:?}",
        result.diagnostics
    );
    let only = armed[0];
    assert_eq!(only.code, "E3001");
    assert_eq!(only.message, "server-owned field 'armed' cannot be set");
    // The diagnostic points at the ordinary `set`, never the hook body.
    let ordinary = src.find("set rec {armed").expect("ordinary set");
    let hook = src.find("scenario h").expect("hook");
    let start = only.primary.start as usize;
    assert!(
        start >= ordinary && start < hook,
        "E3001 on the ordinary path: {start} in {src:?}"
    );
}

// --- T34-F6 each= cohort emission -------------------------------------------
//
// Both adopted spellings emit static cohort descriptors into the
// entry module's `appDefinition.cohorts` member (F1 `FanoutCohortKind`
// vocabulary; see `ArtifactCohortDescriptor` in artifact.ts), which
// the F7 runtime join reads to freeze membership. Descriptors emit
// only for checked cohorts (invalid cohorts stay fail-closed with no
// member); the member is omitted entirely without fanout, so sources
// without `each=` emit byte-identical output (all pre-existing goldens
// also guard this).
//
// Standing context (not F6's): handler triggers still keep their
// `E6008` (no §13 trigger lowering exists yet), pinned below as the
// only emit diagnostics. TEST-ONLY artifacts: see module docs.

/// T34-F6 fixture: one bare-model and one parent-anchored cohort.
const F6_EMIT_BOTH: &str = "app Shop\nGiven\n Todo { title:text }\n Community { name:text }\n Opportunity in Community { title:text }\n Signup in Opportunity { email:text }\n event Ping {}\n event Cancelled { opportunity:Opportunity, reason:text }\nWhen\n scenario sweep on=Ping each=Todo as todo\n  do\n   let x=1\n scenario cancel_each on=Cancelled each=event.opportunity.Signup as signup\n  do\n   let x=1\nThen\n";

/// Extract the exact `cohorts:{...}` member (brace-balanced) from `js`.
fn f6_cohorts_member(js: &str) -> String {
    let start = js.find("cohorts:{").expect("cohorts member");
    let mut depth = 0;
    for (i, ch) in js[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return js[start..start + i + 1].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced cohorts member in:\n{js}");
}

#[test]
fn f6_both_spellings_emit_cohort_descriptors() {
    let (_program, artifact, diags) = d03_emit(F6_EMIT_BOTH);
    // Standing trigger lowering only: each handler trigger keeps its
    // E6008; the cohort descriptors still emit beside it.
    let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
    assert_eq!(codes, vec!["E6008", "E6008"], "emit diags: {diags:?}");
    let js = &artifact.modules[0].js;
    assert_eq!(js.matches("cohorts:{").count(), 1, "one member:\n{js}");
    assert_eq!(
        f6_cohorts_member(js),
        "cohorts:{\"Shop.sweep\":{kind:\"model\",model:\"Shop.Todo\",bind:\"todo\"},\"Shop.cancel_each\":{kind:\"anchored-collection\",model:\"Shop.Signup\",parent:\"event.opportunity\",bind:\"signup\"}}",
        "byte-exact cohorts member:\n{js}"
    );
    // The member rides the appDefinition line the runtime reads.
    let appdef = js
        .lines()
        .find(|line| line.starts_with("export const appDefinition="))
        .expect("appDefinition line");
    assert!(
        appdef.contains("cohorts:{\"Shop.sweep\""),
        "cohorts on appDefinition:\n{appdef}"
    );
}

#[test]
fn f6_no_cohort_emits_no_member() {
    let src = "app Shop\nGiven\n Todo { title:text }\nWhen\n scenario sweep() by=members\n  do\n   let x=1\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    assert!(diags.is_empty(), "clean lower: {diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        !js.contains("cohorts:"),
        "no cohorts member without fanout:\n{js}"
    );
}

#[test]
fn f6_missing_bind_emits_null() {
    let src = "app Shop\nGiven\n Todo { title:text }\n event Ping {}\nWhen\n scenario sweep on=Ping each=Todo\n  do\n   let x=1\nThen\n";
    let (_program, artifact, diags) = d03_emit(src);
    let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
    assert_eq!(codes, vec!["E6008"], "emit diags: {diags:?}");
    let js = &artifact.modules[0].js;
    assert_eq!(
        f6_cohorts_member(js),
        "cohorts:{\"Shop.sweep\":{kind:\"model\",model:\"Shop.Todo\",bind:null}}",
        "bind:null pin:\n{js}"
    );
}

#[test]
fn f6_invalid_cohort_emits_no_descriptor() {
    // Fail-closed: an invalid cohort (E4055 at check time) emits no
    // descriptor even though test-only emission proceeds.
    let src = "app Shop\nGiven\n Todo { title:text }\n event Ping {}\nWhen\n scenario sweep on=Ping each=Nosuch as todo\n  do\n   let x=1\nThen\n";
    let (program, artifact, diags) = d03_emit(src);
    let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
    assert_eq!(codes, vec!["E6008"], "emit diags: {diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        !js.contains("cohorts:"),
        "invalid cohorts emit no member:\n{js}"
    );
    let sweep = program
        .effects
        .scenarios
        .values()
        .find(|s| program.symbols[s.scenario.0 as usize].name == "sweep")
        .expect("sweep row");
    assert!(sweep.cohort.is_none(), "no checked cohort row");
}

// --- A2a: derived-call, for-limit, poll/refresh, action-external ---------------
// TEST-ONLY artifacts: see module docs. No runtime-success claims.

/// A2a pin helper: `check` must be fully clean (all four families are
/// check-green in the suite-3 corpus), then emit test-only.
fn a2a_emit(
    src: &str,
) -> (
    CompileArtifact,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
) {
    let mut db = SourceDb::new();
    let id = db.add("a2a.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (program, result) = check_example(&db, id, Some(&catalog));
    assert!(
        result.diagnostics.is_empty(),
        "check clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_test_only(&program, &db, &result, Some(&catalog));
    let _ = std::fs::remove_file(&path);
    (artifact, diags)
}

/// Derived functions emit as module-scope named functions
/// (`async function name(c,...params)`, CanChat/CanDiscover draft
/// contract); call sites lower to awaited calls, including nested
/// derive-to-derive calls and calls from policy rules (which go
/// `async`). The `canApp()` registry holds canonical callable references.
#[test]
fn a2a_derive_call_lowers_to_awaited_named_fn() {
    let src = "package shop\n Given\n  M { x:int }\n  policy M read=members where=outer(9)==10\n  derive inner(v:int):int = v\n  derive outer(v:int):int = inner(v)\n When\n  scenario tick() by=members\n   require outer(1)==2\n   do let done = 1\n Then\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "derive calls lower without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains(
            "async function $can$s$73686f702e696e6e6572(c,$can$l$303a76){return $can$l$303a76;}"
        ),
        "inner derive shape:\n{js}"
    );
    assert!(
        js.contains("async function $can$s$73686f702e6f75746572(c,$can$l$313a76){return await $can$s$73686f702e696e6e6572(c,$can$l$313a76);}"),
        "nested derive call:\n{js}"
    );
    assert!(
        js.contains("await $can$s$73686f702e6f75746572(c,1n)"),
        "require calls the derive:\n{js}"
    );
    assert!(
        js.contains("async(c,row)=>") && js.contains("await $can$s$73686f702e6f75746572(c,9n)"),
        "policy rule goes async over the call:\n{js}"
    );
    assert!(
        js.contains("\n\"shop.inner\":$can$s$73686f702e696e6e6572,\n")
            && js.contains("\n\"shop.outer\":$can$s$73686f702e6f75746572,\n"),
        "registry holds canonical callable refs:\n{js}"
    );
    assert!(
        !js.contains("(c,row){return"),
        "no row-param derive methods remain:\n{js}"
    );
}

/// `for item in domain limit=N` fails the operation past N items
/// (DESIGN §5): fetch once, `check(length<=N,"limit")`, then loop.
#[test]
fn a2a_for_limit_checks_length_then_loops() {
    let src = "package shop\n Given\n  M { x:int }\n  policy M read=members\n When\n  scenario sweep() by=members\n   do\n    for item in M limit=10\n     set item {x=1}\n Then\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "bound loop lowers without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("const $forRows0 = await records("),
        "loop fetches once:\n{js}"
    );
    assert!(
        js.contains("check($forRows0.length<=10n,\"limit\");"),
        "excess fails the operation:\n{js}"
    );
    assert!(
        js.contains("for (const $can$l$303a6974656d of $forRows0) {"),
        "loop iterates the checked fetch:\n{js}"
    );
}

/// Page `poll=`/`refresh=` (DESIGN §9) lower to sparse descriptor
/// members: exact-BigInt millis plus the canonical refresh mutation.
#[test]
fn a2a_page_poll_refresh_lower_to_descriptor() {
    let src = "package shop\n Given\n  M { x:int }\n  policy M read=members\n When\n  scenario tick() by=members\n   do let done = 1\n Then\n  page /jobs title=\"Jobs\" poll=5s refresh=tick\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "poll/refresh lower without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(js.contains("poll:5000n"), "poll millis member:\n{js}");
    assert!(
        js.contains("refresh:\"shop.tick\""),
        "refresh canonical member:\n{js}"
    );
}

/// `action(...)` over bound-imported operations resolves (no silent
/// poison) and lowers to the draft contract field schema
/// (`{type:"action",targets:[canonical...]}`); aliases record the
/// original member name, never the alias.
#[test]
fn a2a_action_external_targets_lower_to_schema() {
    let src = "package todo\n use maintain {inspect} from=deployment.maintenance\n use success {complete as done} from=deployment.accounts\n Given\n  export contract W { act:action(inspect,done)? }\n When\n Then\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "external action targets lower without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("act:{type:\"action\",targets:[\"maintain.inspect\",\"success.complete\"],nullable:true}"),
        "action schema with canonical targets:\n{js}"
    );
}

/// A2b named→positional: builtin calls with named arguments lower
/// positionally in catalog signature order (`money(minor,currency)`
/// here; the corpus `fold=` 4th slot takes the same path), whether
/// fully named out of order or mixed positional + named. Reordering
/// captures supplied values once in source order before applying slots.
#[test]
fn a2b_named_args_lower_positionally_in_signature_order() {
    let src = "package shop\n Given\n  M { x:int }\n  policy M read=members\n When\n  scenario tick() by=members\n   do\n    let a = money(currency=\"EUR\", minor=25)\n    let b = money(30, currency=\"USD\")\n Then\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "named calls lower without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("(($can$a$30)=>money($can$a$30[1],$can$a$30[0]))([\"EUR\",25n])"),
        "out-of-order named args capture source order once:\n{js}"
    );
    assert!(
        js.contains("money(30n,\"USD\")"),
        "mixed positional+named fills in order:\n{js}"
    );
}

/// A2b composite-unique: the model entry carries a sparse `uniques`
/// member with fields in source order; the `where=` predicate is a
/// `Model.unique.N` registry rule beside the invariants — referenced
/// from `uniques`, never listed in `invariants`.
#[test]
fn a2b_composite_unique_emits_sparse_member_and_registry_rule() {
    let src = "package shop\n Given\n  M { x:int, current:bool }\n  policy M read=members\n  invariant M: row.x>0\n  unique M fields=x where=row.current\n When\n Then\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "uniques lower without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("uniques:[{fields:[\"x\"],where:\"M.unique.1\"}]"),
        "sparse uniques member:\n{js}"
    );
    assert!(
        js.contains("\"M.unique.1\":(c,row)=>"),
        "where rule beside invariants:\n{js}"
    );
    assert!(
        js.contains("invariants:[\"M.require.1\"]"),
        "invariants list holds only the row invariant:\n{js}"
    );
}

/// A2b UI profiles: radio/select join the field-control arm,
/// fieldset is a captioned group, fab groups first/rest into
/// main/actions, chat_bubble dissolves slots into slot props, and
/// bare delete infers the full deleteRecord card.
#[test]
fn a2b_ui_profiles_lower_to_factories() {
    let src = "app Probe uses=[shop]\npackage shop\n Given\n  export Item { name:text label=\"Item\"@{nl=\"Artikel\"} }\n  policy Item read=members\n When\n  crud Item by=members fields=name\n Then\n  page / title=\"Shop\"\n   card \"Go\"\n    form Item.create\n     fieldset \"Details\"\n      input name\n      radio name\n      select name\n    fab\n     button opens=dlg\n     button opens=dlg\n    modal \"Dialog\" id=dlg\n     slot content\n      text \"x\"\n    list Item empty=\"No items yet\"\n     chat_bubble\n      slot content\n       content row.name\n      slot header\n       text row.name\n     delete\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "profiles lower without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("$can$u$6669656c64736574({context:c,caption:$can$u$6d657373616765(\"Details\"),children:[$can$u$696e707574({...$can$f$666f726d.field(\"name\")}),$can$u$726164696f({...$can$f$666f726d.field(\"name\")}),$can$u$73656c656374({...$can$f$666f726d.field(\"name\")})]})"),
        "fieldset group + field controls:\n{js}"
    );
    assert!(
        js.contains("$can$u$666162({context:c,main:[$can$u$627574746f6e({context:c,opens:\"dlg\"})],actions:[$can$u$627574746f6e({context:c,opens:\"dlg\"})]})"),
        "fab main+actions:\n{js}"
    );
    assert!(
        js.contains("$can$u$63686174427562626c65({context:$can$l$313a726f7756696577,content:[$can$u$636f6e74656e74({context:$can$l$313a726f7756696577,value:$can$l$303a726f77.name})],header:[$can$u$74657874({context:$can$l$313a726f7756696577,values:[$can$l$303a726f77.name]})]})"),
        "chat slots dissolve to props:\n{js}"
    );
    assert!(
        js.contains("$can$u$64656c6574655265636f7264({context:$can$l$313a726f7756696577,operation:\"shop.Item.delete\",record:$can$l$303a726f77,mode:\"archive\",action:\"/api/operations/shop.Item.delete\",operationId:\"shop.Item.delete\",itemLabel:\"Item\",confirm:\"Archive this Item?\",idPrefix:\"delete-shop-Item\"})"),
        "delete infers the full card:\n{js}"
    );
}

/// A2b require desugar: page-level `require` gates admission (never
/// renders); nested container `require` keeps its local gate.
#[test]
fn a2b_require_desugars_to_admit_and_gate() {
    let src = "package shop\n Given\n  M { x:int }\n  policy M read=members\n When\n  scenario tick() by=members\n   do let done = 1\n Then\n  page /jobs title=\"Jobs\"\n   require members\n   card \"Go\"\n    text \"hi\"\n";
    let (artifact, diags) = a2a_emit(src);
    assert!(
        diags.iter().all(|d| d.code != "E6006" && d.code != "E6008"),
        "require lowers without gaps: {diags:?}"
    );
    let js = &artifact.modules[0].js;
    assert!(
        js.contains(
            "if(!(hasRole(c,\"members\")))throw {code:\"forbidden\",message:\"forbidden\"}"
        ),
        "page require gates admission:\n{js}"
    );
    assert!(!js.contains("require({"), "require never renders:\n{js}");
}
