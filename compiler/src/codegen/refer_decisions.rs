//! Source-stamped serial owner decision for a referral source reversal.
//!
//! The Credit FIRST follows a SourceEvidence write and controls a second,
//! absence-sensitive Credit scan. A single-query receipt cannot move either
//! read before that write. This profile admits the complete authored order.

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
    NativeReturn, NativeScenarioReceipt, NativeSite, ReceiptDisclosurePlan, ReceiptReturn,
    transport_source,
};

const HEADER: &str = "all(evidence.advocate.parent.locations as location,can_work(actor,location)) and trim(reason)!=\"\"";
const FIRST: &str = "first(evidence.advocate.Credit as credit where credit.source==evidence.source and credit.reversal==null order=credit.id)";
const BRANCH: &str =
    "credit!=null and not any(evidence.advocate.Credit as item,item.reversal==credit)";
const ABSENCE: &str = "any(evidence.advocate.Credit as item,item.reversal==credit)";
const CAN_WORK: &str = "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))";

fn text<'a>(db: &'a SourceDb, node: NodeKey) -> Option<&'a str> {
    db.get(node.file)?
        .text
        .get(node.start as usize..node.end as usize)
        .map(str::trim)
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
    let mut hits = program
        .symbols
        .iter()
        .filter(|symbol| symbol.canonical == canonical);
    let id = hits.next()?.id;
    hits.next().is_none().then_some(id)
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
            "refer-reject/v1:{kind}:{}:{}:{}:{}:{}",
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
    let mut hits = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, selected)| {
            node.file == within.file
                && within.start <= node.start
                && node.end <= within.end
                && matches!(selected.target,SelectedCallTarget::DeriveFn(id) if id==target)
        })
        .map(|(node, _)| *node);
    let hit = hits.next()?;
    hits.next().is_none().then_some(hit)
}
fn unique_collection(
    program: &CheckedProgram,
    within: NodeKey,
    model: SymbolId,
    builtin: &str,
) -> Option<NodeKey> {
    let mut hits = program
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
    let hit = hits.next()?;
    hits.next().is_none().then_some(hit)
}
fn fresh_match(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    scenario: NodeKey,
    helpers: &[SymbolId],
    models: &[SymbolId],
) -> Option<()> {
    let current = context.ir().items.get(item.id.0 as usize)?;
    let fresh = context.fresh().items.get(item.id.0 as usize)?;
    if current.canonical != fresh.canonical
        || format!("{:?}", current.kind) != format!("{:?}", fresh.kind)
        || format!("{:?}", context.ir().modules) != format!("{:?}", context.fresh().modules)
    {
        return None;
    }
    let mut spans = vec![span(scenario)];
    for id in helpers {
        spans.push(span(context.original().effects.derives.get(id)?.node));
        let current = context.ir().items.get(id.0 as usize)?;
        let fresh = context.fresh().items.get(id.0 as usize)?;
        if current.canonical != fresh.canonical
            || format!("{:?}", current.kind) != format!("{:?}", fresh.kind)
        {
            return None;
        }
    }
    for id in models {
        spans.push(span(context.original().effects.models.get(id)?.node));
        let current = context.ir().items.get(id.0 as usize)?;
        let fresh = context.fresh().items.get(id.0 as usize)?;
        if current.canonical != fresh.canonical
            || format!("{:?}", current.kind) != format!("{:?}", fresh.kind)
        {
            return None;
        }
    }
    let overlaps = |a: Span, b: Span| a.file == b.file && a.start < b.end && b.start < a.end;
    (!context.ir_diagnostics().iter().any(|diagnostic| {
        diagnostic.severity == crate::diagnostic::Severity::Error
            && spans.iter().any(|span| {
                overlaps(*span, diagnostic.primary)
                    || diagnostic
                        .related
                        .iter()
                        .any(|related| overlaps(*span, related.span))
            })
    }))
    .then_some(())
}

fn query_site(
    context: &FreshSourceContext<'_>,
    call: NodeKey,
    stage: &str,
    expected: &str,
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let credit = symbol(program, "refer.Credit")?;
    let fact = program.types.checked_collection_calls.get(&call)?;
    let fresh = context
        .program()
        .types
        .checked_collection_calls
        .get(&call)?;
    if fact.model != credit
        || fact.builtin != stage
        || format!("{:?}", fact) != format!("{:?}", fresh)
        || text(db, call) != Some(expected)
    {
        return None;
    }
    let (query, alias, predicate, order) = if stage == "first" {
        let selected = program.types.selected_calls.get(&call)?;
        let fresh_selected = context.program().types.selected_calls.get(&call)?;
        let [query] = selected.arguments.as_slice() else {
            return None;
        };
        if !matches!(&selected.target,SelectedCallTarget::Builtin{id,overload}
            if id=="first" && *overload==0)
            || format!("{:?}", selected) != format!("{:?}", fresh_selected)
            || fact.query != *query
        {
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
            || order_clause.expressions.len() != 1
            || text(db, order_clause.expressions[0]) != Some("credit.id")
        {
            return None;
        }
        (
            *query,
            alias.node,
            where_clause.expressions[0],
            vec!["credit.id"],
        )
    } else {
        if stage != "any" {
            return None;
        }
        (
            fact.query,
            fact.alias,
            fact.predicate.as_ref()?.node,
            Vec::new(),
        )
    };
    let checked = program.types.checked_queries.get(&query)?;
    if !matches!(&checked.domain_type,ResolvedType::Array{element,..}
        if record_is(program,element,"refer.Credit"))
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let origin = source(program, db, call)?;
    let id = sha256_hex(
        format!(
            "refer-reject-query/v1:{stage}:{}:{}:{}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(
        json!({"id":id,"stage":if stage=="first"{"first"}else{"absence"},
        "model":"refer.Credit","source":origin,"queryNode":interval(query),
        "callSite":interval(call),"aliasSite":interval(alias),"predicateSite":interval(predicate),
        "domainKind":"child","ownerPath":["evidence","advocate"],"order":order,
        "deriveChain":[]}),
    )
}

fn employee_query_site(
    context: &FreshSourceContext<'_>,
    work_expr: NodeKey,
    outer_call: NodeKey,
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let employee = symbol(program, "employee.Employee")?;
    let call = unique_collection(program, work_expr, employee, "any")?;
    let fact = program.types.checked_collection_calls.get(&call)?;
    let fresh = context
        .program()
        .types
        .checked_collection_calls
        .get(&call)?;
    let predicate = fact.predicate.as_ref()?.node;
    let checked = program.types.checked_queries.get(&fact.query)?;
    if text(db, call) != Some(CAN_WORK)
        || fact.model != employee
        || fact.builtin != "any"
        || format!("{:?}", fact) != format!("{:?}", fresh)
        || !matches!(&checked.domain_type,ResolvedType::Array{element,..}
            if record_is(program,element,"employee.Employee"))
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.effects.models.get(&employee)?.owner != ModelOwner::Team
    {
        return None;
    }
    let origin = source(program, db, call)?;
    let id = sha256_hex(
        format!(
            "refer-reject-query/v1:header:{}:{}:{}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":"header","model":"employee.Employee",
        "source":origin,"queryNode":interval(fact.query),"callSite":interval(call),
        "aliasSite":interval(fact.alias),"predicateSite":interval(predicate),
        "domainKind":"team","ownerPath":[],"order":[],"deriveChain":[{
            "source":source(program,db,outer_call)?,"callSite":interval(outer_call),
            "derive":"employee.can_work"}]}))
}

pub(super) fn prepare_reject(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<Value> {
    if owner.canonical != "refer.reject_source" {
        return None;
    }
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let advocate = symbol(program, "refer.Advocate")?;
    let program_model = symbol(program, "refer.Program")?;
    let evidence = symbol(program, "refer.SourceEvidence")?;
    let credit = symbol(program, "refer.Credit")?;
    let employee = symbol(program, "employee.Employee")?;
    let location = symbol(program, "rent_catalog.Location")?;
    let work = symbol(program, "employee.can_work")?;
    fresh_match(
        context,
        owner,
        scenario.node,
        &[work],
        &[
            program_model,
            advocate,
            evidence,
            credit,
            employee,
            location,
        ],
    )?;
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.guards.len() != 1
        || scenario.effects.len() != 3
        || scenario.params.len() != 2
        || scenario.by.and_then(|node| text(db, node)) != Some("program_manager")
        || program.effects.models.get(&advocate)?.owner != ModelOwner::ChildOf(program_model)
        || program.effects.models.get(&credit)?.owner != ModelOwner::ChildOf(advocate)
        || program.effects.models.get(&evidence)?.owner != ModelOwner::Team
    {
        return None;
    }
    for (param, (name, ty)) in scenario
        .params
        .iter()
        .zip([("evidence", "refer.SourceEvidence"), ("reason", "text")])
    {
        if program.symbols.get(param.param.0 as usize)?.name != name
            || param.default.is_some()
            || !program
                .types
                .symbol_types
                .get(&param.param)
                .is_some_and(|actual| match ty {
                    "text" => *actual == ResolvedType::Scalar(Scalar::Text),
                    model => record_is(program, actual, model),
                })
        {
            return None;
        }
    }
    let header = &scenario.guards[0];
    let [set, first, branch] = scenario.effects.as_slice() else {
        return None;
    };
    let [create] = branch.then_effects.as_slice() else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || !no_children(header)
        || header.cond.and_then(|node| text(db, node)) != Some(HEADER)
        || set.verb != EffectVerb::Set
        || !no_children(set)
        || !matches!(set.target,Some(EffectTarget::Record{model:Some(id)}) if id==evidence)
        || !text(db, set.node).is_some_and(|s| s.starts_with("set evidence "))
        || !args_match(db, set, &[("reversed", Some("true")), ("reason", None)])
        || first.verb != EffectVerb::Let
        || !no_children(first)
        || first.binding.as_deref() != Some("credit")
        || first.value.and_then(|node| text(db, node)) != Some(FIRST)
        || branch.verb != EffectVerb::If
        || branch.cond.and_then(|node| text(db, node)) != Some(BRANCH)
        || !branch.else_effects.is_empty()
        || !branch.match_arms.is_empty()
        || create.verb != EffectVerb::Create
        || !no_children(create)
        || !matches!(create.target,Some(EffectTarget::Model(id)) if id==credit)
        || create.binding.as_deref() != Some("reversal")
        || !args_match(
            db,
            create,
            &[
                ("parent", Some("evidence.advocate")),
                (
                    "source",
                    Some("format(\"{source}:reversal\",{source=credit.source})"),
                ),
                ("customer", Some("credit.customer")),
                ("amount", Some("-credit.amount")),
                ("reversal", Some("credit")),
                ("qualification", Some("reason")),
            ],
        )
    {
        return None;
    }
    let work_expr = program.effects.derives.get(&work)?.expr?;
    let work_call = unique_call(program, header.cond?, work)?;
    if text(db, work_expr) != Some(CAN_WORK)
        || text(db, work_call) != Some("can_work(actor,location)")
        || program.types.symbol_results.get(&work)
            != Some(&Some(ResolvedType::Scalar(Scalar::Bool)))
        || program.types.node_types.get(&header.cond?) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&branch.cond?) != Some(&ResolvedType::Scalar(Scalar::Bool))
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
    let [
        IrStmt::Require {
            span: header_span, ..
        },
    ] = guards.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Set { span: set_span, .. },
        IrStmt::Let {
            name,
            value,
            span: first_span,
        },
        IrStmt::If {
            cond,
            then_branch,
            else_branch,
            span: branch_span,
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    if *header_span != span(header.node)
        || *set_span != span(set.node)
        || name != "credit"
        || *first_span != span(first.node)
        || value.span != span(first.value?)
        || cond.span != span(branch.cond?)
        || *branch_span != span(branch.node)
        || !matches!(then_branch.as_slice(),[IrStmt::Create{model,binding:Some(binding),span:create_span,..}]
            if model=="refer.Credit" && binding=="reversal" && *create_span==span(create.node))
        || !else_branch.is_empty()
    {
        return None;
    }
    let first_call = unique_collection(program, first.value?, credit, "first")?;
    let absent_call = unique_collection(program, branch.cond?, credit, "any")?;
    let first_site = query_site(context, first_call, "first", FIRST)?;
    let absent_site = query_site(context, absent_call, "any", ABSENCE)?;
    let employee_site = employee_query_site(context, work_expr, work_call)?;
    let origin = source(program, db, scenario.node)?;
    if origin["module"] != "refer" {
        return None;
    }
    let model_site = |node, kind| -> Option<Value> {
        let mut site = site(program, db, node, node, kind)?;
        site["model"] = json!(if kind == "set" {
            "refer.SourceEvidence"
        } else {
            "refer.Credit"
        });
        Some(site)
    };
    Some(
        json!({"version":1,"owner":"refer.reject_source","source":origin,
        "sites":{
            "header":site(program,db,header.cond?,header.node,"header")?,
            "set":model_site(set.node,"set")?,
            "first":site(program,db,first.value?,first.node,"first")?,
            "createIf":site(program,db,branch.cond?,branch.node,"create-if")?,
            "absence":site(program,db,absent_call,branch.node,"absence")?,
            "create":model_site(create.node,"create")?
        },
        "roleSite":site(program,db,scenario.by?,scenario.node,"role")?,
        "membershipSite":site(program,db,header.cond?,header.node,"membership")?,
        "querySites":[employee_site,first_site,absent_site]}),
    )
}

/// The imported can_work helper's active_member is reached only through the
/// checked header Require, including its repeated locations-array calls.
pub(super) fn collect_reject_membership_sites(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<Value>> {
    let decision = prepare_reject(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let guard = scenario.guards.first()?;
    let cond = guard.cond?;
    if decision["membershipSite"]["node"] != interval(cond) {
        return None;
    }
    let work = symbol(program, "employee.can_work")?;
    let work_expr = program.effects.derives.get(&work)?.expr?;
    let outer = unique_call(program, cond, work)?;
    if text(db, outer) != Some("can_work(actor,location)") {
        return None;
    }
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
            "source":source(program,db,outer)?,"node":plain_interval(outer),
            "derive":"employee.can_work"} ]});
    Some(vec![json!({"version":1,"source":source(program,db,cond)?,
        "owner":owner.canonical,"node":plain_interval(cond),
        "statement":plain_interval(guard.node),"stage":"body-condition",
        "position":[{"kind":"guard","index":0}],"calls":[call]})])
}

/// Idempotent cash settlement against the same external payment evidence.
///
/// The FIRST over unscoped Settlement replays an exactly matching row and
/// otherwise creates one Settlement, then allocates it across the
/// Advocate's positive Credits in creation order (at most 500) with
/// per-credit and running-total sums fenced at one revision. A single-query
/// receipt cannot move the replay read before the allocation writes or
/// prove the loop's finite domain and exact sum equality, so this profile
/// admits the complete authored order only.
const SETTLE_HEADER: &str = "amount.currency==advocate.parent.reward.currency and amount.minor>0 and trim(payment_source)!=\"\" and trim(reference)!=\"\" and trim(method)!=\"\" and trim(evidence)!=\"\" and paid<=local_date(now,team.timezone) and all(advocate.parent.locations as location,can_work(actor,location))";
const SETTLE_FIRST: &str = "first(Settlement as settlement where settlement.payment_source==payment_source and settlement.reference==reference order=settlement.id)";
const SETTLE_REPLAY_COND: &str = "existing!=null";
const SETTLE_REPLAY: &str = "existing.parent==advocate and existing.amount==amount and existing.paid==paid and existing.method==method and existing.evidence==evidence";
const SETTLE_AVAILABLE: &str = "amount<=advocate.available";
const SETTLE_LOOP: &str = "advocate.Credit as item where item.amount.minor>0 order=item.created";
const SETTLE_REMAINING: &str = "amount-sum(settlement.Allocation as allocation select allocation.amount,amount.currency)";
const SETTLE_REMAINING_SUM: &str = "sum(settlement.Allocation as allocation select allocation.amount,amount.currency)";
const SETTLE_UNPAID: &str = "credit.amount-sum(Allocation as allocation where allocation.credit==credit select allocation.amount,amount.currency)";
const SETTLE_UNPAID_SUM: &str = "sum(Allocation as allocation where allocation.credit==credit select allocation.amount,amount.currency)";
const SETTLE_EARNED_SUM: &str = "sum(row.Credit as credit select credit.amount,row.parent.reward.currency)";
const SETTLE_PAID_SUM: &str = "sum(row.Settlement as settlement select settlement.amount,row.parent.reward.currency)";
const SETTLE_PART: &str = "min([remaining,unpaid])";
const SETTLE_PART_COND: &str = "part.minor>0";
const SETTLE_SUM_REQUIRE: &str = "sum(settlement.Allocation as allocation select allocation.amount,amount.currency)==amount";
const SETTLE_EARNED: &str = "sum(row.Credit as credit select credit.amount,row.parent.reward.currency)";
const SETTLE_PAID: &str = "sum(row.Settlement as settlement select settlement.amount,row.parent.reward.currency)";
const SETTLE_AVAILABLE_DERIVE: &str = "max([money(0,row.parent.reward.currency),row.earned-row.paid])";

fn settle_sum_call(
    program: &CheckedProgram,
    db: &SourceDb,
    within: NodeKey,
    expected: &str,
) -> Option<NodeKey> {
    let mut hits = program.types.selected_calls.iter().filter(|(node, selected)| {
        node.file == within.file
            && within.start <= node.start
            && node.end <= within.end
            && matches!(&selected.target, SelectedCallTarget::Builtin { id, .. } if id == "sum")
            && text(db, **node) == Some(expected)
    });
    let (node, _) = hits.next()?;
    hits.next().is_none().then_some(*node)
}

pub(super) fn prepare_settle(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<Value> {
    if owner.canonical != "refer.settle" {
        return None;
    }
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let advocate = symbol(program, "refer.Advocate")?;
    let program_model = symbol(program, "refer.Program")?;
    let credit = symbol(program, "refer.Credit")?;
    let settlement = symbol(program, "refer.Settlement")?;
    let allocation = symbol(program, "refer.Allocation")?;
    let earned = symbol(program, "refer.Advocate.earned")?;
    let paid = symbol(program, "refer.Advocate.paid")?;
    let available = symbol(program, "refer.Advocate.available")?;
    let work = symbol(program, "employee.can_work")?;
    let employee = symbol(program, "employee.Employee")?;
    let location = symbol(program, "rent_catalog.Location")?;
    fresh_match(
        context,
        owner,
        scenario.node,
        &[work, earned, paid, available],
        &[program_model, advocate, credit, settlement, allocation, employee, location],
    )?;
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_none()
        || scenario.guards.len() != 1
        || scenario.effects.len() != 7
        || scenario.params.len() != 7
        || scenario.by.and_then(|node| text(db, node)) != Some("finance")
        || text(db, scenario.result?) != Some("Settlement")
        || program.effects.models.get(&advocate)?.owner != ModelOwner::ChildOf(program_model)
        || program.effects.models.get(&credit)?.owner != ModelOwner::ChildOf(advocate)
        || program.effects.models.get(&settlement)?.owner != ModelOwner::ChildOf(advocate)
        || program.effects.models.get(&allocation)?.owner != ModelOwner::ChildOf(settlement)
    {
        return None;
    }
    for (param, (name, ty)) in scenario.params.iter().zip([
        ("advocate", "refer.Advocate"),
        ("amount", "money"),
        ("payment_source", "text"),
        ("reference", "text"),
        ("paid", "date"),
        ("method", "text"),
        ("evidence", "text"),
    ]) {
        if program.symbols.get(param.param.0 as usize)?.name != name
            || param.default.is_some()
            || !program
                .types
                .symbol_types
                .get(&param.param)
                .is_some_and(|actual| match ty {
                    "text" => *actual == ResolvedType::Scalar(Scalar::Text),
                    "money" => *actual == ResolvedType::Scalar(Scalar::Money),
                    "date" => *actual == ResolvedType::Scalar(Scalar::Date),
                    model => record_is(program, actual, model),
                })
        {
            return None;
        }
    }
    let header = &scenario.guards[0];
    let [existing, replay, available_require, create, cycle, sum_require, returned] =
        scenario.effects.as_slice()
    else {
        return None;
    };
    let [replay_require, replay_return] = replay.then_effects.as_slice() else {
        return None;
    };
    let [remaining, unpaid, part, part_branch] = cycle.then_effects.as_slice() else {
        return None;
    };
    let [allocate] = part_branch.then_effects.as_slice() else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || !no_children(header)
        || header.cond.and_then(|node| text(db, node)) != Some(SETTLE_HEADER)
        || existing.verb != EffectVerb::Let
        || !no_children(existing)
        || existing.binding.as_deref() != Some("existing")
        || existing.value.and_then(|node| text(db, node)) != Some(SETTLE_FIRST)
        || replay.verb != EffectVerb::If
        || replay.cond.and_then(|node| text(db, node)) != Some(SETTLE_REPLAY_COND)
        || !replay.else_effects.is_empty()
        || !replay.match_arms.is_empty()
        || replay_require.verb != EffectVerb::Require
        || !no_children(replay_require)
        || replay_require.cond.and_then(|node| text(db, node)) != Some(SETTLE_REPLAY)
        || replay_return.verb != EffectVerb::Return
        || !no_children(replay_return)
        || replay_return.value.and_then(|node| text(db, node)) != Some("existing")
        || available_require.verb != EffectVerb::Require
        || !no_children(available_require)
        || available_require.cond.and_then(|node| text(db, node)) != Some(SETTLE_AVAILABLE)
        || create.verb != EffectVerb::Create
        || !no_children(create)
        || !matches!(create.target, Some(EffectTarget::Model(id)) if id == settlement)
        || create.binding.as_deref() != Some("settlement")
        || !args_match(
            db,
            create,
            &[
                ("parent", Some("advocate")),
                ("source", Some("operation.id")),
                ("amount", None),
                ("payment_source", None),
                ("reference", None),
                ("paid", None),
                ("method", None),
                ("evidence", None),
            ],
        )
        || cycle.verb != EffectVerb::For
        || cycle.item.as_deref() != Some("credit")
        || text(db, cycle.domain?) != Some(SETTLE_LOOP)
        || text(db, cycle.limit?) != Some("500")
        || !cycle.else_effects.is_empty()
        || !cycle.match_arms.is_empty()
        || remaining.verb != EffectVerb::Let
        || !no_children(remaining)
        || remaining.binding.as_deref() != Some("remaining")
        || remaining.value.and_then(|node| text(db, node)) != Some(SETTLE_REMAINING)
        || unpaid.verb != EffectVerb::Let
        || !no_children(unpaid)
        || unpaid.binding.as_deref() != Some("unpaid")
        || unpaid.value.and_then(|node| text(db, node)) != Some(SETTLE_UNPAID)
        || part.verb != EffectVerb::Let
        || !no_children(part)
        || part.binding.as_deref() != Some("part")
        || part.value.and_then(|node| text(db, node)) != Some(SETTLE_PART)
        || part_branch.verb != EffectVerb::If
        || part_branch.cond.and_then(|node| text(db, node)) != Some(SETTLE_PART_COND)
        || !part_branch.else_effects.is_empty()
        || !part_branch.match_arms.is_empty()
        || allocate.verb != EffectVerb::Create
        || !no_children(allocate)
        || !matches!(allocate.target, Some(EffectTarget::Model(id)) if id == allocation)
        || allocate.binding.as_deref() != Some("allocation")
        || !args_match(
            db,
            allocate,
            &[("parent", Some("settlement")), ("credit", None), ("amount", Some("part"))],
        )
        || sum_require.verb != EffectVerb::Require
        || !no_children(sum_require)
        || sum_require.cond.and_then(|node| text(db, node)) != Some(SETTLE_SUM_REQUIRE)
        || returned.verb != EffectVerb::Return
        || !no_children(returned)
        || returned.value.and_then(|node| text(db, node)) != Some("settlement")
    {
        return None;
    }
    Some(json!({"version":1}))
}

fn settle_site(
    context: &FreshSourceContext<'_>,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
    model: Option<&str>,
) -> Option<Value> {
    let program = context.original();
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        return None;
    }
    let origin = source(program, context.db(), node)?;
    if origin["module"] != "refer" {
        return None;
    }
    let id = sha256_hex(
        format!(
            "refer-settle/v1:{kind}:{}:{}:{}:{}:{}",
            origin["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes(),
    );
    let mut value = json!({"id":id,"source":origin,"node":interval(node),
        "statement":interval(statement)});
    if let Some(model) = model {
        value["model"] = json!(model);
    }
    Some(value)
}

fn settle_loop_site(context: &FreshSourceContext<'_>, domain: NodeKey) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let credit = symbol(program, "refer.Credit")?;
    let mut queries = program.types.checked_queries.iter().filter(|(node, _)| {
        node.file == domain.file && domain.start <= node.start && node.end <= domain.end
    });
    let (query_node, query) = queries.next()?;
    if queries.next().is_some()
        || format!("{query:?}")
            != format!(
                "{:?}",
                context.program().types.checked_queries.get(query_node)?
            )
        || !matches!(&query.domain_type, ResolvedType::Array { element, .. }
            if record_is(program, element, "refer.Credit"))
        || text(db, domain) != Some(SETTLE_LOOP)
    {
        return None;
    }
    use CheckedQueryClauseKind as Clause;
    let (alias, predicate, order) = match query.clauses.as_slice() {
        [a, w, o]
            if matches!(a.kind, Clause::As { .. })
                && matches!(w.kind, Clause::Where)
                && matches!(o.kind, Clause::Order) =>
        {
            (a.node, w.expressions.first().copied(), o.expressions.first().copied())
        }
        _ => return None,
    };
    let predicate = predicate?;
    let order = order?;
    if program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool)) {
        return None;
    }
    let origin = source(program, db, domain)?;
    let id = sha256_hex(
        format!(
            "refer-settle-query/v1:loop:{}:{}:{}",
            origin["sha256"].as_str()?,
            domain.start,
            domain.end
        )
        .as_bytes(),
    );
    let _ = credit;
    Some(json!({"id":id,"stage":"loop","model":"refer.Credit","source":origin,
        "queryNode":interval(*query_node),"callSite":interval(domain),
        "aliasSite":interval(alias),"predicateSite":interval(predicate),
        "selectionSite":null,"orderSite":interval(order),
        "domainKind":"child","ownerPath":["advocate"],"order":["item.created"],
        "deriveChain":[]}))
}

fn settle_first_site(
    context: &FreshSourceContext<'_>,
    call: NodeKey,
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let settlement = symbol(program, "refer.Settlement")?;
    let fact = program.types.checked_collection_calls.get(&call)?;
    let fresh = context
        .program()
        .types
        .checked_collection_calls
        .get(&call)?;
    if fact.model != settlement
        || fact.builtin != "first"
        || format!("{fact:?}") != format!("{fresh:?}")
        || text(db, call) != Some(SETTLE_FIRST)
    {
        return None;
    }
    let selected = program.types.selected_calls.get(&call)?;
    let fresh_selected = context.program().types.selected_calls.get(&call)?;
    let [query] = selected.arguments.as_slice() else {
        return None;
    };
    if !matches!(&selected.target, SelectedCallTarget::Builtin { id, overload }
        if id == "first" && *overload == 0)
        || format!("{selected:?}") != format!("{fresh_selected:?}")
        || fact.query != *query
    {
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
        || order_clause.expressions.len() != 1
        || text(db, order_clause.expressions[0]) != Some("settlement.id")
    {
        return None;
    }
    if !matches!(&checked.domain_type, ResolvedType::Array { element, .. }
        if record_is(program, element, "refer.Settlement"))
        || program.types.node_types.get(&where_clause.expressions[0])
            != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let origin = source(program, db, call)?;
    let id = sha256_hex(
        format!(
            "refer-settle-query/v1:existing:{}:{}:{}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":"existing","model":"refer.Settlement","source":origin,
        "queryNode":interval(*query),"callSite":interval(call),
        "aliasSite":interval(alias.node),
        "predicateSite":interval(where_clause.expressions[0]),
        "selectionSite":null,"orderSite":interval(order_clause.expressions[0]),
        "domainKind":"team","ownerPath":[],"order":["settlement.id"],"deriveChain":[]}))
}

fn settle_sum_site(
    context: &FreshSourceContext<'_>,
    call: NodeKey,
    stage: &str,
    expected: &str,
    model: &str,
    domain_kind: &str,
    owner_path: &[&str],
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let model_id = symbol(program, model)?;
    let selected = program.types.selected_calls.get(&call)?;
    let fresh_selected = context.program().types.selected_calls.get(&call)?;
    if !matches!(&selected.target, SelectedCallTarget::Builtin { id, .. } if id == "sum")
        || format!("{selected:?}") != format!("{fresh_selected:?}")
        || selected.arguments.len() != 2
        || text(db, call) != Some(expected)
    {
        return None;
    }
    let mut queries = program.types.checked_queries.iter().filter(|(node, _)| {
        node.file == call.file && call.start <= node.start && node.end <= call.end
    });
    let (query_node, query) = queries.next()?;
    if queries.next().is_some()
        || format!("{query:?}")
            != format!(
                "{:?}",
                context.program().types.checked_queries.get(query_node)?
            )
        || !matches!(&query.domain_type, ResolvedType::Array { element, .. }
            if record_is(program, element, model))
    {
        return None;
    }
    use CheckedQueryClauseKind as Clause;
    let (alias, predicate, selection, checked_order): (NodeKey, Option<NodeKey>, NodeKey, Option<NodeKey>) =
        match query.clauses.as_slice() {
        [a, s] if matches!(a.kind, Clause::As { .. }) && matches!(s.kind, Clause::Select) => {
            (a.node, None, *s.expressions.first()?, None)
        }
        [a, w, s]
            if matches!(a.kind, Clause::As { .. })
                && matches!(w.kind, Clause::Where)
                && matches!(s.kind, Clause::Select) =>
        {
            (
                a.node,
                Some(*w.expressions.first()?),
                *s.expressions.first()?,
                None,
            )
        }
        _ => return None,
    };
    if predicate.is_some_and(|node| {
        program.types.node_types.get(&node) != Some(&ResolvedType::Scalar(Scalar::Bool))
    }) {
        return None;
    }
    let _ = (model_id, selection, checked_order);
    let origin = source(program, db, call)?;
    let id = sha256_hex(
        format!(
            "refer-settle-query/v1:{stage}:{model}:{}:{}:{}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":stage,"model":model,"source":origin,
        "queryNode":interval(*query_node),"callSite":interval(call),
        "aliasSite":interval(alias),"predicateSite":predicate.map(interval),
        "selectionSite":interval(selection),"orderSite":null,
        "domainKind":domain_kind,"ownerPath":owner_path,"order":[],
        "deriveChain":[]}))
}

fn settle_header_employee_site(
    context: &FreshSourceContext<'_>,
    work_expr: NodeKey,
    outer_call: NodeKey,
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let employee = symbol(program, "employee.Employee")?;
    let call = unique_collection(program, work_expr, employee, "any")?;
    let fact = program.types.checked_collection_calls.get(&call)?;
    let fresh = context
        .program()
        .types
        .checked_collection_calls
        .get(&call)?;
    let predicate = fact.predicate.as_ref()?.node;
    let checked = program.types.checked_queries.get(&fact.query)?;
    if text(db, call) != Some(CAN_WORK)
        || fact.model != employee
        || fact.builtin != "any"
        || format!("{fact:?}") != format!("{fresh:?}")
        || !matches!(&checked.domain_type, ResolvedType::Array { element, .. }
            if record_is(program, element, "employee.Employee"))
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.effects.models.get(&employee)?.owner != ModelOwner::Team
    {
        return None;
    }
    let origin = source(program, db, call)?;
    let id = sha256_hex(
        format!(
            "refer-settle-query/v1:header:{}:{}:{}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":"header","model":"employee.Employee",
        "source":origin,"queryNode":interval(fact.query),"callSite":interval(call),
        "aliasSite":interval(fact.alias),"predicateSite":interval(predicate),
        "selectionSite":null,"orderSite":null,
        "domainKind":"team","ownerPath":[],"order":[],"deriveChain":[{
            "source":source(program, db, outer_call)?,"callSite":interval(outer_call),
            "derive":"employee.can_work"}]}))
}

fn settle_ir_match(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    scenario: &crate::analysis::effects::ScenarioData,
) -> Option<()> {
    use super::ir::{IrItemKind, IrStmt};
    let program = context.original();
    let db = context.db();
    let header = scenario.guards.first()?;
    let effects = scenario.effects.as_slice();
    let [_, _, _, _, _, _, _] = effects else {
        return None;
    };
    let IrItemKind::Scenario {
        guards,
        effects: ir_effects,
        read: false,
        result: Some(_),
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [IrStmt::Require { span: header_span, .. }] = guards.as_slice() else {
        return None;
    };
    let [IrStmt::Let { span: existing_span, name: existing_name, .. }, IrStmt::If {
        span: replay_span, ..
    }, IrStmt::Require { span: available_span, .. }, IrStmt::Create {
        span: create_span, model: create_model, binding: create_binding, ..
    }, IrStmt::For {
        span: loop_span, item: loop_item, body: loop_body, ..
    }, IrStmt::Require { span: sum_span, .. }, IrStmt::Return { span: return_span, .. }] =
        ir_effects.as_slice()
    else {
        return None;
    };
    if *header_span != span(header.node)
        || *existing_span != span(effects[0].node)
        || existing_name != "existing"
        || *replay_span != span(effects[1].node)
        || *available_span != span(effects[2].node)
        || *create_span != span(effects[3].node)
        || create_model != "refer.Settlement"
        || create_binding.as_deref() != Some("settlement")
        || *loop_span != span(effects[4].node)
        || loop_item != "credit"
        || *sum_span != span(effects[5].node)
        || *return_span != span(effects[6].node)
    {
        return None;
    }
    let [IrStmt::Let { name: remaining_name, .. }, IrStmt::Let { name: unpaid_name, .. }, IrStmt::Let { name: part_name, .. }, IrStmt::If { .. }] =
        loop_body.as_slice()
    else {
        return None;
    };
    if remaining_name != "remaining" || unpaid_name != "unpaid" || part_name != "part" {
        return None;
    }
    let _ = (program, db);
    Some(())
}

fn settle_decision(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<Value> {
    prepare_settle(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let header = scenario.guards.first()?;
    let effects = scenario.effects.as_slice();
    let [_, replay, _, _, cycle, _, _] = effects else {
        return None;
    };
    let work = symbol(program, "employee.can_work")?;
    let earned = symbol(program, "refer.Advocate.earned")?;
    let paid = symbol(program, "refer.Advocate.paid")?;
    let available = symbol(program, "refer.Advocate.available")?;
    let work_expr = program.effects.derives.get(&work)?.expr?;
    let earned_expr = program.effects.derives.get(&earned)?.expr?;
    let paid_expr = program.effects.derives.get(&paid)?.expr?;
    let available_expr = program.effects.derives.get(&available)?.expr?;
    if text(db, work_expr) != Some(CAN_WORK)
        || text(db, earned_expr) != Some(SETTLE_EARNED)
        || text(db, paid_expr) != Some(SETTLE_PAID)
        || text(db, available_expr) != Some(SETTLE_AVAILABLE_DERIVE)
    {
        return None;
    }
    let header_call = unique_call(program, header.cond?, work)?;
    let _ = available;
    if text(db, header_call) != Some("can_work(actor,location)") {
        return None;
    }
    let existing_call = unique_collection(program, effects[0].value?, symbol(program, "refer.Settlement")?, "first")?;
    if text(db, existing_call) != Some(SETTLE_FIRST) {
        return None;
    }
    let remaining_call = settle_sum_call(program, db, effects[4].then_effects[0].value?, SETTLE_REMAINING_SUM)?;
    let unpaid_call = settle_sum_call(program, db, effects[4].then_effects[1].value?, SETTLE_UNPAID_SUM)?;
    let require_sum_call = settle_sum_call(program, db, effects[5].cond?, SETTLE_REMAINING_SUM)?;
    let earned_call = settle_sum_call(program, db, earned_expr, SETTLE_EARNED_SUM)?;
    let paid_call = settle_sum_call(program, db, paid_expr, SETTLE_PAID_SUM)?;
    let origin = source(program, db, scenario.node)?;
    let header_site = settle_header_employee_site(context, work_expr, header_call)?;
    let existing_site = settle_first_site(context, existing_call)?;
    let loop_domain_site = settle_loop_site(context, cycle.domain?)?;
    let remaining_site = settle_sum_site(context, remaining_call, "remaining", SETTLE_REMAINING_SUM,
        "refer.Allocation", "child", &["settlement"])?;
    let unpaid_site = settle_sum_site(context, unpaid_call, "unpaid", SETTLE_UNPAID_SUM,
        "refer.Allocation", "team", &[])?;
    let require_sum_site = settle_sum_site(context, require_sum_call, "requireSum", SETTLE_REMAINING_SUM,
        "refer.Allocation", "child", &["settlement"])?;
    let earned_site = settle_sum_site(context, earned_call, "earned", SETTLE_EARNED_SUM,
        "refer.Credit", "child", &["advocate"])?;
    let paid_site = settle_sum_site(context, paid_call, "paid", SETTLE_PAID_SUM,
        "refer.Settlement", "child", &["advocate"])?;
    let param = |name: &str, ty: &str| json!({"name": name, "type": ty});
    Some(json!({"version":1,"owner":"refer.settle","source":origin,
        "parameters":[param("advocate","refer.Advocate"),param("amount","money"),
            param("payment_source","text"),param("reference","text"),param("paid","date"),
            param("method","text"),param("evidence","text")],
        "roleSite":settle_site(context, scenario.by?,scenario.node,"role",None),
        "membershipSite":settle_site(context, header.cond?,header.node,"membership",None),
        "sites":{
            "header":settle_site(context, header.cond?,header.node,"header",None),
            "existingFirst":settle_site(context, effects[0].value?,effects[0].node,"existing-first",Some("refer.Settlement")),
            "replayBranch":settle_site(context, replay.cond?,replay.node,"replay-branch",None),
            "replayRequire":settle_site(context, replay.then_effects[0].cond?,replay.then_effects[0].node,"replay-require",None),
            "availableRequire":settle_site(context, effects[2].cond?,effects[2].node,"available-require",None),
            "settlementCreate":settle_site(context, effects[3].node,effects[3].node,"settlement-create",Some("refer.Settlement")),
            "loop":settle_site(context, cycle.domain?,cycle.node,"loop",Some("refer.Credit")),
            "remaining":settle_site(context, effects[4].then_effects[0].value?,effects[4].then_effects[0].node,"remaining",Some("refer.Allocation")),
            "unpaid":settle_site(context, effects[4].then_effects[1].value?,effects[4].then_effects[1].node,"unpaid",Some("refer.Allocation")),
            "part":settle_site(context, effects[4].then_effects[2].value?,effects[4].then_effects[2].node,"part",None),
            "allocationCreate":settle_site(context, effects[4].then_effects[3].then_effects[0].node,effects[4].then_effects[3].then_effects[0].node,"allocation-create",Some("refer.Allocation")),
            "sumRequire":settle_site(context, effects[5].cond?,effects[5].node,"sum-require",None)},
        "querySites":[header_site,existing_site,loop_domain_site,earned_site,paid_site,remaining_site,unpaid_site,require_sum_site],
        "returns":[
            {"id":"refer-settle-replay","kind":"replay"},
            {"id":"refer-settle-replay","kind":"replay"},
            {"id":"refer-settle-created","kind":"created"}]}))
}

/// The imported can_work helper's active_member is reached only through the
/// exact header Require, mirroring the rejection profile.
pub(super) fn collect_settle_membership_sites(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<Value>> {
    let decision = settle_decision(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let guard = scenario.guards.first()?;
    let cond = guard.cond?;
    if decision["membershipSite"]["node"] != interval(cond) {
        return None;
    }
    let work = symbol(program, "employee.can_work")?;
    let work_expr = program.effects.derives.get(&work)?.expr?;
    let outer = unique_call(program, cond, work)?;
    if text(db, outer) != Some("can_work(actor,location)") {
        return None;
    }
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
            "source":source(program,db,outer)?,"node":plain_interval(outer),
            "derive":"employee.can_work"} ]});
    Some(vec![json!({"version":1,"source":source(program,db,cond)?,
        "owner":owner.canonical,"node":plain_interval(cond),
        "statement":plain_interval(guard.node),"stage":"leading-require",
        "position":[{"kind":"guard","index":0}],"calls":[call]})])
}

pub(super) fn collect_settle_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
) -> Option<NativeScenarioReceipt> {
    let decision = settle_decision(context, item)?;
    settle_ir_match(context, item, context.original().effects.scenarios.get(&item.id)?)?;
    let file = context.db().get(context.original().effects.scenarios.get(&item.id)?.node.file)?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "refer".into(),
        },
        entry_module,
    )?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let id = sha256_hex(
        format!(
            "refer-settle-void/v1:{}:{}:{}",
            source.sha256, scenario.node.start, scenario.node.end
        )
        .as_bytes(),
    );
    let replay_id = sha256_hex(
        format!("refer-settle-replay/v1:{}:{}:{}", source.sha256, scenario.node.start, scenario.node.end)
            .as_bytes(),
    );
    let created_id = sha256_hex(
        format!("refer-settle-created/v1:{}:{}:{}", source.sha256, scenario.node.start, scenario.node.end)
            .as_bytes(),
    );
    let work = symbol(context.original(), "employee.can_work")?;
    let outer = unique_call(context.original(), scenario.guards.first()?.cond?, work)?;
    Some(NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            version: 1,
            source: source.clone(),
            event_decision: None,
            term_decision: None,
            leave_request_decision: None,
            leave_decide_decision: None,
            refer_reject_decision: None,
            member_retry_decision: None,
            invoice_overdue_decision: None,
            rent_movement_refund_decision: None,
            invoice_collect_decision: None,
            rent_notice_decision: None,
            invoice_issue_decision: None,
            refer_settle_decision: Some(decision),
            queries: Vec::new(),
            returns: vec![
                ReceiptReturn {
                    id: replay_id.clone(),
                    source: source.clone(),
                    influences: Vec::new(),
                    dependencies: Vec::new(),
                    intrinsics: Vec::new(),
                    projection: None,
                },
                ReceiptReturn {
                    id: created_id.clone(),
                    source,
                    influences: Vec::new(),
                    dependencies: Vec::new(),
                    intrinsics: Vec::new(),
                    projection: None,
                },
            ],
        },
        dependencies: Default::default(),
        intrinsics: Default::default(),
        decisions: {
            let mut map = std::collections::HashMap::new();
            map.insert(
                NativeSite {
                    calls: Vec::new(),
                    span: span(scenario.effects[1].node),
                    default_selection: false,
                },
                super::scenario_receipts::NativeDecisionKind::If,
            );
            map
        },
        decision_keys: {
            let mut map = std::collections::HashMap::new();
            map.insert(
                NativeSite {
                    calls: Vec::new(),
                    span: span(scenario.effects[1].node),
                    default_selection: false,
                },
                "refer-settle-replay".to_string(),
            );
            map
        },
        calls: std::collections::HashMap::from([(
            NativeSite {
                calls: Vec::new(),
                span: span(outer),
                default_selection: false,
            },
            "employee.can_work".into(),
        )]),
        returns: vec![
            NativeReturn {
                id: replay_id,
                span: item.span,
                decisions: vec![(
                    "refer-settle-replay".to_string(),
                    crate::analysis::scenario_disclosure::DisclosureChoice::Then,
                )],
                implicit: false,
                reference_result: None,
            },
            NativeReturn {
                id: created_id,
                span: item.span,
                decisions: vec![(
                    "refer-settle-replay".to_string(),
                    crate::analysis::scenario_disclosure::DisclosureChoice::Else,
                )],
                implicit: false,
                reference_result: None,
            },
        ],
        current_revision: None,
    })
}

pub(super) fn collect_reject_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_reject(context, item)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let work = symbol(context.original(), "employee.can_work")?;
    let outer = unique_call(context.original(), scenario.guards.first()?.cond?, work)?;
    let file = context.db().get(scenario.node.file)?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "refer".into(),
        },
        entry_module,
    )?;
    let id = sha256_hex(
        format!(
            "refer-reject-void/v1:{}:{}:{}",
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
            leave_request_decision: None,
            leave_decide_decision: None,
            refer_reject_decision: Some(decision),
            member_retry_decision: None, invoice_overdue_decision: None, rent_movement_refund_decision: None,
            invoice_collect_decision: None, rent_notice_decision: None, invoice_issue_decision: None, refer_settle_decision: None,queries: Vec::new(),
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
        calls: std::collections::HashMap::from([(
            NativeSite {
                calls: Vec::new(),
                span: span(outer),
                default_selection: false,
            },
            "employee.can_work".to_string(),
        )]),
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
