//! The one source-bound event owner that queues an overdue invoice reminder.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{EffectVerb, HandlerSource};
use crate::analysis::resolve::{ModelOwner, SymbolKind};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::{ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};

use super::ir::{IrEventSource, IrExpr, IrItem, IrItemKind, IrStmt};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};
use super::send_guards::PreparedSendGuard;
use super::term_decisions as t;

const CONDITION: &str = "event.invoice.state==issued and event.invoice.balance.minor>0";
const SUBJECT: &str = "format(\"Invoice overdue\"@{nl=\"Factuur achterstallig\"},locale=null)";
const BODY: &str = "format(\"{description} {url}\",{description=event.invoice.description,url=app_url(format(\"/finance/invoice/{invoice}\",{invoice=event.invoice.id}))})";
const CREDITS: &str = "sum(row.Credit as credit select credit.amount,row.currency)";
const RECEIVED: &str = "sum(row.Attempt as attempt where attempt.kind==collection and attempt.status==succeeded select attempt.amount,row.currency)+sum(row.ExternalPayment as payment select payment.amount,row.currency)";
const BALANCE: &str = "max([money(0,row.currency),row.total-row.credits-row.received])";

fn same_item(
    context: &FreshSourceContext<'_>,
    id: crate::analysis::resolve::SymbolId,
) -> Option<()> {
    let original = context.ir().items.get(id.0 as usize)?;
    let fresh = context.fresh().items.get(id.0 as usize)?;
    (original.canonical == fresh.canonical
        && format!("{:?}", original.kind) == format!("{:?}", fresh.kind))
    .then_some(())
}

fn site(
    context: &FreshSourceContext<'_>,
    node: crate::analysis::NodeKey,
    statement: crate::analysis::NodeKey,
    kind: &str,
) -> Option<Value> {
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        return None;
    }
    let source = t::source(context.original(), context.db(), node, "invoice")?;
    let id = sha256_hex(
        format!(
            "invoice-overdue/v1:{kind}:{}:{}:{}:{}:{}",
            source["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"source":source,"node":t::interval(node),
        "statement":t::interval(statement)}))
}

pub(super) fn prepare_overdue(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    if owner.canonical != "invoice.overdue" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let customer = t::symbol(program, "customer.Customer")?;
    let invoice = t::symbol(program, "invoice.Invoice")?;
    let attempt = t::symbol(program, "invoice.Attempt")?;
    let credit = t::symbol(program, "invoice.Credit")?;
    let payment = t::symbol(program, "invoice.ExternalPayment")?;
    let event = t::symbol(program, "invoice.Overdue")?;
    let credits = t::symbol(program, "invoice.Invoice.credits")?;
    let received = t::symbol(program, "invoice.Invoice.received")?;
    let balance = t::symbol(program, "invoice.Invoice.balance")?;
    t::checked_closure(
        context,
        scenario.node,
        &[credits, received, balance],
        &[customer, invoice, attempt, credit, payment],
    )?;
    for id in [
        customer, invoice, attempt, credit, payment, event, credits, received, balance,
    ] {
        same_item(context, id)?;
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || !matches!(scenario.on, Some(HandlerSource::Event(id)) if id == event)
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.is_some()
        || !scenario.params.is_empty()
        || scenario.guards.len() != 1
        || scenario.effects.len() != 1
        || program.effects.models.get(&invoice)?.owner != ModelOwner::ChildOf(customer)
        || [attempt, credit, payment].iter().any(|id| {
            program
                .effects
                .models
                .get(id)
                .is_none_or(|model| model.owner != ModelOwner::ChildOf(invoice))
        })
        || program.effects.models.get(&customer)?.owner != ModelOwner::Team
    {
        return None;
    }
    let SymbolKind::Event { fields } = &program.symbols.get(event.0 as usize)?.kind else {
        return None;
    };
    if fields.len() != 2
        || program.symbols.get(fields[0].0 as usize)?.name != "invoice"
        || program.symbols.get(fields[1].0 as usize)?.name != "revision"
        || !program
            .types
            .symbol_types
            .get(&fields[0])
            .is_some_and(|ty| t::record_is(program, ty, "invoice.Invoice"))
        || program.types.symbol_types.get(&fields[1]) != Some(&ResolvedType::Scalar(Scalar::Int))
    {
        return None;
    }
    for (id, expected) in [(credits, CREDITS), (received, RECEIVED), (balance, BALANCE)] {
        let data = program.effects.derives.get(&id)?;
        if data.derive != id
            || data.module != scenario.module
            || data.expr.and_then(|node| t::text(db, node)) != Some(expected)
            || !data.params.is_empty()
            || data
                .expr
                .and_then(|node| program.types.node_types.get(&node))
                != Some(&ResolvedType::Scalar(Scalar::Money))
        {
            return None;
        }
    }
    let [header] = scenario.guards.as_slice() else {
        return None;
    };
    let [send] = scenario.effects.as_slice() else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || !t::no_children(header)
        || header.cond.and_then(|node| t::text(db, node)) != Some(CONDITION)
        || send.verb != EffectVerb::Send
        || !t::no_children(send)
        || send.target_node.and_then(|node| t::text(db, node)) != Some("Mail.send")
        || send.binding.as_deref() != Some("notice")
        || send.when.and_then(|node| t::text(db, node)) != Some(CONDITION)
        || !t::args_match(
            db,
            send,
            &[
                ("to", Some("event.invoice.recipient_email")),
                ("subject", Some(SUBJECT)),
                ("body", Some(BODY)),
            ],
        )
        || program.types.node_types.get(&header.cond?) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&send.when?) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(IrEventSource::Declared(source)),
        hook: None,
        cohort: None,
        read: false,
        result: None,
        params,
        by,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::Require {
            cond: ir_header,
            span: header_span,
            ..
        },
    ] = guards.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Send {
            operation,
            args,
            binding: Some(binding),
            when: Some(ir_when),
            span: send_span,
            ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    if source != "invoice.Overdue"
        || !params.is_empty()
        || !by.is_empty()
        || *header_span != t::span(header.node)
        || ir_header.span != t::span(header.cond?)
        || operation != "std.EmailV1.send"
        || binding != "notice"
        || *send_span != t::span(send.node)
        || ir_when.span != t::span(send.when?)
        || !matches!(&args.expr, IrExpr::Object(fields) if fields.len() == 3)
    {
        return None;
    }
    let guard = send_guards.get(&t::span(send.node))?;
    if guard.predicate.span != t::span(send.when?)
        || guard.rule.is_empty()
        || guard.event_source.as_ref()?.model_field != "invoice"
        || guard.descriptor["eventSource"]["event"] != "invoice.Overdue"
        || guard.descriptor["eventSource"]["modelField"]["fields"] != json!(["balance", "state"])
        || guard.descriptor["target"] != "std.EmailV1.send"
        || guard.descriptor["binding"] != "invoice.Mail"
        || guard.descriptor["sourceBinding"] != "notice"
    {
        return None;
    }
    let origin = t::source(program, db, scenario.node, "invoice")?;
    let when = site(context, send.when?, send.node, "send")?;
    Some(
        json!({"version":1,"owner":"invoice.overdue","source":origin,
        "event":{"name":"invoice.Overdue","modelField":"invoice",
            "model":"invoice.Invoice","revisionField":"revision"},
        "sites":{"header":site(context,header.cond?,header.node,"header")?,
            "send":when.clone()},
        "sendRule":{"rule":guard.rule,"source":when["source"],"node":when["node"],
            "statement":when["statement"]}}),
    )
}

pub(super) fn collect_overdue_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_overdue(context, item, send_guards)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
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
            "invoice-overdue-void/v1:{}:{}:{}",
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
            refer_reject_decision: None,
            member_retry_decision: None,
            invoice_overdue_decision: Some(decision),
            rent_movement_refund_decision: None,
            invoice_collect_decision: None,queries: Vec::new(),
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
