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
//! * Zero error-severity analysis diagnostics: B1 needs a supported source.
//! * TeamTasks: `E6006 == 0` (every needed position bridged),
//!   `E6007 == 0` (real catalog pins every builtin), `E6008 == 0`
//!   (E5, CAN18-v1: the bool-field list filter conjoins with its Lambda
//!   source where at the collection filter gate instead of refusing —
//!   the same proven `{op:and,[where,...filters]}` conjunction as the
//!   enum/bool pin suites; enum-backed option filters and defaults plus
//!   text content lower via the recorded outcome-6 admissions).
//!   NOTE: `can compile` (CLI policy) refuses to print an artifact
//!   while `E6008`s report; with zero `E6008`s TeamTasks itself now
//!   compiles end to end via the CLI.
//! * ExpenseFlow (B2a): `E6006 == 0`, `E6007 == 0`, `E6008 == 1`
//!   with the real catalog: enum filters/defaults, preference tabs and
//!   fixed order are admitted. Its money-valued stat remains refused
//!   until the owning presentation conversion is implemented.
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
use canlang_compiler::json::Json;
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

/// Every `from "..."` module source must be in the §13 allowlist
/// (`import` lines and `export ... from` re-exports alike). The match
/// anchors on `from "` so message strings containing `from ` (no
/// quote) never read as module sources.
fn imports_allowlisted(js: &str) -> Option<String> {
    for line in js.lines() {
        let trimmed = line.trim();
        let rest = match trimmed
            .strip_prefix("import ")
            .or_else(|| trimmed.strip_prefix("export "))
        {
            Some(rest) => rest,
            None => continue,
        };
        // Bare `export ...` (no `from "`) declares locals; nothing to
        // check.
        let Some(from_at) = rest.find("from \"") else {
            continue;
        };
        let after = &rest[from_at + 6..];
        let Some(end) = after.find('"') else {
            continue;
        };
        let source = &after[..end];
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
    // Any error-severity analysis diagnostic blocks B1 (not just
    // E1/E2/E3: E4/E5/E7 families must not slip past either).
    let blocking: Vec<&Diagnostic> = analysis_diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    if !blocking.is_empty() {
        let mut detail =
            String::from("analysis blocking errors (B1 needs zero error-severity diagnostics):");
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
    // no unsupported UI profiles (E6008=0). Nothing else may appear.
    // (A2b closed the `delete` gap: bare delete lowers to deleteRecord.)
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
    if e6008 != 0 {
        failures.push(format!(
            "expected E6008=0 with the E5 conjunction, got {e6008}"
        ));
    }
    for (profile, expected) in [
        ("cannot lower tooltip:", 0),
        ("cannot lower collapse:", 0),
        ("cannot lower breadcrumbs:", 0),
        ("cannot lower edit:", 0),
        // E5: the bool-field list filter passes the collection filter
        // gate (typed bool toggle conjoins with the Lambda source where).
        ("cannot lower list filters:", 0),
        // Text content lowers via the recorded outcome-6 admission.
        ("cannot lower content:", 0),
        ("cannot lower bound tabs", 0),
        ("cannot lower collection order", 0),
    ] {
        let actual = emit_diags
            .iter()
            .filter(|d| d.code == "E6008" && d.message.starts_with(profile))
            .count();
        if actual != expected {
            failures.push(format!("expected {profile} count {expected}, got {actual}"));
        }
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

#[test]
fn b2_expenseflow_artifact() {
    let root = repo_root();
    let can_path = root.join("examples").join("ExpenseFlow.can");
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
            "SKIP b2_expenseflow_artifact: no {} (run `npm run catalog` in packages/values)",
            catalog_path.display()
        );
        return;
    }
    let text = std::fs::read_to_string(&can_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", can_path.display()));
    let mut db = SourceDb::new();
    let id = db.add("examples/ExpenseFlow.can".to_string(), text);
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
        panic!("B2 catalog failed to load: {load_diags:?}");
    };
    if catalog.version().is_empty() {
        failures.push("catalog version is empty".to_string());
    }

    // Analyze with the real catalog (production: complete=true). Any
    // error-severity analysis diagnostic blocks the join.
    let (program, analysis_diags) = check_program(&db, &[id], Some(&catalog));
    let blocking: Vec<&Diagnostic> = analysis_diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    if !blocking.is_empty() {
        let mut detail =
            String::from("analysis blocking errors (B2 needs zero error-severity diagnostics):");
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
    let mut result = DiagnosticResult::new("b2", LANGUAGE_VERSION, SCHEMA_VERSION);
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

    // Exact emission profile: everything bridges (E6006=0), pins
    // (E6007=0); the money-valued stat retains its exact E6008.
    // Nominal preference tabs and fixed collection order are supported.
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
    if e6008 != 1 {
        failures.push(format!("expected E6008=1 money stat refusal, got {e6008}"));
    }
    for (profile, expected) in [
        ("cannot lower breadcrumbs:", 0),
        ("cannot lower edit:", 0),
        ("cannot lower action:", 0),
        ("cannot lower history:", 0),
        ("cannot lower stat:", 1),
        // The enum-backed option filter and defaults pass the collection
        // filter gate (recorded admission): admitted, never refused.
        ("cannot lower list: option filter", 0),
        ("cannot lower list: option defaults", 0),
        ("cannot lower list filters:", 0),
        ("cannot lower bound tabs", 0),
        ("cannot lower collection order", 0),
    ] {
        let actual = emit_diags
            .iter()
            .filter(|d| d.code == "E6008" && d.message.starts_with(profile))
            .count();
        if actual != expected {
            failures.push(format!("expected {profile} count {expected}, got {actual}"));
        }
    }
    if !emit_diags.iter().any(|d| d.code == "E6008" && d.message == "cannot lower stat: only one value header without a slotted suite has an owning factory profile") {
        failures.push("missing precise unsupported money stat refusal".to_string());
    }

    // Artifact shape per artifact.ts.
    validate_expenseflow_artifact(&artifact, &expected_sha, &mut failures);

    if !failures.is_empty() {
        panic!(
            "B2 join failures ({}):\n- {}",
            failures.len(),
            failures.join("\n- ")
        );
    }
}

/// Strict `artifact.ts` shape checks for ExpenseFlow. Never weakened to
/// pass.
fn validate_expenseflow_artifact(
    artifact: &CompileArtifact,
    expected_sha: &str,
    failures: &mut Vec<String>,
) {
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
        if source.path != "examples/ExpenseFlow.can" {
            failures.push(format!(
                "source path {:?} != examples/ExpenseFlow.can",
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
    // source order.
    let paths: Vec<&str> = artifact.modules.iter().map(|m| m.path.as_str()).collect();
    if paths
        != [
            "$can$m$457870656e7365466c6f77.mjs",
            "$can$m$657870656e736573.mjs",
            "$can$m$7265706f7274696e67.mjs",
        ]
    {
        failures.push(format!(
            "modules {paths:?} != [expenseflow, expenses, reporting]"
        ));
    }
    if artifact.modules.is_empty() {
        failures.push("no modules emitted".to_string());
        return;
    }
    // Entrypoint markers pinned from real emission (model shapes, CRUD
    // operations, scenario operations, page descriptors, lowered UI).
    let entry = &artifact.modules[0].js;
    for marker in [
        "id:\"ExpenseFlow\"",
        "\"expenses.Expense\":{",
        "\"expenses.Expense.create\":",
        "\"expenses.submit\":",
        "\"reporting.summarize\":",
        "pages:[$can$p$657870656e7365733a64657363726970746f723a2f,$can$p$7265706f7274696e673a64657363726970746f723a2f7265706f727473]",
        "$can$u$62726561646372756d6273({context:c,label:",
        "=c.breadcrumbs;",
        "$can$u$6261646765({context:$can$l$313a726f7756696577,value:$can$l$303a726f77.status})",
        "binding:{name:\"status\",options:",
        "current:preferences.status,version:c.preferenceVersions.reporting.status,postTo:c.pollUrl ?? c.path",
        "preferenceFields:[{name:\"status\",options:[\"draft\",\"submitted\",\"approved\",\"rejected\"],defaultValue:\"submitted\",caption:$can$h$636865636b65645f6d657373616765(\"Status\",{nl:\"Status\"},undefined,\"en\"),optionLabels:{draft:$can$h$636865636b65645f6d657373616765(\"Draft\",{nl:\"Concept\"},undefined,\"en\"),submitted:$can$h$636865636b65645f6d657373616765(\"Submitted\",{nl:\"Ingediend\"},undefined,\"en\"),approved:$can$h$636865636b65645f6d657373616765(\"Approved\",{nl:\"Goedgekeurd\"},undefined,\"en\"),rejected:$can$h$636865636b65645f6d657373616765(\"Rejected\",{nl:\"Afgewezen\"},undefined,\"en\")}}]",
        // The admitted option filter forwards the nullable expenses-page
        // preference the defaults declaration binds (settings shell
        // optionLabels included, as for the reporting page above).
        "preferenceFields:[{name:\"status\",options:[\"draft\",\"submitted\",\"approved\",\"rejected\"],defaultValue:null,nullable:true,caption:$can$h$636865636b65645f6d657373616765(\"Status\",{nl:\"Status\"},undefined,\"en\"),optionLabels:{draft:$can$h$636865636b65645f6d657373616765(\"Draft\",{nl:\"Concept\"},undefined,\"en\"),submitted:$can$h$636865636b65645f6d657373616765(\"Submitted\",{nl:\"Ingediend\"},undefined,\"en\"),approved:$can$h$636865636b65645f6d657373616765(\"Approved\",{nl:\"Goedgekeurd\"},undefined,\"en\"),rejected:$can$h$636865636b65645f6d657373616765(\"Rejected\",{nl:\"Afgewezen\"},undefined,\"en\")}}]",
        "order:[\"-created\"]",
        "$can$l$313a726f7756696577.prepareForm({operation:\"expenses.approve\",arguments:{expense:$can$l$303a726f77}",
        "$can$l$313a726f7756696577.prepareForm({operation:\"expenses.reject\",arguments:{expense:$can$l$303a726f77}",
        "$can$l$31303a73656c6563746564.map(($can$l$31313a657870656e7365)=>$can$l$31313a657870656e7365.amount)",
    ] {
        if !entry.contains(marker) {
            failures.push(format!("entrypoint missing {marker:?}"));
        }
    }
    if entry.matches("content:[").count() != 2 || entry.contains("$can$u$736c6f74({") {
        failures.push(
            "modal content must use exactly two named suites, without a slot factory".to_string(),
        );
    }
    if entry.contains("values:[result.count,result.total]") {
        failures.push("refused money stat must not forward unsupported values".to_string());
    }
    if entry.contains("...appDefinition") {
        failures.push("entrypoint spreads metadata (...appDefinition)".to_string());
    }
    // Every module: non-empty JS, valid map, allowlisted imports, no
    // test leakage, and — zero gaps means — no throwing placeholders.
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
        let without_missing_trail_guard = module.js.replace(
            "throw new Error(\"breadcrumbs: admitted declared ancestry is unavailable\");",
            "",
        );
        if without_missing_trail_guard.contains("throw new Error") {
            failures.push(format!(
                "{}: throwing placeholder with zero diagnostics",
                module.path
            ));
        }
    }
    // Callables: the two CRUD ops plus the four scenarios, each bound
    // to a real module export with an explicit member path.
    let callable_ids: Vec<&str> = artifact.callables.iter().map(|c| c.id.as_str()).collect();
    if callable_ids
        != [
            "expenses.Expense.create",
            "expenses.Expense.update",
            "expenses.submit",
            "expenses.approve",
            "expenses.reject",
            "reporting.summarize",
        ]
    {
        failures.push(format!("callables {callable_ids:?} != CRUD + scenarios"));
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
        // F1: the explicit `member` path is non-empty and every segment
        // resolves against the emitted `canApp()` registry text.
        if callable.member.is_empty() {
            failures.push(format!("callable {} has empty member path", callable.id));
        }
        for segment in &callable.member {
            if segment.is_empty() {
                failures.push(format!("callable {} has empty member segment", callable.id));
            } else if !module.js.contains(segment) {
                failures.push(format!(
                    "callable {} member segment {segment:?} absent from {}",
                    callable.id, callable.module
                ));
            }
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
        // or the runtime cannot import the descriptor.
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
    // Tests: one suite per operation with examples plus one recipe-only
    // suite per checked fixture (8c2dc7fe canonical providers), each with
    // the normative §13 factory shape and separate from production. The
    // approve suite carries tables plus the causal sequence.
    let scopes: Vec<&str> = artifact.tests.iter().map(|t| t.scope.as_str()).collect();
    if scopes
        != [
            "expenses.submit",
            "expenses.approve",
            "reporting.summarize",
            "expenses.reviewer_one",
            "expenses.reviewer_two",
            "expenses.pending",
            "reporting.mine",
        ]
    {
        failures.push(format!(
            "suites {scopes:?} != submit/approve/summarize + fixture recipes"
        ));
    }
    for suite in &artifact.tests {
        if !suite.module.js.contains("return {fixtures:{") {
            failures.push(format!(
                "suite {} lacks normative fixtures return shape",
                suite.scope
            ));
        }
        if !suite.module.js.contains(",examples:[") {
            failures.push(format!(
                "suite {} return lacks the examples half",
                suite.scope
            ));
        }
        if suite.module.js.contains("from \"./") || suite.module.js.contains("from \"../") {
            failures.push(format!("suite {} imports production modules", suite.scope));
        }
        if suite.module.js.contains("throw new Error") {
            failures.push(format!(
                "suite {} has a throwing placeholder with zero diagnostics",
                suite.scope
            ));
        }
    }
    if let Some(approve) = artifact
        .tests
        .iter()
        .find(|t| t.scope == "expenses.approve")
    {
        for marker in [
            "sequence:[{operation:\"expenses.Expense.create\"",
            "{let:\"draft_claim\",value:async(c,s,b)=>",
            "types:[\"expenses.Expense.status\",\"user?\"]",
        ] {
            if !approve.module.js.contains(marker) {
                failures.push(format!("approve suite missing {marker:?}"));
            }
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
            // F1: every callable carries an explicit `member` path
            // (non-empty array of non-empty strings).
            match parsed.get("callables") {
                Some(Json::Arr(items)) if !items.is_empty() => {
                    for item in items {
                        match item.get("member") {
                            Some(Json::Arr(segments))
                                if !segments.is_empty()
                                    && segments
                                        .iter()
                                        .all(|s| matches!(s, Json::Str(t) if !t.is_empty())) => {}
                            _ => failures.push(format!(
                                "callable JSON lacks a non-empty member string array: {item:?}"
                            )),
                        }
                    }
                }
                _ => failures.push("artifact JSON callables is not a non-empty array".to_string()),
            }
        }
        Err(e) => failures.push(format!("artifact JSON does not parse: {e:?}")),
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
    if paths
        != [
            "$can$m$5465616d4f6666696365.mjs",
            "$can$m$5465616d5461736b73.mjs",
            "$can$m$5465616d4e6f746573.mjs",
        ]
    {
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
        "\"TeamTasks.Todo\":{label:$can$h$636865636b65645f6d657373616765(\"Task\",{nl:\"Taak\"},undefined,\"en\")",
        "\"TeamNotes.Note\":{",
        "\"TeamTasks.Todo.create\":",
        "binding:{name:\"view\",options:[{value:\"all\",label:$can$h$636865636b65645f6d657373616765(\"All tasks\"",
        "current:preferences.view,version:c.preferenceVersions.TeamTasks.view,postTo:c.pollUrl ?? c.path",
        "preferenceFields:[{name:\"view\",options:[\"all\",\"unfinished\",\"finished\"],defaultValue:\"all\",caption:$can$h$636865636b65645f6d657373616765(\"Task view\",{nl:\"Taakweergave\"},undefined,\"en\"),optionLabels:{all:$can$h$636865636b65645f6d657373616765(\"All tasks\",{nl:\"Alle taken\"},undefined,\"en\"),unfinished:$can$h$636865636b65645f6d657373616765(\"Unfinished tasks\",{nl:\"Open taken\"},undefined,\"en\"),finished:$can$h$636865636b65645f6d657373616765(\"Finished tasks\",{nl:\"Afgeronde taken\"},undefined,\"en\")}}]",
        // E5: the admitted list emits a working descriptor — its typed
        // bool filter, source predicate and fixed ordering lower instead
        // of degrading to the throwing placeholder.
        "filter:[{field:\"done\"",
        "where:($can$l$303a7461736b)=>",
        "search:[\"title\"]",
        "order:[\"-created\"]",
        "pages:[$can$p$5465616d5461736b733a64657363726970746f723a2f,$can$p$5465616d4e6f7465733a64657363726970746f723a2f6e6f746573]",
    ] {
        if !entry.contains(marker) {
            failures.push(format!("entrypoint missing {marker:?}"));
        }
    }
    if entry.contains("...appDefinition") {
        failures.push("entrypoint spreads metadata (...appDefinition)".to_string());
    }
    if entry.contains("unsupported collection filter profile") {
        failures.push("admitted TeamTasks list must not keep the refusal placeholder".to_string());
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
        // F1: the explicit `member` path is non-empty and every segment
        // resolves against the emitted `canApp()` registry text.
        if callable.member.is_empty() {
            failures.push(format!("callable {} has empty member path", callable.id));
        }
        for segment in &callable.member {
            if segment.is_empty() {
                failures.push(format!("callable {} has empty member segment", callable.id));
            } else if !module.js.contains(segment) {
                failures.push(format!(
                    "callable {} member segment {segment:?} absent from {}",
                    callable.id, callable.module
                ));
            }
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
    // Tests: the real update suite plus the canonical fixture-recipe
    // provider (8c2dc7fe — every checked fixture owns one recipe-only
    // suite), each with the normative §13 factory shape, separate from
    // production.
    let scopes: Vec<&str> = artifact.tests.iter().map(|t| t.scope.as_str()).collect();
    if scopes != ["TeamTasks.Todo.update", "TeamTasks.task"] {
        failures.push(format!("suites {scopes:?} != [update, task recipe]"));
    }
    for suite in &artifact.tests {
        if !suite.module.js.contains("return {fixtures:{") {
            failures.push(format!(
                "suite {} lacks normative fixtures return shape",
                suite.scope
            ));
        }
        // Both halves of `{fixtures:{...},examples:[...]}`.
        if !suite.module.js.contains(",examples:[") {
            failures.push(format!(
                "suite {} return lacks the examples half",
                suite.scope
            ));
        }
        if suite.module.js.contains("from \"./") || suite.module.js.contains("from \"../") {
            failures.push(format!("suite {} imports production modules", suite.scope));
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
            // F1: every callable carries an explicit `member` path
            // (non-empty array of non-empty strings).
            match parsed.get("callables") {
                Some(Json::Arr(items)) if !items.is_empty() => {
                    for item in items {
                        match item.get("member") {
                            Some(Json::Arr(segments))
                                if !segments.is_empty()
                                    && segments
                                        .iter()
                                        .all(|s| matches!(s, Json::Str(t) if !t.is_empty())) => {}
                            _ => failures.push(format!(
                                "callable JSON lacks a non-empty member string array: {item:?}"
                            )),
                        }
                    }
                }
                _ => failures.push("artifact JSON callables is not a non-empty array".to_string()),
            }
        }
        Err(e) => failures.push(format!("artifact JSON does not parse: {e:?}")),
    }
}
