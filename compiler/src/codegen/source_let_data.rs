//! Immediate DATA observations at original scalar LET and constructor field sites.
use super::ir::*;
use crate::analysis::{ResolvedType, SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(super) fn collect(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    requires: &HashMap<Span, serde_json::Value>,
    module: &str,
    loops: Option<&serde_json::Value>,
) -> Option<HashMap<Span, serde_json::Value>> {
    let IrItemKind::Scenario {
        params,
        effects,
        hook: None,
        read: false,
        trusted: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let source = requires
        .values()
        .find(|source| source["owner"] == owner.canonical)?["source"]
        .clone();
    fn relevant(body: &[IrStmt]) -> bool {
        body.iter().any(|statement| match statement {
            IrStmt::Let { .. }
            | IrStmt::Create { .. }
            | IrStmt::Set { .. }
            | IrStmt::Schedule { .. } => true,
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => relevant(then_branch) || relevant(else_branch),
            IrStmt::For { body, .. } => relevant(body),
            _ => false,
        })
    }
    if !relevant(effects) {
        return Some(HashMap::new());
    }
    context.same_scenario(ir, owner)?;
    let mut roots: BTreeMap<String, SymbolId> = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                ..
            } = &param.kind
            else {
                return None;
            };
            matches!(
                ir.items.get(symbol.0 as usize)?.kind,
                IrItemKind::Model { .. }
            )
            .then(|| (param.name.clone(), *symbol))
        })
        .collect();
    fn uses(value: &TypedExpr, name: &str, depth: usize) -> bool {
        if depth >= 64 {
            return false;
        }
        match &value.expr {
            IrExpr::Name(value) => value == name,
            IrExpr::Member { base, .. } => uses(base, name, depth + 1),
            IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } | IrExpr::Array(args) => {
                args.iter().any(|value| uses(value, name, depth + 1))
            }
            IrExpr::Object(fields) => fields.iter().any(|(_, value)| uses(value, name, depth + 1)),
            IrExpr::Binary { left, right, .. } => {
                uses(left, name, depth + 1) || uses(right, name, depth + 1)
            }
            IrExpr::Unary { operand, .. } => uses(operand, name, depth + 1),
            _ => false,
        }
    }
    fn used_by_send_at(statements: &[IrStmt], name: &str, depth: usize) -> bool {
        if depth >= 64 {
            return false;
        }
        for statement in statements {
            match statement {
                IrStmt::Send { args, .. } if uses(args, name, 0) => return true,
                IrStmt::Let { name: shadow, .. } if shadow == name => return false,
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    if used_by_send_at(then_branch, name, depth + 1)
                        || used_by_send_at(else_branch, name, depth + 1)
                    {
                        return true;
                    }
                }
                IrStmt::For {
                    item,
                    limit: Some(limit),
                    body,
                    ..
                } if item != name
                    && matches!(limit.expr,IrExpr::Int(maximum)if (1..=1000).contains(&maximum)) =>
                {
                    if used_by_send_at(body, name, depth + 1) {
                        return true;
                    }
                }
                IrStmt::For { .. } => {}
                IrStmt::Match { .. } => return false,
                _ => {}
            }
        }
        false
    }
    fn used_by_send(statements: &[IrStmt], name: &str) -> bool {
        used_by_send_at(statements, name, 0)
    }
    fn scalar_loan(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        roots: &BTreeMap<String, SymbolId>,
        source: &serde_json::Value,
        module: &str,
        value: &TypedExpr,
        span: Span,
        stage: usize,
        name: &str,
    ) -> Option<serde_json::Value> {
        fn receiver(
            ir: &IrProgram,
            value: &TypedExpr,
            roots: &BTreeMap<String, SymbolId>,
            depth: usize,
        ) -> Option<(String, SymbolId, Vec<SymbolId>)> {
            if depth >= 16 {
                return None;
            }
            match &value.expr {
                IrExpr::Name(name) => {
                    let model = *roots.get(name)?;
                    (value.ty
                        == ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        })
                    .then(|| (name.clone(), model, Vec::new()))
                }
                IrExpr::Member { base, field } if field == "parent" => {
                    let (parameter, root, mut parents) = receiver(ir, base, roots, depth + 1)?;
                    let owner = parents.last().copied().unwrap_or(root);
                    let IrItemKind::Model {
                        owner: IrOwner::ChildOf(parent),
                        ..
                    } = &ir.items.get(owner.0 as usize)?.kind
                    else {
                        return None;
                    };
                    if value.ty
                        != (ResolvedType::Record {
                            symbol: *parent,
                            stored: true,
                        })
                    {
                        return None;
                    }
                    parents.push(*parent);
                    Some((parameter, root, parents))
                }
                _ => None,
            }
        }
        let IrExpr::Member { base, .. } = &value.expr else {
            return None;
        };
        let (parameter, root, path) = receiver(ir, base, roots, 0)
            .map(|(parameter, root, parents)| {
                (
                    parameter,
                    root,
                    parents
                        .into_iter()
                        .map(|model| ("parent".into(), model, false))
                        .collect::<Vec<_>>(),
                )
            })
            .or_else(|| super::source_send_data::scalar_field_receiver(ir, base, roots))?;
        let model = &path.last().map(|(_, model, _)| *model).unwrap_or(root);
        let transport = |ty: &ResolvedType| {
            super::source_send_data::data_type(ir, ty).or_else(|| match ty {
                ResolvedType::Record {
                    symbol,
                    stored: true,
                } if matches!(
                    ir.items.get(symbol.0 as usize)?.kind,
                    IrItemKind::Model { .. }
                ) =>
                {
                    Some(ir.items[symbol.0 as usize].canonical.clone())
                }
                _ => None,
            })
        };
        if let IrExpr::Member { base, field } = &value.expr
            && base.ty
                == (ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                })
            && let IrItemKind::Model { fields, .. } = &ir.items[model.0 as usize].kind
            && let Some(declaration) = fields
                .iter()
                .filter_map(|id| ir.items.get(id.0 as usize))
                .find(|item| item.name == *field)
            && let IrItemKind::Field {
                owner: field_owner,
                ty: IrType::Known(ty),
                ..
            } = &declaration.kind
            && field_owner == model
            && (ty == &value.ty
                || matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty))
            && let Some(field_type) = transport(ty)
            && let Some(value_type) = transport(&value.ty)
            && let Some(original) = context.fresh().items.get(declaration.id.0 as usize)
            && declaration.id == original.id
            && declaration.canonical == original.canonical
            && declaration.name == original.name
            && declaration.module == original.module
            && declaration.span == original.span
            && matches!(&original.kind,IrItemKind::Field{owner,ty:IrType::Known(original_ty),..}if owner==model&&original_ty==ty)
        {
            let mut site = serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"stage":stage,"binding":name,
                "parameter":parameter,"model":ir.items[root.0 as usize].canonical,"field":{"name":field,"type":field_type},"valueType":value_type});
            if !path.is_empty() {
                if path
                    .iter()
                    .all(|(field, _, narrowed)| field == "parent" && !*narrowed)
                {
                    site["parents"] = serde_json::json!(
                        path.iter()
                            .map(|(_, id, _)| ir.items[id.0 as usize].canonical.clone())
                            .collect::<Vec<_>>()
                    );
                } else {
                    site["path"]=serde_json::json!(path.iter().map(|(field,id,narrowed)|{
                    let mut edge=serde_json::json!({"field":field,"model":ir.items[id.0 as usize].canonical});
                    if *narrowed{edge["nullable"]=serde_json::json!(true);}edge
                }).collect::<Vec<_>>());
                }
            }
            return Some(site);
        }
        None
    }
    let mut stage = 0;
    let mut loans = HashMap::new();
    for (index, statement) in effects.iter().enumerate() {
        match statement {
            IrStmt::Let { name, value, span } => {
                let guard_capture = requires
                    .values()
                    .filter(|source| source["owner"] == owner.canonical)
                    .filter_map(|source| source["captures"].as_array())
                    .flatten()
                    .any(|capture| {
                        capture["binding"] == *name
                            && capture["node"]["start"] == span.start
                            && capture["node"]["end"] == span.end
                    });
                if (guard_capture || used_by_send(&effects[index + 1..], name))
                    && let Some(loan) = scalar_loan(
                        ir, owner, context, &roots, &source, module, value, *span, stage, name,
                    )
                {
                    loans.insert(*span, loan);
                }
                roots.remove(name);
            }
            IrStmt::Create { binding, .. } => {
                if let Some(binding) = binding {
                    roots.remove(binding);
                }
                stage += 1;
            }
            IrStmt::Set { .. } | IrStmt::Transition { .. } | IrStmt::Delete { .. } => stage += 1,
            IrStmt::Require { .. } | IrStmt::Send { .. } => {}
            _ => break,
        }
    }
    // Constructor field DATA is observed exactly where the original field
    // expression executes. Unknown branch/loop write counts never guess a
    // stage, and File/derived fields cannot enter the field loan.
    fn constructors(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        body: &[IrStmt],
        roots: &mut BTreeMap<String, SymbolId>,
        source: &serde_json::Value,
        module: &str,
        mut stage: usize,
        loans: &mut HashMap<Span, serde_json::Value>,
    ) -> Option<usize> {
        for statement in body {
            match statement {
                IrStmt::Create { input, binding, .. } => {
                    if let IrExpr::Object(fields) = &input.expr {
                        for (name, value) in fields {
                            if matches!(
                                value.ty.nullable_inner().unwrap_or(&value.ty),
                                ResolvedType::Scalar(_)
                                    | ResolvedType::Enum { .. }
                                    | ResolvedType::Record { stored: true, .. }
                            ) && let Some(loan) = scalar_loan(
                                ir, owner, context, roots, source, module, value, value.span,
                                stage, name,
                            ) {
                                loans.insert(value.span, loan);
                            }
                        }
                    }
                    if let Some(name) = binding {
                        roots.remove(name);
                    }
                    stage = stage.checked_add(1)?;
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    let left = constructors(
                        ir,
                        owner,
                        context,
                        then_branch,
                        &mut roots.clone(),
                        source,
                        module,
                        stage,
                        loans,
                    );
                    let right = constructors(
                        ir,
                        owner,
                        context,
                        else_branch,
                        &mut roots.clone(),
                        source,
                        module,
                        stage,
                        loans,
                    );
                    if left != right {
                        return None;
                    }
                    stage = left?;
                }
                IrStmt::Let { name, .. } => {
                    roots.remove(name);
                }
                IrStmt::Set { .. } | IrStmt::Transition { .. } | IrStmt::Delete { .. } => {
                    stage = stage.checked_add(1)?
                }
                IrStmt::Require { .. } | IrStmt::Send { .. } => {}
                _ => return None,
            }
            if stage >= 200 {
                return None;
            }
        }
        Some(stage)
    }
    let mut constructor_roots = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                ..
            } = &param.kind
            else {
                return None;
            };
            matches!(
                ir.items.get(symbol.0 as usize)?.kind,
                IrItemKind::Model { .. }
            )
            .then(|| (param.name.clone(), *symbol))
        })
        .collect();
    constructors(
        ir,
        owner,
        context,
        effects,
        &mut constructor_roots,
        &source,
        module,
        0,
        &mut loans,
    );
    // Each scalar field is observed where its original getter executes.
    // Native JavaScript retains lazy operands and earlier Values failures.
    fn scalar(ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Scalar(value) => !matches!(
                value,
                crate::analysis::Scalar::File
                    | crate::analysis::Scalar::Secret
                    | crate::analysis::Scalar::Member
                    | crate::analysis::Scalar::Json
                    | crate::analysis::Scalar::Bytes
            ),
            ResolvedType::Enum { cases, .. } => !cases.is_empty(),
            ResolvedType::Nullable(inner) => scalar(inner),
            _ => false,
        }
    }
    fn leaves(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        value: &TypedExpr,
        roots: &BTreeMap<String, SymbolId>,
        source: &serde_json::Value,
        module: &str,
        stages: &BTreeSet<usize>,
        name: &str,
        loans: &mut HashMap<Span, serde_json::Value>,
        depth: usize,
    ) -> Option<()> {
        if depth > 32 {
            return None;
        }
        if matches!(value.expr, IrExpr::Member { .. })
            && scalar(&value.ty)
            && let Some(mut loan) = scalar_loan(
                ir,
                owner,
                context,
                roots,
                source,
                module,
                value,
                value.span,
                *stages.first()?,
                name,
            )
        {
            if stages.len() > 1 {
                let fields = loan.as_object_mut()?;
                fields.remove("stage");
                fields.insert("stages".into(), serde_json::json!(stages));
            }
            loans.insert(value.span, loan);
            return Some(());
        }
        let mut child = |value: &TypedExpr| {
            leaves(
                ir,
                owner,
                context,
                value,
                roots,
                source,
                module,
                stages,
                name,
                loans,
                depth + 1,
            )
        };
        match &value.expr {
            IrExpr::Member { base, .. } => child(base),
            IrExpr::Binary { left, right, .. } => {
                child(left)?;
                child(right)
            }
            IrExpr::Unary { operand, .. } => child(operand),
            IrExpr::Object(fields) => {
                for (_, value) in fields {
                    child(value)?;
                }
                Some(())
            }
            IrExpr::Call {
                target: IrCallTarget::Builtin { id, awaited: false },
                args,
            }
            | IrExpr::BoundCall {
                target: IrCallTarget::Builtin { id, awaited: false },
                args,
                ..
            } if context.catalog().and_then(|catalog| catalog.effects(id))
                == Some(crate::analysis::catalog::Effects::Pure) =>
            {
                for value in args {
                    child(value)?;
                }
                Some(())
            }
            IrExpr::Query(query) => {
                // Candidate values come only from the existing current-viewer
                // reader. External original root fields retain their separate
                // staged DATA observations; an alias can never borrow a root.
                if !matches!(
                    owner.kind,
                    IrItemKind::Scenario {
                        trusted: false,
                        read: false,
                        ..
                    }
                ) || !matches!(query.domain, IrQueryDomain::Model(_))
                    || query.source.is_none()
                {
                    return None;
                }
                if let Some(parent) = &query.parent {
                    leaves(
                        ir,
                        owner,
                        context,
                        parent,
                        roots,
                        source,
                        module,
                        stages,
                        name,
                        loans,
                        depth + 1,
                    )?;
                }
                let mut scoped = roots.clone();
                scoped.remove(&query.where_param);
                if let Some(alias) = &query.select_param {
                    scoped.remove(alias);
                }
                for value in query
                    .where_pred
                    .iter()
                    .map(|value| value.as_ref())
                    .chain(query.select.iter().map(|value| value.as_ref()))
                    .chain(query.value_order.iter().map(|order| order.key.as_ref()))
                {
                    leaves(
                        ir,
                        owner,
                        context,
                        value,
                        &scoped,
                        source,
                        module,
                        stages,
                        name,
                        loans,
                        depth + 1,
                    )?;
                }
                for value in query.limit.iter().chain(query.archived.iter()) {
                    leaves(
                        ir,
                        owner,
                        context,
                        value,
                        roots,
                        source,
                        module,
                        stages,
                        name,
                        loans,
                        depth + 1,
                    )?;
                }
                Some(())
            }
            IrExpr::Int(_)
            | IrExpr::Decimal(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Money { .. }
            | IrExpr::DurationMs(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_)
            | IrExpr::Name(_) => Some(()),
            _ => None,
        }
    }
    fn expressions(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        body: &[IrStmt],
        roots: &mut BTreeMap<String, SymbolId>,
        values: &mut BTreeSet<String>,
        source: &serde_json::Value,
        module: &str,
        mut stages: BTreeSet<usize>,
        loans: &mut HashMap<Span, serde_json::Value>,
        loops: Option<&serde_json::Value>,
    ) -> Option<BTreeSet<usize>> {
        fn advance(stages: &BTreeSet<usize>) -> Option<BTreeSet<usize>> {
            stages
                .iter()
                .map(|stage| stage.checked_add(1).filter(|stage| *stage < 200))
                .collect()
        }
        if stages.is_empty() || stages.len() > 200 || stages.last().copied()? >= 200 {
            return None;
        }
        for statement in body {
            match statement {
                IrStmt::Let { name, value, span } => {
                    if !loans.contains_key(span)
                        && super::source_send_data::plain_value(ir, &value.ty, 0)
                    {
                        let mut nested = HashMap::new();
                        if leaves(
                            ir,
                            owner,
                            context,
                            value,
                            roots,
                            source,
                            module,
                            &stages,
                            name,
                            &mut nested,
                            0,
                        )
                        .is_some()
                        {
                            loans.extend(nested);
                        }
                    }
                    let pure = loans.contains_key(span)
                        || super::source_send_data::send_value(ir, value, values, 0)
                        || super::source_send_data::observed_scalar_value(ir, value, loans, values);
                    roots.remove(name);
                    values.remove(name);
                    if pure {
                        values.insert(name.clone());
                    }
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    let left = expressions(
                        ir,
                        owner,
                        context,
                        then_branch,
                        &mut roots.clone(),
                        &mut values.clone(),
                        source,
                        module,
                        stages.clone(),
                        loans,
                        loops,
                    );
                    let right = expressions(
                        ir,
                        owner,
                        context,
                        else_branch,
                        &mut roots.clone(),
                        &mut values.clone(),
                        source,
                        module,
                        stages.clone(),
                        loans,
                        loops,
                    );
                    // Both authored branches contribute their exact reachable write counts.
                    // Preserve lazy execution; this is a finite admission set, not a range.
                    stages = left?.union(&right?).copied().collect();
                }
                IrStmt::Schedule {
                    at, payload, span, ..
                } => {
                    let mut nested = HashMap::new();
                    if leaves(
                        ir,
                        owner,
                        context,
                        at,
                        roots,
                        source,
                        module,
                        &stages,
                        "at",
                        &mut nested,
                        0,
                    )
                    .is_some()
                        && leaves(
                            ir,
                            owner,
                            context,
                            payload,
                            roots,
                            source,
                            module,
                            &stages,
                            "payload",
                            &mut nested,
                            0,
                        )
                        .is_some()
                    {
                        loans.extend(nested);
                    }
                    let _ = span;
                }
                IrStmt::For {
                    item,
                    domain,
                    body,
                    span,
                    ..
                } => {
                    if stages.len() != 1 {
                        return None;
                    }
                    let entry = loops?.get("loops")?.as_array()?.iter().find(|entry| {
                        entry["node"]["start"] == span.start
                            && entry["node"]["end"] == span.end
                            && entry.get("work").is_some()
                    })?;
                    let ResolvedType::Array { element, .. } = &domain.ty else {
                        return None;
                    };
                    let ResolvedType::Record {
                        symbol,
                        stored: true,
                    } = element.as_ref()
                    else {
                        return None;
                    };
                    if entry["item"] != *item
                        || entry["model"] != ir.items[symbol.0 as usize].canonical
                    {
                        return None;
                    }
                    let mut nested_roots = roots.clone();
                    nested_roots.insert(item.clone(), *symbol);
                    let mut nested_values = values.clone();
                    nested_values.remove(item);
                    let mut nested = HashMap::new();
                    expressions(
                        ir,
                        owner,
                        context,
                        body,
                        &mut nested_roots,
                        &mut nested_values,
                        source,
                        module,
                        BTreeSet::from([0]),
                        &mut nested,
                        loops,
                    )?;
                    if nested.values().any(|loan| loan.get("stages").is_some()) {
                        return None;
                    }
                    for (key, mut loan) in nested.drain() {
                        loan["loop"] = entry["id"].clone();
                        loans.insert(key, loan);
                    }
                    // A dynamic number of child writes cannot establish a later
                    // static stage. Original loop tail execution remains separate.
                    return None;
                }
                IrStmt::Create { input, binding, .. } => {
                    let mut nested = HashMap::new();
                    if leaves(
                        ir,
                        owner,
                        context,
                        input,
                        roots,
                        source,
                        module,
                        &stages,
                        "create",
                        &mut nested,
                        0,
                    )
                    .is_some()
                    {
                        loans.extend(nested);
                    }
                    if let Some(name) = binding {
                        roots.remove(name);
                        values.remove(name);
                    }
                    stages = advance(&stages)?;
                }
                IrStmt::Set { changes, .. } => {
                    // Nested Object leaves use the same pure expression walker as LET.
                    // Observe each original getter before this SET advances the write stage.
                    let mut nested = HashMap::new();
                    if leaves(
                        ir,
                        owner,
                        context,
                        changes,
                        roots,
                        source,
                        module,
                        &stages,
                        "set",
                        &mut nested,
                        0,
                    )
                    .is_some()
                    {
                        loans.extend(nested);
                    }
                    stages = advance(&stages)?;
                }
                IrStmt::Transition { .. } | IrStmt::Delete { .. } => stages = advance(&stages)?,
                IrStmt::Require { .. } | IrStmt::Send { .. } | IrStmt::Cancel { .. } => {}
                _ => return None,
            }
            if stages.len() > 200 {
                return None;
            }
        }
        Some(stages)
    }
    let mut expression_roots = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                ..
            } = &param.kind
            else {
                return None;
            };
            matches!(
                ir.items.get(symbol.0 as usize)?.kind,
                IrItemKind::Model { .. }
            )
            .then(|| (param.name.clone(), *symbol))
        })
        .collect();
    let mut values = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty: IrType::Known(ty),
                ..
            } = &param.kind
            else {
                return None;
            };
            super::source_send_data::plain_value(ir, ty, 0).then(|| param.name.clone())
        })
        .collect();
    expressions(
        ir,
        owner,
        context,
        effects,
        &mut expression_roots,
        &mut values,
        &source,
        module,
        BTreeSet::from([0]),
        &mut loans,
        loops,
    );
    Some(loans)
}

/// Only original immutable, pre-write LET values may cross a later guard.
/// The emitted callback retains the original query reader and field loans;
/// its result creates no row or ordinary DATA capability.
pub(super) fn capture_plain_value(ir: &IrProgram, ty: &ResolvedType, depth: usize) -> bool {
    if depth >= 16 || !super::source_send_data::plain_value(ir, ty, depth) {
        return false;
    }
    match ty {
        ResolvedType::Scalar(crate::analysis::Scalar::User) => false,
        ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
            capture_plain_value(ir, inner, depth + 1)
        }
        ResolvedType::Object(fields) => fields
            .iter()
            .all(|(_, ty)| capture_plain_value(ir, ty, depth + 1)),
        ResolvedType::Record { symbol, .. } => {
            matches!(ir.items.get(symbol.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{fields,..}) if fields.iter().all(|id|
            matches!(ir.items.get(id.0 as usize).map(|item|&item.kind),Some(IrItemKind::Field{ty:IrType::Known(ty),..}) if capture_plain_value(ir,ty,depth+1))))
        }
        _ => true,
    }
}

/// A staged scalar aggregate still executes its original selected query.
/// No caller-supplied array or arbitrary helper stands in for that domain.
pub(super) fn query_value_expression(value: &TypedExpr) -> Option<(&TypedExpr, &IrQuery)> {
    if let IrExpr::Query(query) = &value.expr {
        return Some((value, query));
    }
    let (IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. }) = &value.expr
    else {
        return None;
    };
    if !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "sum")
        || args.len() != 2
    {
        return None;
    }
    let IrExpr::Query(query) = &args[0].expr else {
        return None;
    };
    Some((&args[0], query))
}

pub(super) fn collect_query_values(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    requires: &HashMap<Span, serde_json::Value>,
    module: &str,
) -> Option<HashMap<Span, serde_json::Value>> {
    let IrItemKind::Scenario {
        params,
        effects,
        read: false,
        trusted: false,
        hook: None,
        result: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    context.same_scenario(ir, owner)?;
    let source = &requires
        .values()
        .find(|source| source["owner"] == owner.canonical)?["source"];
    let mut values = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|item| {
            matches!(&item.kind, IrItemKind::Param { ty: IrType::Known(ty), .. }
            if super::source_send_data::plain_value(ir, ty, 0))
        })
        .map(|item| item.name.clone())
        .collect::<BTreeSet<_>>();
    let mut output = HashMap::new();
    let mut written = false;
    for effect in effects {
        let IrStmt::Let { name, value, span } = effect else {
            if matches!(effect, IrStmt::Require { .. }) {
                continue;
            }
            if matches!(effect, IrStmt::Create { when: None, .. }) {
                written = true;
                continue;
            }
            break;
        };
        let prefix = if written {
            let Some(prefix) = super::scenario_decisions::serialize_let_mutation_prefix(
                context, owner, *span, source,
            ) else {
                continue;
            };
            if !prefix
                .as_array()?
                .iter()
                .all(|step| step["kind"] == "create")
            {
                continue;
            }
            Some(prefix)
        } else {
            None
        };
        let mut queries = Vec::new();
        let query = if let Some((query_value, query)) = query_value_expression(value) {
            let IrQueryDomain::Model(model) = &query.domain else {
                continue;
            };
            let original = query.source.as_ref()?;
            if query.select.is_none()
                || query.where_async
                || query.limit.is_some()
                || query.archived.is_some()
                || original.node.file != span.file
                || original.node.start != query_value.span.start
                || original.node.end != query_value.span.end
            {
                continue;
            }
            queries.push(serde_json::json!({"node":{"start":query_value.span.start,"end":query_value.span.end},"model":model}));
            true
        } else {
            false
        };
        if written && !query {
            continue;
        }
        if !capture_plain_value(ir, &value.ty, 0)
            || !query && !super::source_send_data::send_value(ir, value, &values, 0)
        {
            continue;
        }
        let type_id = super::scenario_decisions::serial_type(&value.ty, context.original(), ir, 0)?;
        values.insert(name.clone());
        let mut descriptor = serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
            "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"value":{"start":value.span.start,"end":value.span.end},
            "binding":name,"typeId":type_id,"stage":0,"queries":queries});
        if let Some(prefix) = prefix {
            descriptor["stage"] = serde_json::json!(prefix.as_array()?.len());
            descriptor["mutationPrefix"] = prefix;
            let readers = collect_query_rows(
                ir,
                owner,
                context,
                &HashMap::from([(*span, descriptor.clone())]),
            );
            let Some(reader) = readers
                .get(span)
                .and_then(|site| site["queries"].as_array())
                .and_then(|queries| queries.first())
            else {
                continue;
            };
            descriptor["queries"][0]["reader"] = reader.clone();
        }
        output.insert(*span, descriptor);
    }
    Some(output)
}

/// Query codecs spell enum cases inline; ordinary stored observations retain
/// their declaring field's nominal identity. Join only those two spellings of
/// the same original checked field, without changing either published type.
pub(super) fn same_query_capture_type(
    context: &super::source_context::FreshSourceContext<'_>,
    ordinary: &crate::analysis::scenario_disclosure::DisclosureDependency,
    query: &crate::analysis::scenario_disclosure::DisclosureDependency,
) -> bool {
    if ordinary.type_id == query.type_id {
        return true;
    }
    let ResolvedType::Enum {
        owner: Some(enum_owner),
        cases,
    } = &ordinary.ty
    else {
        return false;
    };
    if ordinary.ty != query.ty
        || ordinary.field != query.field
        || ordinary.model != query.model
        || cases.is_empty()
        || query.type_id != format!("enum({})", cases.join(","))
    {
        return false;
    }
    let ir = context.ir();
    for id in [ordinary.field, *enum_owner] {
        let Some(actual) = ir.items.get(id.0 as usize) else {
            return false;
        };
        let Some(original) = context.fresh().items.get(id.0 as usize) else {
            return false;
        };
        if actual.id != id
            || original.id != id
            || format!("{actual:?}") != format!("{original:?}")
            || context.original().types.symbol_types.get(&id) != Some(&ordinary.ty)
            || !matches!(&actual.kind, IrItemKind::Field { ty: IrType::Known(ty), .. } if ty == &ordinary.ty)
        {
            return false;
        }
    }
    let field = &ir.items[ordinary.field.0 as usize];
    let declaration = &ir.items[enum_owner.0 as usize];
    matches!(&field.kind, IrItemKind::Field { owner, .. } if *owner == ordinary.model)
        && ordinary.type_id == declaration.canonical
}

/// Full native receipts retain their query slots. This inventory completes only
/// the original initial LET, then deterministic Values-only lexical successors.
pub(super) fn collect_native_query_values(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    module: &str,
) -> Option<HashMap<Span, serde_json::Value>> {
    fn names(value: &TypedExpr, output: &mut BTreeSet<String>, depth: usize) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let mut child = |value: &TypedExpr| names(value, output, depth + 1);
        match &value.expr {
            IrExpr::Name(name) => {
                output.insert(name.clone());
            }
            IrExpr::Member { base, .. } | IrExpr::Unary { operand: base, .. } => child(base)?,
            IrExpr::Binary { left, right, .. } => {
                child(left)?;
                child(right)?;
            }
            IrExpr::Array(values)
            | IrExpr::Call { args: values, .. }
            | IrExpr::BoundCall { args: values, .. } => {
                for value in values {
                    child(value)?;
                }
            }
            IrExpr::Object(fields) => {
                for (_, value) in fields {
                    child(value)?;
                }
            }
            IrExpr::Query(_) => return None,
            _ => {}
        }
        Some(())
    }

    let ir = context.ir();
    context.same_scenario(ir, owner)?;

    let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let originals = context
        .original()
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    if facts.query_values != originals.query_values {
        return None;
    }

    let query_values = facts.query_values.as_deref()?;
    if query_values.is_empty() {
        return None;
    }
    let IrItemKind::Scenario {
        params,
        effects,
        result,
        read: false,
        trusted: false,
        hook: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if result.is_some()
        && super::scenario_receipts::checked_created_model_result(ir, owner).is_none()
    {
        return None;
    }
    let source = serde_json::to_value(super::scenario_receipts::transport_source(
        &facts.source,
        module,
    )?)
    .ok()?;
    let mut values=params.iter().filter_map(|id|ir.items.get(id.0 as usize))
        .filter(|item|matches!(&item.kind,IrItemKind::Param{ty:IrType::Known(ty),..}if capture_plain_value(ir,ty,0)))
        .map(|item|item.name.clone()).collect::<BTreeSet<_>>();
    let mut prior = std::collections::BTreeMap::<String, serde_json::Value>::new();

    let mut output = HashMap::new();
    for statement in effects {
        if matches!(statement, IrStmt::Require { .. }) {
            continue;
        }
        let IrStmt::Let { name, value, span } = statement else {
            break;
        };
        if !capture_plain_value(ir, &value.ty, 0) {
            continue;
        }
        let type_id = super::scenario_decisions::serial_type(&value.ty, context.original(), ir, 0)?;
        let mut descriptor = serde_json::json!({"source":source,"owner":owner.canonical,"node":{"start":span.start,"end":span.end},
            "value":{"start":value.span.start,"end":value.span.end},"binding":name,"typeId":type_id,"stage":0,"queries":[]});
        if let Some(query) = query_values.iter().find(|query| {
            query.statement.file == span.file
                && query.statement.start == span.start
                && query.statement.end == span.end
        }) {
            descriptor["receiptQueryId"] = serde_json::json!(query.query.id);
            let crate::analysis::scenario_disclosure::ScenarioDisclosure::Complete(checked) =
                ir.scenario_disclosures.get(&owner.id)?
            else {
                return None;
            };
            let mut pairs = Vec::new();
            let mut ordinary_ids = BTreeSet::new();
            for dependency in query.query.dependencies.iter().filter(|dependency| {
                dependency.role == crate::analysis::scenario_disclosure::DependencyRole::Data
            }) {
                let mut matches = checked
                    .returns
                    .iter()
                    .filter(|returned| returned.source_values.contains(&query.statement))
                    .flat_map(|returned| &returned.dependencies)
                    .filter(|ordinary| {
                        ordinary.query_id.as_deref() == Some(query.query.id.as_str())
                            && ordinary.node == dependency.node
                            && ordinary.calls == dependency.calls
                            && ordinary.source == dependency.source
                            && ordinary.model == dependency.model
                            && ordinary.field == dependency.field
                            && ordinary.ty == dependency.ty
                            && same_query_capture_type(context, ordinary, dependency)
                            && ordinary.role == dependency.role
                    })
                    .map(|ordinary| ordinary.id.clone())
                    .collect::<BTreeSet<_>>();
                if matches.len() != 1 {
                    return None;
                }
                let ordinary = matches.pop_first()?;
                if ordinary == dependency.id || !ordinary_ids.insert(ordinary.clone()) {
                    return None;
                }
                pairs.push(serde_json::json!({"ordinaryDependencyId":ordinary,"queryDependencyId":dependency.id}));
            }
            descriptor["receiptDependencies"] = serde_json::json!(pairs);
            let cases = |choice| {
                checked
                    .returns
                    .iter()
                    .filter(|returned| {
                        returned.decisions.iter().any(|decision| {
                            decision.node == query.value
                                && decision.calls.is_empty()
                                && decision.choice == choice
                        })
                    })
                    .map(|returned| returned.id.clone())
                    .collect::<Vec<_>>()
            };
            descriptor["receiptCases"] = serde_json::json!({"empty":cases(crate::analysis::scenario_disclosure::DisclosureChoice::Else),"nonempty":cases(crate::analysis::scenario_disclosure::DisclosureChoice::Then)});
            descriptor["queries"] = serde_json::json!([{"node":{"start":query.value.start,"end":query.value.end},"model":query.query.model_name}]);
        } else {
            if !super::source_send_data::send_value(ir, value, &values, 0) {
                continue;
            }
            let mut used = BTreeSet::new();
            names(value, &mut used, 0)?;
            let captures = used
                .iter()
                .filter_map(|name| prior.get(name).cloned())
                .collect::<Vec<_>>();
            if captures.is_empty() {
                continue;
            }
            descriptor["captures"] = serde_json::json!(captures);
        }
        values.insert(name.clone());
        prior.insert(name.clone(),serde_json::json!({"node":{"start":span.start,"end":span.end},"binding":name,"typeId":type_id}));
        output.insert(*span, descriptor);
        if output.len() > 200 {
            return None;
        }
    }

    Some(output)
}

/// A direct plain field projection is the first State-owned Values query.
/// More complex clauses keep their existing independently checked reader.
pub(super) fn collect_query_rows(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    values: &HashMap<Span, serde_json::Value>,
) -> HashMap<Span, serde_json::Value> {
    let mut out = HashMap::new();
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return out;
    };
    for effect in effects {
        let IrStmt::Let { value, span, .. } = effect else {
            continue;
        };
        let Some(site) = values.get(span) else {
            continue;
        };
        // Complete receipt queries retain native slots and DATA obligations.
        if site.get("receiptQueryId").is_some() {
            continue;
        }
        let Some((query_value, query)) = query_value_expression(value) else {
            continue;
        };
        let super::ir::IrQueryDomain::Model(model) = &query.domain else {
            continue;
        };
        if query.parent.is_some() && site.get("mutationPrefix").is_none()
            || query.where_pred.is_some()
            || query.limit.is_some()
            || query.archived.is_some()
            || !query.order.is_empty()
            || query.value_order.is_some()
        {
            continue;
        }
        let (Some(projection), Some(alias)) = (&query.select, &query.select_param) else {
            continue;
        };
        let IrExpr::Member { base, field } = &projection.expr else {
            continue;
        };
        if !matches!(&base.expr,IrExpr::Name(name)if name==alias) {
            continue;
        }
        let Some(model_item) = ir.items.iter().find(|item| item.canonical == *model) else {
            continue;
        };
        let IrItemKind::Model { fields, .. } = &model_item.kind else {
            continue;
        };
        if !fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|item|item.name==*field&&matches!(&item.kind,IrItemKind::Field{ty:IrType::Known(ty),..}if *ty==projection.ty)){continue;}
        let Some(ty) =
            super::scenario_decisions::serial_type(&projection.ty, context.original(), ir, 0)
        else {
            continue;
        };
        let id = crate::source::sha256_hex(
            format!(
                "source-values-query/v1:{}:{}:{}",
                site["source"]["sha256"], query_value.span.start, query_value.span.end
            )
            .as_bytes(),
        );
        let mut descriptor = serde_json::json!({"id":id,"node":{"start":query_value.span.start,"end":query_value.span.end},"model":model,"fields":[{"name":field,"type":ty}]});
        if let Some(parent) = &query.parent {
            let IrExpr::Name(name) = &parent.expr else {
                continue;
            };
            let ResolvedType::Record {
                symbol,
                stored: true,
            } = parent.ty
            else {
                continue;
            };
            let Some(parent_model) = ir.items.get(symbol.0 as usize) else {
                continue;
            };
            if !matches!(&model_item.kind, IrItemKind::Model { owner: IrOwner::ChildOf(actual), .. } if *actual == symbol)
            {
                continue;
            }
            let IrItemKind::Scenario { params, .. } = &owner.kind else {
                continue;
            };
            if params.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|parameter|parameter.name==*name&&matches!(&parameter.kind,IrItemKind::Param {ty:IrType::Known(ty),default:None,..} if *ty==parent.ty)) {
                descriptor["parent"] = serde_json::json!({"model":parent_model.canonical,"parameter":name});
            } else {
                let Some(created) = site["mutationPrefix"].as_array().and_then(|prefix|prefix.iter().find_map(|step|(step["kind"]=="create"&&step["created"]["binding"]==*name&&step["created"]["model"]==parent_model.canonical).then_some(&step["created"]))) else { continue; };
                descriptor["parent"] = serde_json::json!({"model":parent_model.canonical,"created":created});
            }
        }
        out.insert(*span,serde_json::json!({"source":site["source"],"owner":owner.canonical,"node":site["node"],"queries":[descriptor]}));
    }
    out
}
