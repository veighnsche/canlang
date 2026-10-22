//! Source-bound owner decision for the authored leave request.
//!
//! The ordinary single-query receipt cannot express a Category FIRST followed
//! by a bounded number of Allowance FIRSTs with CREATEs between them. Admit
//! only the complete checked flow; the executor owns one versioned decision
//! and observes every original read and write in source order.

use serde_json::{Value, json};

use crate::analysis::effects::{Effect, EffectTarget, EffectVerb};
use crate::analysis::resolve::{ModelOwner, SymbolId};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::types::{CheckedQueryClauseKind, SelectedCallTarget};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};

use super::ir::{IrItem, IrItemKind, IrStmt};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};
use super::send_guards::PreparedSendGuard;
use std::collections::HashMap;

const GUARDS: [&str; 3] = [
    "calendar.parent.user==actor and calendar.parent.active and from<=until and reviewer!=actor and leave_reviewer(reviewer) and can_work(reviewer,calendar.parent.home) and trim(reason)!=\"\"",
    "not any(calendar.Request as old,old.state in [pending,approved] and overlaps(from,add_days(until,1),old.from,add_days(old.until,1)))",
    "all(dates(from,add_days(until,1),3660) as day_date,any(calendar.Day as day,day.date==day_date))",
];
const CAN_WORK: &str = "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))";
const DAY_YEAR: &str = "date_year(row.date)";
const POLICY_FIRST: &str =
    "first(calendar.Category as category where category.name==bucket order=category.id)";
const SELECTED_DAYS: &str =
    "calendar.Day as day where from<=day.date and day.date<=until and day.working";
const ALLOWANCE_FIRST: &str = "first(calendar.parent.Allowance as allowance where allowance.year==year.key and allowance.bucket==policy.allowance_bucket order=allowance.id)";

fn raw<'a>(db: &'a SourceDb, node: NodeKey) -> Option<&'a str> {
    db.get(node.file)?
        .text
        .get(node.start as usize..node.end as usize)
}
fn text<'a>(db: &'a SourceDb, node: NodeKey) -> Option<&'a str> {
    Some(raw(db, node)?.trim())
}
fn span(node: NodeKey) -> Span {
    Span::new(node.file, node.start, node.end)
}
fn interval(node: NodeKey) -> Value {
    json!({"start":node.start,"end":node.end,"kind":node.kind})
}
fn plain_interval(node: NodeKey) -> Value {
    json!({"start":node.start,"end":node.end})
}
fn symbol(program: &CheckedProgram, canonical: &str) -> Option<SymbolId> {
    let mut found = program
        .symbols
        .iter()
        .filter(|item| item.canonical == canonical);
    let id = found.next()?.id;
    found.next().is_none().then_some(id)
}
fn record_is(program: &CheckedProgram, ty: &ResolvedType, canonical: &str) -> bool {
    matches!(ty,ResolvedType::Record{symbol,stored:true}
        if program.symbols.get(symbol.0 as usize).is_some_and(|item|item.canonical==canonical))
}
fn source(program: &CheckedProgram, db: &SourceDb, node: NodeKey) -> Option<Value> {
    let module = program
        .modules
        .iter()
        .filter(|module| {
            module.file == node.file
                && module.span.start <= node.start
                && node.end <= module.span.end
        })
        .min_by_key(|module| module.span.end - module.span.start)?;
    let file = db.get(node.file)?;
    (node.end as usize <= file.text.len() && file.sha256 == sha256_hex(file.text.as_bytes()))
        .then(|| json!({"path":file.path,"sha256":file.sha256,"module":module.name}))
}
fn site(
    program: &CheckedProgram,
    db: &SourceDb,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        return None;
    }
    let origin = source(program, db, node)?;
    let id = sha256_hex(
        format!(
            "leave-request/v1:{kind}:{}:{}:{}:{}:{}",
            origin["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"source":origin,"node":interval(node),"statement":interval(statement)}))
}
fn no_children(effect: &Effect) -> bool {
    effect.then_effects.is_empty() && effect.else_effects.is_empty() && effect.match_arms.is_empty()
}
fn args_match(db: &SourceDb, effect: &Effect, expected: &[(&str, Option<&str>)]) -> bool {
    effect.args.len() == expected.len()
        && effect
            .args
            .iter()
            .zip(expected)
            .all(|(arg, (name, value))| {
                arg.key == *name
                    && match (arg.value, value) {
                        (None, None) => true,
                        (Some(node), Some(want)) => text(db, node) == Some(*want),
                        _ => false,
                    }
            })
}
fn unique_call(program: &CheckedProgram, within: NodeKey, target: SymbolId) -> Option<NodeKey> {
    let mut found=program.types.selected_calls.iter().filter(|(node,call)|
        node.file==within.file && within.start<=node.start && node.end<=within.end
        && matches!(call.target,SelectedCallTarget::DeriveFn(id)|SelectedCallTarget::Role(id) if id==target))
        .map(|(node,_)|*node);
    let node = found.next()?;
    found.next().is_none().then_some(node)
}
fn unique_collection(
    program: &CheckedProgram,
    within: NodeKey,
    model: SymbolId,
    builtin: &str,
) -> Option<NodeKey> {
    let mut found = program
        .types
        .checked_collection_calls
        .values()
        .filter(|call| {
            call.node.file == within.file
                && within.start <= call.node.start
                && call.node.end <= within.end
                && call.model == model
                && call.builtin == builtin
        })
        .map(|call| call.node);
    let node = found.next()?;
    found.next().is_none().then_some(node)
}
fn query_site(
    program: &CheckedProgram,
    db: &SourceDb,
    node: NodeKey,
    model: &str,
    stage: &str,
    owner_path: &[&str],
    order: &[&str],
    derive_chain: Vec<Value>,
) -> Option<Value> {
    let model_id = symbol(program, model)?;
    let (query_node, alias, predicate, call) = if let Some(fact) = program
        .types
        .checked_collection_calls
        .get(&node)
        .filter(|fact| fact.model == model_id && (fact.builtin == "any" || fact.builtin == "all"))
    {
        if !order.is_empty() {
            return None;
        }
        (fact.query, fact.alias, fact.predicate.as_ref()?.node, node)
    } else if let Some(selected) = program.types.selected_calls.get(&node).filter(|selected| {
        matches!(&selected.target,SelectedCallTarget::Builtin{id,overload}
            if id=="first" && *overload==0)
    }) {
        let [query] = selected.arguments.as_slice() else {
            return None;
        };
        let fact = program.types.checked_collection_calls.get(&node)?;
        if fact.model != model_id || fact.builtin != "first" || fact.query != *query {
            return None;
        }
        let checked = program.types.checked_queries.get(query)?;
        let [alias, where_clause, order_clause] = checked.clauses.as_slice() else {
            return None;
        };
        if !matches!(alias.kind, CheckedQueryClauseKind::As { .. })
            || !matches!(where_clause.kind, CheckedQueryClauseKind::Where)
            || !matches!(order_clause.kind, CheckedQueryClauseKind::Order)
            || where_clause.expressions.len() != 1
            || order_clause.expressions.len() != order.len()
            || order_clause
                .expressions
                .iter()
                .zip(order)
                .any(|(actual, want)| text(db, *actual) != Some(*want))
        {
            return None;
        }
        (*query, alias.node, where_clause.expressions[0], node)
    } else {
        let checked = program.types.checked_queries.get(&node)?;
        let [alias, where_clause] = checked.clauses.as_slice() else {
            return None;
        };
        if !order.is_empty()
            || !matches!(alias.kind, CheckedQueryClauseKind::As { .. })
            || !matches!(where_clause.kind, CheckedQueryClauseKind::Where)
            || where_clause.expressions.len() != 1
        {
            return None;
        }
        (node, alias.node, where_clause.expressions[0], node)
    };
    let checked = program.types.checked_queries.get(&query_node)?;
    if !matches!(&checked.domain_type,ResolvedType::Array{element,..} if record_is(program,element,model))
        || !matches!(program.effects.models.get(&model_id)?.owner,
            ModelOwner::Team if owner_path.is_empty()
        ) && !matches!(program.effects.models.get(&model_id)?.owner,ModelOwner::ChildOf(_)
            if !owner_path.is_empty())
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let origin = source(program, db, call)?;
    let id = sha256_hex(
        format!(
            "leave-query/v1:{stage}:{model}:{}:{}:{}:{derive_chain:?}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":stage,"model":model,"source":origin,
        "callSite":interval(call),"aliasSite":interval(alias),"predicateSite":interval(predicate),
        "domainKind":if owner_path.is_empty(){"team"}else{"child"},"ownerPath":owner_path,
        "order":order,"deriveChain":derive_chain}))
}
fn frame(program: &CheckedProgram, db: &SourceDb, call: NodeKey, derive: &str) -> Option<Value> {
    Some(json!({"source":source(program,db,call)?,"callSite":interval(call),"derive":derive}))
}
fn original_ir_match(context: &FreshSourceContext<'_>, item: &IrItem) -> Option<()> {
    let fresh = context.fresh().items.get(item.id.0 as usize)?;
    (fresh.canonical == item.canonical
        && format!("{:?}", fresh.kind) == format!("{:?}", item.kind)
        && format!("{:?}", context.fresh().modules) == format!("{:?}", context.ir().modules))
    .then_some(())
}
fn checked_closure(
    context: &FreshSourceContext<'_>,
    scenario: NodeKey,
    helpers: &[SymbolId],
    models: &[SymbolId],
) -> Option<()> {
    let program = context.original();
    let mut spans = vec![span(scenario)];
    for id in helpers {
        let original = program.effects.derives.get(id)?;
        spans.push(span(original.node));
        let current = context.ir().items.get(id.0 as usize)?;
        let fresh = context.fresh().items.get(id.0 as usize)?;
        if current.canonical != fresh.canonical
            || format!("{:?}", current.kind) != format!("{:?}", fresh.kind)
        {
            return None;
        }
    }
    for id in models {
        spans.push(span(program.effects.models.get(id)?.node));
        let current = context.ir().items.get(id.0 as usize)?;
        let fresh = context.fresh().items.get(id.0 as usize)?;
        if current.canonical != fresh.canonical
            || format!("{:?}", current.kind) != format!("{:?}", fresh.kind)
        {
            return None;
        }
    }
    let overlaps = |left: Span, right: Span| {
        left.file == right.file && left.start < right.end && right.start < left.end
    };
    (!context.ir_diagnostics().iter().any(|diagnostic| {
        diagnostic.severity == crate::diagnostic::Severity::Error
            && spans.iter().any(|site| {
                overlaps(*site, diagnostic.primary)
                    || diagnostic
                        .related
                        .iter()
                        .any(|related| overlaps(*site, related.span))
            })
    }))
    .then_some(())
}

pub(super) fn prepare_leave(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<Value> {
    if owner.canonical != "leave.request" {
        return None;
    }
    original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let employee = symbol(program, "employee.Employee")?;
    let calendar = symbol(program, "leave.Calendar")?;
    let category = symbol(program, "leave.Category")?;
    let day = symbol(program, "leave.Day")?;
    let allowance = symbol(program, "leave.Allowance")?;
    let request = symbol(program, "leave.Request")?;
    let portion = symbol(program, "leave.Portion")?;
    let role = symbol(program, "leave.leave_reviewer")?;
    let work = symbol(program, "employee.can_work")?;
    let year = symbol(program, "leave.Day.year")?;
    checked_closure(
        context,
        scenario.node,
        &[work, year],
        &[
            employee, calendar, category, day, allowance, request, portion,
        ],
    )?;
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.and_then(|node| text(db, node)) != Some("members")
        || scenario.params.len() != 6
        || scenario.guards.len() != 3
        || scenario.effects.len() != 6
        || program.effects.models.get(&calendar)?.owner != ModelOwner::ChildOf(employee)
        || [category, day, request].iter().any(|id| {
            program
                .effects
                .models
                .get(id)
                .is_none_or(|data| data.owner != ModelOwner::ChildOf(calendar))
        })
        || program.effects.models.get(&allowance)?.owner != ModelOwner::ChildOf(employee)
        || program.effects.models.get(&portion)?.owner != ModelOwner::ChildOf(request)
    {
        return None;
    }
    for (param, (name, ty)) in scenario.params.iter().zip([
        ("calendar", "leave.Calendar"),
        ("from", "date"),
        ("until", "date"),
        ("bucket", "text"),
        ("reason", "text"),
        ("reviewer", "user"),
    ]) {
        if program.symbols.get(param.param.0 as usize)?.name != name
            || param.default.is_some()
            || !program
                .types
                .symbol_types
                .get(&param.param)
                .is_some_and(|actual| match ty {
                    "date" => *actual == ResolvedType::Scalar(Scalar::Date),
                    "text" => *actual == ResolvedType::Scalar(Scalar::Text),
                    "user" => *actual == ResolvedType::Scalar(Scalar::User),
                    model => record_is(program, actual, model),
                })
        {
            return None;
        }
    }
    let mut header = Vec::new();
    for (index, guard) in scenario.guards.iter().enumerate() {
        let cond = guard.cond?;
        if guard.verb != EffectVerb::Require
            || !no_children(guard)
            || text(db, cond) != Some(GUARDS[index])
            || program.types.node_types.get(&cond) != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
        header.push(site(program, db, cond, guard.node, "header")?);
    }
    let [
        policy_let,
        policy_require,
        selected_let,
        selected_require,
        create_request,
        year_for,
    ] = scenario.effects.as_slice()
    else {
        return None;
    };
    let [allowance_let, allowance_require, create_portion] = year_for.then_effects.as_slice()
    else {
        return None;
    };
    if policy_let.verb != EffectVerb::Let
        || policy_let.binding.as_deref() != Some("policy")
        || policy_let.value.and_then(|node| text(db, node)) != Some(POLICY_FIRST)
        || !no_children(policy_let)
        || policy_require.verb != EffectVerb::Require
        || policy_require.cond.and_then(|node| text(db, node)) != Some("policy!=null")
        || !no_children(policy_require)
        || selected_let.verb != EffectVerb::Let
        || selected_let.binding.as_deref() != Some("selected")
        || selected_let.value.and_then(|node| text(db, node)) != Some(SELECTED_DAYS)
        || !no_children(selected_let)
        || selected_require.verb != EffectVerb::Require
        || selected_require.cond.and_then(|node| text(db, node)) != Some("count(selected)>0")
        || !no_children(selected_require)
        || create_request.verb != EffectVerb::Create
        || create_request.binding.as_deref() != Some("request")
        || !matches!(create_request.target,Some(EffectTarget::Model(id)) if id==request)
        || !no_children(create_request)
        || !args_match(
            db,
            create_request,
            &[
                ("parent", Some("calendar")),
                ("location", Some("calendar.parent.home")),
                ("from", None),
                ("until", None),
                ("bucket", None),
                ("reason", None),
                ("reviewer", None),
                ("timezone", Some("calendar.timezone")),
                ("allowance_bucket", Some("policy.allowance_bucket")),
                ("calendar_version", Some("calendar.revision")),
            ],
        )
        || year_for.verb != EffectVerb::For
        || year_for.item.as_deref() != Some("year")
        || year_for.domain.and_then(|node| text(db, node))
            != Some("group(selected as day,day.year)")
        || year_for.limit.and_then(|node| text(db, node)) != Some("10")
        || !year_for.else_effects.is_empty()
        || !year_for.match_arms.is_empty()
        || allowance_let.verb != EffectVerb::Let
        || allowance_let.binding.as_deref() != Some("allowance")
        || allowance_let.value.and_then(|node| text(db, node)) != Some(ALLOWANCE_FIRST)
        || !no_children(allowance_let)
        || allowance_require.verb != EffectVerb::Require
        || allowance_require.cond.and_then(|node| text(db, node))
            != Some("policy.allowance_bucket==null or allowance!=null")
        || !no_children(allowance_require)
        || create_portion.verb != EffectVerb::Create
        || create_portion.binding.as_deref() != Some("portion")
        || !matches!(create_portion.target,Some(EffectTarget::Model(id)) if id==portion)
        || !args_match(
            db,
            create_portion,
            &[
                ("parent", Some("request")),
                ("allowance", None),
                ("days", Some("count(year.items)")),
                ("dates", Some("year.items as day select day.date")),
            ],
        )
        || !no_children(create_portion)
    {
        return None;
    }
    let IrItemKind::Scenario {
        guards,
        effects,
        read: false,
        result: None,
        trusted: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if guards.len() != 3
        || effects.len() != 6
        || !guards
            .iter()
            .zip(&scenario.guards)
            .all(|(ir, source)| matches!(ir,IrStmt::Require{span:s,..} if *s==span(source.node)))
        || !matches!(&effects[0],IrStmt::Let{name,value,span:s} if name=="policy" && *s==span(policy_let.node)
            && value.span==span(policy_let.value?))
        || !matches!(&effects[2],IrStmt::Let{name,value,span:s} if name=="selected" && *s==span(selected_let.node)
            && value.span==span(selected_let.value?))
        || !matches!(&effects[4],IrStmt::Create{model,binding,span:s,..} if model=="leave.Request"
            && binding.as_deref()==Some("request") && *s==span(create_request.node))
        || !matches!(&effects[5],IrStmt::For{item,limit:Some(_),body,span:s,..} if item=="year"
            && body.len()==3 && *s==span(year_for.node))
    {
        return None;
    }
    let work_expr = program.effects.derives.get(&work)?.expr?;
    let year_expr = program.effects.derives.get(&year)?.expr?;
    if text(db, work_expr) != Some(CAN_WORK)
        || text(db, year_expr) != Some(DAY_YEAR)
        || program.types.symbol_results.get(&work)
            != Some(&Some(ResolvedType::Scalar(Scalar::Bool)))
        || program.types.node_types.get(&year_expr) != Some(&ResolvedType::Scalar(Scalar::Int))
    {
        return None;
    }
    let role_call = unique_call(program, scenario.guards[0].cond?, role)?;
    let work_call = unique_call(program, scenario.guards[0].cond?, work)?;
    if text(db, role_call) != Some("leave_reviewer(reviewer)")
        || text(db, work_call) != Some("can_work(reviewer,calendar.parent.home)")
        || !matches!(program.types.selected_calls.get(&role_call)?.target,SelectedCallTarget::Role(id) if id==role)
        || program
            .types
            .selected_calls
            .get(&role_call)?
            .arguments
            .len()
            != 1
        || program.types.selected_calls.get(&role_call)?.slots != [Some(0)]
        || text(
            db,
            program.types.selected_calls.get(&role_call)?.arguments[0],
        ) != Some("reviewer")
    {
        return None;
    }
    let employee_any = unique_collection(program, work_expr, employee, "any")?;
    let request_any = unique_collection(program, scenario.guards[1].cond?, request, "any")?;
    let day_any = unique_collection(program, scenario.guards[2].cond?, day, "any")?;
    let category_first = unique_collection(program, policy_let.value?, category, "first")?;
    let allowance_first = unique_collection(program, allowance_let.value?, allowance, "first")?;
    if category_first != policy_let.value? || allowance_first != allowance_let.value? {
        return None;
    }
    let query_sites = vec![
        query_site(
            program,
            db,
            employee_any,
            "employee.Employee",
            "header",
            &[],
            &[],
            vec![frame(program, db, work_call, "employee.can_work")?],
        )?,
        query_site(
            program,
            db,
            request_any,
            "leave.Request",
            "header",
            &["calendar"],
            &[],
            vec![],
        )?,
        query_site(
            program,
            db,
            day_any,
            "leave.Day",
            "header",
            &["calendar"],
            &[],
            vec![],
        )?,
        query_site(
            program,
            db,
            category_first,
            "leave.Category",
            "body",
            &["calendar"],
            &["category.id"],
            vec![],
        )?,
        query_site(
            program,
            db,
            selected_let.value?,
            "leave.Day",
            "body",
            &["calendar"],
            &[],
            vec![],
        )?,
        query_site(
            program,
            db,
            allowance_first,
            "leave.Allowance",
            "year",
            &["calendar", "parent"],
            &["allowance.id"],
            vec![],
        )?,
    ];
    let origin = source(program, db, scenario.node)?;
    if origin["module"] != "leave" {
        return None;
    }
    let create_site = site(
        program,
        db,
        create_request.node,
        create_request.node,
        "request-create",
    )?;
    let portion_site = site(
        program,
        db,
        create_portion.node,
        create_portion.node,
        "portion-create",
    )?;
    Some(json!({"version":1,"owner":"leave.request","source":origin,
        "sites":{"header":header,
            "policyFirst":site(program,db,policy_let.value?,policy_let.node,"policy-first")?,
            "policyRequire":site(program,db,policy_require.cond?,policy_require.node,"policy-require")?,
            "selectedDays":site(program,db,selected_let.value?,selected_let.node,"selected-days")?,
            "selectedRequire":site(program,db,selected_require.cond?,selected_require.node,"selected-require")?,
            "requestCreate":json!({"id":create_site["id"],"source":create_site["source"],
                "node":create_site["node"],"statement":create_site["statement"],"model":"leave.Request"}),
            "yearLoop":json!({"id":site(program,db,year_for.domain?,year_for.node,"year-loop")?["id"],
                "source":source(program,db,year_for.node)?,"node":interval(year_for.domain?),
                "statement":interval(year_for.node),"limit":10}),
            "allowanceFirst":site(program,db,allowance_let.value?,allowance_let.node,"allowance-first")?,
            "allowanceRequire":site(program,db,allowance_require.cond?,allowance_require.node,"allowance-require")?,
            "portionCreate":json!({"id":portion_site["id"],"source":portion_site["source"],
                "node":portion_site["node"],"statement":portion_site["statement"],"model":"leave.Portion"})},
        "roleSite":site(program,db,role_call,scenario.guards[0].node,"role")?,
        "membershipSite":site(program,db,scenario.guards[0].cond?,scenario.guards[0].node,"membership")?,
        "querySites":query_sites}))
}

pub(super) fn collect_leave_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_leave(context, item)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let file = context.db().get(scenario.node.file)?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "leave".into(),
        },
        entry_module,
    )?;
    let id = sha256_hex(
        format!(
            "leave-request-void/v1:{}:{}:{}",
            source.sha256, scenario.node.start, scenario.node.end
        )
        .as_bytes(),
    );
    Some(NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            version: 1,
            source: source.clone(),
            event_decision: None,
            term_decision: None,
            leave_request_decision: Some(decision),
            leave_decide_decision: None, refer_reject_decision: None, member_retry_decision: None, invoice_overdue_decision: None, rent_movement_refund_decision: None,
            invoice_collect_decision: None, rent_notice_decision: None, invoice_issue_decision: None, observe_venue_decision: None, success_renewal_decision: None, purchase_receive_all: None, event_notice_audit: None,queries: Vec::new(),
            returns: vec![ReceiptReturn {
                id: id.clone(),
                source,
                influences: Vec::new(),
                dependencies: Vec::new(),
                intrinsics: Vec::new(),
                projection: None,
            }],
        },
        dependencies: Default::default(),
        intrinsics: Default::default(),
        decisions: Default::default(),
        decision_keys: Default::default(),
        calls: Default::default(),
        returns: vec![NativeReturn {
            id,
            span: item.span,
            decisions: Vec::new(),
            implicit: true,
            reference_result: None,
        }],
        current_revision: None,
    })
}

/// The imported employee helper's active_member runs only under the first
/// authored header Require inside the sealed owner decision.
pub(super) fn collect_leave_membership_sites(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<Value>> {
    let decision = prepare_leave(context, owner)?;
    collect_work_membership_sites(context,owner,Some(&decision),
        "can_work(reviewer,calendar.parent.home)")
}

pub(super) fn collect_leave_decide_membership_sites(
    context: &FreshSourceContext<'_>, owner: &IrItem,
) -> Option<Vec<Value>> {
    if owner.canonical!="leave.decide" {return None;}
    original_ir_match(context,owner)?;
    let program=context.original();
    let scenario=program.effects.scenarios.get(&owner.id)?;
    if scenario.guards.len()!=1 || scenario.guards[0].cond
        .and_then(|node|text(context.db(),node))!=Some(DECIDE_HEADER) {return None;}
    collect_work_membership_sites(context,owner,None,
        "can_work(actor,request.parent.parent.home)")
}

fn collect_work_membership_sites(
    context: &FreshSourceContext<'_>, owner: &IrItem,
    decision: Option<&Value>, expected_work: &str,
) -> Option<Vec<Value>> {
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let guard = scenario.guards.first()?;
    let cond = guard.cond?;
    if decision.is_some_and(|decision|decision["membershipSite"]["node"] != interval(cond)) {
        return None;
    }
    let work = symbol(program, "employee.can_work")?;
    let work_expr = program.effects.derives.get(&work)?.expr?;
    let outer = unique_call(program, cond, work)?;
    if text(db,outer)!=Some(expected_work) {return None;}
    let mut members = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, selected)| {
            node.file == work_expr.file
                && work_expr.start <= node.start
                && node.end <= work_expr.end
                && matches!(&selected.target,SelectedCallTarget::Builtin{id,overload}
            if id=="active_member" && *overload==0)
        });
    let (member, selected) = members.next()?;
    if members.next().is_some()
        || text(db, *member) != Some("active_member(person,team)")
        || selected.arguments.len() != 2
        || selected.slots != [Some(0), Some(1)]
        || text(db, selected.arguments[0]) != Some("person")
        || text(db, selected.arguments[1]) != Some("team")
        || program.types.node_types.get(member) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&selected.arguments[0])
            != Some(&ResolvedType::Scalar(Scalar::User))
        || program.types.node_types.get(&selected.arguments[1]) != Some(&ResolvedType::Team)
    {
        return None;
    }
    let fresh = context.program().types.selected_calls.get(member)?;
    if !matches!(&fresh.target,SelectedCallTarget::Builtin{id,overload}
            if id=="active_member" && *overload==0)
        || fresh.arguments != selected.arguments
        || fresh.slots != selected.slots
    {
        return None;
    }
    let call = json!({"source":source(program,db,*member)?,"node":plain_interval(*member),
    "target":{"kind":"builtin","id":"active_member","overload":0},
    "arguments":[{"node":plain_interval(selected.arguments[0]),"type":"user"},
        {"node":plain_interval(selected.arguments[1]),"type":"Team"}],
    "slots":[0,1],"defaults":[],"chain":[{
        "source":source(program,db,outer)?,
        "node":plain_interval(outer),
        "derive":"employee.can_work"
    }]});
    Some(vec![
        json!({"version":1,"source":source(program,db,cond)?,"owner":owner.canonical,
        "node":plain_interval(cond),"statement":plain_interval(guard.node),
        "stage":"body-condition","position":[{"kind":"guard","index":0}],"calls":[call]}),
    ])
}

const DECIDE_HEADER: &str = "request.state==pending and request.reviewer==actor and request.parent.parent.user!=actor and can_work(actor,request.parent.parent.home) and trim(reason)!=\"\"";
const DECIDE_ALL: &str = "all(request.Portion as portion,portion.allowance==null or portion.days<=portion.allowance.remaining)";
const REMAINING: &str = "row.days-sum(Portion as portion where portion.allowance==row and portion.parent.state==approved select portion.days)";
const DECIDE_WHEN: &str = "request.state==approved and request.schedule_source==operation.id and request.schedule_revision==reserve_revision";
const DECIDE_SEND_VALUE: &str = "{source=operation.id,employee=request.parent.parent.user,location=request.location.id,from=local_instant(request.from,\"00:00\",request.timezone,fold=earlier),until=local_instant(add_days(request.until,1),\"00:00\",request.timezone,fold=earlier),skill=\"absence\",kind=absence,revision=reserve_revision}";

/// A projected aggregate is distinct from a Boolean collection call: the
/// checked `sum` must consume exactly the global Portion query in the original
/// Allowance.remaining derive. Its dynamic Allowance receiver is passed by the
/// generated owner wrapper, never inferred from a JavaScript closure.
fn remaining_sum_site(
    program: &CheckedProgram,
    db: &SourceDb,
    derive: NodeKey,
) -> Option<Value> {
    let portion = symbol(program, "leave.Portion")?;
    let mut sums = program.types.selected_calls.iter().filter(|(node, call)| {
        node.file == derive.file && derive.start <= node.start && node.end <= derive.end
            && matches!(&call.target, SelectedCallTarget::Builtin { id, overload }
                if id == "sum" && *overload == 0)
    });
    let (call_node, sum) = sums.next()?;
    if sums.next().is_some() || sum.arguments.len() != 1 || sum.slots != [Some(0)] {
        return None;
    }
    let query_node = sum.arguments[0];
    let checked = program.types.checked_queries.get(&query_node)?;
    let [alias, predicate, projection] = checked.clauses.as_slice() else {
        return None;
    };
    if !matches!(&checked.domain_type, ResolvedType::Array { element, .. }
        if record_is(program, element, "leave.Portion"))
        || !matches!(&alias.kind, CheckedQueryClauseKind::As { name } if name == "portion")
        || !matches!(predicate.kind, CheckedQueryClauseKind::Where)
        || !matches!(projection.kind, CheckedQueryClauseKind::Select)
        || predicate.expressions.len() != 1
        || projection.expressions.len() != 1
        || text(db, checked.domain) != Some("Portion")
        || text(db, predicate.expressions[0])
            != Some("portion.allowance==row and portion.parent.state==approved")
        || text(db, projection.expressions[0]) != Some("portion.days")
        || program.types.node_types.get(&predicate.expressions[0])
            != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&projection.expressions[0])
            != Some(&ResolvedType::Scalar(Scalar::Int))
        || program.effects.models.get(&portion)?.owner != ModelOwner::ChildOf(symbol(program,"leave.Request")?)
    {
        return None;
    }
    let origin = source(program, db, *call_node)?;
    let id = sha256_hex(format!("leave-decide-sum/v1:{}:{}:{}",
        origin["sha256"].as_str()?, call_node.start, call_node.end).as_bytes());
    Some(json!({"id":id,"stage":"allowance","model":"leave.Portion",
        "source":origin,"callSite":interval(*call_node),"aliasSite":interval(alias.node),
        "predicateSite":interval(predicate.expressions[0]),
        "selectionSite":interval(projection.expressions[0]),
        "domainKind":"global","ownerPath":[],"order":[],"aggregate":"sum",
        "deriveChain":[{"source":source(program,db,derive)?,
            "callSite":interval(derive),"derive":"leave.Allowance.remaining"}]}))
}

/// Seal the whole serial approval/rejection body, including the `sum` used by
/// each dynamically reached Allowance. This profile never publishes a receipt
/// if the source, checked types, freshly lowered IR, or prepared SEND Rule
/// differs from the admitted authored flow.
pub(super) fn prepare_leave_decide(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    if owner.canonical != "leave.decide" { return None; }
    original_ir_match(context,owner)?;
    let program=context.original();
    let db=context.db();
    let scenario=program.effects.scenarios.get(&owner.id)?;
    let employee=symbol(program,"employee.Employee")?;
    let calendar=symbol(program,"leave.Calendar")?;
    let request=symbol(program,"leave.Request")?;
    let portion=symbol(program,"leave.Portion")?;
    let allowance=symbol(program,"leave.Allowance")?;
    let location=symbol(program,"rent_catalog.Location")?;
    let work=symbol(program,"employee.can_work")?;
    let remaining=symbol(program,"leave.Allowance.remaining")?;
    let role=symbol(program,"leave.leave_reviewer")?;
    checked_closure(context,scenario.node,&[work,remaining],
        &[employee,calendar,request,portion,allowance,location])?;
    if scenario.scenario!=owner.id || scenario.module!=owner.module || scenario.on.is_some()
        || scenario.read || scenario.scope_authority || scenario.cohort.is_some()
        || scenario.result.is_some() || scenario.guards.len()!=1
        || scenario.effects.len()!=2 || scenario.params.len()!=3
        || scenario.by.and_then(|node|text(db,node))!=Some("leave_reviewer")
        || program.effects.models.get(&calendar)?.owner!=ModelOwner::ChildOf(employee)
        || program.effects.models.get(&request)?.owner!=ModelOwner::ChildOf(calendar)
        || program.effects.models.get(&portion)?.owner!=ModelOwner::ChildOf(request)
        || program.effects.models.get(&allowance)?.owner!=ModelOwner::ChildOf(employee)
    { return None; }
    for (param,(name,ty)) in scenario.params.iter().zip([
        ("request","leave.Request"),("approve","bool"),("reason","text")]) {
        if program.symbols.get(param.param.0 as usize)?.name!=name || param.default.is_some()
            || !program.types.symbol_types.get(&param.param).is_some_and(|actual|match ty {
                "bool"=>*actual==ResolvedType::Scalar(Scalar::Bool),
                "text"=>*actual==ResolvedType::Scalar(Scalar::Text),
                model=>record_is(program,actual,model)
            }) { return None; }
    }
    let header=&scenario.guards[0];
    let [revision_let,approve_if]=scenario.effects.as_slice() else {return None};
    let [portion_require,approved_set,send,delivery_set]=approve_if.then_effects.as_slice() else {return None};
    let [rejected_set]=approve_if.else_effects.as_slice() else {return None};
    if header.verb!=EffectVerb::Require || !no_children(header)
        || header.cond.and_then(|node|text(db,node))!=Some(DECIDE_HEADER)
        || revision_let.verb!=EffectVerb::Let || !no_children(revision_let)
        || revision_let.binding.as_deref()!=Some("reserve_revision")
        || revision_let.value.and_then(|node|text(db,node))!=Some("request.schedule_revision")
        || approve_if.verb!=EffectVerb::If || approve_if.cond.and_then(|node|text(db,node))!=Some("approve")
        || !approve_if.match_arms.is_empty()
        || portion_require.verb!=EffectVerb::Require || !no_children(portion_require)
        || portion_require.cond.and_then(|node|text(db,node))!=Some(DECIDE_ALL)
        || approved_set.verb!=EffectVerb::Set || !no_children(approved_set)
        || !matches!(approved_set.target,Some(EffectTarget::Record{model:Some(id)}) if id==request)
        || !text(db,approved_set.node).is_some_and(|s|s.starts_with("set request "))
        || !args_match(db,approved_set,&[("state",Some("approved")),("decision",Some("reason")),
            ("schedule_source",Some("operation.id")),("sync",Some("pending"))])
        || send.verb!=EffectVerb::Send || !no_children(send)
        || send.target_node.and_then(|node|text(db,node))!=Some("StaffSchedule.reserve")
        || send.binding.as_deref()!=Some("delivery")
        || send.when.and_then(|node|text(db,node))!=Some(DECIDE_WHEN)
        || !args_match(db,send,&[("value",Some(DECIDE_SEND_VALUE))])
        || delivery_set.verb!=EffectVerb::Set || !no_children(delivery_set)
        || !matches!(delivery_set.target,Some(EffectTarget::Record{model:Some(id)}) if id==request)
        || !text(db,delivery_set.node).is_some_and(|s|s.starts_with("set request "))
        || !args_match(db,delivery_set,&[("reserve_delivery",Some("delivery.id"))])
        || rejected_set.verb!=EffectVerb::Set || !no_children(rejected_set)
        || !matches!(rejected_set.target,Some(EffectTarget::Record{model:Some(id)}) if id==request)
        || !text(db,rejected_set.node).is_some_and(|s|s.starts_with("set request "))
        || !args_match(db,rejected_set,&[("state",Some("rejected")),("decision",Some("reason"))])
    { return None; }
    let work_expr=program.effects.derives.get(&work)?.expr?;
    let remaining_expr=program.effects.derives.get(&remaining)?.expr?;
    if text(db,work_expr)!=Some(CAN_WORK) || text(db,remaining_expr)!=Some(REMAINING)
        || program.types.symbol_results.get(&work)!=Some(&Some(ResolvedType::Scalar(Scalar::Bool)))
        || program.types.node_types.get(&remaining_expr)!=Some(&ResolvedType::Scalar(Scalar::Int))
        || program.types.node_types.get(&header.cond?)!=Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&portion_require.cond?)!=Some(&ResolvedType::Scalar(Scalar::Bool))
    { return None; }
    let IrItemKind::Scenario {guards,effects,read:false,result:None,trusted:false,..}=&owner.kind else {return None};
    let [IrStmt::Require{span:header_span,..}]=guards.as_slice() else {return None};
    let [IrStmt::Let{name,value,span:let_span},IrStmt::If{cond,then_branch,else_branch,span:if_span}]=effects.as_slice() else {return None};
    if *header_span!=span(header.node) || name!="reserve_revision"
        || *let_span!=span(revision_let.node) || value.span!=span(revision_let.value?)
        || cond.span!=span(approve_if.cond?) || *if_span!=span(approve_if.node)
        || !matches!(then_branch.as_slice(),[
            IrStmt::Require{span:a,..},IrStmt::Set{span:b,..},
            IrStmt::Send{span:c,binding:Some(delivery),when:Some(_),..},
            IrStmt::Set{span:d,..}]
            if *a==span(portion_require.node) && *b==span(approved_set.node)
            && *c==span(send.node) && delivery=="delivery" && *d==span(delivery_set.node))
        || !matches!(else_branch.as_slice(),[IrStmt::Set{span:s,..}] if *s==span(rejected_set.node))
    { return None; }
    let work_call=unique_call(program,header.cond?,work)?;
    if text(db,work_call)!=Some("can_work(actor,request.parent.parent.home)") {return None;}
    let employee_any=unique_collection(program,work_expr,employee,"any")?;
    let portion_all=unique_collection(program,portion_require.cond?,portion,"all")?;
    let sum_site=remaining_sum_site(program,db,remaining_expr)?;
    let queries=vec![
        query_site(program,db,employee_any,"employee.Employee","header",&[],&[],
            vec![frame(program,db,work_call,"employee.can_work")?])?,
        query_site(program,db,portion_all,"leave.Portion","approve",&["request"],&[],vec![])?,
        sum_site,
    ];
    let guard=send_guards.get(&span(send.node))?;
    if guard.predicate.span!=span(send.when?) || guard.rule.is_empty() {return None;}
    let origin=source(program,db,scenario.node)?;
    if origin["module"]!="leave" {return None;}
    let when=site(program,db,send.when?,send.node,"decide-send")?;
    Some(json!({"version":1,"owner":"leave.decide","source":origin,
        "sites":{
            "header":site(program,db,header.cond?,header.node,"decide-header")?,
            "revisionLet":site(program,db,revision_let.value?,revision_let.node,"decide-revision")?,
            "approveIf":site(program,db,approve_if.cond?,approve_if.node,"decide-if")?,
            "portionRequire":site(program,db,portion_require.cond?,portion_require.node,"decide-portion")?,
            "approvedSet":{"id":site(program,db,approved_set.node,approved_set.node,"decide-approved")?["id"],
                "source":source(program,db,approved_set.node)?,"node":interval(approved_set.node),
                "statement":interval(approved_set.node),"model":"leave.Request"},
            "send":when.clone(),
            "deliverySet":{"id":site(program,db,delivery_set.node,delivery_set.node,"decide-delivery")?["id"],
                "source":source(program,db,delivery_set.node)?,"node":interval(delivery_set.node),
                "statement":interval(delivery_set.node),"model":"leave.Request"},
            "rejectedSet":{"id":site(program,db,rejected_set.node,rejected_set.node,"decide-rejected")?["id"],
                "source":source(program,db,rejected_set.node)?,"node":interval(rejected_set.node),
                "statement":interval(rejected_set.node),"model":"leave.Request"}
        },
        "roleSite":site(program,db,scenario.by?,scenario.node,"decide-role")?,
        "membershipSite":site(program,db,header.cond?,header.node,"decide-membership")?,
        "querySites":queries,
        "sendRule":{"rule":guard.rule,"source":when["source"],
            "node":when["node"],"statement":when["statement"]}}))
}

pub(super) fn collect_leave_decide_receipt(
    context: &FreshSourceContext<'_>, item: &IrItem, entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    let decision=prepare_leave_decide(context,item,send_guards)?;
    let scenario=context.original().effects.scenarios.get(&item.id)?;
    let file=context.db().get(scenario.node.file)?;
    let source=transport_source(&DisclosureSource{path:file.path.clone(),sha256:file.sha256.clone(),module:"leave".into()},entry_module)?;
    let id=sha256_hex(format!("leave-decide-void/v1:{}:{}:{}",source.sha256,scenario.node.start,scenario.node.end).as_bytes());
    Some(NativeScenarioReceipt{
        plan:ReceiptDisclosurePlan{version:1,source:source.clone(),event_decision:None,
            term_decision:None,leave_request_decision:None,leave_decide_decision:Some(decision),refer_reject_decision:None,member_retry_decision:None,invoice_overdue_decision:None,rent_movement_refund_decision:None,
            invoice_collect_decision: None, rent_notice_decision: None, invoice_issue_decision: None, observe_venue_decision: None, success_renewal_decision: None, purchase_receive_all: None, event_notice_audit: None,queries:Vec::new(),returns:vec![ReceiptReturn{id:id.clone(),source,
                influences:Vec::new(),dependencies:Vec::new(),intrinsics:Vec::new(),projection:None}]},
        dependencies:Default::default(),intrinsics:Default::default(),decisions:Default::default(),
        decision_keys:Default::default(),calls:Default::default(),
        returns:vec![NativeReturn{id,span:item.span,decisions:Vec::new(),implicit:true,reference_result:None}],
        current_revision:None,
    })
}
