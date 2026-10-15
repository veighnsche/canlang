//! Real checked rule IR, not fabricated local-call metadata.
use canlang_compiler::{
    analysis::{ResolvedType, Scalar, check_program, resolve::SymbolId},
    codegen::{
        ir::{self, IrBinOp, IrExpr, IrItemKind, IrProgram, IrType, IrUnOp},
        js,
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
fn owning_nullable_audit_presence_collects_exact_stored_fields() {
    let (program, model) = rule_with_fields(
        "",
        "(not row.enabled and row.account==null and row.recorded==null) or (row.enabled and null!=row.account and row.recorded!=null)",
        ",account:user?,recorded:datetime?",
    );
    let fields = local_rule_fields(&program, model, &program.invariants[0].pred).unwrap();
    assert_eq!(
        fields
            .iter()
            .map(|id| program.item(*id).name.as_str())
            .collect::<Vec<_>>(),
        ["enabled", "account", "recorded"]
    );
    for predicate in [
        "row.account==actor",
        "row.recorded==now",
        "row.account!=null and row.account.id!=\"\"",
        "row.optional==null",
    ] {
        let (program, model) = rule_with_fields(
            "",
            predicate,
            ",account:user?,recorded:datetime?,optional:int?",
        );
        assert!(
            local_rule_fields(&program, model, &program.invariants[0].pred).is_none(),
            "{predicate}"
        );
    }
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

#[test]
fn singular_user_lock_target_preserves_numeric_rule_and_refuses_changed_field_identity() {
    let (program, model) = rule_with_fields(
        "Other {title:text}\n policy Other read=members\n lock Item fields=account",
        "row.count>=0",
        ",account:user",
    );
    let field = program
        .items
        .iter()
        .find(|item| item.name == "account")
        .unwrap()
        .id;
    let other = program
        .items
        .iter()
        .find(|item| item.name == "Other")
        .unwrap()
        .id;
    let output = js::emit_program(&program);
    let policies = output
        .model_policies
        .as_ref()
        .expect("singular User lock target");
    assert_eq!(policies.len(), 1);
    let descriptor = serde_json::to_value(&policies[0]).unwrap();
    assert_eq!(descriptor["model"], "LocalRule.Item");
    // Written source order is retained: the fixture's lock precedes invariant.
    assert_eq!(
        descriptor["rules"],
        serde_json::json!([
            {"kind":"lock","id":"LocalRule.Item.lock.1","fields":["account"]},
            {"kind":"invariant","id":"LocalRule.Item.require.1","dependencies":[]},
        ])
    );
    assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_some());
    for ty in [
        ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::User))),
        ResolvedType::Array {
            element: Box::new(ResolvedType::Scalar(Scalar::User)),
            ordered: true,
            nonempty: false,
        },
        ResolvedType::Record {
            symbol: other,
            stored: true,
        },
        ResolvedType::Unknown,
    ] {
        let mut changed = program.clone();
        let IrItemKind::Field { ty: actual, .. } = &mut changed.items[field.0 as usize].kind else {
            panic!()
        };
        *actual = IrType::Known(ty);
        assert!(
            js::emit_program(&changed).model_policies.is_none(),
            "unsupported User target acquired policy claim"
        );
        assert_eq!(changed.invariants.len(), 1);
        assert_eq!(changed.locks.len(), 1);
    }
    let mut changed = program;
    let IrItemKind::Field { owner, .. } = &mut changed.items[field.0 as usize].kind else {
        panic!()
    };
    *owner = other;
    assert!(
        js::emit_program(&changed).model_policies.is_none(),
        "foreign owning field acquired User lock claim"
    );
}

#[test]
fn user_predicates_and_nullable_or_array_user_lock_sources_keep_existing_refusals() {
    let (program, model) = rule_with_fields("", "row.account==row.account", ",account:user");
    assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_none());
    assert!(js::emit_program(&program).model_policies.is_none());
    for field in ["user?", "user[]"] {
        let (program, _) = rule_with_fields(
            "lock Item fields=account",
            "row.count>=0",
            &format!(",account:{field}"),
        );
        assert!(
            js::emit_program(&program).model_policies.is_none(),
            "{field}"
        );
    }
}

#[test]
fn original_duration_relations_deduplicate_the_owning_field_and_publish_its_lock() {
    let (program, model) = rule_with_fields(
        "lock Item fields=duration",
        "row.duration>=1s and row.duration<=10m",
        ",duration:duration=120s",
    );
    let duration = program
        .items
        .iter()
        .find(|item| item.canonical == "LocalRule.Item.duration")
        .unwrap()
        .id;
    assert_eq!(
        local_rule_fields(&program, model, &program.invariants[0].pred),
        Some(vec![duration])
    );
    let IrExpr::Binary {
        op: IrBinOp::And,
        left,
        right,
    } = &program.invariants[0].pred.expr
    else {
        panic!("original two bounds")
    };
    for (comparison, expected_op, millis) in
        [(left, IrBinOp::Ge, 1_000), (right, IrBinOp::Le, 600_000)]
    {
        let IrExpr::Binary {
            op,
            left: field,
            right: literal,
        } = &comparison.expr
        else {
            panic!("Duration comparison")
        };
        assert_eq!(*op, expected_op);
        assert!(matches!(&field.expr, IrExpr::Member { field, .. } if field == "duration"));
        assert_eq!(field.ty, ResolvedType::Scalar(Scalar::Duration));
        assert_eq!(literal.ty, ResolvedType::Scalar(Scalar::Duration));
        assert!(matches!(literal.expr, IrExpr::DurationMs(value) if value == millis));
    }
    let emitted = js::emit_program(&program);
    assert!(emitted.diagnostics.is_empty(), "{:#?}", emitted.diagnostics);
    let descriptors = emitted
        .model_policies
        .expect("singular original Duration invariant and lock");
    assert_eq!(descriptors.len(), 1);
    let descriptor = serde_json::to_value(&descriptors[0]).unwrap();
    assert_eq!(descriptor["model"], "LocalRule.Item");
    assert_eq!(
        descriptor["rules"],
        serde_json::json!([
            {"kind":"lock","id":"LocalRule.Item.lock.1","fields":["duration"]},
            {"kind":"invariant","id":"LocalRule.Item.require.1","dependencies":[]}
        ])
    );
}

#[test]
fn duration_field_type_or_owner_changes_cannot_claim_the_original_relational_policy() {
    let (program, model) = rule_with_fields(
        "Other {duration:duration}\n policy Other read=members\n lock Item fields=duration",
        "row.duration>=1s and row.duration<=10m",
        ",duration:duration=120s",
    );
    let duration = program
        .items
        .iter()
        .find(|item| item.canonical == "LocalRule.Item.duration")
        .unwrap()
        .id;
    let other = program
        .items
        .iter()
        .find(|item| item.canonical == "LocalRule.Other")
        .unwrap()
        .id;
    assert_eq!(
        local_rule_fields(&program, model, &program.invariants[0].pred),
        Some(vec![duration])
    );
    for ty in [
        ResolvedType::Scalar(Scalar::Int),
        ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Duration))),
        ResolvedType::Array {
            element: Box::new(ResolvedType::Scalar(Scalar::Duration)),
            ordered: true,
            nonempty: false,
        },
        ResolvedType::Record {
            symbol: other,
            stored: true,
        },
    ] {
        let mut changed = program.clone();
        let IrItemKind::Field { ty: actual, .. } = &mut changed.items[duration.0 as usize].kind
        else {
            panic!("owning duration")
        };
        *actual = IrType::Known(ty);
        assert!(local_rule_fields(&changed, model, &changed.invariants[0].pred).is_none());
        assert!(js::emit_program(&changed).model_policies.is_none());
    }
    let mut changed = program;
    let IrItemKind::Field { owner, .. } = &mut changed.items[duration.0 as usize].kind else {
        panic!("owning duration")
    };
    *owner = other;
    assert!(local_rule_fields(&changed, model, &changed.invariants[0].pred).is_none());
    assert!(js::emit_program(&changed).model_policies.is_none());
    // Source-legal unsupported lock targets retain the same boundary even
    // when the predicate itself is an ordinary supported integer rule.
    for ty in ["duration?", "duration[]", "Other"] {
        let (program, _) = rule_with_fields(
            "Other {duration:duration}\n policy Other read=members\n lock Item fields=duration",
            "row.count>=0",
            &format!(",duration:{ty}"),
        );
        assert!(
            js::emit_program(&program).model_policies.is_none(),
            "{ty} lock"
        );
    }
}

#[test]
fn duration_literals_fields_and_receivers_require_exact_types_without_arithmetic_or_unary_expansion()
 {
    let (program, model) = rule_with_fields(
        "Other {duration:duration}\n policy Other read=members",
        "row.duration>=1s and row.duration<=10m",
        ",duration:duration=120s",
    );
    let other = program
        .items
        .iter()
        .find(|item| item.canonical == "LocalRule.Other")
        .unwrap()
        .id;
    assert!(local_rule_fields(&program, model, &program.invariants[0].pred).is_some());
    for mode in [
        "literal-type",
        "literal-shape",
        "field-type",
        "field-name",
        "receiver",
        "arithmetic",
        "unary",
        "array",
        "equality",
        "field-to-field",
    ] {
        let mut changed = program.clone();
        let IrExpr::Binary { left, .. } = &mut changed.invariants[0].pred.expr else {
            panic!("bounds")
        };
        let IrExpr::Binary {
            op,
            left: field,
            right: literal,
        } = &mut left.expr
        else {
            panic!("lower bound")
        };
        match mode {
            "literal-type" => literal.ty = ResolvedType::Scalar(Scalar::Int),
            "literal-shape" => literal.expr = IrExpr::Int(1_000),
            "field-type" => field.ty = ResolvedType::Scalar(Scalar::Int),
            "field-name" => {
                let IrExpr::Member { field, .. } = &mut field.expr else {
                    panic!("Duration member")
                };
                *field = "count".into();
            }
            "receiver" => {
                let IrExpr::Member { base, .. } = &mut field.expr else {
                    panic!("Duration member")
                };
                base.ty = ResolvedType::Record {
                    symbol: other,
                    stored: true,
                };
            }
            "arithmetic" => {
                field.expr = IrExpr::Binary {
                    op: IrBinOp::Add,
                    left: Box::new(field.as_ref().clone()),
                    right: Box::new(literal.as_ref().clone()),
                }
            }
            "unary" => {
                field.expr = IrExpr::Unary {
                    op: IrUnOp::Neg,
                    operand: Box::new(field.as_ref().clone()),
                }
            }
            "array" => {
                literal.expr = IrExpr::Array(vec![literal.as_ref().clone()]);
                literal.ty = ResolvedType::Array {
                    element: Box::new(ResolvedType::Scalar(Scalar::Duration)),
                    ordered: true,
                    nonempty: false,
                };
            }
            "equality" => *op = IrBinOp::Eq,
            "field-to-field" => *literal = field.clone(),
            _ => unreachable!(),
        }
        assert!(
            local_rule_fields(&changed, model, &changed.invariants[0].pred).is_none(),
            "{mode}"
        );
        assert!(
            js::emit_program(&changed).model_policies.is_none(),
            "{mode}"
        );
    }
}
