//! Exact original current-Revision classifier facts; no native policy certificate.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::{
    ResolvedType, Scalar, SymbolId, check_program, resolve::ModuleId,
};
use canlang_compiler::codegen::ir::{
    self, IrBinOp, IrExpr, IrItemKind, IrModelRuleKind, IrOwner, IrProgram, IrType, IrUnOp,
    TypedExpr,
};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::model_policy_profile::{
    CurrentRevisionRuleKind, current_revision_rule_profile, local_rule_fields,
};
use canlang_compiler::source::{SourceDb, SourceId, Span, sha256_hex};
use std::path::Path;

const SOURCE: &str = include_str!("fixtures/source-current-revision.can");
const HASH: &str = "4da5ddcc956e72ee6f8e0d5942467692c549d925dee2a01a4e01192f93e31bbf";

fn checked() -> (canlang_compiler::analysis::CheckedProgram, IrProgram) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let catalog_path = root.join("packages/cloudflare/dist/native-catalog.json");
    let mut db = SourceDb::new();
    let file = db.add("current-revision.can".into(), SOURCE.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (checked, ir)
}

fn symbol(ir: &IrProgram, name: &str) -> SymbolId {
    ir.items
        .iter()
        .find(|item| item.canonical == format!("SourceCurrentRevision.{name}"))
        .unwrap()
        .id
}

fn rule_index(ir: &IrProgram, model: SymbolId) -> usize {
    ir.invariants
        .iter()
        .position(|rule| {
            rule.origin
                .as_ref()
                .is_some_and(|origin| origin.model == model)
        })
        .unwrap()
}

fn map_expression(expr: &mut TypedExpr, apply: &mut impl FnMut(&mut TypedExpr)) {
    match &mut expr.expr {
        IrExpr::Binary { left, right, .. } => {
            map_expression(left, apply);
            map_expression(right, apply);
        }
        IrExpr::Unary { operand, .. } => map_expression(operand, apply),
        IrExpr::Member { base, .. } => map_expression(base, apply),
        _ => {}
    }
    apply(expr);
}

#[test]
fn original_template_and_revision_rules_keep_real_origin_and_lazy_typed_fields_without_certificate()
{
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let original = include_str!("fixtures/original-a850/CanCreative.can");
    for line in SOURCE.lines().map(str::trim).filter(|line| {
        line.starts_with("invariant Template:") || line.starts_with("invariant Revision:")
    }) {
        assert!(
            original
                .lines()
                .map(str::trim)
                .any(|original| original == line)
        );
    }
    let (checked, ir) = checked();
    let template = symbol(&ir, "Template");
    let revision = symbol(&ir, "Revision");
    for (model, expected) in [
        (
            template,
            CurrentRevisionRuleKind::Template {
                duration: symbol(&ir, "Template.duration"),
                current: symbol(&ir, "Template.current"),
                revision,
                published: symbol(&ir, "Revision.published"),
            },
        ),
        (
            revision,
            CurrentRevisionRuleKind::Revision {
                duration: symbol(&ir, "Revision.duration"),
                published: symbol(&ir, "Revision.published"),
                digest: symbol(&ir, "Revision.digest"),
            },
        ),
    ] {
        let rule = &ir.invariants[rule_index(&ir, model)];
        let actual =
            current_revision_rule_profile(&ir, rule).expect("exact mandatory original invariant");
        assert_eq!(actual.kind, expected);
        let declaration = &checked.effects.models[&model].invariants[0];
        assert_eq!(actual.origin.model, declaration.target);
        assert_eq!(actual.origin.module, declaration.module);
        assert_eq!(actual.origin.ordinal, declaration.id);
        assert_eq!(actual.origin.node, declaration.node);
        assert_eq!(actual.origin.kind, IrModelRuleKind::Invariant);
        assert_eq!(actual.origin.registry_id, rule.id);
        assert_eq!(actual.origin.span, rule.span);
        assert_eq!(
            local_rule_fields(&ir, model, &rule.pred),
            None,
            "nongrant source classification cannot certify unsupported dependencies as empty"
        );
    }
    assert!(
        js::emit_program(&ir).model_policies.is_none(),
        "both owning source rules remain visible but unclaimed until complete native dependency binding"
    );
}

#[test]
fn owning_model_field_parent_type_source_and_rule_identity_mutations_refuse() {
    let (_, ir) = checked();
    let template = symbol(&ir, "Template");
    let revision = symbol(&ir, "Revision");
    let run = symbol(&ir, "Run");
    let current = symbol(&ir, "Template.current");
    let digest = symbol(&ir, "Revision.digest");
    for mutation in [
        "kind",
        "module",
        "source",
        "model-source",
        "field-source",
        "field-owner",
        "field-type",
        "field-name",
        "field-canonical",
        "parent",
        "digest-type",
    ] {
        let mut changed = ir.clone();
        let selected = if mutation == "digest-type" {
            revision
        } else {
            template
        };
        let index = rule_index(&changed, selected);
        match mutation {
            "kind" => {
                changed.invariants[index].origin.as_mut().unwrap().kind = IrModelRuleKind::Lock
            }
            "module" => {
                changed.invariants[index].origin.as_mut().unwrap().module = ModuleId(u32::MAX)
            }
            "source" => {
                changed.invariants[index].origin.as_mut().unwrap().node.file = SourceId(u32::MAX)
            }
            "model-source" => changed.items[template.0 as usize].span.file = SourceId(u32::MAX),
            "field-source" => changed.items[current.0 as usize].span.file = SourceId(u32::MAX),
            "field-canonical" => {
                changed.items[current.0 as usize].canonical = "Foreign.Template.current".into()
            }
            "field-name" => changed.items[current.0 as usize].name = "other".into(),
            "field-owner" => {
                let IrItemKind::Field { owner, .. } = &mut changed.items[current.0 as usize].kind
                else {
                    unreachable!()
                };
                *owner = run;
            }
            "field-type" => {
                let IrItemKind::Field { ty, .. } = &mut changed.items[current.0 as usize].kind
                else {
                    unreachable!()
                };
                *ty = IrType::Known(ResolvedType::Nullable(Box::new(ResolvedType::Record {
                    symbol: run,
                    stored: true,
                })));
            }
            "parent" => {
                let IrItemKind::Model { owner, .. } = &mut changed.items[revision.0 as usize].kind
                else {
                    unreachable!()
                };
                *owner = IrOwner::ChildOf(run);
            }
            "digest-type" => {
                let IrItemKind::Field { ty, .. } = &mut changed.items[digest.0 as usize].kind
                else {
                    unreachable!()
                };
                *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
            }
            _ => unreachable!(),
        }
        assert!(
            current_revision_rule_profile(&changed, &changed.invariants[index]).is_none(),
            "{mutation}"
        );
    }
    let rule = &ir.invariants[rule_index(&ir, template)];
    let mut detached = rule.clone();
    detached.origin.as_mut().unwrap().ordinal += 1;
    assert!(
        current_revision_rule_profile(&ir, &detached).is_none(),
        "detached changed source ordinal"
    );
}

#[test]
fn original_lazy_null_comparison_parent_equality_and_duration_shapes_are_not_generalized() {
    let (_, ir) = checked();
    let template = symbol(&ir, "Template");
    let revision = symbol(&ir, "Revision");
    for mutation in [
        "duration",
        "null-op",
        "lazy-or",
        "parent-field",
        "parent-type",
        "published-subject",
        "digest-null-op",
        "not-op",
    ] {
        let mut changed = ir.clone();
        let model = if matches!(mutation, "digest-null-op" | "not-op") {
            revision
        } else {
            template
        };
        let index = rule_index(&changed, model);
        let mut edits = 0;
        map_expression(&mut changed.invariants[index].pred, &mut |expr| match (
            &mut expr.expr,
            mutation,
        ) {
            (IrExpr::DurationMs(value), "duration") if *value == 900_000 => {
                *value = 900_001;
                edits += 1;
            }
            (IrExpr::Binary { op, right, .. }, "null-op")
                if *op == IrBinOp::Eq && matches!(right.expr, IrExpr::Null) =>
            {
                *op = IrBinOp::Ne;
                edits += 1;
            }
            (IrExpr::Binary { op, .. }, "lazy-or") if *op == IrBinOp::Or => {
                *op = IrBinOp::And;
                edits += 1;
            }
            (IrExpr::Member { field, .. }, "parent-field") if field == "parent" => {
                *field = "owner".into();
                edits += 1;
            }
            (IrExpr::Member { field, .. }, "parent-type") if field == "parent" => {
                expr.ty = ResolvedType::Record {
                    symbol: revision,
                    stored: true,
                };
                edits += 1;
            }
            (IrExpr::Member { base, field }, "published-subject") if field == "published" => {
                base.ty = ResolvedType::Record {
                    symbol: template,
                    stored: true,
                };
                edits += 1;
            }
            (IrExpr::Binary { op, right, .. }, "digest-null-op")
                if *op == IrBinOp::Ne && matches!(right.expr, IrExpr::Null) =>
            {
                *op = IrBinOp::Eq;
                edits += 1;
            }
            (IrExpr::Unary { op, .. }, "not-op") => {
                *op = IrUnOp::Neg;
                edits += 1;
            }
            _ => {}
        });
        assert_eq!(edits, 1, "one exact original occurrence for {mutation}");
        assert!(
            current_revision_rule_profile(&changed, &changed.invariants[index]).is_none(),
            "{mutation}"
        );
    }
}
