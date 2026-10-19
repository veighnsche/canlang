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
use canlang_compiler::codegen::ir::{self, IrItem, IrItemKind, IrProgram, IrStmt};
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
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::codegen::artifact::to_json;
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
        serde_json::from_str(&to_json(&artifact)).unwrap(),
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
fn archived_first_query_same_module() {
    let source = "app FirstSources\nGiven\n Budget {account:user,approved:bool}\n policy Budget read=members\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget archived=include as row where row.account==actor order=row.id)\n   require budget!=null and budget.approved\n   return true\nThen\n";
    let (db, program, _, catalog) = fixture_source("archived-first.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
}

/// Otherwise-equivalent archived positive WITHOUT order: the leading
/// `archived=include` clause with only as/where must close the same way.
/// Regression for the REVIEW-8 arm-order gap (the unguarded 3-slot arm
/// swallowed this shape and failed As/Where validation).
#[test]
fn archived_first_query_same_module_without_order() {
    let source = "app FirstSources\nGiven\n Budget {account:user,approved:bool}\n policy Budget read=members\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget archived=include as row where row.account==actor)\n   require budget!=null and budget.approved\n   return true\nThen\n";
    let (db, program, _, catalog) = fixture_source("archived-first-no-order.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
}

/// REVIEW-8 finding 2: a foreign file claiming the PROVIDER path refuses
/// E6008 through the existing stored-contract source seal, independent of
/// the helper-expression mutation negative. The multi-file baseline emits
/// (provider/consumer paths legitimately differ, so the import
/// correspondence itself compares module/canonical only); duplicating the
/// provider path breaks `match_stored_contract_source`
/// (`compiler/src/codegen/scenario_receipts.rs`, via
/// `checked_first_query_schema` → `match_stored_contract_schema`: owning
/// module, path equality, sha256 equality, recomputed hash, single db entry
/// for the path). Consumer-side sealing is untouched: `checked_source`
/// (`scenario_calls.rs`) plus `query.source == facts.source`
/// (`checked_owner_first_query_ir`). The helper-inclusive shape was observed
/// to refuse identically in scratch probing. No repair needed; this test
/// guards the seal.
#[test]
fn foreign_provider_path_refuses_first_query_source_correspondence() {
    let lib = "package lib\n Given\n  export Budget {account:user,approved:bool,active:bool}\n  policy Budget read=members\n When\n Then\n";
    let shop = "package shop\n use lib {Budget}\n Given\n When\n  scenario generate() -> bool by=members\n   do\n    let budget=first(Budget as row where row.account==actor order=row.id)\n    require budget!=null and budget.approved\n    return true\n Then\n";
    let app = "app FirstSources uses=[shop]\n";
    let mut db = SourceDb::new();
    let lib_file = db.add("import-lib.can".into(), lib.into());
    let shop_file = db.add("import-shop.can".into(), shop.into());
    let app_file = db.add("import-app.can".into(), app.into());
    let path = native_owner_root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(app_file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[lib_file, shop_file, app_file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
    // Foreign bytes claiming the provider path: the stored-contract source
    // seal must refuse even though module/canonical still correspond.
    db.add("import-lib.can".into(), "package lib\n".into());
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        diagnostics.iter().any(|diagnostic| diagnostic.code == "E6008"),
        "foreign provider-path source must still refuse"
    );
}

/// Default-exclude control: no archived clause and no order keeps the
/// default closed shape through the reordered arms (no permission change).
#[test]
fn plain_first_query_same_module_without_order_control() {
    let source = "app FirstSources\nGiven\n Budget {account:user,approved:bool}\n policy Budget read=members\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor)\n   require budget!=null and budget.approved\n   return true\nThen\n";
    let (db, program, _, catalog) = fixture_source("plain-first-no-order.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
}

const CONTAINED_DOMAIN_SOURCE: &str = "app DomainProbe\nGiven\n Term {name:text}\n Seat in Term {account:user,active:bool}\n policy Term read=members\n policy Seat read=members\nWhen\n scenario assign(term:Term,account:user) -> bool by=members\n  do\n   let seat=first(term.Seat as seat where seat.account==account order=seat.id)\n   require seat!=null and seat.active\n   return true\nThen\n";

fn contained_operation(artifact: &serde_json::Value) -> &serde_json::Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "DomainProbe.assign")
        .unwrap()
}

/// Contained-domain first-query correspondence (CAN18-v1 Lane C native
/// first/domain slice): `term.Seat` scans the required parent parameter's
/// children against their actual native owner. Disclosure records the
/// contained parent; the query plan, native receipt, owner-first IR join and
/// emitter each re-prove the receiver, and the emitted plan carries the
/// admitted-reference parent edge. Native first lowering (not the pure
/// builtin) executes the call.
#[test]
fn contained_domain_first_query_same_module() {
    let (db, program, _, catalog) = fixture_source("contained-first.can", CONTAINED_DOMAIN_SOURCE);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
    assert!(text.contains("firstQuery("), "contained first lowers natively");
    assert!(
        text.contains("\"field\":\"active\",\"type\":\"bool\""),
        "contained row field keeps its checked bool profile"
    );
    let plan = &contained_operation(&artifact)["result"]["disclosure"];
    assert_eq!(plan["queries"][0]["model"], "DomainProbe.Seat");
    assert_eq!(plan["queries"][0]["parent"]["model"], "DomainProbe.Term");
    assert_eq!(
        plan["queries"][0]["parent"]["origin"]["parameter"],
        "term"
    );
    assert_eq!(
        plan["queries"][0]["order"],
        serde_json::json!([{"field":"id","direction":"asc"}])
    );
}

/// Otherwise-equivalent contained first WITHOUT order: the default
/// created/id engine ordering keeps the same admitted parent edge.
#[test]
fn contained_domain_first_query_same_module_without_order() {
    let source = CONTAINED_DOMAIN_SOURCE.replace(
        "first(term.Seat as seat where seat.account==account order=seat.id)",
        "first(term.Seat as seat where seat.account==account)",
    );
    let (db, program, _, catalog) = fixture_source("contained-first-no-order.can", &source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("firstQuery("), "contained first lowers natively");
    let plan = &contained_operation(&artifact)["result"]["disclosure"];
    assert_eq!(plan["queries"][0]["parent"]["model"], "DomainProbe.Term");
    assert_eq!(
        plan["queries"][0]["parent"]["origin"]["parameter"],
        "term"
    );
    assert_eq!(plan["queries"][0]["order"], serde_json::json!([]));
}

/// Contained-domain refusals stay fail-closed with E6008: a receiver that is
/// not the required parent parameter, a non-child spelling, and IR-level
/// parent add/drop tampering must all refuse even though the plain shape
/// emits.
#[test]
fn contained_domain_first_query_refusals_stay_fail_closed() {
    // A non-child spelling already refuses at check with E2013 (unknown
    // member); only checked shapes reach the native join below.
    // Receiver is a let-bound alias, not the original required parameter.
    let source = "app DomainProbe\nGiven\n Term {name:text}\n Seat in Term {account:user,active:bool}\n policy Term read=members\n policy Seat read=members\nWhen\n scenario assign(term:Term,account:user) -> bool by=members\n  do\n   let holder=term\n   let seat=first(holder.Seat as seat where seat.account==account order=seat.id)\n   require seat!=null and seat.active\n   return true\nThen\n";
    let (db, program, _, catalog) = fixture_source("contained-first-let-receiver.can", source);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        diagnostics.iter().any(|diagnostic| diagnostic.code == "E6008"),
        "let-bound receiver must refuse"
    );
    // IR tampering: dropping the admitted parent lets an unscoped scan ride
    // the contained plan, and renaming it rebinds another parameter. Both
    // must refuse at the native join.
    let (db, _, ir, _) = fixture_source("contained-first.can", CONTAINED_DOMAIN_SOURCE);
    let owner = item(&ir, "DomainProbe.assign").id;
    let mut tampered = ir.clone();
    let IrItemKind::Scenario { effects, .. } = &mut tampered.items[owner.0 as usize].kind else {
        panic!("scenario");
    };
    let IrStmt::Let { value, .. } = &mut effects[0] else {
        panic!("let");
    };
    let ir_expr = match &mut value.expr {
        canlang_compiler::codegen::ir::IrExpr::Call { args, .. } => &mut args[0].expr,
        canlang_compiler::codegen::ir::IrExpr::BoundCall { args, .. } => &mut args[0].expr,
        other => panic!("call {other:?}"),
    };
    let canlang_compiler::codegen::ir::IrExpr::Query(scan) = ir_expr else {
        panic!("query");
    };
    assert!(scan.parent.is_some(), "fixture carries the admitted parent");
    scan.parent = None;
    assert!(
        js::emit_program_with_native_source_receipts(&tampered, true, &db)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "dropped IR parent must still refuse"
    );
    let mut renamed = ir.clone();
    let IrItemKind::Scenario { effects, .. } = &mut renamed.items[owner.0 as usize].kind else {
        panic!("scenario");
    };
    let IrStmt::Let { value, .. } = &mut effects[0] else {
        panic!("let");
    };
    let ir_expr = match &mut value.expr {
        canlang_compiler::codegen::ir::IrExpr::Call { args, .. } => &mut args[0].expr,
        canlang_compiler::codegen::ir::IrExpr::BoundCall { args, .. } => &mut args[0].expr,
        other => panic!("call {other:?}"),
    };
    let canlang_compiler::codegen::ir::IrExpr::Query(scan) = ir_expr else {
        panic!("query");
    };
    let Some(parent) = scan.parent.as_deref_mut() else {
        panic!("parent");
    };
    let canlang_compiler::codegen::ir::IrExpr::Name(name) = &mut parent.expr else {
        panic!("name");
    };
    assert_eq!(name, "term");
    *name = "account".into();
    assert!(
        js::emit_program_with_native_source_receipts(&renamed, true, &db)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "renamed IR parent must still refuse"
    );
}
