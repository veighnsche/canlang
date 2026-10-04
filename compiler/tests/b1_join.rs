//! B1 join: one compiled model/operation/page from lane-01 emission.
//!
//! Compiles `examples/TeamTasks.can` with the REAL lane-02 catalog
//! (`packages/values/dist/catalog.json`) through the PRODUCTION analysis
//! (`complete=true`) and emitter (`EmitOptions::new`, no test-only
//! acknowledgment), then validates the artifact shape against
//! `packages/contracts/src/artifact.ts`: version, SHA-256 sources,
//! entrypoint-first modules, callables, pages, requires, tests.
//!
//! Strict gates (never weakened to pass):
//!
//! * Zero `E1xxx`/`E2xxx`/`E3xxx`: B1 needs a supported source.
//! * `E6006 == 0` (every needed position bridged), `E6007 == 0`
//!   (real catalog pins every builtin), `E6008 == 10` (the pinned
//!   unlowered-UI-factory positions; each a throwing placeholder).
//!   NOTE: `can compile` (CLI policy) refuses to print an artifact
//!   while `E6008`s report; this test drives `emit()` directly to pin
//!   the artifact SHAPE those diagnostics accompany. A zero-`E6008`
//!   source (`demo.can`, TeamTasks minus the 12 unlowered lines)
//!   compiles end to end via the CLI; see the phase-2 evidence note.
//! * Entrypoint markers pinned from real emission (model shapes, CRUD
//!   operations, page descriptors); no metadata spread.
//! * Pages: exactly the 2 declared descriptors, exports resolved.
//! * Callables: valid kinds, every export present in its module.
//! * Requires: non-empty with the `canlang.builtins` catalog pin.
//! * Tests: exactly the real `TeamTasks.Todo.update` suite with the
//!   normative §13 `return {fixtures:{...},examples:[...]}` shape and
//!   no production imports; production modules never reference tests.
//! * JSON envelope: `artifact_version` 1 prefix, parses, version checks.
//!
//! Hermetic CI has no real catalog: without
//! `packages/values/dist/catalog.json` this test SKIPS loudly (no
//! fixture fallback — B1 is meaningless without the producer
//! catalog). With the catalog present every gate above is strict.
//!
//! This test pins the lane-01 half of B1 (a real artifact the runtime
//! CAN consume). Runtime consumption itself is lane 7's half: at the
//! time of writing `can-platform run` is a missing-producer stub, so
//! no runtime-success claim is made here.

use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::artifact::{self, CompileArtifact};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult, Severity};
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::path::PathBuf;

/// Repo root (`compiler/../`).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// `true` for lowercase hex SHA-256.
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Every `from "..."` import source must be in the §13 allowlist.
fn imports_allowlisted(js: &str) -> Option<String> {
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
        if !(source == "@canlang/stdlib" || source == "@canlang/ui" || source.starts_with("./")) {
            return Some(source.to_string());
        }
    }
    None
}

#[test]
fn b1_teamtasks_artifact() {
    let root = repo_root();
    let can_path = root.join("examples").join("TeamTasks.can");
    let catalog_path = root
        .join("packages")
        .join("values")
        .join("dist")
        .join("catalog.json");
    let mut failures: Vec<String> = Vec::new();

    // The real catalog must exist; SKIP loudly without it (hermetic CI),
    // never fall back to a fixture.
    if !catalog_path.exists() {
        eprintln!(
            "SKIP b1_teamtasks_artifact: no {} (run `npm run catalog` in packages/values)",
            catalog_path.display()
        );
        return;
    }
    let text = std::fs::read_to_string(&can_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", can_path.display()));
    let mut db = SourceDb::new();
    let id = db.add("examples/TeamTasks.can".to_string(), text);
    let expected_sha = db.get(id).unwrap().sha256.clone();

    // Load the catalog through the documented flag path.
    let request = CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root,
        primary: Span::new(id, 0, 0),
    };
    let (catalog, load_diags) = load_catalog(&request);
    if !load_diags.is_empty() {
        failures.push(format!("catalog load diagnostics: {load_diags:?}"));
    }
    let Some(catalog) = catalog else {
        panic!("B1 catalog failed to load: {load_diags:?}");
    };
    if catalog.version().is_empty() {
        failures.push("catalog version is empty".to_string());
    }

    // Analyze with the real catalog (production: complete=true).
    let (program, analysis_diags) = check_program(&db, &[id], Some(&catalog));
    let blocking: Vec<&Diagnostic> = analysis_diags
        .iter()
        .filter(|d| {
            d.code.starts_with("E1") || d.code.starts_with("E2") || d.code.starts_with("E3")
        })
        .collect();
    if !blocking.is_empty() {
        let mut detail =
            String::from("analysis blocking errors (B1 needs zero E1xxx/E2xxx/E3xxx):");
        for d in blocking.iter().take(10) {
            detail.push_str(&format!(
                "\n  {} @{}..{} {}",
                d.code, d.primary.start, d.primary.end, d.message
            ));
        }
        failures.push(detail);
    }

    // Emit through the PRODUCTION path: complete analysis, production
    // options (no test-only acknowledgment — E6005 must not fire).
    let mut result = DiagnosticResult::new("b1", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.diagnostics = analysis_diags;
    result.complete = true;
    result.finish();
    let sources = EmitSources {
        db: &db,
        result: &result,
        catalog: Some(&catalog),
        options: EmitOptions::new(),
    };
    let (artifact, emit_diags) = emit(&program, &sources);

    // Exact emission profile: bridged (E6006=0), pinned (E6007=0),
    // 10 loud unlowered-UI positions (E6008). Nothing else may appear.
    for d in &emit_diags {
        if d.code != "E6006" && d.code != "E6007" && d.code != "E6008" {
            failures.push(format!("unexpected codegen code {}: {}", d.code, d.message));
        }
        if d.severity != Severity::Error {
            failures.push(format!(
                "codegen diagnostic {} is not error severity",
                d.code
            ));
        }
    }
    let e6006 = emit_diags.iter().filter(|d| d.code == "E6006").count();
    let e6007 = emit_diags.iter().filter(|d| d.code == "E6007").count();
    let e6008 = emit_diags.iter().filter(|d| d.code == "E6008").count();
    if e6006 != 0 {
        failures.push(format!("expected E6006=0 bridged, got {e6006}"));
    }
    if e6007 != 0 {
        failures.push(format!(
            "expected zero E6007 with the real catalog, got {e6007}"
        ));
    }
    if e6008 != 10 {
        failures.push(format!("expected E6008=10 pinned UI gaps, got {e6008}"));
    }

    // Artifact shape per artifact.ts.
    validate_artifact(&artifact, &expected_sha, &mut failures);

    if !failures.is_empty() {
        panic!(
            "B1 join failures ({}):\n- {}",
            failures.len(),
            failures.join("\n- ")
        );
    }
}

/// Strict `artifact.ts` shape checks. Never weakened to pass.
fn validate_artifact(artifact: &CompileArtifact, expected_sha: &str, failures: &mut Vec<String>) {
    if artifact.language_version != LANGUAGE_VERSION {
        failures.push(format!(
            "language_version {:?} != {:?}",
            artifact.language_version, LANGUAGE_VERSION
        ));
    }
    // Sources: exactly the compiled file with its real hash.
    if artifact.sources.len() != 1 {
        failures.push(format!("sources len {} != 1", artifact.sources.len()));
    } else {
        let source = &artifact.sources[0];
        if source.path != "examples/TeamTasks.can" {
            failures.push(format!(
                "source path {:?} != examples/TeamTasks.can",
                source.path
            ));
        }
        if source.sha256 != expected_sha {
            failures.push("source sha256 != compiled bytes hash".to_string());
        }
        if !is_sha256_hex(&source.sha256) {
            failures.push("source sha256 is not lowercase hex".to_string());
        }
    }
    // Modules: entrypoint (composed assembly) first, then packages in
    // source order. All three apps must be present.
    let paths: Vec<&str> = artifact.modules.iter().map(|m| m.path.as_str()).collect();
    if paths != ["teamoffice.mjs", "teamtasks.mjs", "teamnotes.mjs"] {
        failures.push(format!(
            "modules {paths:?} != [teamoffice, teamtasks, teamnotes]"
        ));
    }
    if artifact.modules.is_empty() {
        failures.push("no modules emitted".to_string());
        return;
    }
    // Entrypoint markers pinned from real emission (model shapes, CRUD
    // operations, page descriptors — same pins as the codegen goldens).
    let entry = &artifact.modules[0].js;
    for marker in [
        "id:\"TeamOffice\"",
        "\"TeamTasks.Todo\":{label:message(\"Task\",{nl:\"Taak\"})",
        "\"TeamNotes.Note\":{",
        "\"TeamTasks.Todo.create\":",
        "pages:[TeamTasksPageDescriptor,TeamNotesNotesPageDescriptor]",
    ] {
        if !entry.contains(marker) {
            failures.push(format!("entrypoint missing {marker:?}"));
        }
    }
    if entry.contains("...appDefinition") {
        failures.push("entrypoint spreads metadata (...appDefinition)".to_string());
    }
    // Every module: non-empty JS, valid map, allowlisted imports, no
    // test leakage.
    for module in &artifact.modules {
        if module.js.is_empty() {
            failures.push(format!("{}: empty js", module.path));
        }
        if module.map.file != module.path {
            failures.push(format!("{}: map file mismatch", module.path));
        }
        if module.map.sources.is_empty() || module.map.mappings.is_empty() {
            failures.push(format!("{}: empty source map", module.path));
        }
        if let Some(bad) = imports_allowlisted(&module.js) {
            failures.push(format!("{}: import outside allowlist: {bad}", module.path));
        }
        if module.js.contains("exampleFixtures") || module.js.contains("tests/") {
            failures.push(format!(
                "{}: production imports test artifacts",
                module.path
            ));
        }
    }
    // Callables: valid kinds, each bound to a real module export.
    if artifact.callables.is_empty() {
        failures.push("no callables emitted".to_string());
    }
    for callable in &artifact.callables {
        if !["operation", "pure", "rule", "handler", "migration"].contains(&callable.kind.as_str())
        {
            failures.push(format!(
                "callable {} has kind {:?}",
                callable.id, callable.kind
            ));
        }
        let Some(module) = artifact.modules.iter().find(|m| m.path == callable.module) else {
            failures.push(format!(
                "callable {} names missing module {}",
                callable.id, callable.module
            ));
            continue;
        };
        if !module.js.contains(&callable.export) {
            failures.push(format!(
                "callable {} export {} absent from {}",
                callable.id, callable.export, callable.module
            ));
        }
    }
    // Pages: exactly the 2 declared descriptors, exports resolved.
    if artifact.pages.len() != 2 {
        failures.push(format!("pages len {} != 2", artifact.pages.len()));
    }
    for page in &artifact.pages {
        let Some(module) = artifact.modules.iter().find(|m| m.path == page.module) else {
            failures.push(format!(
                "page {} names missing module {}",
                page.path, page.module
            ));
            continue;
        };
        if !module.js.contains(&page.export) {
            failures.push(format!(
                "page {} export {} absent from {}",
                page.path, page.export, page.module
            ));
        }
        // Importability: the named binding must be an exported const,
        // or the runtime cannot import the descriptor (B1 loadability).
        let exported = format!("export const {}=", page.export);
        if !module.js.contains(&exported) {
            failures.push(format!(
                "page {} export {} is not an exported const in {}",
                page.path, page.export, page.module
            ));
        }
    }
    // Requires pins the consumed catalog plus lowered families.
    if artifact.requires.is_empty() {
        failures.push("requires is empty with the real catalog".to_string());
    }
    if !artifact
        .requires
        .iter()
        .any(|r| r.capability == "canlang.builtins")
    {
        failures.push("requires lacks the canlang.builtins catalog pin".to_string());
    }
    // Tests: exactly the real update suite with the normative §13
    // factory shape, separate from production.
    if artifact.tests.len() != 1 {
        failures.push(format!("tests len {} != 1 suite", artifact.tests.len()));
    } else {
        let suite = &artifact.tests[0];
        if suite.scope != "TeamTasks.Todo.update" {
            failures.push(format!(
                "suite scope {:?} != TeamTasks.Todo.update",
                suite.scope
            ));
        }
        if !suite.module.js.contains("return {fixtures:{") {
            failures.push("suite lacks normative fixtures return shape".to_string());
        }
        if suite.module.js.contains("from \"./") || suite.module.js.contains("from \"../") {
            failures.push("suite imports production modules".to_string());
        }
    }
    // JSON envelope per artifact.ts.
    let json = artifact::to_json(artifact);
    if !json.starts_with("{\"artifact_version\":1,") {
        failures.push("artifact JSON lacks artifact_version 1 prefix".to_string());
    }
    match canlang_compiler::json::parse(&json) {
        Ok(parsed) => {
            if parsed.get("artifact_version").and_then(|v| v.as_i64()) != Some(1) {
                failures.push("artifact JSON artifact_version != 1".to_string());
            }
        }
        Err(e) => failures.push(format!("artifact JSON does not parse: {e:?}")),
    }
}
