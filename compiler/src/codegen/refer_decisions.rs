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
            invoice_collect_decision: None, rent_notice_decision: None, invoice_issue_decision: None, observe_venue_decision: None, success_renewal_decision: None,queries: Vec::new(),
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
