//! B3-I1 migration lowering tests (lane-01 codegen): valid `.can`
//! migrations lower to interim-intake `IrMigration` transitions with zero
//! `E6008`; directive conflicts are `E6009`, predecessor problems are
//! `E6010`; the artifact carries a migration registry.
//!
//! TEST-ONLY: hermetic, no catalog (`check_program`/`ir::build` with
//! `None`); fixtures use no imports so no `E6007` can fire.

use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::artifact;
use canlang_compiler::codegen::ir::{self, IrMigrationDirective};
use canlang_compiler::source::{SourceDb, SourceId};
use std::collections::BTreeSet;

fn build(text: &str) -> (ir::IrProgram, Vec<String>) {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), text.to_string());
    let (program, _) = check_program(&db, &[id], None);
    let (ir_program, diags) = ir::build(&program, &db, None);
    let codes: Vec<String> = diags.iter().map(|d| d.code.to_string()).collect();
    (ir_program, codes)
}

fn app(models: &str, migration: &str) -> String {
    format!("# B3-I1 fixture.\napp Shop\nGiven\n{models}When\nThen\n{migration}")
}

// --- Valid migrations: zero E6008, lowered transitions ----------------------

#[test]
fn valid_model_rename_lowers() {
    let (ir, codes) = build(&app(
        " Todo { title:text }\n Task { title:text }\n",
        "migration Shop from=\"snap-1\"\n rename before.Todo to Task\n",
    ));
    assert_eq!(codes, Vec::<String>::new(), "valid rename is silent");
    assert_eq!(ir.migrations.len(), 1);
    let migration = &ir.migrations[0];
    assert_eq!(migration.owner, "Shop");
    assert_eq!(migration.migration_id, "Shop@snap-1");
    assert_eq!(migration.from_snapshot, "snap-1");
    assert_eq!(migration.body_digest.len(), 64, "sha256 hex digest");
    assert!(migration.body_digest.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(migration.directives.len(), 1);
    match &migration.directives[0] {
        IrMigrationDirective::RenameModel { from, to } => {
            assert_eq!(from, "Shop.Todo");
            assert_eq!(to, "Shop.Task");
        }
        other => panic!("expected RenameModel, got {other:?}"),
    }
}

#[test]
fn valid_field_directives_and_backfill_lower() {
    let (ir, codes) = build(&app(
        " Todo { title:text, priority:int }\n",
        "migration Shop from=\"snap-1\"\n rename before.Todo.label to Todo.title\n drop before.Todo.legacy\n backfill Todo\n",
    ));
    assert_eq!(
        codes,
        Vec::<String>::new(),
        "valid field migration is silent"
    );
    assert_eq!(ir.migrations.len(), 1);
    let directives = &ir.migrations[0].directives;
    assert_eq!(directives.len(), 3);
    match &directives[0] {
        IrMigrationDirective::RenameField { model, from, to } => {
            assert_eq!(model, "Shop.Todo");
            assert_eq!(from, "label");
            assert_eq!(to, "title");
        }
        other => panic!("expected RenameField, got {other:?}"),
    }
    match &directives[1] {
        IrMigrationDirective::DropField { model, field } => {
            assert_eq!(model, "Shop.Todo");
            assert_eq!(field, "legacy");
        }
        other => panic!("expected DropField, got {other:?}"),
    }
    match &directives[2] {
        IrMigrationDirective::Backfill { model } => assert_eq!(model, "Shop.Todo"),
        other => panic!("expected Backfill, got {other:?}"),
    }
}

#[test]
fn valid_drop_model_invalidate_and_owner_drop_lower() {
    let (ir, codes) = build(&app(
        " Todo { title:text }\n",
        "migration Shop from=\"snap-1\"\n drop before.Old\n invalidate before.cleanup\n",
    ));
    assert_eq!(
        codes,
        Vec::<String>::new(),
        "valid drop/invalidate is silent"
    );
    let directives = &ir.migrations[0].directives;
    assert_eq!(directives.len(), 2);
    match &directives[0] {
        IrMigrationDirective::DropModel { model } => assert_eq!(model, "Shop.Old"),
        other => panic!("expected DropModel, got {other:?}"),
    }
    match &directives[1] {
        IrMigrationDirective::Invalidate { handler } => assert_eq!(handler, "cleanup"),
        other => panic!("expected Invalidate, got {other:?}"),
    }

    let (ir, codes) = build(&app(
        " Todo { title:text }\n",
        "migration Shop from=\"snap-1\"\n drop owner\n",
    ));
    assert_eq!(codes, Vec::<String>::new(), "valid owner drop is silent");
    assert!(matches!(
        ir.migrations[0].directives[..],
        [IrMigrationDirective::DropOwner]
    ));

    let (ir, codes) = build(&app(
        " Todo { title:text }\n",
        "migration Shop from=\"snap-1\"\n rename owner\n",
    ));
    assert_eq!(codes, Vec::<String>::new(), "valid owner rename is silent");
    assert!(matches!(
        ir.migrations[0].directives[..],
        [IrMigrationDirective::RenameOwner { .. }]
    ));

    // Header-only: a constraint-only transition acknowledges with no rows.
    let (ir, codes) = build(&app(
        " Todo { title:text }\n",
        "migration Shop from=\"s\"\n",
    ));
    assert_eq!(codes, Vec::<String>::new(), "header-only is silent");
    assert!(ir.migrations[0].directives.is_empty());
}

#[test]
fn body_digest_is_deterministic() {
    let fixture = app(
        " Todo { title:text }\n Task { title:text }\n",
        "migration Shop from=\"snap-1\"\n rename before.Todo to Task\n",
    );
    let (first, _) = build(&fixture);
    let (second, _) = build(&fixture);
    assert_eq!(
        first.migrations[0].body_digest,
        second.migrations[0].body_digest
    );
    let (other, _) = build(&app(
        " Todo { title:text }\n Task { title:text }\n",
        "migration Shop from=\"snap-1\"\n rename before.Todo to Task\n invalidate before.cleanup\n",
    ));
    assert_ne!(
        first.migrations[0].body_digest, other.migrations[0].body_digest,
        "digest covers the directive set"
    );
}

// --- E6009: directive conflicts ----------------------------------------------

fn codes_of(migration: &str) -> Vec<String> {
    let (_, codes) = build(&app(
        " Todo { title:text }\n Task { title:text }\n",
        migration,
    ));
    codes
}

#[test]
fn exactly_once_violations_are_e6009() {
    // Same before-model handled twice.
    assert!(
        codes_of("migration Shop from=\"s\"\n rename before.Todo to Task\n drop before.Todo\n")
            .contains(&"E6009".to_string()),
        "rename+drop double-handles"
    );
    // Same before-field handled twice.
    assert!(
        codes_of(
            "migration Shop from=\"s\"\n rename before.Todo.label to Todo.title\n drop before.Todo.label\n"
        )
        .contains(&"E6009".to_string()),
        "field double-handle"
    );
    // Two sources onto one target.
    assert!(
        codes_of(
            "migration Shop from=\"s\"\n rename before.Todo to Task\n rename before.Old to Task\n"
        )
        .contains(&"E6009".to_string()),
        "target collision"
    );
    // Self rename (retained-target collisions need the old tables: the
    // runtime's validateTransition owns those).
    assert!(
        codes_of("migration Shop from=\"s\"\n rename before.Todo to Todo\n")
            .contains(&"E6009".to_string()),
        "self rename"
    );
    // Rename target undeclared.
    assert!(
        codes_of("migration Shop from=\"s\"\n rename before.Todo to Missing\n")
            .contains(&"E6009".to_string()),
        "unknown rename target"
    );
    // Drop of a still-declared model.
    assert!(
        codes_of("migration Shop from=\"s\"\n drop before.Todo\n").contains(&"E6009".to_string()),
        "drop of declared model"
    );
    // RenameField target undeclared.
    assert!(
        codes_of("migration Shop from=\"s\"\n rename before.Todo.label to Todo.missing\n")
            .contains(&"E6009".to_string()),
        "unknown field target"
    );
    // RenameField target naming the wrong model.
    assert!(
        codes_of("migration Shop from=\"s\"\n rename before.Todo.label to Task.title\n")
            .contains(&"E6009".to_string()),
        "field target model mismatch"
    );
    // DropField of a still-declared field.
    assert!(
        codes_of("migration Shop from=\"s\"\n drop before.Todo.title\n")
            .contains(&"E6009".to_string()),
        "drop of declared field"
    );
    // Backfill of an undeclared model.
    assert!(
        codes_of("migration Shop from=\"s\"\n backfill Missing\n").contains(&"E6009".to_string()),
        "unknown backfill"
    );
    // DropOwner takes no model/field/backfill directives.
    assert!(
        codes_of("migration Shop from=\"s\"\n drop owner\n drop before.Old\n")
            .contains(&"E6009".to_string()),
        "dropOwner with model directive"
    );
    // RenameOwner and DropOwner together.
    assert!(
        codes_of("migration Shop from=\"s\"\n rename owner\n drop owner\n")
            .contains(&"E6009".to_string()),
        "rename+drop owner"
    );
    // NOTE: target-less renames and non-before sources are E1200 at
    // parse (the parser owns those shapes); the checker's defensive
    // branches for them are pinned by migrate_check unit tests.
}

#[test]
fn violations_emit_no_e6008() {
    for migration in [
        "migration Shop from=\"s\"\n rename before.Todo to Task\n drop before.Todo\n",
        "migration Shop\n rename before.Todo to Task\n",
        "migration Ghost from=\"s\"\n rename before.Todo to Task\n",
    ] {
        let codes = codes_of(migration);
        assert!(
            !codes.contains(&"E6008".to_string()),
            "migration diagnostics use new codes, got {codes:?}"
        );
    }
}

#[test]
fn invalid_migration_lowers_nothing() {
    let (ir, codes) = build(&app(
        " Todo { title:text }\n Task { title:text }\n",
        "migration Shop from=\"s\"\n rename before.Todo to Task\n drop before.Todo\n",
    ));
    assert!(codes.contains(&"E6009".to_string()));
    assert!(ir.migrations.is_empty(), "no partial lowering");
}

// --- E6010: predecessor problems -----------------------------------------------

#[test]
fn predecessor_problems_are_e6010() {
    // NOTE: a missing from= is E1200 at parse (required attribute); the
    // checker's missing-predecessor branch covers hand-built tables.
    // Empty from=.
    assert!(
        codes_of("migration Shop from=\"\"\n rename before.Todo to Task\n")
            .contains(&"E6010".to_string()),
        "empty from"
    );
    // Owner names no module.
    assert!(
        codes_of("migration Ghost from=\"s\"\n rename before.Todo to Task\n")
            .contains(&"E6010".to_string()),
        "unknown owner"
    );
    // Duplicate (owner, from).
    let (_, codes) = build(&app(
        " Todo { title:text }\n Task { title:text }\n",
        "migration Shop from=\"s\"\n rename before.Todo to Task\nmigration Shop from=\"s\"\n drop before.Old\n",
    ));
    assert!(
        codes.iter().filter(|c| c.as_str() == "E6010").count() >= 1,
        "duplicate predecessor, got {codes:?}"
    );
}

// --- Artifact registry ---------------------------------------------------------

#[test]
fn artifact_carries_migration_registry() {
    let fixture = app(
        " Todo { title:text }\n Task { title:text }\n",
        "migration Shop from=\"snap-1\"\n rename before.Todo to Task\n",
    );
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), fixture);
    let _ = id;
    let (program, _) = check_program(&db, &[SourceId(0)], None);
    let (ir_program, diags) = ir::build(&program, &db, None);
    assert!(diags.is_empty(), "valid migration is silent: {diags:?}");
    let js = canlang_compiler::codegen::js::JsOutput {
        entry: canlang_compiler::codegen::js::JsModule {
            path: "test.mjs".to_string(),
            js: String::new(),
            lines: Vec::new(),
        },
        packages: Vec::new(),
        diagnostics: Vec::new(),
        referenced_builtins: Vec::new(),
        callables: Vec::new(),
        pages: Vec::new(),
        operations: Vec::new(),
        stdlib_imports: BTreeSet::new(),
        ui_imports: BTreeSet::new(),
    };
    let (artifact, _) = artifact::assemble(&ir_program, &js, &[], &[], &db, None);
    assert_eq!(artifact.migrations.len(), 1);
    let entry = &artifact.migrations[0];
    assert_eq!(entry.id, "Shop@snap-1");
    assert_eq!(entry.owner, "Shop");
    assert_eq!(entry.from, "snap-1");
    assert_eq!(entry.directives.len(), 1);
    let json = artifact::to_json(&artifact);
    assert!(
        json.contains("\"migrations\":[{"),
        "registry renders: {json}"
    );
    assert!(json.contains("\"Shop@snap-1\""), "registry id renders");
}
