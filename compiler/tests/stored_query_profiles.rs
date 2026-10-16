//! Stored-query/selected-read profiles (CAN18-v1 outcome 5, Lane B5).
//!
//! Red probes for the original first/archive forms with required
//! helper/import reuse. Status: OPEN — each test below fails with E6008 at
//! emit while the checker and IR admit the source (their `fixture_source`
//! asserts pass). They are `#[ignore]`d pending the owning lane's repair;
//! un-ignore (no other change) is that repair's verification.
//!
//! Root causes localized by Lane B5 (2026-10-16, base a1579edb):
//! - Import probes: the disclosure checker declines the cross-package query
//!   closure (`reason: "query closure is not supported"`, queries None) at
//!   the first gate `owner.module != scenario.module` in
//!   `compiler/src/analysis/scenario_disclosure.rs::checked_first_query_source`.
//!   That file is Lane C owned (disclosure) with Lane C7 actively editing
//!   disclosure gates — flagged overlap, not touched without release.
//! - Archive probe: checker and IR admit `archived=include` on first, but
//!   every plan/emitter layer refuses (`q.archived` / `query.archived`
//!   guards in `compiler/src/codegen/scenario_queries.rs`, hardcoded
//!   `archived: "exclude"` receipts, `archived.is_none()` in
//!   `compiler/src/codegen/js.rs::native_first_query`); native honoring is
//!   State/Cloudflare runtime (Lane C).
//!
//! Acceptance carried by these probes once green: checked source/type/owner
//! survive into emission (no invented or dropped declarations) and corrupted
//! source/type/owner still refuse E6008.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrItem, IrItemKind, IrProgram};
use canlang_compiler::codegen::js;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_owner_root() -> PathBuf {
    let public = Path::new("/Users/vince/Projects/canlang");
    if public
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        public.into()
    } else {
        root()
    }
}

fn fixture_source(path: &str, source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let path = native_owner_root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

fn prepared_artifact(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (serde_json::Value, Vec<Diagnostic>) {
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, to_json_string};
    let mut result = DiagnosticResult::new("stored-query-profile", "1.0", 1);
    result.add_sources(db);
    let (artifact, diagnostics) = emit(
        program,
        &EmitSources {
            db,
            result: &result,
            catalog: Some(catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    (
        serde_json::from_str(&to_json_string(&artifact)).unwrap(),
        diagnostics,
    )
}

fn item<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}

/// Cross-package first-query without any helper call. Same-module pairs emit
/// (verified 2026-10-16: implicit-app, entry-only and non-entry-pair shapes
/// pass); the `use lib {Budget}` import refuses E6008 at the first span.
#[test]
fn imported_model_first_without_helper_control() {
    let source = "app FirstSources uses=[shop]\npackage lib\n Given\n  export Budget {account:user,approved:bool,active:bool}\n  policy Budget read=members\n When\n Then\npackage shop\n use lib {Budget}\n Given\n When\n  scenario generate() -> bool by=members\n   do\n    let budget=first(Budget as row where row.account==actor order=row.id)\n    require budget!=null and budget.approved\n    return true\n Then\n";
    let (db, program, _, catalog) = fixture_source("imported-first-control.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
}

/// Original first-query with an imported-helper guard: the checked
/// source/type/owner of the imported `allowed` helper must survive into the
/// emitted consumer; corrupting the helper body must still refuse E6008.
#[test]
fn imported_helper_guard_keeps_first_query_source_correspondence() {
    let source = "app FirstSources uses=[shop]\npackage lib\n Given\n  export Budget {account:user,approved:bool,active:bool}\n  policy Budget read=members\n  export derive allowed(record:Budget):bool = record.approved and record.active\n When\n Then\npackage shop\n use lib {Budget,allowed}\n Given\n When\n  scenario generate() -> bool by=members\n   do\n    let budget=first(Budget as row where row.account==actor order=row.id)\n    require budget!=null and allowed(record=budget)\n    return true\n Then\n";
    let (db, program, original, catalog) = fixture_source("imported-first-helper.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
    for field in ["approved", "active"] {
        assert!(
            text.contains(&format!("\"field\":\"{field}\",\"type\":\"bool\"")),
            "imported helper field {field} keeps its checked bool profile"
        );
    }
    let mut corrupt = original.clone();
    let helper = item(&original, "lib.allowed").id;
    let IrItemKind::DeriveFn {
        expr: Some(body), ..
    } = &mut corrupt.items[helper.0 as usize].kind
    else {
        panic!("derive");
    };
    let canlang_compiler::codegen::ir::IrExpr::Binary { left, .. } = &mut body.expr else {
        panic!("and");
    };
    let canlang_compiler::codegen::ir::IrExpr::Member { field, .. } = &mut left.expr else {
        panic!("member");
    };
    *field = "active".into();
    assert!(
        js::emit_program_with_native_source_receipts(&corrupt, true, &db)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "corrupted imported helper source must still refuse"
    );
}

/// Same-module first with `archived=include`. Checker and IR admit; the
/// plan/emitter layers refuse E6008 (multi-layer archive gap, Lane C runtime
/// honoring still needed after the compiler join).
#[test]
#[ignore = "outcome 5 OPEN: archived-first plan/emitter join missing (compiler bridge + Lane C runtime); un-ignore after repair"]
fn archived_first_query_same_module() {
    let source = "app FirstSources\nGiven\n Budget {account:user,approved:bool}\n policy Budget read=members\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget archived=include as row where row.account==actor order=row.id)\n   require budget!=null and budget.approved\n   return true\nThen\n";
    let (db, program, _, catalog) = fixture_source("archived-first.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
}
