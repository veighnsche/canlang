//! Real checked rule IR, not fabricated local-call metadata.
use canlang_compiler::{
    analysis::{check_program, resolve::SymbolId},
    codegen::{
        ir::{self, IrItemKind, IrProgram},
        model_policy_profile::local_rule_fields,
    },
    source::{SourceDb, Span},
};

fn rule(extra: &str, predicate: &str) -> (IrProgram, SymbolId) {
    rule_with_fields(extra, predicate, "")
}

fn rule_with_fields(
    extra: &str,
    predicate: &str,
    additional_fields: &str,
) -> (IrProgram, SymbolId) {
    let source = format!(
        "app LocalRule\nGiven\n Item {{count:int,title:text,enabled:bool,state:enum(draft,done)=draft{additional_fields}}}\n policy Item read=members\n {extra}\n invariant Item: {predicate}\nWhen\nThen\n"
    );
    let mut db = SourceDb::new();
    let id = db.add("local-rule.can".into(), source);
    let catalog_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = canlang_compiler::analysis::catalog::load_catalog(
        &canlang_compiler::analysis::catalog::CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: catalog_path.parent().unwrap(),
            primary: Span::new(id, 0, 0),
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let model = program
        .items
        .iter()
        .find(|item| item.name == "Item" && matches!(item.kind, IrItemKind::Model { .. }))
        .unwrap()
        .id;
    (program, model)
}

#[test]
fn checked_primitive_rules_collect_first_observed_stored_fields() {
    let (program, model) = rule(
        "",
        "row.enabled and row.count>0 and row.title!=\"\" and row.count<10 and row.state==draft",
    );
    let fields = local_rule_fields(&program, model, &program.invariants[0].pred).unwrap();
    assert_eq!(
        fields
            .iter()
            .map(|id| program.item(*id).name.as_str())
            .collect::<Vec<_>>(),
        ["enabled", "count", "title", "state"]
    );
}

#[test]
fn checked_derive_calls_and_derived_fields_are_not_local_stored_dependencies() {
    for (extra, predicate) in [
        (
            "derive positive(value:int):bool = value>0",
            "positive(row.count)",
        ),
        ("derive Item.positive:bool = row.count>0", "row.positive"),
    ] {
        let (program, model) = rule(extra, predicate);
        assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_none());
    }
}

#[test]
fn checked_invocation_context_is_not_a_local_row_rule() {
    let (program, model) = rule("", "actor!=null");
    assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_none());
}

#[test]
fn checked_foreign_references_and_reserved_metadata_are_refused() {
    let (program, model) = rule_with_fields(
        "Other {title:text}\n policy Other read=members",
        "row.other.title!=\"\"",
        ",other:Other",
    );
    assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_none());
    let (program, model) = rule("", "row.version>0");
    assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_none());
}

#[test]
fn checked_direct_and_hidden_model_queries_are_refused() {
    for (extra, predicate) in [
        ("", "count(Item)>0"),
        ("derive any_items():bool = count(Item)>0", "any_items()"),
    ] {
        let (program, model) = rule(extra, predicate);
        assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_none());
    }
}

#[test]
fn checked_local_arrays_unary_operations_and_constant_predicates_are_supported() {
    for (predicate, names) in [
        ("not row.enabled or -row.count<0", vec!["enabled", "count"]),
        ("row.count in [1,2]", vec!["count"]),
        ("true", vec![]),
    ] {
        let (program, model) = rule("", predicate);
        let fields = local_rule_fields(&program, model, &program.invariants[0].pred).unwrap();
        assert_eq!(
            fields
                .iter()
                .map(|id| program.item(*id).name.as_str())
                .collect::<Vec<_>>(),
            names
        );
    }
}
