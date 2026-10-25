//! Policy rebuild + migration predecessor (`E6010`) tests.
//!
//! `rebuild_policy_source` is `pub(crate)` (only the outer builder/checked
//! collector may admit the contextual candidate), so integration coverage
//! drives it through its public owners: [`ir::build`] decodes the same
//! policy closure deterministically across fresh builds, and [`emit`] runs
//! the checked collector (`rebuild_policy_source` plus source agreement)
//! before sealing `modelPolicies`. `E6010` predecessor checking is covered
//! both directly through [`check_migration`] with hand-built tables (the
//! parser owns the missing-`from=` shape as `E1200`, per the checker docs)
//! and end to end through `check_program`/`ir::build`.
//!
//! TEST-ONLY: hermetic except the `emit` test, which loads the repo
//! catalog like its siblings (producer capabilities need pinning);
//! fixtures use no imports so no `E6007` can fire elsewhere.

use canlang_compiler::analysis::NodeKey;
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::effects::MigrationData;
use canlang_compiler::analysis::migrate_check::{OwnerModelView, check_migration};
use canlang_compiler::codegen::ir::{self, IrProgram};
use canlang_compiler::codegen::model_policies::ModelRule;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, SourceId};
use std::path::Path;

const POLICY_APP: &str = "# Policy rebuild fixture.\napp Shop\nGiven\n Item {qty:int,title:text}\n policy Item read=public\n invariant Item: row.qty>=0\n lock Item fields=title\nWhen\nThen\n";

fn checked_ir(source: &str) -> (SourceDb, IrProgram, Vec<String>) {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), source.to_string());
    let (program, _) = check_program(&db, &[id], None);
    let (ir, diags) = ir::build(&program, &db, None);
    let codes: Vec<String> = diags.iter().map(|d| d.code.to_string()).collect();
    (db, ir, codes)
}

fn migration_app(models: &str, migration: &str) -> String {
    format!("# E6010 fixture.\napp Shop\nGiven\n{models}When\nThen\n{migration}")
}

fn migration_codes(models: &str, migration: &str) -> Vec<String> {
    let (_, _, codes) = checked_ir(&migration_app(models, migration));
    codes
}

fn node() -> NodeKey {
    NodeKey {
        file: SourceId(0),
        start: 0,
        end: 1,
        kind: 0,
    }
}

fn migration(owner: &str, from: Option<&str>) -> MigrationData {
    MigrationData {
        node: node(),
        owner: owner.to_string(),
        module: None,
        from: from.map(str::to_string),
        from_node: None,
        directives: Vec::new(),
        descriptions: Vec::new(),
    }
}

fn owner_models() -> Vec<OwnerModelView> {
    vec![OwnerModelView {
        name: "Item".to_string(),
        fields: vec!["qty".to_string(), "title".to_string()],
    }]
}

// --- rebuild_policy_source (public owners: ir::build + emit) -----------------

#[test]
fn policy_closure_decodes_deterministically_across_fresh_builds() {
    let (_, first, first_codes) = checked_ir(POLICY_APP);
    let (_, second, second_codes) = checked_ir(POLICY_APP);
    assert_eq!(first_codes, Vec::<String>::new(), "policy app is silent");
    assert_eq!(second_codes, Vec::<String>::new(), "rebuild is silent");
    let first_invariants: Vec<&str> = first.invariants.iter().map(|r| r.id.as_str()).collect();
    let second_invariants: Vec<&str> = second.invariants.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(first_invariants, ["Item.require.1"]);
    assert_eq!(first_invariants, second_invariants, "rebuild agrees");
    let first_locks: Vec<&str> = first.locks.iter().map(|l| l.id.as_str()).collect();
    let second_locks: Vec<&str> = second.locks.iter().map(|l| l.id.as_str()).collect();
    assert_eq!(first_locks, ["Item.lock.1"]);
    assert_eq!(first_locks, second_locks, "rebuild agrees");
}

#[test]
fn emit_seals_policy_closure_through_checked_rebuild() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diags) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: canlang_compiler::source::Span::new(SourceId(0), 0, 0),
    });
    assert!(diags.is_empty(), "{diags:?}");
    let catalog = catalog.unwrap();
    let mut db = SourceDb::new();
    let file = db.add("test.can".to_string(), POLICY_APP.to_string());
    let (program, diags) = check_program(&db, &[file], Some(&catalog));
    assert!(diags.is_empty(), "{diags:?}");
    let mut result = DiagnosticResult::new(env!("CARGO_PKG_VERSION"), "1.0", 1);
    result.add_sources(&db);
    let (artifact, diags) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    assert!(diags.is_empty(), "{diags:?}");
    let policies = artifact.model_policies.expect("policy closure seals");
    let policy = policies
        .iter()
        .find(|p| p.model == "Shop.Item")
        .expect("owning Shop.Item descriptor");
    assert_eq!(policy.owner_package, "Shop");
    assert!(
        policy
            .rules
            .iter()
            .any(|r| matches!(r, ModelRule::Invariant { .. }))
    );
    assert!(
        policy
            .rules
            .iter()
            .any(|r| matches!(r, ModelRule::Lock { .. }))
    );
}

// --- E6010: check_migration predecessor problems ------------------------------

#[test]
fn missing_or_empty_predecessor_is_e6010() {
    let models = owner_models();
    for from in [None, Some("")] {
        let diags = check_migration(&migration("Shop", from), Some(&models), &[]);
        assert!(
            diags.iter().any(|d| d.code == "E6010"),
            "from={from:?} is E6010, got {diags:?}"
        );
    }
}

#[test]
fn unknown_owner_is_e6010() {
    let diags = check_migration(&migration("Ghost", Some("s")), None, &[]);
    assert!(
        diags.iter().any(|d| d.code == "E6010"),
        "owner naming no module is E6010, got {diags:?}"
    );
}

#[test]
fn duplicate_predecessor_is_e6010() {
    let models = owner_models();
    let prior = vec![("Shop".to_string(), "s".to_string())];
    let diags = check_migration(&migration("Shop", Some("s")), Some(&models), &prior);
    assert!(
        diags.iter().any(|d| d.code == "E6010"),
        "second transition from the same snapshot is E6010, got {diags:?}"
    );
    let diags = check_migration(&migration("Shop", Some("other")), Some(&models), &prior);
    assert!(
        !diags.iter().any(|d| d.code == "E6010"),
        "a fresh predecessor stays silent, got {diags:?}"
    );
}

#[test]
fn valid_migration_has_no_e6010() {
    let models = owner_models();
    let diags = check_migration(&migration("Shop", Some("s")), Some(&models), &[]);
    assert!(diags.is_empty(), "valid header is silent, got {diags:?}");
}

#[test]
fn end_to_end_predecessor_problems_are_e6010() {
    let models = " Todo { title:text }\n Task { title:text }\n";
    assert!(
        migration_codes(
            models,
            "migration Shop from=\"\"\n rename before.Todo to Task\n"
        )
        .contains(&"E6010".to_string()),
        "empty from"
    );
    assert!(
        migration_codes(
            models,
            "migration Ghost from=\"s\"\n rename before.Todo to Task\n"
        )
        .contains(&"E6010".to_string()),
        "unknown owner"
    );
    let (_, _, codes) = checked_ir(&migration_app(
        models,
        "migration Shop from=\"s\"\n rename before.Todo to Task\nmigration Shop from=\"s\"\n drop before.Old\n",
    ));
    assert!(
        codes.iter().filter(|c| c.as_str() == "E6010").count() >= 1,
        "duplicate predecessor, got {codes:?}"
    );
}

#[test]
fn end_to_end_valid_migration_is_silent() {
    let (_, ir, codes) = checked_ir(&migration_app(
        " Todo { title:text }\n Task { title:text }\n",
        "migration Shop from=\"snap-1\"\n rename before.Todo to Task\n",
    ));
    assert_eq!(codes, Vec::<String>::new(), "valid migration is silent");
    assert_eq!(ir.migrations.len(), 1);
    assert_eq!(ir.migrations[0].migration_id, "Shop@snap-1");
}
