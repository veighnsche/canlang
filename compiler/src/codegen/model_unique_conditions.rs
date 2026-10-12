//! Original conditional unique declaration -> existing QueryPredicate facts.
//! These facts confer no native authority and do not change artifact uniqueKeys.
use super::ir::{self, IrBinOp, IrExpr, IrItemKind, IrProgram, IrType, IrUnOp, TypedExpr};
use crate::analysis::catalog::Catalog;
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::{CheckedProgram, ModuleId, NodeKey, ResolvedType, Scalar, SymbolId};
use crate::diagnostic::Severity;
use crate::source::SourceDb;
use serde_json::{Value, json};

/// One source-owned existing `uniques` entry and its exact `where` registry.
/// The defining consumer must verify the generated module and bind the State
/// uniqueWhen option; a copied fact is never a native policy certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedUniqueCondition {
    pub model: SymbolId,
    pub canonical_model: String,
    pub module: ModuleId,
    pub owner_package: String,
    pub fields: Vec<String>,
    pub field_symbols: Vec<SymbolId>,
    pub registry_id: String,
    pub ordinal: u32,
    pub node: NodeKey,
    pub fields_node: NodeKey,
    pub where_node: NodeKey,
    pub source: DisclosureSource,
    pub predicate: Value,
}

/// Only the released singular primitive conditional-unique profile is emitted.
/// No inferred unconditional key, invariant or composite-key transport exists.
pub fn collect_checked_unique_conditions(
    program: &CheckedProgram,
    actual: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<CheckedUniqueCondition>> {
    program.validate_cohort(db, catalog).ok()?;
    let (fresh, diagnostics) = ir::build(program, db, catalog);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
        || actual.items.len() != fresh.items.len()
        || actual.modules.len() != fresh.modules.len()
        || actual.catalog_version != fresh.catalog_version
    {
        return None;
    }
    for (actual, expected) in actual.modules.iter().zip(&fresh.modules) {
        if actual.id != expected.id
            || actual.name != expected.name
            || actual.kind != expected.kind
            || actual.file != expected.file
            || actual.span != expected.span
            || format!("{:?}", actual.imports) != format!("{:?}", expected.imports)
        {
            return None;
        }
    }
    // Whole original owning declarations include type/default/server/source and
    // preserve namespace collisions which determine existing registry spelling.
    for (actual, expected) in actual.items.iter().zip(&fresh.items) {
        if (matches!(
            actual.kind,
            IrItemKind::Model { .. } | IrItemKind::Field { .. }
        ) || matches!(
            expected.kind,
            IrItemKind::Model { .. } | IrItemKind::Field { .. }
        )) && format!("{actual:?}") != format!("{expected:?}")
        {
            return None;
        }
    }
    let mut result = Vec::new();
    for model in &actual.items {
        let IrItemKind::Model { uniques, .. } = &model.kind else {
            continue;
        };
        let declaration = program.effects.models.get(&model.id)?;
        if declaration.model != model.id
            || declaration.module != model.module
            || uniques.len() != declaration.uniques.len()
        {
            return None;
        }
        let module = actual.modules.get(model.module.0 as usize)?;
        let source = db.get(declaration.node.file)?;
        if module.id != model.module || module.file != declaration.node.file {
            return None;
        }
        for (index, (unique, declared)) in uniques.iter().zip(&declaration.uniques).enumerate() {
            if declared.module != model.module
                || unique.fields != declared.fields
                || unique.span.file != declared.node.file
                || unique.span.start != declared.node.start
                || unique.span.end != declared.node.end
            {
                return None;
            }
            let Some(where_node) = declared.where_predicate else {
                if unique.where_predicate.is_some() {
                    return None;
                }
                continue;
            };
            if declared.fields.len() != 1 || declared.fields[0].contains('.') {
                return None;
            }
            let value = unique.where_predicate.as_ref()?;
            let expected_model = fresh.items.get(model.id.0 as usize)?;
            let IrItemKind::Model {
                uniques: original_uniques,
                ..
            } = &expected_model.kind
            else {
                return None;
            };
            let original_value = original_uniques.get(index)?.where_predicate.as_ref()?;
            if format!("{value:?}") != format!("{original_value:?}") {
                return None;
            }
            let registry_id = format!(
                "{}.unique.{}",
                ir::ir_model_rule_prefix(actual, model),
                index + 1
            );
            let mut registry = actual
                .invariants
                .iter()
                .filter(|rule| rule.id == registry_id);
            let rule = registry.next()?;
            if registry.next().is_some()
                || rule.origin.is_some()
                || rule.span != unique.span
                || format!("{:?}", rule.pred) != format!("{original_value:?}")
            {
                return None;
            }
            let mut fresh_registry = fresh
                .invariants
                .iter()
                .filter(|rule| rule.id == registry_id);
            let original_rule = fresh_registry.next()?;
            if fresh_registry.next().is_some()
                || format!("{rule:?}") != format!("{original_rule:?}")
            {
                return None;
            }
            let constrained = field(actual, model.id, &declared.fields[0])?;
            let mut work = 0;
            let predicate = query_predicate(actual, model.id, value, 0, &mut work)?;
            result.push(CheckedUniqueCondition {
                model: model.id,
                canonical_model: model.canonical.clone(),
                module: model.module,
                owner_package: module.name.clone(),
                fields: declared.fields.clone(),
                field_symbols: vec![constrained],
                registry_id,
                ordinal: declared.id,
                node: declared.node,
                fields_node: declared.fields_node?,
                where_node,
                source: DisclosureSource {
                    path: source.path.clone(),
                    sha256: source.sha256.clone(),
                    module: module.name.clone(),
                },
                predicate,
            });
        }
    }
    // Effects ordinals retain true declaration order across model grouping.
    result.sort_by_key(|condition| condition.ordinal);
    Some(result)
}

fn field(ir: &IrProgram, model: SymbolId, name: &str) -> Option<SymbolId> {
    if matches!(
        name,
        "id" | "version"
            | "parent"
            | "created"
            | "updated"
            | "createdBy"
            | "updatedBy"
            | "archivedAt"
    ) {
        return None;
    }
    let owning = ir.items.get(model.0 as usize)?;
    let IrItemKind::Model { fields, .. } = &owning.kind else {
        return None;
    };
    let mut selected = fields.iter().filter_map(|id| {
        ir.items
            .get(id.0 as usize)
            .filter(|item| item.id == *id && item.name == name)
    });
    let selected = selected.next()?;
    if fields
        .iter()
        .filter(|id| {
            ir.items
                .get(id.0 as usize)
                .is_some_and(|item| item.name == name)
        })
        .count()
        != 1
        || selected.module != owning.module
        || selected.canonical != format!("{}.{}", owning.canonical, name)
        || !matches!(&selected.kind, IrItemKind::Field { owner, ty: IrType::Known(ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool)), required_array: false, .. } if *owner == model)
    {
        return None;
    }
    Some(selected.id)
}

fn member(ir: &IrProgram, model: SymbolId, value: &TypedExpr) -> Option<String> {
    let IrExpr::Member { base, field: name } = &value.expr else {
        return None;
    };
    if !matches!(&base.expr, IrExpr::Name(name) if name == "row")
        || base.ty
            != (ResolvedType::Record {
                symbol: model,
                stored: true,
            })
    {
        return None;
    }
    let symbol = field(ir, model, name)?;
    if !matches!(&ir.items.get(symbol.0 as usize)?.kind, IrItemKind::Field { ty: IrType::Known(ty), .. } if ty == &value.ty)
    {
        return None;
    }
    Some(name.clone())
}

fn query_predicate(
    ir: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    depth: usize,
    work: &mut usize,
) -> Option<Value> {
    *work += 1;
    if depth > 32 || *work > 128 || expr.ty != ResolvedType::Scalar(Scalar::Bool) {
        return None;
    }
    match &expr.expr {
        IrExpr::Member { .. } => {
            Some(json!({"op":"eq","field":member(ir, model, expr)?,"value":true}))
        }
        IrExpr::Binary {
            op: op @ (IrBinOp::And | IrBinOp::Or),
            left,
            right,
        } => Some(json!({
            "op":if *op == IrBinOp::And { "and" } else { "or" },
            "args":[query_predicate(ir,model,left,depth+1,work)?,query_predicate(ir,model,right,depth+1,work)?]
        })),
        IrExpr::Unary {
            op: IrUnOp::Not,
            operand,
        } => Some(json!({"op":"not","arg":query_predicate(ir,model,operand,depth+1,work)?})),
        IrExpr::Binary {
            op: op @ (IrBinOp::Eq | IrBinOp::Ne),
            left,
            right,
        } => {
            let name = member(ir, model, left)?;
            if left.ty != right.ty {
                return None;
            }
            let value = match (&right.expr, &right.ty) {
                (IrExpr::Bool(value), ResolvedType::Scalar(Scalar::Bool)) => json!(value),
                (IrExpr::Text(value), ResolvedType::Scalar(Scalar::Text)) => json!(value),
                // Stored Can int wire is canonical decimal text. Only equality
                // is admitted, so State's existing scalar comparison agrees.
                (IrExpr::Int(value), ResolvedType::Scalar(Scalar::Int)) => json!(value.to_string()),
                _ => return None,
            };
            Some(json!({"op":if *op == IrBinOp::Eq {"eq"} else {"ne"},"field":name,"value":value}))
        }
        _ => None,
    }
}
