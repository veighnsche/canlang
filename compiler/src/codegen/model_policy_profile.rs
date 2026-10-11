//! Conservative stored-field dependencies for the first native local-rule scope.
use super::ir::{IrBinOp, IrExpr, IrItemKind, IrProgram, IrStmt, IrType, IrUnOp, TypedExpr};
use crate::analysis::{
    resolve::{CrudOp, ModuleId, SymbolId},
    types::{ResolvedType, Scalar},
};
use std::collections::{HashMap, HashSet};

/// A separate, bounded native candidate/staging profile. Classification neither
/// supplies a runtime context nor authorizes owner activation.
pub fn local_hook_supported(program: &IrProgram, scenario: SymbolId) -> bool {
    let Some(item) = program
        .items
        .get(scenario.0 as usize)
        .filter(|item| item.id == scenario)
    else {
        return false;
    };
    let IrItemKind::Scenario {
        hook: Some(hook),
        params,
        cohort,
        by,
        guards,
        effects,
        ..
    } = &item.kind
    else {
        return false;
    };
    if !matches!(hook.op, CrudOp::Create | CrudOp::Update)
        || !params.is_empty()
        || cohort.is_some()
        || !by.is_empty()
    {
        return false;
    }
    let mut profile = HookProfile {
        program,
        model: hook.model,
        op: hook.op,
        module: item.module,
        remaining: 4096,
    };
    if !profile.model_supported(hook.model) {
        return false;
    }
    let mut locals = HashMap::new();
    profile.statements(guards, &mut locals, 0).is_some()
        && profile.statements(effects, &mut locals, 0).is_some()
}

struct HookProfile<'a> {
    program: &'a IrProgram,
    model: SymbolId,
    op: CrudOp,
    module: ModuleId,
    remaining: usize,
}

impl HookProfile<'_> {
    fn step(&mut self, depth: usize) -> Option<()> {
        if depth > 64 || self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        Some(())
    }

    fn leaf(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool | Scalar::User | Scalar::Datetime | Scalar::Email | Scalar::Timezone) => true,
            ResolvedType::Nullable(inner) => self.leaf(inner),
            ResolvedType::Enum { cases, owner: Some(owner) } => {
                !cases.is_empty() && self.program.items.get(owner.0 as usize).is_some_and(|item| {
                    item.id == *owner && item.module == self.module
                        && matches!(&item.kind, IrItemKind::Field { ty: IrType::Known(field_ty), .. } if field_ty == ty)
                })
            }
            _ => false,
        }
    }

    fn model_supported(&self, model: SymbolId) -> bool {
        self.program.items.get(model.0 as usize).is_some_and(|item| {
            item.id == model && item.module == self.module
                && matches!(&item.kind, IrItemKind::Model { fields, .. } if fields.iter().all(|id| {
                    self.program.items.get(id.0 as usize).is_some_and(|field| {
                        field.id == *id && field.module == self.module
                            && matches!(&field.kind, IrItemKind::Field { owner, ty: IrType::Known(ty), .. } if *owner == model && self.leaf(ty))
                    })
                }))
        })
    }

    fn field(&self, model: SymbolId, name: &str, writable: bool) -> Option<&ResolvedType> {
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
        let IrItemKind::Model { fields, .. } = &self.program.items.get(model.0 as usize)?.kind
        else {
            return None;
        };
        let mut matches = fields.iter().filter_map(|id| {
            self.program
                .items
                .get(id.0 as usize)
                .filter(|item| item.id == *id && item.name == name && item.module == self.module)
        });
        let field = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        let IrItemKind::Field {
            owner,
            ty: IrType::Known(ty),
            server,
            modifiers,
            ..
        } = &field.kind
        else {
            return None;
        };
        (*owner == model
            && self.leaf(ty)
            && (!writable || (server.is_none() && !modifiers.machine)))
            .then_some(ty)
    }

    fn after(expr: &TypedExpr) -> bool {
        matches!(&expr.expr, IrExpr::Member { base, field }
            if field == "after" && base.ty == ResolvedType::Unknown
                && matches!(&base.expr, IrExpr::Name(name) if name == "event"))
    }

    fn before(&self, expr: &TypedExpr) -> bool {
        // Only update has a nonnull, immutable owning snapshot. Create's null
        // side and every delete profile retain their existing refusals.
        self.op == CrudOp::Update
            && matches!(&expr.expr, IrExpr::Member { base, field }
                if field == "before" && base.ty == ResolvedType::Unknown
                    && matches!(&base.expr, IrExpr::Name(name) if name == "event"))
    }

    fn context(expr: &TypedExpr) -> bool {
        let IrExpr::Member { base, field } = &expr.expr else {
            return false;
        };
        if matches!(&base.expr, IrExpr::Name(name) if name == "c")
            && base.ty == ResolvedType::Unknown
        {
            return match field.as_str() {
                "actor" => {
                    expr.ty == ResolvedType::Scalar(Scalar::User)
                        || expr.ty
                            == ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::User)))
                }
                "now" => expr.ty == ResolvedType::Scalar(Scalar::Datetime),
                _ => false,
            };
        }
        let IrExpr::Member {
            base: root,
            field: context,
        } = &base.expr
        else {
            return false;
        };
        if !matches!(&root.expr, IrExpr::Name(name) if name == "c")
            || root.ty != ResolvedType::Unknown
        {
            return false;
        }
        match (context.as_str(), field.as_str()) {
            ("team", "id") => {
                base.ty == ResolvedType::Team && expr.ty == ResolvedType::Scalar(Scalar::Text)
            }
            ("team", "timezone") => {
                base.ty == ResolvedType::Team && expr.ty == ResolvedType::Scalar(Scalar::Timezone)
            }
            ("operation", "id" | "source") => {
                base.ty == ResolvedType::OperationContext
                    && expr.ty == ResolvedType::Scalar(Scalar::Text)
            }
            ("actorFacts", "email") => {
                base.ty == ResolvedType::Unknown && expr.ty == ResolvedType::Scalar(Scalar::Email)
            }
            ("actorFacts", "email_verified") => {
                base.ty == ResolvedType::Unknown && expr.ty == ResolvedType::Scalar(Scalar::Bool)
            }
            _ => false,
        }
    }

    fn expr(
        &mut self,
        expr: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
        depth: usize,
    ) -> Option<()> {
        self.step(depth)?;
        if Self::context(expr) {
            return Some(());
        }
        match &expr.expr {
            IrExpr::Int(_) if expr.ty == ResolvedType::Scalar(Scalar::Int) => Some(()),
            IrExpr::Bool(_) if expr.ty == ResolvedType::Scalar(Scalar::Bool) => Some(()),
            IrExpr::Datetime(_) if expr.ty == ResolvedType::Scalar(Scalar::Datetime) => Some(()),
            IrExpr::Null if expr.ty == ResolvedType::Null => Some(()),
            IrExpr::Text(value)
                if expr.ty == ResolvedType::Scalar(Scalar::Text)
                    || matches!(&expr.ty, ResolvedType::Enum { cases, .. } if self.leaf(&expr.ty) && cases.contains(value)) =>
            {
                Some(())
            }
            IrExpr::Name(name) if locals.get(name) == Some(&expr.ty) => Some(()),
            IrExpr::Name(name) if matches!(&expr.ty, ResolvedType::Enum { cases, .. } if self.leaf(&expr.ty) && cases.contains(name)) => {
                Some(())
            }
            IrExpr::Member { base, field } if Self::after(base) || self.before(base) => {
                // Flattened IR may leave an intermediate wrapper untyped; only
                // this exact owning candidate/update-before path and its checked
                // business leaf qualify. Nullable/foreign snapshot shells refuse.
                if base.ty != ResolvedType::Unknown
                    && base.ty
                        != (ResolvedType::Record {
                            symbol: self.model,
                            stored: true,
                        })
                {
                    return None;
                }
                // Reserved identity/version are readonly views of this exact
                // trigger model. Mutation inputs still use field(..., true),
                // which refuses every metadata name.
                match field.as_str() {
                    "id" => return (expr.ty == ResolvedType::Scalar(Scalar::Text)).then_some(()),
                    "version" => {
                        return (expr.ty == ResolvedType::Scalar(Scalar::Int)).then_some(());
                    }
                    _ => {}
                }
                (self.field(self.model, field, false)? == &expr.ty).then_some(())
            }
            IrExpr::Binary { op, left, right } => {
                let bool_ty = ResolvedType::Scalar(Scalar::Bool);
                let int_ty = ResolvedType::Scalar(Scalar::Int);
                let null_test = (left.ty == ResolvedType::Null
                    && right.ty.nullable_inner().is_some())
                    || (right.ty == ResolvedType::Null && left.ty.nullable_inner().is_some());
                let allowed = match op {
                    IrBinOp::Eq | IrBinOp::Ne => {
                        expr.ty == bool_ty
                            && (null_test
                                || (left.ty == right.ty
                                    && matches!(
                                        &left.ty,
                                        ResolvedType::Scalar(
                                            Scalar::Text | Scalar::Int | Scalar::Bool
                                        ) | ResolvedType::Enum { .. }
                                    )
                                    && self.leaf(&left.ty)))
                    }
                    IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge => {
                        expr.ty == bool_ty && left.ty == int_ty && right.ty == int_ty
                    }
                    IrBinOp::And | IrBinOp::Or => {
                        expr.ty == bool_ty && left.ty == bool_ty && right.ty == bool_ty
                    }
                    IrBinOp::Add | IrBinOp::Sub | IrBinOp::Mul => {
                        expr.ty == int_ty && left.ty == int_ty && right.ty == int_ty
                    }
                    _ => false,
                };
                if !allowed {
                    return None;
                }
                self.expr(left, locals, depth + 1)?;
                self.expr(right, locals, depth + 1)
            }
            IrExpr::Unary { op, operand }
                if (matches!(op, IrUnOp::Not) && expr.ty == ResolvedType::Scalar(Scalar::Bool))
                    || (matches!(op, IrUnOp::Neg)
                        && expr.ty == ResolvedType::Scalar(Scalar::Int)) =>
            {
                if operand.ty != expr.ty {
                    return None;
                }
                self.expr(operand, locals, depth + 1)
            }
            _ => None,
        }
    }

    fn input(
        &mut self,
        model: SymbolId,
        input: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
        depth: usize,
    ) -> Option<()> {
        let IrExpr::Object(entries) = &input.expr else {
            return None;
        };
        let mut names = HashSet::new();
        for (name, value) in entries {
            if !names.insert(name) {
                return None;
            }
            let ty = self.field(model, name, true)?;
            if ty != &value.ty && !(value.ty == ResolvedType::Null && ty.nullable_inner().is_some())
            {
                return None;
            }
            self.expr(value, locals, depth + 1)?;
        }
        // Only supplied fields are inspected. Owning State resolves omissions,
        // including server actor/now fields and declared creation defaults.
        Some(())
    }

    fn statements(
        &mut self,
        statements: &[IrStmt],
        locals: &mut HashMap<String, ResolvedType>,
        depth: usize,
    ) -> Option<()> {
        for statement in statements {
            self.step(depth)?;
            match statement {
                IrStmt::Let { name, value, .. } => {
                    self.expr(value, locals, depth + 1)?;
                    if !self.leaf(&value.ty) && !Self::context(value) {
                        return None;
                    }
                    locals.insert(name.clone(), value.ty.clone());
                }
                IrStmt::Require { cond, .. } => {
                    if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
                        return None;
                    }
                    self.expr(cond, locals, depth + 1)?;
                }
                IrStmt::Set {
                    record, changes, ..
                } => {
                    if !Self::after(record)
                        || (record.ty != ResolvedType::Unknown
                            && record.ty
                                != (ResolvedType::Record {
                                    symbol: self.model,
                                    stored: true,
                                }))
                    {
                        return None;
                    }
                    // decode_record_path preserves this contextual target as
                    // Unknown. The exact synthetic event.after path above and
                    // this checked hook's trigger establish its model; every
                    // supplied writable field is validated against that model.
                    self.input(self.model, changes, locals, depth + 1)?;
                }
                IrStmt::Create { model, input, .. } => {
                    let mut targets = self.program.items.iter().filter(|item| {
                        item.canonical == *model && matches!(item.kind, IrItemKind::Model { .. })
                    });
                    let target = targets.next()?;
                    if targets.next().is_some()
                        || target.id == self.model
                        || !self.model_supported(target.id)
                    {
                        return None;
                    }
                    self.input(target.id, input, locals, depth + 1)?;
                }
                IrStmt::If {
                    cond,
                    then_branch,
                    else_branch,
                    ..
                } => {
                    if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
                        return None;
                    }
                    self.expr(cond, locals, depth + 1)?;
                    self.statements(then_branch, &mut locals.clone(), depth + 1)?;
                    self.statements(else_branch, &mut locals.clone(), depth + 1)?;
                }
                _ => return None,
            }
        }
        Some(())
    }
}

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
    // A lock compares the owning stored value; it does not read a User in
    // a predicate or acquire invocation/identity authority.
    if ty == &ResolvedType::Scalar(Scalar::User) {
        return true;
    }
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
