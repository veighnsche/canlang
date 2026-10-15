//! Conservative stored-field dependencies for the first native local-rule scope.
use super::ir::{
    IrBinOp, IrExpr, IrItemKind, IrModelRuleKind, IrModelRuleOrigin, IrOwner, IrProgram, IrRuleFn,
    IrStmt, IrType, IrUnOp, TypedExpr,
};
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
    visit(program, model, predicate, &mut fields, false)?;
    Some(fields)
}

/// Nongrant classification for required owning paths. Native activation still
/// requires the complete source/fresh declaration and predicate correspondence.
/// Nullable references, collections, aliases and computed receivers stay out.
pub(crate) fn required_model_rule_path(
    program: &IrProgram,
    model: SymbolId,
    value: &TypedExpr,
) -> Option<Vec<SymbolId>> {
    fn path(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
        depth: usize,
    ) -> Option<()> {
        if depth > 16 {
            return None;
        }
        if matches!(value.expr, IrExpr::Name(_)) {
            return policy_row(value, model);
        }
        let IrExpr::Member { base, field } = &value.expr else {
            return None;
        };
        if !contains_span(value.span, base.span) {
            return None;
        }
        path(program, model, base, fields, depth + 1)?;
        match &base.ty {
            ResolvedType::Record {
                symbol,
                stored: true,
            } => {
                let target = policy_model(program, *symbol)?;
                if field == "parent" {
                    let IrItemKind::Model {
                        owner: IrOwner::ChildOf(parent),
                        ..
                    } = target.kind
                    else {
                        return None;
                    };
                    policy_model(program, parent)?;
                    return (value.ty
                        == ResolvedType::Record {
                            symbol: parent,
                            stored: true,
                        })
                    .then_some(());
                }
                if !matches!(
                    &value.ty,
                    ResolvedType::Record { stored: true, .. }
                        | ResolvedType::Scalar(Scalar::Money | Scalar::Currency)
                ) {
                    return None;
                }
                let id = policy_field(program, *symbol, field, &value.ty)?;
                if let ResolvedType::Record { symbol, .. } = value.ty {
                    policy_model(program, symbol)?;
                }
                if !fields.contains(&id) {
                    fields.push(id);
                }
                Some(())
            }
            ResolvedType::Scalar(Scalar::Money) => match (field.as_str(), &value.ty) {
                ("minor", ResolvedType::Scalar(Scalar::Int))
                | ("currency", ResolvedType::Scalar(Scalar::Currency)) => Some(()),
                _ => None,
            },
            _ => None,
        }
    }
    let mut fields = Vec::new();
    path(program, model, value, &mut fields, 0)?;
    Some(fields)
}

/// The bounded invariant extension composes identity/currency comparisons and
/// Money minor bounds through the existing lazy bool tree. It adds no general
/// Record arithmetic, nullable traversal, calls or collection operations.
pub(crate) fn required_model_rule_fields(
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
) -> Option<Vec<SymbolId>> {
    if local_rule_fields(program, model, predicate).is_some() {
        return None;
    }
    fn visit(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
        depth: usize,
    ) -> Option<()> {
        if depth > 64 || value.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        if let Some(local) = local_rule_fields(program, model, value) {
            for id in local {
                if !fields.contains(&id) {
                    fields.push(id);
                }
            }
            return Some(());
        }
        let IrExpr::Binary { op, left, right } = &value.expr else {
            return None;
        };
        policy_binary(value, *op)?;
        if matches!(op, IrBinOp::And | IrBinOp::Or) {
            visit(program, model, left, fields, depth + 1)?;
            return visit(program, model, right, fields, depth + 1);
        }
        if left.ty != right.ty {
            return None;
        }
        let path_pair = matches!(op, IrBinOp::Eq | IrBinOp::Ne)
            && matches!(
                &left.ty,
                ResolvedType::Record { stored: true, .. } | ResolvedType::Scalar(Scalar::Currency)
            );
        let minor_bound = matches!(op, IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge)
            && left.ty == ResolvedType::Scalar(Scalar::Int);
        if !path_pair && !minor_bound {
            return None;
        }
        let mut paths = 0;
        for operand in [left, right] {
            if minor_bound && matches!(operand.expr, IrExpr::Int(_)) {
                continue;
            }
            let path = required_model_rule_path(program, model, operand)?;
            if path.is_empty() {
                return None;
            }
            paths += 1;
            for id in path {
                if !fields.contains(&id) {
                    fields.push(id);
                }
            }
        }
        (paths > 0).then_some(())
    }
    let mut fields = Vec::new();
    visit(program, model, predicate, &mut fields, 0)?;
    Some(fields)
}

/// Existing dependency bindings consume declaration-derived reverse edges.
/// Each edge is (owning Model, actual stored field or implicit parent, target).
pub(crate) type RequiredModelRuleDependency = (SymbolId, Vec<(SymbolId, String, SymbolId)>);

pub(crate) fn required_model_rule_dependencies(
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
) -> Option<Vec<RequiredModelRuleDependency>> {
    fn edges(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        depth: usize,
    ) -> Option<Vec<(SymbolId, String, SymbolId)>> {
        if depth > 16 {
            return None;
        }
        if matches!(value.expr, IrExpr::Name(_)) {
            policy_row(value, model)?;
            return Some(Vec::new());
        }
        let IrExpr::Member { base, field } = &value.expr else {
            return None;
        };
        let ResolvedType::Record {
            symbol: source,
            stored: true,
        } = base.ty
        else {
            return None;
        };
        let ResolvedType::Record {
            symbol: target,
            stored: true,
        } = value.ty
        else {
            return None;
        };
        required_model_rule_path(program, model, value)?;
        let mut path = edges(program, model, base, depth + 1)?;
        path.push((source, field.clone(), target));
        Some(path)
    }
    fn visit(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        dependencies: &mut Vec<RequiredModelRuleDependency>,
        depth: usize,
    ) -> Option<()> {
        if depth > 64 || dependencies.len() > 200 {
            return None;
        }
        match &value.expr {
            IrExpr::Member { base, .. } => {
                visit(program, model, base, dependencies, depth + 1)?;
                if let ResolvedType::Record {
                    symbol,
                    stored: true,
                } = base.ty
                {
                    let path = edges(program, model, base, 0)?;
                    if !path.is_empty()
                        && !dependencies
                            .iter()
                            .any(|(target, original)| *target == symbol && *original == path)
                    {
                        dependencies.push((symbol, path));
                    }
                }
            }
            IrExpr::Binary { left, right, .. } => {
                visit(program, model, left, dependencies, depth + 1)?;
                visit(program, model, right, dependencies, depth + 1)?;
            }
            IrExpr::Unary { operand, .. } => {
                visit(program, model, operand, dependencies, depth + 1)?
            }
            _ => {}
        }
        Some(())
    }
    required_model_rule_fields(program, model, predicate)?;
    let mut dependencies = Vec::new();
    visit(program, model, predicate, &mut dependencies, 0)?;
    Some(dependencies)
}

/// The two original current-Revision rules, classified without publishing a
/// policy descriptor. In particular, Template's referenced Revision requires
/// an original/fresh source join and an owning reverse affected-row selector;
/// it must never enter `local_rule_fields` with an empty dependency certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentRevisionRuleProfile {
    pub origin: IrModelRuleOrigin,
    pub kind: CurrentRevisionRuleKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurrentRevisionRuleKind {
    Template {
        duration: SymbolId,
        current: SymbolId,
        revision: SymbolId,
        published: SymbolId,
    },
    Revision {
        duration: SymbolId,
        published: SymbolId,
        digest: SymbolId,
    },
}

/// Additional lock targets only for the source-sealed original Revision rule.
/// This helper alone never authorizes a descriptor or a structural value type.
pub(crate) fn current_revision_lock_target(
    program: &IrProgram,
    profile: &CurrentRevisionRuleProfile,
    field: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> bool {
    let CurrentRevisionRuleKind::Revision { digest, .. } = profile.kind else {
        return false;
    };
    if policy_field(program, profile.origin.model, name, ty) != Some(field) {
        return false;
    }
    match (name, ty) {
        ("digest", ResolvedType::Nullable(inner)) => {
            field == digest && inner.as_ref() == &ResolvedType::Scalar(Scalar::Text)
        }
        ("definition", _) => {
            crate::analysis::types::checked_standard_nominal_name(ty) == Some("WorkflowDefinition")
        }
        ("validation", ResolvedType::Nullable(inner)) => {
            matches!(inner.as_ref(), ResolvedType::StdDelivery { capability: "std.ImagesV1", op }
            if crate::analysis::catalog::std_operation("std.ImagesV1", "validate") == Some(*op))
        }
        _ => false,
    }
}

/// Preserve the actual typed lazy tree and owning identities of the original
/// Template/Revision invariants. This is a nongrant classifier over checked IR,
/// not a source seal, executable policy binding, or native activation claim.
pub fn current_revision_rule_profile(
    program: &IrProgram,
    rule: &IrRuleFn,
) -> Option<CurrentRevisionRuleProfile> {
    let origin = rule.origin.as_ref()?;
    let model = policy_model(program, origin.model)?;
    let IrItemKind::Model { invariants, .. } = &model.kind else {
        return None;
    };
    if origin.kind != IrModelRuleKind::Invariant
        || origin.module != model.module
        || origin.registry_id != rule.id
        || origin.span != rule.span
        || origin.node.file != rule.span.file
        || origin.node.start != rule.span.start
        || origin.node.end != rule.span.end
        || origin.node.kind != crate::syntax::SyntaxKind::Invariant as u8
        || !invariants.contains(&rule.id)
        || rule.span.file != model.span.file
        || !contains_span(rule.span, rule.pred.span)
        || program
            .invariants
            .iter()
            .filter(|candidate| {
                candidate.id == rule.id
                    && candidate
                        .origin
                        .as_ref()
                        .is_some_and(|value| value.model == model.id)
            })
            .count()
            != 1
        || !program
            .invariants
            .iter()
            .any(|candidate| std::ptr::eq(candidate, rule))
    {
        return None;
    }
    let (bounds, relation) = policy_binary(&rule.pred, IrBinOp::And)?;
    let duration = original_duration_bounds(program, model.id, bounds)?;
    let kind = match model.name.as_str() {
        "Template" => {
            let (absent, present) = policy_binary(relation, IrBinOp::Or)?;
            let (presence, null) = policy_binary(absent, IrBinOp::Eq)?;
            if !matches!(null.expr, IrExpr::Null) || null.ty != ResolvedType::Null {
                return None;
            }
            let IrExpr::Member { field, .. } = &presence.expr else {
                return None;
            };
            if field != "current" {
                return None;
            }
            let ResolvedType::Nullable(inner) = &presence.ty else {
                return None;
            };
            let ResolvedType::Record {
                symbol: revision,
                stored: true,
            } = inner.as_ref()
            else {
                return None;
            };
            let revision_model = policy_model(program, *revision)?;
            if revision_model.name != "Revision"
                || revision_model.module != model.module
                || !matches!(revision_model.kind, IrItemKind::Model { owner: IrOwner::ChildOf(parent), .. } if parent == model.id)
            {
                return None;
            }
            let current = policy_field(program, model.id, "current", &presence.ty)?;
            policy_row_member(presence, model.id, "current", &presence.ty)?;
            let (same_parent, published_read) = policy_binary(present, IrBinOp::And)?;
            let (parent, owning_row) = policy_binary(same_parent, IrBinOp::Eq)?;
            policy_row(owning_row, model.id)?;
            let IrExpr::Member {
                base: selected,
                field,
            } = &parent.expr
            else {
                return None;
            };
            if field != "parent" || parent.ty != owning_row.ty {
                return None;
            }
            // The owning checker retains the nullable declaration type on
            // these two original getter occurrences. The exact OR false arm
            // permits required parent/published results; do not invent a
            // different receiver type or admit general nullable traversal.
            policy_row_member(selected, model.id, "current", &presence.ty)?;
            let published = policy_field(
                program,
                *revision,
                "published",
                &ResolvedType::Scalar(Scalar::Bool),
            )?;
            let IrExpr::Member {
                base: selected,
                field,
            } = &published_read.expr
            else {
                return None;
            };
            if field != "published" || published_read.ty != ResolvedType::Scalar(Scalar::Bool) {
                return None;
            }
            policy_row_member(selected, model.id, "current", &presence.ty)?;
            CurrentRevisionRuleKind::Template {
                duration,
                current,
                revision: *revision,
                published,
            }
        }
        "Revision" => {
            let IrItemKind::Model {
                owner: IrOwner::ChildOf(template),
                ..
            } = &model.kind
            else {
                return None;
            };
            let parent = policy_model(program, *template)?;
            if parent.name != "Template" || parent.module != model.module {
                return None;
            }
            let (unpublished, nonnull_digest) = policy_binary(relation, IrBinOp::Or)?;
            let IrExpr::Unary {
                op: IrUnOp::Not,
                operand,
            } = &unpublished.expr
            else {
                return None;
            };
            if unpublished.ty != ResolvedType::Scalar(Scalar::Bool)
                || !contains_span(unpublished.span, operand.span)
            {
                return None;
            }
            let bool_ty = ResolvedType::Scalar(Scalar::Bool);
            let published = policy_field(program, model.id, "published", &bool_ty)?;
            policy_row_member(operand, model.id, "published", &bool_ty)?;
            let (digest_read, null) = policy_binary(nonnull_digest, IrBinOp::Ne)?;
            if !matches!(null.expr, IrExpr::Null) || null.ty != ResolvedType::Null {
                return None;
            }
            let text_ty = ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text)));
            let digest = policy_field(program, model.id, "digest", &text_ty)?;
            policy_row_member(digest_read, model.id, "digest", &text_ty)?;
            CurrentRevisionRuleKind::Revision {
                duration,
                published,
                digest,
            }
        }
        _ => return None,
    };
    Some(CurrentRevisionRuleProfile {
        origin: origin.clone(),
        kind,
    })
}

/// Exact additional original Chat invariants. This is consumed only after the
/// complete owning source/model/field/rule tables match a fresh checked build.
/// Nullable arithmetic and borrowed catalog enums do not enter the raw local
/// predicate classifier through this helper.
pub(crate) fn checked_chat_invariant_fields(
    program: &IrProgram,
    rule: &IrRuleFn,
) -> Option<Vec<SymbolId>> {
    let origin = rule.origin.as_ref()?;
    let model = policy_model(program, origin.model)?;
    let IrItemKind::Model { invariants, .. } = &model.kind else {
        return None;
    };
    if origin.kind != IrModelRuleKind::Invariant
        || origin.module != model.module
        || origin.registry_id != rule.id
        || origin.span != rule.span
        || origin.node.file != rule.span.file
        || origin.node.start != rule.span.start
        || origin.node.end != rule.span.end
        || origin.node.kind != crate::syntax::SyntaxKind::Invariant as u8
        || !invariants.contains(&rule.id)
        || rule.span.file != model.span.file
        || !contains_span(rule.span, rule.pred.span)
        || program
            .invariants
            .iter()
            .filter(|candidate| {
                candidate.id == rule.id
                    && candidate
                        .origin
                        .as_ref()
                        .is_some_and(|value| value.model == model.id)
            })
            .count()
            != 1
        || !program
            .invariants
            .iter()
            .any(|candidate| std::ptr::eq(candidate, rule))
    {
        return None;
    }
    match model.name.as_str() {
        "Turn" => {
            let (read, allowed) = policy_binary(&rule.pred, IrBinOp::In)?;
            if !chat_role_type(&read.ty) {
                return None;
            }
            let role = policy_field(program, model.id, "role", &read.ty)?;
            policy_row_member(read, model.id, "role", &read.ty)?;
            let IrExpr::Array(items) = &allowed.expr else {
                return None;
            };
            if !matches!(&allowed.ty, ResolvedType::Array { element, ordered: true, nonempty: true }
                if element.as_ref() == &read.ty)
                || items.len() != 2
            {
                return None;
            }
            for (item, name) in items.iter().zip(["user", "assistant"]) {
                if item.ty != read.ty
                    || !contains_span(allowed.span, item.span)
                    || !matches!(&item.expr, IrExpr::Text(value) if value == name)
                {
                    return None;
                }
            }
            if items[0].span.end > items[1].span.start {
                return None;
            }
            Some(vec![role])
        }
        "Run" => {
            let (absent, within_reservation) = policy_binary(&rule.pred, IrBinOp::Or)?;
            let (nullable_read, null) = policy_binary(absent, IrBinOp::Eq)?;
            let nullable_int = ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Int)));
            let int = ResolvedType::Scalar(Scalar::Int);
            let used = policy_field(program, model.id, "used", &nullable_int)?;
            let reserved = policy_field(program, model.id, "reserved", &int)?;
            policy_row_member(nullable_read, model.id, "used", &nullable_int)?;
            if null.ty != ResolvedType::Null || !matches!(null.expr, IrExpr::Null) {
                return None;
            }
            let (present_read, limit) = policy_binary(within_reservation, IrBinOp::Le)?;
            // The checker narrows this exact second occurrence only in the
            // false arm of the original owning used==null expression.
            policy_row_member(present_read, model.id, "used", &int)?;
            policy_row_member(limit, model.id, "reserved", &int)?;
            Some(vec![used, reserved])
        }
        _ => None,
    }
}

fn chat_role_type(ty: &ResolvedType) -> bool {
    crate::analysis::catalog::nominal_schema("TextMessage")
        .and_then(|schema| schema.fields.iter().find(|(name, _)| *name == "role"))
        .and_then(|(_, declared)| crate::analysis::types::std_schema_type(declared))
        .as_ref()
        == Some(ty)
}

fn chat_model_reference(
    program: &IrProgram,
    owner: SymbolId,
    ty: &ResolvedType,
    target_name: &str,
) -> bool {
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = ty
    else {
        return false;
    };
    let Some(owner) = policy_model(program, owner) else {
        return false;
    };
    let Some(target) = policy_model(program, *symbol) else {
        return false;
    };
    target.module == owner.module && target.name == target_name
}

/// A lock compares the original StoredRow.data value in State; it does not
/// execute equality over decoded references, Files, nominal objects or receipts.
/// These additional owning fields qualify only under the complete source seal,
/// never through local_stored_field_type or a generic structural value fallback.
pub(crate) fn checked_chat_lock_target(
    program: &IrProgram,
    model: SymbolId,
    field: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> bool {
    let Some(owner) = policy_model(program, model) else {
        return false;
    };
    if policy_field(program, model, name, ty) != Some(field) {
        return false;
    }
    match (owner.name.as_str(), name, ty) {
        ("Branch", "profile", _) => chat_model_reference(program, model, ty, "Profile"),
        (
            "Branch",
            "prefix",
            ResolvedType::Array {
                element,
                ordered: true,
                nonempty: false,
            },
        ) => crate::analysis::types::checked_standard_nominal_name(element) == Some("TextMessage"),
        ("Branch", "origin", ResolvedType::Nullable(inner)) => {
            chat_model_reference(program, model, inner, "Turn")
        }
        ("Turn", "role", _) => chat_role_type(ty),
        (
            "Turn",
            "attachments",
            ResolvedType::Array {
                element,
                ordered: true,
                nonempty: false,
            },
        ) => element.as_ref() == &ResolvedType::Scalar(Scalar::File),
        ("Turn", "run", _) => chat_model_reference(program, model, ty, "Run"),
        ("Run", "allowance", _) => chat_model_reference(program, model, ty, "Allowance"),
        ("Run", "request_value", _) => {
            crate::analysis::types::checked_standard_nominal_name(ty) == Some("TextRequest")
        }
        ("Run", "request", ResolvedType::Nullable(inner)) => {
            matches!(inner.as_ref(), ResolvedType::StdDelivery { capability: "std.TextGenerationV1", op }
                if crate::analysis::catalog::std_operation("std.TextGenerationV1", "generate") == Some(*op))
        }
        _ => false,
    }
}

fn contains_span(parent: crate::source::Span, child: crate::source::Span) -> bool {
    parent.file == child.file && parent.start <= child.start && child.end <= parent.end
}

fn policy_model(program: &IrProgram, id: SymbolId) -> Option<&super::ir::IrItem> {
    let model = program.items.get(id.0 as usize)?;
    let module = program.modules.get(model.module.0 as usize)?;
    (model.id == id
        && module.id == model.module
        && model.span.file == module.file
        && contains_span(module.span, model.span)
        && model.canonical == format!("{}.{}", module.name, model.name)
        && matches!(model.kind, IrItemKind::Model { .. }))
    .then_some(model)
}

fn policy_field(
    program: &IrProgram,
    model: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> Option<SymbolId> {
    let owner = policy_model(program, model)?;
    let IrItemKind::Model { fields, .. } = &owner.kind else {
        return None;
    };
    let mut matching = fields.iter().filter_map(|id| {
        program
            .items
            .get(id.0 as usize)
            .filter(|field| field.id == *id && field.name == name)
    });
    let field = matching.next()?;
    let module = program.modules.get(owner.module.0 as usize)?;
    if matching.next().is_some()
        || field.module != owner.module
        || field.span.file != module.file
        || !contains_span(module.span, field.span)
        || field.canonical != format!("{}.{}", owner.canonical, name)
        || !matches!(&field.kind, IrItemKind::Field { owner: own, ty: IrType::Known(actual), required_array: false,
            server: None, modifiers, .. } if *own == model && actual == ty && !modifiers.machine)
    {
        return None;
    }
    Some(field.id)
}

fn policy_row(expr: &TypedExpr, model: SymbolId) -> Option<()> {
    (matches!(&expr.expr, IrExpr::Name(name) if name == "row")
        && expr.ty
            == (ResolvedType::Record {
                symbol: model,
                stored: true,
            }))
    .then_some(())
}

fn policy_row_member(
    expr: &TypedExpr,
    model: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> Option<()> {
    let IrExpr::Member { base, field } = &expr.expr else {
        return None;
    };
    if field != name || &expr.ty != ty || !contains_span(expr.span, base.span) {
        return None;
    }
    policy_row(base, model)
}

fn policy_binary(expr: &TypedExpr, expected: IrBinOp) -> Option<(&TypedExpr, &TypedExpr)> {
    let IrExpr::Binary { op, left, right } = &expr.expr else {
        return None;
    };
    (*op == expected
        && expr.ty == ResolvedType::Scalar(Scalar::Bool)
        && contains_span(expr.span, left.span)
        && contains_span(expr.span, right.span)
        && left.span.end <= right.span.start)
        .then_some((left, right))
}

fn original_duration_bounds(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
) -> Option<SymbolId> {
    let (lower, upper) = policy_binary(expr, IrBinOp::And)?;
    let ty = ResolvedType::Scalar(Scalar::Duration);
    let field = policy_field(program, model, "duration", &ty)?;
    for (expression, op, millis) in [(lower, IrBinOp::Ge, 1_000), (upper, IrBinOp::Le, 900_000)] {
        let (read, literal) = policy_binary(expression, op)?;
        policy_row_member(read, model, "duration", &ty)?;
        if literal.ty != ty || !matches!(literal.expr, IrExpr::DurationMs(value) if value == millis)
        {
            return None;
        }
    }
    Some(field)
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
    // A lock compares the singular owning stored value. Duration does not
    // enter the generic rule arithmetic/container profile through this path.
    if matches!(ty, ResolvedType::Scalar(Scalar::User | Scalar::Duration)) {
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
    duration_operand: bool,
) -> Option<()> {
    // Presence of an owning nullable audit field needs no dereference or
    // additional owner dependency. Keep this distinct from scalar equality,
    // nullable arithmetic and navigation through a user/reference value.
    if let IrExpr::Binary {
        op: IrBinOp::Eq | IrBinOp::Ne,
        left,
        right,
    } = &expr.expr
        && (matches!(left.expr, IrExpr::Null) || matches!(right.expr, IrExpr::Null))
    {
        if duration_operand || expr.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        let (read, null) = if matches!(left.expr, IrExpr::Null) {
            (right, left)
        } else {
            (left, right)
        };
        if null.ty != ResolvedType::Null
            || !matches!(&read.ty, ResolvedType::Nullable(inner)
                if matches!(inner.as_ref(), ResolvedType::Scalar(Scalar::User | Scalar::Datetime)))
        {
            return None;
        }
        let IrExpr::Member { field, .. } = &read.expr else {
            return None;
        };
        let id = policy_field(program, model, field, &read.ty)?;
        policy_row_member(read, model, field, &read.ty)?;
        if !fields.contains(&id) {
            fields.push(id);
        }
        return Some(());
    }
    if duration_operand {
        if expr.ty != ResolvedType::Scalar(Scalar::Duration)
            || !matches!(expr.expr, IrExpr::Member { .. } | IrExpr::DurationMs(_))
        {
            return None;
        }
    } else if !local_type(program, model, &expr.ty) {
        return None;
    }
    match &expr.expr {
        IrExpr::DurationMs(_) if duration_operand => Some(()),
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
                || !(matches!(
                    ty,
                    ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool)
                        | ResolvedType::Enum { .. }
                ) || duration_operand && ty == &ResolvedType::Scalar(Scalar::Duration))
            {
                return None;
            }
            if !fields.contains(&item.id) {
                fields.push(item.id);
            }
            Some(())
        }
        IrExpr::Binary { op, left, right }
            if left.ty == ResolvedType::Scalar(Scalar::Duration)
                || right.ty == ResolvedType::Scalar(Scalar::Duration) =>
        {
            if expr.ty != ResolvedType::Scalar(Scalar::Bool)
                || !matches!(op, IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge)
                || !matches!(
                    (&left.expr, &right.expr),
                    (IrExpr::Member { .. }, IrExpr::DurationMs(_))
                        | (IrExpr::DurationMs(_), IrExpr::Member { .. })
                )
            {
                return None;
            }
            visit(program, model, left, fields, true)?;
            visit(program, model, right, fields, true)
        }
        IrExpr::Binary { left, right, .. } => {
            visit(program, model, left, fields, false)?;
            visit(program, model, right, fields, false)
        }
        IrExpr::Unary { operand, .. } => visit(program, model, operand, fields, false),
        IrExpr::Array(items) => {
            for item in items {
                visit(program, model, item, fields, false)?;
            }
            Some(())
        }
        _ => None,
    }
}
