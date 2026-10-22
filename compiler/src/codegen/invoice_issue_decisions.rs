//! The exact invoice issue owner: global defaults selection and its guarded Mail intent.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{EffectTarget, EffectVerb};
use crate::analysis::resolve::{Binding, ModelOwner, SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::types::{CheckedQueryClauseKind, SelectedCallTarget};
use crate::analysis::{NodeKey, ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt, TypedExpr};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, NativeSite, ReceiptDisclosurePlan, ReceiptReturn,
    transport_source,
};
use super::send_guards::{PreparedSendGuard, PreparedSendInput};
use super::term_decisions as t;

const ISSUE: &str = r#"scenario issue(invoice:Invoice,number:text label=label_InvoiceDocument_number) by=finance label="Issue invoice"@{nl="Factuur uitgeven"}
   require can_work(actor,invoice.location) and invoice.state==draft and count(invoice.Line)>0 and trim(number)!=""
   require not any(Invoice as other,other.number==number)
   do
    let defaults=first(Defaults as setting order=setting.id)
    require defaults!=null and defaults.retry_delay>0m and defaults.retry_window>0m
    let total=sum(invoice.Line as line select line.price*line.quantity+line.tax-line.discount,invoice.currency)
    set invoice {state=issued,total,number,issued_at=now,attempt_limit=defaults.attempt_limit,retry_delay=defaults.retry_delay,retry_until=now+defaults.retry_window,ledger_revision=invoice.ledger_revision+1}
    emit InvoiceSettlement {value=settlement(invoice)}
    send Mail.send {to=invoice.recipient_email,subject=format(notice_invoice_issued,locale=null),body=format("{description} {url}",{description=invoice.description,url=app_url(format("/finance/invoice/{invoice}",{invoice=invoice.id}))})} when=invoice.state==issued as notice
    schedule invoice.id at=local_instant(add_days(invoice.due,1),"00:00",invoice.location.timezone,fold=earlier) event=Overdue {invoice,revision=invoice.version+1}"#;

const HEADER: &str = "can_work(actor,invoice.location) and invoice.state==draft and count(invoice.Line)>0 and trim(number)!=\"\"";
const UNIQUE: &str = "not any(Invoice as other,other.number==number)";
const FIRST: &str = "first(Defaults as setting order=setting.id)";
const DEFAULTS_REQUIRE: &str =
    "defaults!=null and defaults.retry_delay>0m and defaults.retry_window>0m";
const TOTAL: &str = "sum(invoice.Line as line select line.price*line.quantity+line.tax-line.discount,invoice.currency)";
const WHEN: &str = "invoice.state==issued";
const SETTLEMENT: &str = "Settlement {source=invoice.source,invoice=invoice.id,revision=invoice.ledger_revision,amount=invoice.total,collected=invoice.received,refunded=invoice.refunded,collection_pending=any(invoice.Attempt as attempt,attempt.kind==collection and attempt.status in [pending,unknown]),refund_pending=any(invoice.Attempt as attempt,attempt.kind==refund and attempt.status in [pending,unknown]),state=invoice.state,recorded_at=now}";
const WORK: &str = "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))";
const CREDITS: &str = "sum(row.Credit as credit select credit.amount,row.currency)";
const RECEIVED: &str = "sum(row.Attempt as attempt where attempt.kind==collection and attempt.status==succeeded select attempt.amount,row.currency)+sum(row.ExternalPayment as payment select payment.amount,row.currency)";
const REFUNDED: &str = "sum(row.Attempt as attempt where attempt.kind==refund and attempt.status==succeeded select attempt.amount,row.currency)+sum(row.ExternalRefund as refund select refund.amount,row.currency)";

fn same_item(context: &FreshSourceContext<'_>, id: SymbolId) -> Option<()> {
    let original = context.ir().items.get(id.0 as usize)?;
    let fresh = context.fresh().items.get(id.0 as usize)?;
    (original.canonical == fresh.canonical
        && format!("{:?}", original.kind) == format!("{:?}", fresh.kind))
    .then_some(())
}

fn site(
    context: &FreshSourceContext<'_>,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    let mut value = t::site(
        context.original(),
        context.db(),
        "invoice",
        node,
        statement,
        kind,
    )?;
    value["id"] = json!(sha256_hex(
        format!(
            "invoice-issue/v1:{kind}:{}:{}:{}:{}:{}",
            value["source"]["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes()
    ));
    Some(value)
}

fn selected_builtin(
    context: &FreshSourceContext<'_>,
    within: NodeKey,
    builtin: &str,
    expected: &str,
) -> Option<NodeKey> {
    let mut hits = context
        .original()
        .types
        .selected_calls
        .iter()
        .filter(|(node, selected)| {
            node.file == within.file
                && within.start <= node.start
                && node.end <= within.end
                && matches!(&selected.target,SelectedCallTarget::Builtin{id,..} if id==builtin)
                && t::text(context.db(), **node) == Some(expected)
        });
    let (node, original) = hits.next()?;
    (hits.next().is_none()
        && format!("{original:?}")
            == format!("{:?}", context.program().types.selected_calls.get(node)?))
    .then_some(*node)
}

fn query_site(
    context: &FreshSourceContext<'_>,
    call: NodeKey,
    stage: &str,
    builtin: &str,
    model: &str,
    domain: &str,
    owner_path: &[&str],
    outer: Option<(NodeKey, &str)>,
    order: &[&str],
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let model_id = t::symbol(program, model)?;
    let (query_node, alias, predicate, selection, checked_order) = if builtin == "sum" {
        let mut hits=program.types.checked_queries.iter().filter(|(node,query)|
            node.file==call.file && call.start<=node.start && node.end<=call.end
            && matches!(&query.domain_type,ResolvedType::Array{element,..} if t::record_is(program,element,model)));
        let (node, query) = hits.next()?;
        if hits.next().is_some()
            || t::text(db, query.domain) != Some(domain)
            || format!("{query:?}")
                != format!("{:?}", context.program().types.checked_queries.get(node)?)
            || !order.is_empty()
        {
            return None;
        }
        let (alias, predicate, selection) = match query.clauses.as_slice() {
            [a, s]
                if matches!(a.kind, CheckedQueryClauseKind::As { .. })
                    && matches!(s.kind, CheckedQueryClauseKind::Select) =>
            {
                (a.node, None, *s.expressions.first()?)
            }
            [a, w, s]
                if matches!(a.kind, CheckedQueryClauseKind::As { .. })
                    && matches!(w.kind, CheckedQueryClauseKind::Where)
                    && matches!(s.kind, CheckedQueryClauseKind::Select) =>
            {
                (
                    a.node,
                    Some(*w.expressions.first()?),
                    *s.expressions.first()?,
                )
            }
            _ => return None,
        };
        (*node, Some(alias), predicate, Some(selection), None)
    } else if builtin == "count" {
        let selected = program.types.selected_calls.get(&call)?;
        if !matches!(&selected.target,SelectedCallTarget::Builtin{id,..} if id=="count")
            || format!("{selected:?}")
                != format!("{:?}", context.program().types.selected_calls.get(&call)?)
        {
            return None;
        }
        let [node] = selected.arguments.as_slice() else {
            return None;
        };
        if t::text(db, *node) != Some(domain)
            || !matches!(program.types.node_types.get(node),Some(ResolvedType::Array{element,..})
                if t::record_is(program,element,model))
            || program.types.node_types.get(node) != context.program().types.node_types.get(node)
            || !order.is_empty()
        {
            return None;
        }
        (*node, None, None, None, None)
    } else {
        let fact = program.types.checked_collection_calls.get(&call)?;
        if fact.model != model_id
            || fact.builtin != builtin
            || format!("{fact:?}")
                != format!(
                    "{:?}",
                    context
                        .program()
                        .types
                        .checked_collection_calls
                        .get(&call)?
                )
        {
            return None;
        }
        let query = program.types.checked_queries.get(&fact.query)?;
        if t::text(db, query.domain) != Some(domain) {
            return None;
        }
        let clauses = query.clauses.as_slice();
        let (predicate, checked_order) = match builtin {
            "any"
                if matches!(clauses,[a] if matches!(a.kind,CheckedQueryClauseKind::As{..})
                && a.node==fact.alias)
                    && order.is_empty() =>
            {
                (Some(fact.predicate.as_ref()?.node), None)
            }
            "count"
                if matches!(clauses,[a] if matches!(a.kind,CheckedQueryClauseKind::As{..})
                && a.node==fact.alias)
                    && order.is_empty() =>
            {
                (None, None)
            }
            "first"
                if matches!(clauses,[a,o] if matches!(a.kind,CheckedQueryClauseKind::As{..})
                && a.node==fact.alias && matches!(o.kind,CheckedQueryClauseKind::Order)
                && o.expressions.len()==order.len()
                && o.expressions.iter().zip(order).all(|(n,want)|t::text(db,*n)==Some(*want))) =>
            {
                (None, Some(clauses[1].node))
            }
            _ => return None,
        };
        (fact.query, Some(fact.alias), predicate, None, checked_order)
    };
    if predicate.is_some_and(|node| {
        program.types.node_types.get(&node) != Some(&ResolvedType::Scalar(Scalar::Bool))
    }) {
        return None;
    }
    let module = model.split('.').next()?;
    let origin = t::source(program, db, call, module)?;
    let chain = outer
        .map(|(node, derive)| {
            Some(json!({"source":t::source(program,db,node,"invoice")?,
        "callSite":t::interval(node),"derive":derive}))
        })
        .into_iter()
        .collect::<Option<Vec<_>>>()?;
    // Imported financial and authority helpers are shared with invoice.collect.
    // Their source reads need one stable marker under either owning lease.
    let namespace = if matches!(
        stage,
        "authorityWork"
            | "balanceCredits"
            | "balanceReceivedAttempts"
            | "balanceReceivedExternal"
            | "refundedAttempts"
            | "refundedExternal"
            | "settlementCollectionPending"
            | "settlementRefundPending"
    ) {
        "invoice-collect-query"
    } else {
        "invoice-issue-query"
    };
    let id = sha256_hex(
        format!(
            "{namespace}/v1:{stage}:{model}:{}:{}:{}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":stage,"model":model,"source":origin,
        "queryNode":t::interval(query_node),"callSite":t::interval(call),
        "aliasSite":alias.map(t::interval),"predicateSite":predicate.map(t::interval),
        "selectionSite":selection.map(t::interval),"orderSite":checked_order.map(t::interval),
        "domainKind":if owner_path.is_empty(){"team"}else{"child"},
        "ownerPath":owner_path,"order":order,"deriveChain":chain}))
}

fn source_effect_shape(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<()> {
    if owner.canonical != "invoice.issue" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    if t::text(db, scenario.node) != Some(ISSUE)
        || scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.and_then(|node| t::text(db, node)) != Some("finance")
        || scenario.params.len() != 2
        || scenario.guards.len() != 2
        || scenario.effects.len() != 7
    {
        return None;
    }
    let customer = t::symbol(program, "customer.Customer")?;
    let location = t::symbol(program, "rent_catalog.Location")?;
    let employee = t::symbol(program, "employee.Employee")?;
    let invoice = t::symbol(program, "invoice.Invoice")?;
    let defaults = t::symbol(program, "invoice.Defaults")?;
    let line = t::symbol(program, "invoice.Line")?;
    let credit = t::symbol(program, "invoice.Credit")?;
    let attempt = t::symbol(program, "invoice.Attempt")?;
    let external_payment = t::symbol(program, "invoice.ExternalPayment")?;
    let external_refund = t::symbol(program, "invoice.ExternalRefund")?;
    let settlement = t::symbol(program, "invoice.settlement")?;
    let settlement_event = t::symbol(program, "invoice.InvoiceSettlement")?;
    let overdue_event = t::symbol(program, "invoice.Overdue")?;
    let can_work = t::symbol(program, "employee.can_work")?;
    let credits = t::symbol(program, "invoice.Invoice.credits")?;
    let received = t::symbol(program, "invoice.Invoice.received")?;
    let refunded = t::symbol(program, "invoice.Invoice.refunded")?;
    t::checked_closure(
        context,
        scenario.node,
        &[can_work, settlement, credits, received, refunded],
        &[
            customer,
            location,
            employee,
            invoice,
            defaults,
            line,
            credit,
            attempt,
            external_payment,
            external_refund,
        ],
    )?;
    for id in [
        customer,
        location,
        employee,
        invoice,
        defaults,
        line,
        credit,
        attempt,
        external_payment,
        external_refund,
        settlement,
        settlement_event,
        overdue_event,
        can_work,
        credits,
        received,
        refunded,
    ] {
        same_item(context, id)?;
    }
    if [customer, location, employee, defaults].iter().any(|id| {
        program
            .effects
            .models
            .get(id)
            .is_none_or(|model| model.owner != ModelOwner::Team)
    }) || program.effects.models.get(&invoice)?.owner != ModelOwner::ChildOf(customer)
        || [line, credit, attempt, external_payment, external_refund]
            .iter()
            .any(|id| {
                program
                    .effects
                    .models
                    .get(id)
                    .is_none_or(|model| model.owner != ModelOwner::ChildOf(invoice))
            })
    {
        return None;
    }
    for ((param, name), ty) in scenario
        .params
        .iter()
        .zip(["invoice", "number"])
        .zip(["invoice.Invoice", "text"])
    {
        if program.symbols.get(param.param.0 as usize)?.name != name || param.default.is_some() {
            return None;
        }
        let actual = program.types.symbol_types.get(&param.param)?;
        if if ty == "text" {
            actual != &ResolvedType::Scalar(Scalar::Text)
        } else {
            !t::record_is(program, actual, ty)
        } {
            return None;
        }
    }
    let [header, unique] = scenario.guards.as_slice() else {
        return None;
    };
    let [first, require, total, set, emit, send, schedule] = scenario.effects.as_slice() else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || unique.verb != EffectVerb::Require
        || first.verb != EffectVerb::Let
        || require.verb != EffectVerb::Require
        || total.verb != EffectVerb::Let
        || set.verb != EffectVerb::Set
        || emit.verb != EffectVerb::Emit
        || send.verb != EffectVerb::Send
        || schedule.verb != EffectVerb::Schedule
        || [
            header, unique, first, require, total, set, emit, send, schedule,
        ]
        .iter()
        .any(|effect| !t::no_children(effect))
        || header.cond.and_then(|node| t::text(db, node)) != Some(HEADER)
        || unique.cond.and_then(|node| t::text(db, node)) != Some(UNIQUE)
        || first.value.and_then(|node| t::text(db, node)) != Some(FIRST)
        || first.binding.as_deref() != Some("defaults")
        || require.cond.and_then(|node| t::text(db, node)) != Some(DEFAULTS_REQUIRE)
        || total.value.and_then(|node| t::text(db, node)) != Some(TOTAL)
        || total.binding.as_deref() != Some("total")
        || !matches!(set.target, Some(EffectTarget::Record {model:Some(id)}) if id==invoice)
        || !t::args_match(
            db,
            set,
            &[
                ("state", Some("issued")),
                ("total", None),
                ("number", None),
                ("issued_at", Some("now")),
                ("attempt_limit", Some("defaults.attempt_limit")),
                ("retry_delay", Some("defaults.retry_delay")),
                ("retry_until", Some("now+defaults.retry_window")),
                ("ledger_revision", Some("invoice.ledger_revision+1")),
            ],
        )
        || !matches!(emit.target, Some(EffectTarget::Event(id)) if id==settlement_event)
        || !t::args_match(db, emit, &[("value", Some("settlement(invoice)"))])
        || send.target_node.and_then(|node| t::text(db, node)) != Some("Mail.send")
        || !t::args_match(
            db,
            send,
            &[
                ("to", Some("invoice.recipient_email")),
                ("subject", Some("format(notice_invoice_issued,locale=null)")),
                (
                    "body",
                    Some(
                        "format(\"{description} {url}\",{description=invoice.description,url=app_url(format(\"/finance/invoice/{invoice}\",{invoice=invoice.id}))})",
                    ),
                ),
            ],
        )
        || send.when.and_then(|node| t::text(db, node)) != Some(WHEN)
        || send.binding.as_deref() != Some("notice")
        || !matches!(schedule.target, Some(EffectTarget::Event(id)) if id==overdue_event)
        || schedule.key.and_then(|node| t::text(db, node)) != Some("invoice.id")
        || schedule.at.and_then(|node| t::text(db, node))
            != Some(
                "local_instant(add_days(invoice.due,1),\"00:00\",invoice.location.timezone,fold=earlier)",
            )
        || !t::args_match(
            db,
            schedule,
            &[("invoice", None), ("revision", Some("invoice.version+1"))],
        )
        || program
            .effects
            .derives
            .get(&settlement)?
            .expr
            .and_then(|node| t::text(db, node))
            != Some(SETTLEMENT)
        || program
            .effects
            .derives
            .get(&can_work)?
            .expr
            .and_then(|node| t::text(db, node))
            != Some(WORK)
        || program
            .effects
            .derives
            .get(&credits)?
            .expr
            .and_then(|node| t::text(db, node))
            != Some(CREDITS)
        || program
            .effects
            .derives
            .get(&received)?
            .expr
            .and_then(|node| t::text(db, node))
            != Some(RECEIVED)
        || program
            .effects
            .derives
            .get(&refunded)?
            .expr
            .and_then(|node| t::text(db, node))
            != Some(REFUNDED)
    {
        return None;
    }
    let IrItemKind::Scenario {
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        read: false,
        result: None,
        params,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::Require { span: h, .. },
        IrStmt::Require { span: u, .. },
    ] = guards.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Let {
            span: f,
            name: fn_name,
            ..
        },
        IrStmt::Require { span: r, .. },
        IrStmt::Let {
            span: tot,
            name: total_name,
            ..
        },
        IrStmt::Set { span: s, .. },
        IrStmt::Emit {
            span: e,
            event: ir_event,
            ..
        },
        IrStmt::Send {
            span: mail,
            operation,
            when: Some(ir_when),
            binding: Some(ir_binding),
            ..
        },
        IrStmt::Schedule {
            span: d,
            event: due,
            ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    if params.len() != 2
        || *h != t::span(header.node)
        || *u != t::span(unique.node)
        || *f != t::span(first.node)
        || fn_name != "defaults"
        || *r != t::span(require.node)
        || *tot != t::span(total.node)
        || total_name != "total"
        || *s != t::span(set.node)
        || *e != t::span(emit.node)
        || ir_event != "invoice.InvoiceSettlement"
        || *mail != t::span(send.node)
        || operation != "std.EmailV1.send"
        || ir_binding != "notice"
        || ir_when.span != t::span(send.when?)
        || *d != t::span(schedule.node)
        || due != "invoice.Overdue"
    {
        return None;
    }
    Some(())
}

/// The imported employee helper's membership call is reached only through the
/// first authored Require. Pin that invocation to the exact Issue source and
/// freshly rebuilt IR before the native owner frame can observe it.
pub(super) fn collect_issue_membership_sites(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<Value>> {
    source_effect_shape(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let header = scenario.guards.first()?;
    let cond = header.cond?;
    let can_work = t::symbol(program, "employee.can_work")?;
    let outer = t::selected_derive(program, cond, can_work)?;
    if t::text(db, outer) != Some("can_work(actor,invoice.location)") {
        return None;
    }
    let work_expr = program.effects.derives.get(&can_work)?.expr?;
    if t::text(db, work_expr) != Some(WORK) {
        return None;
    }
    let member = selected_builtin(
        context,
        work_expr,
        "active_member",
        "active_member(person,team)",
    )?;
    let selected = program.types.selected_calls.get(&member)?;
    if !matches!(&selected.target, SelectedCallTarget::Builtin { id, overload }
            if id == "active_member" && *overload == 0)
        || selected.arguments.len() != 2
        || selected.slots != [Some(0), Some(1)]
        || t::text(db, selected.arguments[0]) != Some("person")
        || t::text(db, selected.arguments[1]) != Some("team")
        || program.types.node_types.get(&member) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&selected.arguments[0])
            != Some(&ResolvedType::Scalar(Scalar::User))
        || program.types.node_types.get(&selected.arguments[1]) != Some(&ResolvedType::Team)
    {
        return None;
    }
    let plain = |node: NodeKey| json!({"start":node.start,"end":node.end});
    let owner_source = t::source(program, db, cond, "invoice")?;
    let call = json!({
        "source":t::source(program, db, member, "employee")?,
        "node":plain(member),
        "target":{"kind":"builtin","id":"active_member","overload":0},
        "arguments":[
            {"node":plain(selected.arguments[0]),"type":"user"},
            {"node":plain(selected.arguments[1]),"type":"Team"}
        ],
        "slots":[0,1],"defaults":[],
        "chain":[{"source":owner_source,"node":plain(outer),"derive":"employee.can_work"}]
    });
    Some(vec![json!({
        "version":1,"source":owner_source,"owner":owner.canonical,
        "node":plain(cond),"statement":plain(header.node),
        "stage":"leading-require","position":[{"kind":"guard","index":0}],
        "calls":[call]
    })])
}

pub(super) fn prepare_issue_send_guard(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    source_effect_shape(context, owner)?;
    let program = context.original();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let send = scenario.effects.get(5)?;
    let predicate = send.when?;
    let invoice_id = scenario.params.first()?.param;
    let original_type = program.types.symbol_types.get(&invoice_id)?.clone();
    if !t::record_is(program, &original_type, "invoice.Invoice")
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || context.program().types.node_types.get(&predicate)
            != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let name_refs = context
        .trees()
        .iter()
        .find(|(file, _)| *file == predicate.file)?
        .1
        .descendants()
        .filter(|node| {
            node.kind == SyntaxKind::NameRef
                && node.span.start >= predicate.start
                && node.span.end <= predicate.end
                && t::text(context.db(), NodeKey::of(node)) == Some("invoice")
        })
        .collect::<Vec<_>>();
    if name_refs.len() != 1 {
        return None;
    }
    let lexical = NodeKey::of(name_refs[0]);
    if t::text(context.db(), lexical) != Some("invoice")
        || !matches!(context.resolved().node_binding.get(&lexical), Some(Binding::Symbol(id)) if *id==invoice_id)
    {
        return None;
    }
    let SymbolKind::Param {
        type_node: declaration,
        ..
    } = program.symbols.get(invoice_id.0 as usize)?.kind
    else {
        return None;
    };
    let source = t::source(program, context.db(), predicate, "invoice")?;
    let rule = format!(
        "invoice.issue.sendWhen.{}.{}.{}",
        source["sha256"].as_str()?,
        predicate.start,
        predicate.end
    );
    let input = PreparedSendInput {
        name: "invoice".into(),
        type_id: "invoice.Invoice".into(),
        value: TypedExpr::new(
            IrExpr::Name("invoice".into()),
            original_type,
            t::span(lexical),
        ),
        declaration,
        symbol: Some(invoice_id),
        owner: owner.id,
        ordinal: 0,
        narrowing: None,
    };
    let descriptor = json!({"rule":rule,"owner":"invoice.issue","source":source,
        "node":t::interval(predicate),"statement":t::interval(send.node),
        "target":"std.EmailV1.send","binding":"invoice.Mail","sourceBinding":"notice",
        "inputs":[{"name":"invoice","type":"invoice.Invoice"}]});
    let ir_send = match &owner.kind {
        IrItemKind::Scenario { effects, .. } => effects.get(5)?,
        _ => return None,
    };
    let IrStmt::Send {
        when: Some(ir_when),
        ..
    } = ir_send
    else {
        return None;
    };
    Some((
        t::span(send.node),
        PreparedSendGuard {
            rule,
            predicate: ir_when.clone(),
            descriptor,
            inputs: vec![input],
            event_source: None,
        },
    ))
}

pub(super) fn collect_issue_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    source_effect_shape(context, item)?;
    let program = context.original();
    let scenario = program.effects.scenarios.get(&item.id)?;
    let send = scenario.effects.get(5)?;
    let prepared = send_guards.get(&t::span(send.node))?;
    if prepared.rule.is_empty() || prepared.predicate.span != t::span(send.when?) {
        return None;
    }
    let file = context.db().get(scenario.node.file)?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "invoice".into(),
        },
        entry_module,
    )?;
    let id = sha256_hex(
        format!(
            "invoice-issue-void/v1:{}:{}:{}",
            source.sha256, scenario.node.start, scenario.node.end
        )
        .as_bytes(),
    );
    let can_work = t::symbol(program, "employee.can_work")?;
    let credits = t::symbol(program, "invoice.Invoice.credits")?;
    let received = t::symbol(program, "invoice.Invoice.received")?;
    let refunded = t::symbol(program, "invoice.Invoice.refunded")?;
    let settlement = t::symbol(program, "invoice.settlement")?;
    let work_call = t::selected_derive(program, scenario.guards[0].cond?, can_work)?;
    let settlement_value = scenario.effects[4]
        .args
        .iter()
        .find(|a| a.key == "value")?
        .value?;
    let settlement_call = t::selected_derive(program, settlement_value, settlement)?;
    if t::text(context.db(), work_call) != Some("can_work(actor,invoice.location)")
        || t::text(context.db(), settlement_call) != Some("settlement(invoice)")
    {
        return None;
    }
    let work_expr = program.effects.derives.get(&can_work)?.expr?;
    let credits_expr = program.effects.derives.get(&credits)?.expr?;
    let received_expr = program.effects.derives.get(&received)?.expr?;
    let refunded_expr = program.effects.derives.get(&refunded)?.expr?;
    let settlement_expr = program.effects.derives.get(&settlement)?.expr?;
    let q = |within, builtin, source| selected_builtin(context, within, builtin, source);
    let query_sites = vec![
        query_site(
            context,
            q(work_expr, "any", WORK)?,
            "authorityWork",
            "any",
            "employee.Employee",
            "Employee",
            &[],
            Some((work_call, "employee.can_work")),
            &[],
        )?,
        query_site(
            context,
            q(scenario.guards[0].cond?, "count", "count(invoice.Line)")?,
            "lineCount",
            "count",
            "invoice.Line",
            "invoice.Line",
            &["invoice"],
            None,
            &[],
        )?,
        query_site(
            context,
            q(
                scenario.guards[1].cond?,
                "any",
                "any(Invoice as other,other.number==number)",
            )?,
            "numberUnique",
            "any",
            "invoice.Invoice",
            "Invoice",
            &[],
            None,
            &[],
        )?,
        query_site(
            context,
            q(scenario.effects[0].value?, "first", FIRST)?,
            "defaultsFirst",
            "first",
            "invoice.Defaults",
            "Defaults",
            &[],
            None,
            &["setting.id"],
        )?,
        query_site(
            context,
            q(scenario.effects[2].value?, "sum", TOTAL)?,
            "lineTotal",
            "sum",
            "invoice.Line",
            "invoice.Line",
            &["invoice"],
            None,
            &[],
        )?,
        query_site(
            context,
            q(credits_expr, "sum", CREDITS)?,
            "balanceCredits",
            "sum",
            "invoice.Credit",
            "row.Credit",
            &["invoice"],
            None,
            &[],
        )?,
        query_site(
            context,
            q(
                received_expr,
                "sum",
                "sum(row.Attempt as attempt where attempt.kind==collection and attempt.status==succeeded select attempt.amount,row.currency)",
            )?,
            "balanceReceivedAttempts",
            "sum",
            "invoice.Attempt",
            "row.Attempt",
            &["invoice"],
            None,
            &[],
        )?,
        query_site(
            context,
            q(
                received_expr,
                "sum",
                "sum(row.ExternalPayment as payment select payment.amount,row.currency)",
            )?,
            "balanceReceivedExternal",
            "sum",
            "invoice.ExternalPayment",
            "row.ExternalPayment",
            &["invoice"],
            None,
            &[],
        )?,
        query_site(
            context,
            q(
                refunded_expr,
                "sum",
                "sum(row.Attempt as attempt where attempt.kind==refund and attempt.status==succeeded select attempt.amount,row.currency)",
            )?,
            "refundedAttempts",
            "sum",
            "invoice.Attempt",
            "row.Attempt",
            &["invoice"],
            None,
            &[],
        )?,
        query_site(
            context,
            q(
                refunded_expr,
                "sum",
                "sum(row.ExternalRefund as refund select refund.amount,row.currency)",
            )?,
            "refundedExternal",
            "sum",
            "invoice.ExternalRefund",
            "row.ExternalRefund",
            &["invoice"],
            None,
            &[],
        )?,
        query_site(
            context,
            q(
                settlement_expr,
                "any",
                "any(invoice.Attempt as attempt,attempt.kind==collection and attempt.status in [pending,unknown])",
            )?,
            "settlementCollectionPending",
            "any",
            "invoice.Attempt",
            "invoice.Attempt",
            &["invoice"],
            Some((settlement_call, "invoice.settlement")),
            &[],
        )?,
        query_site(
            context,
            q(
                settlement_expr,
                "any",
                "any(invoice.Attempt as attempt,attempt.kind==refund and attempt.status in [pending,unknown])",
            )?,
            "settlementRefundPending",
            "any",
            "invoice.Attempt",
            "invoice.Attempt",
            &["invoice"],
            Some((settlement_call, "invoice.settlement")),
            &[],
        )?,
    ];
    let mut defaults_site = site(
        context,
        scenario.effects[0].value?,
        scenario.effects[0].node,
        "defaults-first",
    )?;
    defaults_site["model"] = json!("invoice.Defaults");
    let mut total_site = site(
        context,
        scenario.effects[2].value?,
        scenario.effects[2].node,
        "line-sum",
    )?;
    total_site["model"] = json!("invoice.Line");
    let mut set_site = site(
        context,
        scenario.effects[3].node,
        scenario.effects[3].node,
        "invoice-set",
    )?;
    set_site["model"] = json!("invoice.Invoice");
    let mut emit_site = site(
        context,
        scenario.effects[4].node,
        scenario.effects[4].node,
        "settlement-emit",
    )?;
    emit_site["event"] = json!("invoice.InvoiceSettlement");
    let mut send_site = site(context, send.when?, send.node, "mail-send")?;
    send_site["operation"] = json!("std.EmailV1.send");
    let mut schedule_site = site(
        context,
        scenario.effects[6].node,
        scenario.effects[6].node,
        "overdue-schedule",
    )?;
    schedule_site["event"] = json!("invoice.Overdue");
    let decision = json!({"version":1,"owner":"invoice.issue","source":t::source(program,context.db(),scenario.node,"invoice")?,
        "parameters":[{"name":"invoice","type":"invoice.Invoice"},{"name":"number","type":"text"}],
        "roleSite":site(context,scenario.by?,scenario.node,"role")?,
        "sites":{"headers":[site(context,scenario.guards[0].cond?,scenario.guards[0].node,"header")?,
            site(context,scenario.guards[1].cond?,scenario.guards[1].node,"unique")?],
            "defaultsFirst":defaults_site,
            "defaultsRequire":site(context,scenario.effects[1].cond?,scenario.effects[1].node,"defaults-require")?,
            "lineSum":total_site,
            "invoiceSet":set_site,
            "settlementEmit":emit_site,
            "mailSend":send_site,
            "overdueSchedule":schedule_site},
        "querySites":query_sites,
        "sendRule":{"rule":prepared.rule,"source":prepared.descriptor["source"],
            "node":prepared.descriptor["node"],"statement":prepared.descriptor["statement"]}});
    let calls = HashMap::from([(
        NativeSite {
            calls: Vec::new(),
            span: t::span(work_call),
            default_selection: false,
        },
        "employee.can_work".into(),
    )]);
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
            invoice_issue_decision: Some(decision),
            observe_venue_decision: None,
            success_renewal_decision: None,
            queries: Vec::new(),
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
        calls,
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
