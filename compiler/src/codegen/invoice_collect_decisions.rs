//! The exact invoice collection owner, including its authority and financial scans.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{EffectTarget, EffectVerb};
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
use super::send_guards::PreparedSendGuard;
use super::term_decisions as t;

const HEADER: &str = "invoice.state==issued and invoice.balance.minor>0 and (has_role(actor,invoice.parent,billing) or owns(actor,invoice.parent) or (finance and can_work(actor,invoice.location)))";
const NO_PENDING: &str = "not any(invoice.Attempt as attempt,attempt.kind==collection and (attempt.status in [pending,unknown] or (attempt.status==failed and attempt.failure==permanent)))";
const CANCEL: &str = "cancel format(\"{invoice}:collection\",{invoice=invoice.id})";
const RESET: &str = "set invoice {next_collection=null}";
const CREATE: &str = "create Attempt {parent=invoice,reference=operation.id,amount=invoice.balance,kind=collection} as attempt";
const SEND: &str = "send Payments.collect {customer=invoice.parent.id,amount=attempt.amount,reference=attempt.reference,consent=null} when=invoice.state==issued and invoice.balance==attempt.amount and not attempt.disabled as delivery";
const WHEN: &str =
    "invoice.state==issued and invoice.balance==attempt.amount and not attempt.disabled";
const DELIVERY_SET: &str = "set attempt {delivery=delivery.id}";
const LEDGER_SET: &str = "set invoice {ledger_revision=invoice.ledger_revision+1}";
const EMIT: &str = "emit InvoiceSettlement {value=settlement(invoice)}";
const ROLE: &str =
    "any(org.CompanyRole as grant,grant.account==person and grant.role==role and grant.active)";
const OWN: &str = "org.kind==individual and any(org.Contact as contact,contact.account==person and contact.verified)";
const WORK: &str = "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))";
const CREDITS: &str = "sum(row.Credit as credit select credit.amount,row.currency)";
const RECEIVED: &str = "sum(row.Attempt as attempt where attempt.kind==collection and attempt.status==succeeded select attempt.amount,row.currency)+sum(row.ExternalPayment as payment select payment.amount,row.currency)";
const REFUNDED: &str = "sum(row.Attempt as attempt where attempt.kind==refund and attempt.status==succeeded select attempt.amount,row.currency)+sum(row.ExternalRefund as refund select refund.amount,row.currency)";
const BALANCE: &str = "max([money(0,row.currency),row.total-row.credits-row.received])";
const SETTLEMENT: &str = "Settlement {source=invoice.source,invoice=invoice.id,revision=invoice.ledger_revision,amount=invoice.total,collected=invoice.received,refunded=invoice.refunded,collection_pending=any(invoice.Attempt as attempt,attempt.kind==collection and attempt.status in [pending,unknown]),refund_pending=any(invoice.Attempt as attempt,attempt.kind==refund and attempt.status in [pending,unknown]),state=invoice.state,recorded_at=now}";

fn same_item(context: &FreshSourceContext<'_>, id: SymbolId) -> Option<()> {
    let original = context.ir().items.get(id.0 as usize)?;
    let fresh = context.fresh().items.get(id.0 as usize)?;
    (original.canonical == fresh.canonical
        && format!("{:?}", original.kind) == format!("{:?}", fresh.kind))
    .then_some(())
}

fn site(
    program: &CheckedProgram,
    db: &SourceDb,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    let mut site = t::site(program, db, "invoice", node, statement, kind)?;
    site["id"] = json!(sha256_hex(
        format!(
            "invoice-collect/v1:{kind}:{}:{}:{}:{}:{}",
            site["source"]["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes()
    ));
    Some(site)
}

fn selected_derive(
    context: &FreshSourceContext<'_>,
    within: NodeKey,
    target: SymbolId,
    expected: &str,
) -> Option<NodeKey> {
    let call = t::selected_derive(context.original(), within, target)?;
    let original = context.original().types.selected_calls.get(&call)?;
    let fresh = context.program().types.selected_calls.get(&call)?;
    (t::text(context.db(), call) == Some(expected)
        && format!("{original:?}") == format!("{fresh:?}"))
    .then_some(call)
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
    model: &str,
    domain: &str,
    owner_path: &[&str],
    outer: Option<(NodeKey, &str)>,
    sum: bool,
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let model_id = t::symbol(program, model)?;
    let (query_node, alias, predicate, selection) = if sum {
        let mut queries=program.types.checked_queries.iter().filter(|(node,query)|
            node.file==call.file && call.start<=node.start && node.end<=call.end &&
            matches!(&query.domain_type,ResolvedType::Array{element,..} if t::record_is(program,element,model)));
        let (node, query) = queries.next()?;
        if queries.next().is_some()
            || t::text(db, query.domain) != Some(domain)
            || format!("{query:?}")
                != format!("{:?}", context.program().types.checked_queries.get(node)?)
        {
            return None;
        }
        let (alias, predicate, selection) = match query.clauses.as_slice() {
            [alias, select]
                if matches!(alias.kind, CheckedQueryClauseKind::As { .. })
                    && matches!(select.kind, CheckedQueryClauseKind::Select) =>
            {
                (alias.node, None, *select.expressions.first()?)
            }
            [alias, where_clause, select]
                if matches!(alias.kind, CheckedQueryClauseKind::As { .. })
                    && matches!(where_clause.kind, CheckedQueryClauseKind::Where)
                    && matches!(select.kind, CheckedQueryClauseKind::Select) =>
            {
                (
                    alias.node,
                    Some(*where_clause.expressions.first()?),
                    *select.expressions.first()?,
                )
            }
            _ => return None,
        };
        (*node, alias, predicate, Some(selection))
    } else {
        let fact = program.types.checked_collection_calls.get(&call)?;
        let fresh = context
            .program()
            .types
            .checked_collection_calls
            .get(&call)?;
        if fact.model != model_id
            || fact.builtin != "any"
            || format!("{fact:?}") != format!("{fresh:?}")
        {
            return None;
        }
        let query = program.types.checked_queries.get(&fact.query)?;
        if t::text(db, query.domain) != Some(domain)
            || !matches!(query.clauses.as_slice(),[alias] if matches!(alias.kind,CheckedQueryClauseKind::As{..}) && alias.node==fact.alias)
        {
            return None;
        }
        (
            fact.query,
            fact.alias,
            Some(fact.predicate.as_ref()?.node),
            None,
        )
    };
    if predicate.is_some_and(|node| {
        program.types.node_types.get(&node) != Some(&ResolvedType::Scalar(Scalar::Bool))
    }) {
        return None;
    }
    let module = model.split('.').next()?;
    let origin = t::source(program, db, call, module)?;
    let id = sha256_hex(
        format!(
            "invoice-collect-query/v1:{stage}:{model}:{}:{}:{}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    let chain = outer
        .map(|(node, derive)| {
            Some(json!({"source":t::source(program,db,node,"invoice")?,
                "callSite":t::interval(node),"derive":derive}))
        })
        .into_iter()
        .collect::<Option<Vec<_>>>()?;
    Some(json!({"id":id,"stage":stage,"model":model,"source":origin,
        "queryNode":t::interval(query_node),"callSite":t::interval(call),
        "aliasSite":t::interval(alias),"predicateSite":predicate.map(t::interval),
        "selectionSite":selection.map(t::interval),
        "domainKind":if owner_path.is_empty(){"team"}else{"child"},
        "ownerPath":owner_path,"order":[],"deriveChain":chain}))
}

pub(super) fn prepare_collect(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    if owner.canonical != "invoice.collect" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let customer = t::symbol(program, "customer.Customer")?;
    let contact = t::symbol(program, "customer.Contact")?;
    let company_role = t::symbol(program, "customer.CompanyRole")?;
    let employee = t::symbol(program, "employee.Employee")?;
    let location = t::symbol(program, "rent_catalog.Location")?;
    let invoice = t::symbol(program, "invoice.Invoice")?;
    let attempt = t::symbol(program, "invoice.Attempt")?;
    let credit = t::symbol(program, "invoice.Credit")?;
    let payment = t::symbol(program, "invoice.ExternalPayment")?;
    let refund = t::symbol(program, "invoice.ExternalRefund")?;
    let settlement_contract = t::symbol(program, "invoice.Settlement")?;
    let settlement_event = t::symbol(program, "invoice.InvoiceSettlement")?;
    let has_role = t::symbol(program, "customer.has_role")?;
    let owns = t::symbol(program, "customer.owns")?;
    let can_work = t::symbol(program, "employee.can_work")?;
    let credits = t::symbol(program, "invoice.Invoice.credits")?;
    let received = t::symbol(program, "invoice.Invoice.received")?;
    let refunded = t::symbol(program, "invoice.Invoice.refunded")?;
    let balance = t::symbol(program, "invoice.Invoice.balance")?;
    let settlement = t::symbol(program, "invoice.settlement")?;
    t::checked_closure(
        context,
        scenario.node,
        &[
            has_role, owns, can_work, credits, received, refunded, balance, settlement,
        ],
        &[
            customer,
            contact,
            company_role,
            employee,
            location,
            invoice,
            attempt,
            credit,
            payment,
            refund,
        ],
    )?;
    for id in [
        customer,
        contact,
        company_role,
        employee,
        location,
        invoice,
        attempt,
        credit,
        payment,
        refund,
        settlement_contract,
        settlement_event,
        has_role,
        owns,
        can_work,
        credits,
        received,
        refunded,
        balance,
        settlement,
    ] {
        same_item(context, id)?;
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.and_then(|n| t::text(db, n)) != Some("authenticated or finance")
        || scenario.params.len() != 1
        || scenario.guards.len() != 2
        || scenario.effects.len() != 7
        || program.effects.models.get(&customer)?.owner != ModelOwner::Team
        || program.effects.models.get(&employee)?.owner != ModelOwner::Team
        || program.effects.models.get(&location)?.owner != ModelOwner::Team
        || program.effects.models.get(&invoice)?.owner != ModelOwner::ChildOf(customer)
        || program.effects.models.get(&contact)?.owner != ModelOwner::ChildOf(customer)
        || program.effects.models.get(&company_role)?.owner != ModelOwner::ChildOf(customer)
        || [attempt, credit, payment, refund].iter().any(|id| {
            program
                .effects
                .models
                .get(id)
                .is_none_or(|m| m.owner != ModelOwner::ChildOf(invoice))
        })
    {
        return None;
    }
    let param = &scenario.params[0];
    if program.symbols.get(param.param.0 as usize)?.name != "invoice"
        || param.default.is_some()
        || !t::record_is(
            program,
            program.types.symbol_types.get(&param.param)?,
            "invoice.Invoice",
        )
    {
        return None;
    }
    let [header, pending] = scenario.guards.as_slice() else {
        return None;
    };
    let [cancel, reset, create, send, delivery_set, ledger_set, emit] = scenario.effects.as_slice()
    else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || !t::no_children(header)
        || header.message.is_some()
        || header.cond.and_then(|n| t::text(db, n)) != Some(HEADER)
        || pending.verb != EffectVerb::Require
        || !t::no_children(pending)
        || pending.message.is_some()
        || pending.cond.and_then(|n| t::text(db, n)) != Some(NO_PENDING)
        || cancel.verb != EffectVerb::Cancel
        || !t::no_children(cancel)
        || t::text(db, cancel.node) != Some(CANCEL)
        || cancel.value.and_then(|n| t::text(db, n))
            != Some("format(\"{invoice}:collection\",{invoice=invoice.id})")
        || reset.verb != EffectVerb::Set
        || !t::no_children(reset)
        || t::text(db, reset.node) != Some(RESET)
        || !matches!(reset.target,Some(EffectTarget::Record{model:Some(id)}) if id==invoice)
        || !t::args_match(db, reset, &[("next_collection", Some("null"))])
        || create.verb != EffectVerb::Create
        || !t::no_children(create)
        || t::text(db, create.node) != Some(CREATE)
        || !matches!(create.target,Some(EffectTarget::Model(id)) if id==attempt)
        || create.binding.as_deref() != Some("attempt")
        || !t::args_match(
            db,
            create,
            &[
                ("parent", Some("invoice")),
                ("reference", Some("operation.id")),
                ("amount", Some("invoice.balance")),
                ("kind", Some("collection")),
            ],
        )
        || send.verb != EffectVerb::Send
        || !t::no_children(send)
        || t::text(db, send.node) != Some(SEND)
        || send.target_node.and_then(|n| t::text(db, n)) != Some("Payments.collect")
        || send.binding.as_deref() != Some("delivery")
        || send.when.and_then(|n| t::text(db, n)) != Some(WHEN)
        || !t::args_match(
            db,
            send,
            &[
                ("customer", Some("invoice.parent.id")),
                ("amount", Some("attempt.amount")),
                ("reference", Some("attempt.reference")),
                ("consent", Some("null")),
            ],
        )
        || delivery_set.verb != EffectVerb::Set
        || !t::no_children(delivery_set)
        || t::text(db, delivery_set.node) != Some(DELIVERY_SET)
        || !matches!(delivery_set.target,Some(EffectTarget::Record{model:Some(id)}) if id==attempt)
        || !t::args_match(db, delivery_set, &[("delivery", Some("delivery.id"))])
        || ledger_set.verb != EffectVerb::Set
        || !t::no_children(ledger_set)
        || t::text(db, ledger_set.node) != Some(LEDGER_SET)
        || !matches!(ledger_set.target,Some(EffectTarget::Record{model:Some(id)}) if id==invoice)
        || !t::args_match(
            db,
            ledger_set,
            &[("ledger_revision", Some("invoice.ledger_revision+1"))],
        )
        || emit.verb != EffectVerb::Emit
        || !t::no_children(emit)
        || t::text(db, emit.node) != Some(EMIT)
        || !matches!(emit.target,Some(EffectTarget::Event(id)) if id==settlement_event)
        || !t::args_match(db, emit, &[("value", Some("settlement(invoice)"))])
    {
        return None;
    }
    for (id, expected) in [
        (has_role, ROLE),
        (owns, OWN),
        (can_work, WORK),
        (credits, CREDITS),
        (received, RECEIVED),
        (refunded, REFUNDED),
        (balance, BALANCE),
        (settlement, SETTLEMENT),
    ] {
        if program
            .effects
            .derives
            .get(&id)?
            .expr
            .and_then(|n| t::text(db, n))
            != Some(expected)
        {
            return None;
        }
    }
    for id in [has_role, owns, can_work] {
        if program.types.symbol_results.get(&id) != Some(&Some(ResolvedType::Scalar(Scalar::Bool)))
        {
            return None;
        }
    }
    for id in [credits, received, refunded, balance] {
        if program
            .effects
            .derives
            .get(&id)?
            .expr
            .and_then(|n| program.types.node_types.get(&n))
            != Some(&ResolvedType::Scalar(Scalar::Money))
        {
            return None;
        }
    }
    for cond in [header.cond?, pending.cond?, send.when?] {
        if program.types.node_types.get(&cond) != Some(&ResolvedType::Scalar(Scalar::Bool)) {
            return None;
        }
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
        IrStmt::Require { span: g0, .. },
        IrStmt::Require { span: g1, .. },
    ] = guards.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Cancel {
            owner_package,
            key,
            span: c,
        },
        IrStmt::Set {
            when: None,
            span: r,
            ..
        },
        IrStmt::Create {
            model: create_model,
            when: None,
            binding: Some(create_binding),
            span: cr,
            ..
        },
        IrStmt::Send {
            operation,
            when: Some(ir_when),
            binding: Some(send_binding),
            span: s,
            ..
        },
        IrStmt::Set {
            when: None,
            span: d,
            ..
        },
        IrStmt::Set {
            when: None,
            span: l,
            ..
        },
        IrStmt::Emit { event, span: e, .. },
    ] = effects.as_slice()
    else {
        return None;
    };
    if *g0 != t::span(header.node)
        || *g1 != t::span(pending.node)
        || owner_package != "invoice"
        || key.span != t::span(cancel.value?)
        || *c != t::span(cancel.node)
        || *r != t::span(reset.node)
        || create_model != "invoice.Attempt"
        || create_binding != "attempt"
        || *cr != t::span(create.node)
        || operation != "std.PaymentsV1.collect"
        || send_binding != "delivery"
        || *s != t::span(send.node)
        || ir_when.span != t::span(send.when?)
        || *d != t::span(delivery_set.node)
        || *l != t::span(ledger_set.node)
        || event != "invoice.InvoiceSettlement"
        || *e != t::span(emit.node)
    {
        return None;
    }
    let role_call = selected_derive(
        context,
        header.cond?,
        has_role,
        "has_role(actor,invoice.parent,billing)",
    )?;
    let own_call = selected_derive(context, header.cond?, owns, "owns(actor,invoice.parent)")?;
    let work_call = selected_derive(
        context,
        header.cond?,
        can_work,
        "can_work(actor,invoice.location)",
    )?;
    let emit_value = emit.args.iter().find(|a| a.key == "value")?.value?;
    let settlement_call = selected_derive(context, emit_value, settlement, "settlement(invoice)")?;
    let role_expr = program.effects.derives.get(&has_role)?.expr?;
    let own_expr = program.effects.derives.get(&owns)?.expr?;
    let work_expr = program.effects.derives.get(&can_work)?.expr?;
    let credits_expr = program.effects.derives.get(&credits)?.expr?;
    let received_expr = program.effects.derives.get(&received)?.expr?;
    let refunded_expr = program.effects.derives.get(&refunded)?.expr?;
    let settlement_expr = program.effects.derives.get(&settlement)?.expr?;
    let role_any = selected_builtin(context, role_expr, "any", ROLE)?;
    let own_any = selected_builtin(
        context,
        own_expr,
        "any",
        "any(org.Contact as contact,contact.account==person and contact.verified)",
    )?;
    let work_any = selected_builtin(context, work_expr, "any", WORK)?;
    let pending_any = selected_builtin(
        context,
        pending.cond?,
        "any",
        "any(invoice.Attempt as attempt,attempt.kind==collection and (attempt.status in [pending,unknown] or (attempt.status==failed and attempt.failure==permanent)))",
    )?;
    let credit_sum = selected_builtin(context, credits_expr, "sum", CREDITS)?;
    let received_attempt_sum = selected_builtin(
        context,
        received_expr,
        "sum",
        "sum(row.Attempt as attempt where attempt.kind==collection and attempt.status==succeeded select attempt.amount,row.currency)",
    )?;
    let received_external_sum = selected_builtin(
        context,
        received_expr,
        "sum",
        "sum(row.ExternalPayment as payment select payment.amount,row.currency)",
    )?;
    let refunded_attempt_sum = selected_builtin(
        context,
        refunded_expr,
        "sum",
        "sum(row.Attempt as attempt where attempt.kind==refund and attempt.status==succeeded select attempt.amount,row.currency)",
    )?;
    let refunded_external_sum = selected_builtin(
        context,
        refunded_expr,
        "sum",
        "sum(row.ExternalRefund as refund select refund.amount,row.currency)",
    )?;
    let collection_pending_any = selected_builtin(
        context,
        settlement_expr,
        "any",
        "any(invoice.Attempt as attempt,attempt.kind==collection and attempt.status in [pending,unknown])",
    )?;
    let refund_pending_any = selected_builtin(
        context,
        settlement_expr,
        "any",
        "any(invoice.Attempt as attempt,attempt.kind==refund and attempt.status in [pending,unknown])",
    )?;
    let query_sites = vec![
        query_site(
            context,
            credit_sum,
            "balanceCredits",
            "invoice.Credit",
            "row.Credit",
            &["invoice"],
            None,
            true,
        )?,
        query_site(
            context,
            received_attempt_sum,
            "balanceReceivedAttempts",
            "invoice.Attempt",
            "row.Attempt",
            &["invoice"],
            None,
            true,
        )?,
        query_site(
            context,
            received_external_sum,
            "balanceReceivedExternal",
            "invoice.ExternalPayment",
            "row.ExternalPayment",
            &["invoice"],
            None,
            true,
        )?,
        query_site(
            context,
            role_any,
            "authorityRole",
            "customer.CompanyRole",
            "org.CompanyRole",
            &["invoice", "parent"],
            Some((role_call, "customer.has_role")),
            false,
        )?,
        query_site(
            context,
            own_any,
            "authorityOwn",
            "customer.Contact",
            "org.Contact",
            &["invoice", "parent"],
            Some((own_call, "customer.owns")),
            false,
        )?,
        query_site(
            context,
            work_any,
            "authorityWork",
            "employee.Employee",
            "Employee",
            &[],
            Some((work_call, "employee.can_work")),
            false,
        )?,
        query_site(
            context,
            pending_any,
            "pendingAttempt",
            "invoice.Attempt",
            "invoice.Attempt",
            &["invoice"],
            None,
            false,
        )?,
        query_site(
            context,
            refunded_attempt_sum,
            "refundedAttempts",
            "invoice.Attempt",
            "row.Attempt",
            &["invoice"],
            None,
            true,
        )?,
        query_site(
            context,
            refunded_external_sum,
            "refundedExternal",
            "invoice.ExternalRefund",
            "row.ExternalRefund",
            &["invoice"],
            None,
            true,
        )?,
        query_site(
            context,
            collection_pending_any,
            "settlementCollectionPending",
            "invoice.Attempt",
            "invoice.Attempt",
            &["invoice"],
            Some((settlement_call, "invoice.settlement")),
            false,
        )?,
        query_site(
            context,
            refund_pending_any,
            "settlementRefundPending",
            "invoice.Attempt",
            "invoice.Attempt",
            &["invoice"],
            Some((settlement_call, "invoice.settlement")),
            false,
        )?,
    ];
    let prepared = send_guards.get(&t::span(send.node))?;
    if prepared.predicate.span != t::span(send.when?) || prepared.rule.is_empty() {
        return None;
    }
    let when = site(program, db, send.when?, send.node, "collect-send")?;
    let mut reset_site = site(program, db, reset.node, reset.node, "collect-reset")?;
    reset_site["model"] = json!("invoice.Invoice");
    let mut create_site = site(program, db, create.node, create.node, "collect-create")?;
    create_site["model"] = json!("invoice.Attempt");
    let mut delivery_site = site(
        program,
        db,
        delivery_set.node,
        delivery_set.node,
        "collect-delivery",
    )?;
    delivery_site["model"] = json!("invoice.Attempt");
    let mut ledger_site = site(
        program,
        db,
        ledger_set.node,
        ledger_set.node,
        "collect-ledger",
    )?;
    ledger_site["model"] = json!("invoice.Invoice");
    let mut emit_site = site(program, db, emit.node, emit.node, "collect-emit")?;
    emit_site["event"] = json!("invoice.InvoiceSettlement");
    let mut send_site = when.clone();
    send_site["operation"] = json!("std.PaymentsV1.collect");
    Some(
        json!({"version":1,"owner":"invoice.collect","source":t::source(program,db,scenario.node,"invoice")?,
        "parameters":[{"name":"invoice","type":"invoice.Invoice"}],
        "sites":{"header":[site(program,db,header.cond?,header.node,"collect-header")?,
            site(program,db,pending.cond?,pending.node,"collect-pending")?],
            "cancel":site(program,db,cancel.node,cancel.node,"collect-cancel")?,
            "invoiceReset":reset_site,"createAttempt":create_site,"send":send_site,
            "deliverySet":delivery_site,"ledgerSet":ledger_site,"settlementEmit":emit_site},
        "roleSite":site(program,db,scenario.by?,scenario.node,"collect-role")?,
        "membershipSite":site(program,db,header.cond?,header.node,"collect-membership")?,
        "querySites":query_sites,
        "sendRule":{"rule":prepared.rule,"source":when["source"],"node":when["node"],"statement":when["statement"]}}),
    )
}

pub(super) fn collect_collect_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_collect(context, item, send_guards)?;
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
            "invoice-collect-void/v1:{}:{}:{}",
            source.sha256, scenario.node.start, scenario.node.end
        )
        .as_bytes(),
    );
    let calls = [
        (
            "customer.has_role",
            "has_role(actor,invoice.parent,billing)",
        ),
        ("customer.owns", "owns(actor,invoice.parent)"),
        ("employee.can_work", "can_work(actor,invoice.location)"),
    ]
    .iter()
    .map(|(canonical, expected)| {
        let derive = t::symbol(context.original(), canonical)?;
        let call = selected_derive(context, scenario.guards.first()?.cond?, derive, expected)?;
        Some((
            NativeSite {
                calls: Vec::new(),
                span: t::span(call),
                default_selection: false,
            },
            canonical.to_string(),
        ))
    })
    .collect::<Option<HashMap<_, _>>>()?;
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
            invoice_collect_decision: Some(decision), rent_notice_decision: None, invoice_issue_decision: None, observe_venue_decision: None, success_renewal_decision: None, purchase_receive_all: None, event_notice_audit: None,
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
