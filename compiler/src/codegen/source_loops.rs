//! Private finite source-only loops. Selection is control; SEND fields retain
//! their separate DATA producer and Work owns every actual delivery.
use super::ir::*;
use crate::analysis::{ResolvedType, Scalar, SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

fn control_type(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Scalar(scalar) => !matches!(
            scalar,
            Scalar::File | Scalar::Secret | Scalar::Json | Scalar::Bytes | Scalar::Member
        ),
        ResolvedType::Enum { .. } => true,
        ResolvedType::Nullable(inner) => control_type(inner),
        _ => false,
    }
}
fn record_model(
    ir: &IrProgram,
    value: &TypedExpr,
    roots: &HashMap<String, SymbolId>,
    depth: usize,
) -> Option<SymbolId> {
    if depth > 4 {
        return None;
    }
    let model = match &value.expr {
        IrExpr::Name(name) => *roots.get(name)?,
        IrExpr::Member { base, field } if field == "parent" => {
            let child = record_model(ir, base, roots, depth + 1)?;
            let IrItemKind::Model {
                owner: IrOwner::ChildOf(parent),
                ..
            } = ir.items.get(child.0 as usize)?.kind
            else {
                return None;
            };
            parent
        }
        _ => return None,
    };
    (value.ty
        == ResolvedType::Record {
            symbol: model,
            stored: true,
        })
    .then_some(model)
}
fn descendant_parameter<'a>(
    ir: &IrProgram,
    value: &'a TypedExpr,
    alias: &str,
    model: SymbolId,
    roots: &HashMap<String, SymbolId>,
) -> Option<(&'a str, SymbolId, Vec<SymbolId>)> {
    let mut first = value;
    while let IrExpr::Binary {
        op: IrBinOp::And,
        left,
        ..
    } = &first.expr
    {
        first = left;
    }
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left,
        right,
    } = &first.expr
    else {
        return None;
    };
    let IrExpr::Name(parameter) = &right.expr else {
        return None;
    };
    let parent = *roots.get(parameter)?;
    if right.ty
        != (ResolvedType::Record {
            symbol: parent,
            stored: true,
        })
    {
        return None;
    }
    let mut actual = left.as_ref();
    let mut count = 0;
    while let IrExpr::Member { base, field } = &actual.expr {
        if field != "parent" || count >= 4 {
            return None;
        }
        count += 1;
        actual = base;
    }
    if count < 2
        || !matches!(&actual.expr,IrExpr::Name(name)if name==alias)
        || actual.ty
            != (ResolvedType::Record {
                symbol: model,
                stored: true,
            })
    {
        return None;
    }
    let mut ancestors = Vec::new();
    let mut current = model;
    for _ in 0..count {
        let IrItemKind::Model {
            owner: IrOwner::ChildOf(parent),
            ..
        } = ir.items.get(current.0 as usize)?.kind
        else {
            return None;
        };
        current = parent;
        ancestors.push(current);
    }
    if current != parent
        || record_model(ir, left, &HashMap::from([(alias.to_owned(), model)]), 0) != Some(parent)
    {
        return None;
    }
    Some((parameter, parent, ancestors))
}
fn control_fields(ir: &IrProgram, model: SymbolId) -> Option<serde_json::Value> {
    let item = ir.items.get(model.0 as usize)?;
    let IrItemKind::Model { fields, .. } = &item.kind else {
        return None;
    };
    let fields=fields.iter().filter_map(|id|{
        let field=ir.items.get(id.0 as usize)?;let IrItemKind::Field{ty:IrType::Known(ty),..}=&field.kind else{return None;};
        control_type(ty).then(||Some(serde_json::json!({"name":field.name,"type":super::source_send_data::data_type(ir,ty)?}))).flatten()
    }).collect::<Vec<_>>();
    Some(serde_json::json!({"model":item.canonical,"fields":fields}))
}
fn predicate(
    ir: &IrProgram,
    context: &super::source_context::FreshSourceContext<'_>,
    value: &TypedExpr,
    roots: &HashMap<String, SymbolId>,
    values: &BTreeSet<String>,
    stack: &mut HashSet<SymbolId>,
    depth: usize,
) -> bool {
    if depth > 32 {
        return false;
    }
    match &value.expr {
        IrExpr::Text(_)
        | IrExpr::Int(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Decimal(_)
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_) => true,
        IrExpr::Name(name) => {
            values.contains(name) && control_type(&value.ty)
                || record_model(ir, value, roots, 0).is_some()
        }
        IrExpr::Array(entries) => {
            entries.len() <= 200
                && entries
                    .iter()
                    .all(|entry| predicate(ir, context, entry, roots, values, stack, depth + 1))
        }
        IrExpr::Binary {
            op: IrBinOp::In,
            left,
            right,
        } if matches!(&right.ty,
            ResolvedType::Array{element,ordered:true,nonempty:false}if matches!(element.as_ref(),ResolvedType::Record{stored:true,..})) =>
        {
            let ResolvedType::Array { element, .. } = &right.ty else {
                return false;
            };
            if left.ty != **element {
                return false;
            }
            let paths = roots
                .iter()
                .map(|(name, model)| (name.clone(), *model))
                .collect::<BTreeMap<_, _>>();
            let Some((_, root, path)) =
                super::source_send_data::scalar_field_receiver(ir, left, &paths)
            else {
                return false;
            };
            if path.iter().any(|(_, _, nullable)| *nullable)
                || model_corresponds(context, root).is_none()
                || path
                    .iter()
                    .any(|(_, model, _)| model_corresponds(context, *model).is_none())
            {
                return false;
            }
            let IrExpr::Member { base, field } = &right.expr else {
                return false;
            };
            let Some(model) = record_model(ir, base, roots, 0) else {
                return false;
            };
            if model_corresponds(context, model).is_none() {
                return false;
            }
            let Some(IrItem {
                kind: IrItemKind::Model { fields, .. },
                ..
            }) = ir.items.get(model.0 as usize)
            else {
                return false;
            };
            fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|item|item.name==*field
                &&matches!(&item.kind,IrItemKind::Field{owner,ty:IrType::Known(ty),..}if *owner==model && ty==&right.ty))
        }
        IrExpr::Binary { left, right, .. } => {
            predicate(ir, context, left, roots, values, stack, depth + 1)
                && predicate(ir, context, right, roots, values, stack, depth + 1)
        }
        IrExpr::Unary { operand, .. } => {
            predicate(ir, context, operand, roots, values, stack, depth + 1)
        }
        IrExpr::Member { base, field } => {
            if field == "now"
                && value.ty == ResolvedType::Scalar(Scalar::Datetime)
                && base.ty == ResolvedType::Unknown
                && matches!(&base.expr,IrExpr::Name(name)if name=="c")
            {
                return true;
            }
            if field == "parent" && record_model(ir, value, roots, 0).is_some() {
                return true;
            }
            if let Some(model) = record_model(ir, base, roots, 0) {
                let Some(IrItem {
                    kind: IrItemKind::Model { fields, .. },
                    ..
                }) = ir.items.get(model.0 as usize)
                else {
                    return false;
                };
                return fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|item|item.name==*field
                    &&matches!(&item.kind,IrItemKind::Field{owner,ty:IrType::Known(ty),..}
                        if *owner==model&&control_type(ty)&&(ty==&value.ty||matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty))));
            }
            control_type(&base.ty)
                && control_type(&value.ty)
                && predicate(ir, context, base, roots, values, stack, depth + 1)
        }
        IrExpr::Call {
            target: IrCallTarget::DeriveFn(name),
            args,
        }
        | IrExpr::BoundCall {
            target: IrCallTarget::DeriveFn(name),
            args,
            ..
        } => {
            let Some(helper) = ir.items.iter().find(|item| item.canonical == *name) else {
                return false;
            };
            let IrItemKind::DeriveFn {
                params,
                expr: Some(body),
                ..
            } = &helper.kind
            else {
                return false;
            };
            if stack.len() >= 16 || !stack.insert(helper.id) {
                return false;
            }
            let slots = match &value.expr {
                IrExpr::BoundCall { slots, .. } => Some(slots),
                _ => None,
            };
            let mut callee = HashMap::new();
            let mut pure = BTreeSet::new();
            let mut used = BTreeSet::new();
            let valid = params.iter().enumerate().all(|(index, id)| {
                let Some(param) = ir.items.get(id.0 as usize) else {
                    return false;
                };
                let IrItemKind::Param {
                    owner,
                    ty: IrType::Known(ty),
                    default,
                    ..
                } = &param.kind
                else {
                    return false;
                };
                if *owner != helper.id {
                    return false;
                }
                let slot = slots
                    .map(|slots| slots.get(index).copied().flatten())
                    .unwrap_or(Some(index));
                let arg = if let Some(slot) = slot {
                    if !used.insert(slot) {
                        return false;
                    }
                    let Some(arg) = args.get(slot) else {
                        return false;
                    };
                    arg
                } else {
                    let Some(IrDefault::Literal(value)) = default else {
                        return false;
                    };
                    value
                };
                if let ResolvedType::Record {
                    symbol,
                    stored: true,
                } = ty
                {
                    let IrExpr::Name(name) = &arg.expr else {
                        return false;
                    };
                    if roots.get(name) != Some(symbol) || arg.ty != *ty {
                        return false;
                    }
                    callee.insert(param.name.clone(), *symbol);
                    true
                } else if control_type(ty)
                    && predicate(ir, context, arg, roots, values, stack, depth + 1)
                {
                    pure.insert(param.name.clone());
                    true
                } else {
                    false
                }
            }) && used.len() == args.len()
                && predicate(ir, context, body, &callee, &pure, stack, depth + 1);
            stack.remove(&helper.id);
            valid
        }
        _ => false,
    }
}
pub(super) fn model_corresponds(
    context: &super::source_context::FreshSourceContext<'_>,
    id: SymbolId,
) -> Option<()> {
    let (ir, fresh) = (context.ir(), context.fresh());
    let optional = |a: &Option<TypedExpr>, b: &Option<TypedExpr>| match (a, b) {
        (None, None) => Some(()),
        (Some(a), Some(b)) => context.same_expression(a, b),
        _ => None,
    };
    let (a, b) = (
        ir.items.get(id.0 as usize)?,
        fresh.items.get(id.0 as usize)?,
    );
    let (
        IrItemKind::Model {
            owner: ao,
            fields: af,
            ..
        },
        IrItemKind::Model {
            owner: bo,
            fields: bf,
            ..
        },
    ) = (&a.kind, &b.kind)
    else {
        return None;
    };
    if a.id != b.id
        || a.name != b.name
        || a.canonical != b.canonical
        || a.span != b.span
        || a.module != b.module
        || ao != bo
        || af != bf
    {
        return None;
    }
    let (am, bm) = (
        ir.modules.get(a.module.0 as usize)?,
        fresh.modules.get(b.module.0 as usize)?,
    );
    if am.id != bm.id
        || am.name != bm.name
        || am.kind != bm.kind
        || am.file != bm.file
        || am.span != bm.span
    {
        return None;
    }
    for id in af {
        let (a, b) = (
            ir.items.get(id.0 as usize)?,
            fresh.items.get(id.0 as usize)?,
        );
        if a.id != b.id
            || a.name != b.name
            || a.canonical != b.canonical
            || a.span != b.span
            || a.module != b.module
        {
            return None;
        }
        match (&a.kind, &b.kind) {
            (
                IrItemKind::Field {
                    owner: a,
                    ty: IrType::Known(at),
                    required_array: aa,
                    default: ad,
                    server: as_,
                    modifiers: am,
                    ..
                },
                IrItemKind::Field {
                    owner: b,
                    ty: IrType::Known(bt),
                    required_array: ba,
                    default: bd,
                    server: bs,
                    modifiers: bm,
                    ..
                },
            ) if a == b && at == bt && aa == ba => {
                match (ad, bd) {
                    (None, None) => {}
                    (Some(IrDefault::Literal(a)), Some(IrDefault::Literal(b))) => {
                        context.same_expression(a, b)?
                    }
                    (
                        Some(IrDefault::Computed {
                            expr: a,
                            has_parent: ap,
                        }),
                        Some(IrDefault::Computed {
                            expr: b,
                            has_parent: bp,
                        }),
                    ) if ap == bp => context.same_expression(a, b)?,
                    _ => return None,
                }
                match (as_, bs) {
                    (None, None)
                    | (Some(IrServer::Actor), Some(IrServer::Actor))
                    | (Some(IrServer::Now), Some(IrServer::Now)) => {}
                    (Some(IrServer::Computed(a)), Some(IrServer::Computed(b))) => {
                        context.same_expression(a, b)?
                    }
                    _ => return None,
                }
                if am.trim != bm.trim || am.unique != bm.unique || am.machine != bm.machine {
                    return None;
                }
                optional(&am.min, &bm.min)?;
                optional(&am.max, &bm.max)?;
            }
            (
                IrItemKind::DeriveField {
                    model: a,
                    ty: IrType::Known(at),
                    ..
                },
                IrItemKind::DeriveField {
                    model: b,
                    ty: IrType::Known(bt),
                    ..
                },
            ) if a == b && at == bt => {}
            _ => return None,
        }
    }
    Some(())
}
fn delivery_operation_matches(ir: &IrProgram, ty: &ResolvedType, actual: &str) -> bool {
    match ty {
        ResolvedType::Delivery { op } => ir
            .items
            .get(op.0 as usize)
            .is_some_and(|owner| owner.canonical == actual),
        ResolvedType::StdDelivery { capability, op } => {
            actual == format!("{capability}.{}", op.name)
        }
        _ => false,
    }
}

// A delivery identity is available only after that exact original SEND.
// Its payload is never treated as a plain value or a stored-row field grant.
fn loop_write_value(
    ir: &IrProgram,
    value: &TypedExpr,
    values: &BTreeSet<String>,
    deliveries: &HashMap<&String, &String>,
    item: &str,
    model: SymbolId,
) -> bool {
    if super::source_send_data::send_value(ir, value, values, 0) {
        return true;
    }
    match &value.expr {
        IrExpr::Name(name)
            if deliveries
                .get(name)
                .is_some_and(|actual| delivery_operation_matches(ir, &value.ty, actual)) =>
        {
            true
        }
        IrExpr::Name(name)
            if name == item
                && value.ty
                    == (ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    }) =>
        {
            true
        }
        IrExpr::Member { base, field }
            if field == "version"
                && value.ty == ResolvedType::Scalar(Scalar::Int)
                && matches!(&base.expr,IrExpr::Name(name)if name==item)
                && base.ty
                    == (ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    }) =>
        {
            true
        }
        IrExpr::Object(fields) => {
            fields.len() <= 200
                && fields
                    .iter()
                    .all(|(_, value)| loop_write_value(ir, value, values, deliveries, item, model))
        }
        IrExpr::Member { base, field }
            if field == "id" && value.ty == ResolvedType::Scalar(Scalar::Text) =>
        {
            let IrExpr::Name(name) = &base.expr else {
                return false;
            };
            deliveries
                .get(name)
                .is_some_and(|actual| delivery_operation_matches(ir, &base.ty, actual))
        }
        _ => false,
    }
}

fn conditional_send_set(body: &[IrStmt]) -> bool {
    matches!(
        body,
        [
            IrStmt::Send {
                binding: Some(_),
                when: None,
                ..
            },
            IrStmt::Set { when: None, .. }
        ]
    )
}

fn body_counts(
    ir: &IrProgram,
    context: &super::source_context::FreshSourceContext<'_>,
    body: &[IrStmt],
    item: &str,
    model: SymbolId,
    parameter: &str,
    parent_model: SymbolId,
    root_model: SymbolId,
    values: &BTreeSet<String>,
) -> Option<(usize, usize, Vec<serde_json::Value>)> {
    // LET phases currently prove only their original straight-line SET body.
    // Conditional CREATE/Work needs its independently sealed item prefix.
    if body
        .iter()
        .any(|statement| matches!(statement, IrStmt::Let { .. }))
        && body.iter().any(|statement| {
            !matches!(
                statement,
                IrStmt::Let { .. } | IrStmt::Set { when: None, .. }
            )
        })
    {
        return None;
    }
    let mut values = values.clone();
    let mut writes = 0;
    let mut sends = 0;
    let mut work = Vec::new();
    let mut deliveries = HashMap::new();
    for statement in body {
        match statement{
        IrStmt::Let{name,value,..} if super::source_let_data::capture_plain_value(ir,&value.ty,0)
            &&(super::source_let_data::query_value_expression(value).is_some()||super::source_send_data::send_value(ir,value,&values,0))=>{values.insert(name.clone());},
        IrStmt::If{cond,then_branch,else_branch,..}if else_branch.is_empty()
            && context.original().scenario_disclosures().values().filter_map(|checked|checked.source_facts())
                .any(|facts|facts.source_requires.as_deref().unwrap_or(&[]).iter().any(|site|
                    site.node.file==cond.span.file&&site.node.start==cond.span.start&&site.node.end==cond.span.end
                    &&matches!(site.position.as_slice(),[crate::analysis::scenario_disclosure::CheckedDecisionPosition::Body(_),crate::analysis::scenario_disclosure::CheckedDecisionPosition::Loop(_)])))=>{
            let (child_writes,child_sends,child_work)=body_counts(ir,context,then_branch,item,model,parameter,parent_model,root_model,&values)?;
            if child_sends!=0 && (body.len()!=1 || !conditional_send_set(then_branch) || child_sends!=1 || child_writes!=1 || !child_work.is_empty())
                || !child_work.is_empty()&&(child_writes!=0||child_work.len()!=1||child_work[0]["kind"]!="schedule"){return None;}
            sends+=child_sends;
            for mut site in child_work{site["stage"]=serde_json::json!(writes+site["stage"].as_u64()? as usize);site["conditional"]=serde_json::json!(true);work.push(site);}writes+=child_writes;
        },
        IrStmt::Set{record,changes,when:None,..}if (matches!(&record.expr,IrExpr::Name(name)if name==item)
            &&record.ty==(ResolvedType::Record{symbol:model,stored:true})
            || matches!(&record.expr,IrExpr::Name(name)if name==parameter)
                &&record.ty==(ResolvedType::Record{symbol:root_model,stored:true}))
            &&loop_write_value(ir,changes,&values,&deliveries,item,model)=>{writes+=1;},
        IrStmt::Cancel{key,span,..}|IrStmt::Schedule{key,span,..}=>{
            if !matches!(&key.expr,IrExpr::Member{base,field}if field=="id"&&matches!(&base.expr,IrExpr::Name(name)if name==item)
                &&base.ty==(ResolvedType::Record{symbol:model,stored:true}))||key.ty!=ResolvedType::Scalar(Scalar::Text){return None;}
            let kind=if matches!(statement,IrStmt::Cancel{..}){"cancel"}else{"schedule"};
            work.push(serde_json::json!({"kind":kind,"node":{"start":span.start,"end":span.end},"stage":writes}));
        },
        IrStmt::Send{operation,deployment_binding:Some(_),binding,when:None,..}=>{
            sends+=1;if let Some(name)=binding&& deliveries.insert(name,operation).is_some(){return None;}
        },
        IrStmt::Create{model:created,input,when:None,..}=>{
            let target=ir.items.iter().find(|candidate|candidate.canonical==*created)?;
            if !matches!(target.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==model||parent==parent_model){return None;}
            model_corresponds(context,target.id)?;
            let IrExpr::Object(fields)=&input.expr else{return None;};
            if fields.iter().filter(|(field,_)|field=="parent").count()!=1{return None;}
            for (field,value) in fields{
                if field=="parent"{
                    let expected=if matches!(target.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==model){(item,model)}else{(parameter,parent_model)};
                    if !matches!(&value.expr,IrExpr::Name(name)if name==expected.0)||value.ty!=(ResolvedType::Record{symbol:expected.1,stored:true}){return None;}
                }else if matches!(&value.expr,IrExpr::Name(name)if name==item)&&value.ty==(ResolvedType::Record{symbol:model,stored:true}){
                    // The actual selected view remains an opaque reference; ordinary
                    // CREATE reference authorization still owns the target grant.
                }else if !super::source_send_data::send_value(ir,value,&values,0){
                    let IrExpr::Name(name)=&value.expr else{return None;};
                    if !deliveries.get(name).is_some_and(|actual|delivery_operation_matches(ir,&value.ty,actual)){return None;}
                }
            }
            writes+=1;
        },
        _=>return None,
    }
    }
    ((writes > 0 || !work.is_empty()) && writes <= 4 && sends <= 2 && work.len() <= 2)
        .then_some((writes, sends, work))
}
pub(super) fn collect(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    requires: &HashMap<Span, serde_json::Value>,
    module: &str,
) -> Option<serde_json::Value> {
    let source = &requires
        .values()
        .find(|source| source["owner"] == owner.canonical)?["source"];
    let plan = collect_from_source(ir, owner, context, source, module)?;
    // The declaration stays finite; only reached per-item branches consume
    // State's unchanged shared 200-guard execution budget.
    let guards = requires
        .values()
        .filter(|source| source["owner"] == owner.canonical)
        .count();
    (guards <= 200).then_some(plan)
}

pub(super) fn collect_native(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    source: &serde_json::Value,
    module: &str,
) -> Option<serde_json::Value> {
    let IrItemKind::Scenario {
        result: None,
        effects,
        hook: None,
        read: false,
        trusted: false,
        event_source: None,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut candidates = effects.iter().filter_map(|statement| {
        let IrStmt::For { body, span, .. } = statement else { return None; };
        let constructor = matches!(body.as_slice(), [IrStmt::Create { .. }])
            || matches!(body.as_slice(), [IrStmt::If { then_branch, else_branch, .. }]
                if else_branch.is_empty() && matches!(then_branch.as_slice(), [IrStmt::Create { .. }]));
        let commands = !body.is_empty()
            && body.iter().all(|statement| matches!(statement,
                IrStmt::Set { when: None, .. } | IrStmt::Send { when: None, .. } | IrStmt::Cancel { .. }))
            || matches!(body.as_slice(),[IrStmt::If{then_branch,else_branch,..}]
                if else_branch.is_empty() && conditional_send_set(then_branch));
        ((constructor && effects.last().is_some_and(|last| std::ptr::eq(last, statement))) || commands)
            .then_some((*span, commands))
    });
    let (span, commands) = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    let plan = collect_from_source(ir, owner, context, source, module)?;
    let loops = plan["loops"].as_array()?;
    (loops.len() == 1
        && loops[0]["node"]["start"] == span.start
        && loops[0]["node"]["end"] == span.end
        && (commands || loops[0]["sends"] == 0))
        .then_some(plan)
}

/// Reuse the exact source loop census for a nongrant phase prefix proof.
pub(super) fn collect_phase_prefix(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    source: &serde_json::Value,
    module: &str,
) -> Option<serde_json::Value> {
    collect_from_source(ir, owner, context, source, module)
}

fn collect_from_source(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    source: &serde_json::Value,
    module: &str,
) -> Option<serde_json::Value> {
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
    context.same_scenario(ir, owner)?;
    let roots: HashMap<_, _> = params
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
            Some((param.name.clone(), *symbol))
        })
        .collect();
    let values: BTreeSet<_> = params
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
    fn walk(
        ir: &IrProgram,
        context: &super::source_context::FreshSourceContext<'_>,
        owner: &IrItem,
        body: &[IrStmt],
        roots: &mut HashMap<String, SymbolId>,
        values: &mut BTreeSet<String>,
        source: &serde_json::Value,
        out: &mut Vec<serde_json::Value>,
    ) -> Option<()> {
        for statement in body {
            match statement {
                IrStmt::Let { name, value, .. } => {
                    // This names the original once-only plain DATA value;
                    // source_let_data independently proves its executed reads.
                    let plain = super::source_send_data::plain_value(ir, &value.ty, 0);
                    roots.remove(name);
                    values.remove(name);
                    if plain {
                        values.insert(name.clone());
                    }
                }
                IrStmt::For {
                    item,
                    domain,
                    limit: Some(limit),
                    body,
                    span,
                } => {
                    let IrExpr::Int(maximum) = limit.expr else {
                        return None;
                    };
                    if !(1..=1000).contains(&maximum) || out.len() >= 200 {
                        return None;
                    }
                    let IrExpr::Query(query) = &domain.expr else {
                        return None;
                    };
                    let IrQueryDomain::Model(model) = &query.domain else {
                        return None;
                    };
                    let model = ir
                        .items
                        .iter()
                        .find(|candidate| candidate.canonical == *model)?;
                    let mut parent_depth = 0;
                    let mut parent_path = Vec::new();
                    let (parameter, parent_model, ancestors) = if let Some(parent) =
                        query.parent.as_deref()
                    {
                        let paths = roots
                            .iter()
                            .map(|(name, model)| (name.clone(), *model))
                            .collect::<BTreeMap<_, _>>();
                        let (parameter, root_model, path) =
                            super::source_send_data::scalar_field_receiver(ir, parent, &paths)?;
                        model_corresponds(context, root_model)?;
                        for (_, target, _) in &path {
                            model_corresponds(context, *target)?;
                        }
                        // Keep existing containment transport stable; reference paths
                        // reuse the effect DATA edge schema and permission observations.
                        let parent_model = path
                            .last()
                            .map(|(_, model, _)| *model)
                            .unwrap_or(root_model);
                        if path
                            .iter()
                            .all(|(field, _, nullable)| field == "parent" && !nullable)
                        {
                            if path.len() > 2 {
                                return None;
                            }
                            parent_depth = path.len();
                        } else {
                            // The existing required-reference analysis permits one
                            // original stored edge after at most two containment hops.
                            if path.iter().any(|(_, _, nullable)| *nullable)
                                || path.len() > 3
                                || path[..path.len() - 1]
                                    .iter()
                                    .any(|(field, _, _)| field != "parent")
                            {
                                return None;
                            }
                            parent_path = path.iter().map(|(field, model, _)| serde_json::json!({"field":field,"model":ir.items[model.0 as usize].canonical})).collect();
                        }
                        if !matches!(model.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==parent_model)
                        {
                            return None;
                        }
                        (parameter, parent_model, Vec::new())
                    } else {
                        let (parameter, parent, ancestors) = descendant_parameter(
                            ir,
                            query.where_pred.as_deref()?,
                            &query.where_param,
                            model.id,
                            roots,
                        )?;
                        (parameter.to_owned(), parent, ancestors)
                    };
                    if item == &parameter {
                        return None;
                    }
                    let mut predicate_roots = roots.clone();
                    predicate_roots.insert(query.where_param.clone(), model.id);
                    if !matches!(&domain.ty,ResolvedType::Array{element,ordered:true,..}if element.as_ref()==&ResolvedType::Record{symbol:model.id,stored:true})
                        || query.select.is_some()
                        || query.select_param.is_some()
                        || !query.order.is_empty()
                        || query.value_order.is_some()
                        || query.limit.is_some()
                        || query.archived.is_some()
                        || query.where_pred.as_deref().is_some_and(|value| {
                            value.ty != ResolvedType::Scalar(Scalar::Bool)
                                || !predicate(
                                    ir,
                                    context,
                                    value,
                                    &predicate_roots,
                                    values,
                                    &mut HashSet::new(),
                                    0,
                                )
                        })
                    {
                        return None;
                    }
                    for ancestor in &ancestors {
                        model_corresponds(context, *ancestor)?;
                    }
                    model_corresponds(context, parent_model)?;
                    model_corresponds(context, model.id)?;
                    let (writes, sends, work) = body_counts(
                        ir,
                        context,
                        body,
                        item,
                        model.id,
                        &parameter,
                        parent_model,
                        *roots.get(&parameter)?,
                        values,
                    )?;
                    if work.iter().any(|site| site["kind"] == "schedule") {
                        let facts = context
                            .original()
                            .scenario_disclosures()
                            .get(&owner.id)?
                            .source_facts()?;
                        let mut plans = facts.member_work_loops.as_deref()?.iter().filter(|plan| {
                            plan.node.file == span.file
                                && plan.node.start == span.start
                                && plan.node.end == span.end
                        });
                        let plan = plans.next()?;
                        let mut statements = body.iter();
                        let set = if matches!(body.first(), Some(IrStmt::Set { .. })) {
                            statements.next()
                        } else {
                            None
                        };
                        let Some(IrStmt::Cancel { span: cancel, .. }) = statements.next() else {
                            return None;
                        };
                        let Some(IrStmt::If {
                            cond,
                            then_branch,
                            else_branch,
                            span: condition,
                        }) = statements.next()
                        else {
                            return None;
                        };
                        let [
                            IrStmt::Schedule {
                                event,
                                span: schedule,
                                ..
                            },
                        ] = then_branch.as_slice()
                        else {
                            return None;
                        };
                        let matches_node = |node: crate::analysis::NodeKey, span: Span| {
                            node.file == span.file
                                && node.start == span.start
                                && node.end == span.end
                        };
                        if plans.next().is_some()
                            || statements.next().is_some()
                            || !else_branch.is_empty()
                            || plan.item != *item
                            || plan.model != model.id
                            || ir.items.get(plan.parameter.0 as usize)?.name != parameter
                            || i128::from(plan.maximum) != maximum
                            || !matches_node(plan.domain, domain.span)
                            || !matches_node(plan.limit, limit.span)
                            || !matches_node(plan.cancel, *cancel)
                            || !matches_node(plan.condition, cond.span)
                            || !matches_node(plan.condition_statement, *condition)
                            || !matches_node(plan.schedule, *schedule)
                            || ir.items.get(plan.event.0 as usize)?.canonical != *event
                            || match (set, plan.set) {
                                (None, None) => false,
                                (Some(IrStmt::Set { span, .. }), Some(node)) => {
                                    !matches_node(node, *span)
                                }
                                _ => true,
                            }
                            || work.len() != 2
                            || work[0]["kind"] != "cancel"
                            || work[1]["kind"] != "schedule"
                            || work[1]["conditional"] != true
                        {
                            return None;
                        }
                    }
                    let id = crate::source::sha256_hex(
                        format!(
                            "source-body-loop/v1:{}:{}:{}:{}:{}",
                            source["path"], source["sha256"], owner.canonical, span.start, span.end
                        )
                        .as_bytes(),
                    );
                    let mut descriptor = serde_json::json!({"id":id,"node":{"start":span.start,"end":span.end},"domain":{"start":domain.span.start,"end":domain.span.end},
                    "maximum":maximum,"parameter":parameter,"parentModel":ir.items[parent_model.0 as usize].canonical,"model":model.canonical,
                    "item":item,"filtered":query.where_pred.is_some(),"writes":writes,"sends":sends});
                    if !work.is_empty() {
                        if work
                            .iter()
                            .filter(|site| site["conditional"] == true)
                            .count()
                            > 1
                        {
                            return None;
                        }
                        descriptor["work"] = serde_json::json!(work);
                        if let Some(IrStmt::If {
                            cond,
                            span: condition,
                            then_branch,
                            else_branch,
                        }) = body.last()
                        {
                            if !else_branch.is_empty()
                                || !matches!(then_branch.as_slice(), [IrStmt::Schedule { .. }])
                            {
                                return None;
                            }
                            descriptor["condition"] = serde_json::json!({"node":{"start":cond.span.start,"end":cond.span.end},"statement":{"start":condition.start,"end":condition.end}});
                        }
                    }
                    if parent_depth > 0 {
                        descriptor["parentDepth"] = serde_json::json!(parent_depth);
                    }
                    if !parent_path.is_empty() {
                        descriptor["parentPath"] = serde_json::json!(parent_path);
                    }
                    if !ancestors.is_empty() {
                        descriptor["ancestors"] = serde_json::Value::Array(
                            ancestors
                                .iter()
                                .map(|id| control_fields(ir, *id))
                                .collect::<Option<Vec<_>>>()?,
                        );
                        descriptor["control"] = control_fields(ir, model.id)?;
                    }
                    if work.is_empty()
                        && let [
                            IrStmt::If {
                                cond,
                                span: condition,
                                then_branch,
                                else_branch,
                            },
                        ] = body.as_slice()
                    {
                        if !else_branch.is_empty()
                            || !(matches!(
                                then_branch.as_slice(),
                                [IrStmt::Set { .. } | IrStmt::Create { .. }]
                            ) && sends == 0
                                || conditional_send_set(then_branch) && sends == 1)
                            || writes != 1
                        {
                            return None;
                        }
                        descriptor["condition"] = serde_json::json!({"node":{"start":cond.span.start,"end":cond.span.end},"statement":{"start":condition.start,"end":condition.end}});
                    }
                    out.push(descriptor);
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    walk(
                        ir,
                        context,
                        owner,
                        then_branch,
                        &mut roots.clone(),
                        &mut values.clone(),
                        source,
                        out,
                    )?;
                    walk(
                        ir,
                        context,
                        owner,
                        else_branch,
                        &mut roots.clone(),
                        &mut values.clone(),
                        source,
                        out,
                    )?;
                }
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        walk(
                            ir,
                            context,
                            owner,
                            &arm.body,
                            &mut roots.clone(),
                            &mut values.clone(),
                            source,
                            out,
                        )?;
                    }
                }
                _ => {}
            }
        }
        Some(())
    }
    let mut loops = Vec::new();
    walk(
        ir,
        context,
        owner,
        effects,
        &mut roots.clone(),
        &mut values.clone(),
        source,
        &mut loops,
    )?;
    let work = loops
        .iter()
        .map(|loop_| {
            Some(
                loop_["maximum"].as_u64()?
                    * (loop_["sends"].as_u64()?
                        + loop_
                            .get("work")
                            .and_then(|work| work.as_array())
                            .map_or(0, |work| work.len()) as u64),
            )
        })
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .sum::<u64>();
    if loops.is_empty()
        || loops
            .iter()
            .filter_map(|loop_| loop_["maximum"].as_u64())
            .sum::<u64>()
            > 1000
        || work > 200
    {
        return None;
    }
    Some(
        serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},"owner":owner.canonical,"loops":loops}),
    )
}
