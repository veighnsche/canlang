//! Conservative stored-field dependencies for the first native local-rule scope.
use super::ir::{IrExpr, IrItemKind, IrProgram, IrType, TypedExpr};
use crate::analysis::{
    resolve::SymbolId,
    types::{ResolvedType, Scalar},
};

/// Return first-observed owning stored fields, or refuse the entire predicate.
/// This classification does not authorize or activate native execution.
pub fn local_rule_fields(
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
) -> Option<Vec<SymbolId>> {
    let item = program.items.get(model.0 as usize)?;
    if item.id != model
        || !matches!(item.kind, IrItemKind::Model { .. })
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    let mut fields = Vec::new();
    visit(program, model, predicate, &mut fields)?;
    Some(fields)
}

fn local_type(program: &IrProgram, model: SymbolId, ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool) => true,
        ResolvedType::Enum { cases, owner: Some(owner) } => {
            !cases.is_empty() && program.items.get(owner.0 as usize).is_some_and(|field| {
                field.id == *owner && matches!(&field.kind, IrItemKind::Field { owner, ty: IrType::Known(field_type), .. } if *owner == model && field_type == ty)
            })
        }
        ResolvedType::Array { element, .. } => local_type(program, model, element),
        _ => false,
    }
}

/// The first native stored-field profile also bounds protected lock targets.
pub(crate) fn local_stored_field_type(
    program: &IrProgram,
    model: SymbolId,
    ty: &ResolvedType,
) -> bool {
    matches!(
        ty,
        ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool) | ResolvedType::Enum { .. }
    ) && local_type(program, model, ty)
}

fn visit(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    fields: &mut Vec<SymbolId>,
) -> Option<()> {
    if !local_type(program, model, &expr.ty) {
        return None;
    }
    match &expr.expr {
        IrExpr::Int(_) if expr.ty == ResolvedType::Scalar(Scalar::Int) => Some(()),
        IrExpr::Bool(_) if expr.ty == ResolvedType::Scalar(Scalar::Bool) => Some(()),
        IrExpr::Text(value) => match &expr.ty {
            ResolvedType::Scalar(Scalar::Text) => Some(()),
            ResolvedType::Enum { cases, .. } if cases.contains(value) => Some(()),
            _ => None,
        },
        IrExpr::Name(value) => match &expr.ty {
            ResolvedType::Enum { cases, .. } if cases.contains(value) => Some(()),
            _ => None,
        },
        IrExpr::Member { base, field } => {
            if !matches!(&base.expr, IrExpr::Name(name) if name == "row")
                || base.ty
                    != (ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    })
            {
                return None;
            }
            let IrItemKind::Model {
                fields: declared, ..
            } = &program.items.get(model.0 as usize)?.kind
            else {
                return None;
            };
            let mut matching = declared.iter().filter_map(|id| {
                program
                    .items
                    .get(id.0 as usize)
                    .filter(|item| item.id == *id && item.name == *field)
            });
            let item = matching.next()?;
            if matching.next().is_some() {
                return None;
            }
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(ty),
                ..
            } = &item.kind
            else {
                return None;
            };
            if *owner != model
                || *ty != expr.ty
                || !matches!(
                    ty,
                    ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool)
                        | ResolvedType::Enum { .. }
                )
            {
                return None;
            }
            if !fields.contains(&item.id) {
                fields.push(item.id);
            }
            Some(())
        }
        IrExpr::Binary { left, right, .. } => {
            visit(program, model, left, fields)?;
            visit(program, model, right, fields)
        }
        IrExpr::Unary { operand, .. } => visit(program, model, operand, fields),
        IrExpr::Array(items) => {
            for item in items {
                visit(program, model, item, fields)?;
            }
            Some(())
        }
        _ => None,
    }
}
