//! Complete source-bound owner receipt for retrying one immutable term charge.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{EffectTarget, EffectVerb};
use crate::analysis::resolve::ModelOwner;
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::{NodeKey, ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};

use super::ir::{IrItem, IrItemKind, IrStmt};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, NativeSite, ReceiptDisclosurePlan, ReceiptReturn,
    transport_source,
};
use super::send_guards::PreparedSendGuard;
use super::term_decisions as t;

const HEADER: [&str; 2] = [
    "(member_manager and any(term.locations as location,can_work(actor,location))) or term.parent.account==actor or has_role(actor,term.parent.parent,billing)",
    "term.collection in [failed,unknown] and term.until>now and term.cancellation==none",
];
const FIRST: &str = "first(term.locations as site order=site.id)";
const WHEN: &str = "term.cancellation==none and term.until>now and not term.parent.revoked and (not term.automatic or (term.parent.recurrence and term.parent.consent==term.consent and (term.parent.cancellation_at==null or term.from<term.parent.cancellation_at)))";
const CHARGE: &str = "{source=term.source,customer=term.parent.parent.id,location=location.id,description=term.title,amount=term.price,due=local_date(term.from,term.parent.timezone),consent=term.consent,items=[{title=term.title,quantity=1,price=term.price,tax=money(0,term.price.currency),discount=money(0,term.price.currency),unit=\"term\",from=term.from,until=term.until,location=location.id,reference=term.source}]}";

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
fn same_call(context: &FreshSourceContext<'_>, key: NodeKey) -> Option<()> {
    (format!("{:?}", context.original().types.selected_calls.get(&key)?)
        == format!("{:?}", context.program().types.selected_calls.get(&key)?))
    .then_some(())
}
fn same_collection(context: &FreshSourceContext<'_>, key: NodeKey) -> Option<()> {
    (format!(
        "{:?}",
        context
            .original()
            .types
            .checked_collection_calls
            .get(&key)?
    ) == format!(
        "{:?}",
        context.program().types.checked_collection_calls.get(&key)?
    ))
    .then_some(())
}

pub(super) fn prepare_retry(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    if owner.canonical != "member_terms.retry_collection" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let term = t::symbol(program, "member_terms.Term")?;
    let membership = t::symbol(program, "member_terms.Membership")?;
    let customer = t::symbol(program, "customer.Customer")?;
    let location = t::symbol(program, "rent_catalog.Location")?;
    let employee = t::symbol(program, "employee.Employee")?;
    let company_role = t::symbol(program, "customer.CompanyRole")?;
    let can_work = t::symbol(program, "employee.can_work")?;
    let has_role = t::symbol(program, "customer.has_role")?;
    let billing = t::symbol(program, "invoice.BillingV1.charge")?;
    t::checked_closure(
        context,
        scenario.node,
        &[can_work, has_role],
        &[term, membership, customer, location, employee, company_role],
    )?;
    for id in [
        term,
        membership,
        customer,
        location,
        employee,
        company_role,
        can_work,
        has_role,
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
        || scenario.params.len() != 1
        || scenario.guards.len() != 2
        || scenario.effects.len() != 4
        || scenario.by.and_then(|node| t::text(db, node)) != Some("member_manager or authenticated")
        || program.effects.models.get(&term)?.owner != ModelOwner::ChildOf(membership)
        || program.effects.models.get(&membership)?.owner != ModelOwner::ChildOf(customer)
        || program.effects.models.get(&company_role)?.owner != ModelOwner::ChildOf(customer)
        || [customer, location, employee].iter().any(|id| {
            program
                .effects
                .models
                .get(id)
                .is_none_or(|m| m.owner != ModelOwner::Team)
        })
    {
        return None;
    }
    let parameter = &scenario.params[0];
    if program.symbols.get(parameter.param.0 as usize)?.name != "term"
        || parameter.default.is_some()
        || !program
            .types
            .symbol_types
            .get(&parameter.param)
            .is_some_and(|ty| t::record_is(program, ty, "member_terms.Term"))
    {
        return None;
    }
    let [guard0, guard1] = scenario.guards.as_slice() else {
        return None;
    };
    for (guard, expected) in [guard0, guard1].iter().zip(HEADER) {
        if guard.verb != EffectVerb::Require
            || !t::no_children(guard)
            || guard.cond.and_then(|node| t::text(db, node)) != Some(expected)
            || program.types.node_types.get(&guard.cond?)
                != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
    }
    let [location_let, location_require, send, set] = scenario.effects.as_slice() else {
        return None;
    };
    if location_let.verb != EffectVerb::Let
        || !t::no_children(location_let)
        || location_let.binding.as_deref() != Some("location")
        || location_let.value.and_then(|node| t::text(db, node)) != Some(FIRST)
        || location_require.verb != EffectVerb::Require
        || !t::no_children(location_require)
        || location_require.cond.and_then(|node| t::text(db, node)) != Some("location!=null")
        || send.verb != EffectVerb::Send
        || !t::no_children(send)
        || send.target_node.and_then(|node| t::text(db, node)) != Some("Billing.charge")
        || send.binding.as_deref() != Some("delivery")
        || send.when.and_then(|node| t::text(db, node)) != Some(WHEN)
        || !t::args_match(db, send, &[("value", Some(CHARGE))])
        || set.verb != EffectVerb::Set
        || !t::no_children(set)
        || !matches!(set.target,Some(EffectTarget::Record{model:Some(id)}) if id==term)
        || !t::text(db, set.node).is_some_and(|s| s.starts_with("set term "))
        || !t::args_match(
            db,
            set,
            &[
                ("charge_delivery", Some("delivery.id")),
                ("collection", Some("pending")),
            ],
        )
        || program.types.node_types.get(&location_require.cond?)
            != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&send.when?) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let (_, work_expr) = t::derive(
        program,
        db,
        "employee.can_work",
        t::CAN_WORK,
        &[("person", "user"), ("location", "rent_catalog.Location")],
        "bool",
    )?;
    let (_, role_expr) = t::derive(
        program,
        db,
        "customer.has_role",
        t::HAS_ROLE,
        &[
            ("person", "user"),
            ("org", "customer.Customer"),
            ("role", "customer.CompanyRole.role"),
        ],
        "bool",
    )?;
    let work_call = t::selected_derive(program, guard0.cond?, can_work)?;
    let role_call = t::selected_derive(program, guard0.cond?, has_role)?;
    if t::text(db, work_call) != Some("can_work(actor,location)")
        || t::text(db, role_call) != Some("has_role(actor,term.parent.parent,billing)")
    {
        return None;
    }
    let work_any = t::selected_collection(program, work_expr, "any", "employee.Employee")?;
    let role_any = t::selected_collection(program, role_expr, "any", "customer.CompanyRole")?;
    let first = t::selected_collection(
        program,
        location_let.value?,
        "first",
        "rent_catalog.Location",
    )?;
    if t::text(db, work_any) != Some(t::CAN_WORK)
        || t::text(db, role_any) != Some(t::HAS_ROLE)
        || t::text(db, first) != Some(FIRST)
    {
        return None;
    }
    for call in [work_call, role_call, first] {
        same_call(context, call)?;
    }
    for call in [work_any, role_any] {
        same_collection(context, call)?;
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
        IrStmt::Let {
            name,
            value,
            span: l,
        },
        IrStmt::Require { span: r, .. },
        IrStmt::Send {
            operation,
            binding: Some(delivery),
            when: Some(ir_when),
            span: s,
            ..
        },
        IrStmt::Set {
            record,
            changes,
            span: set_span,
            ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    if *g0 != t::span(guard0.node)
        || *g1 != t::span(guard1.node)
        || name != "location"
        || *l != t::span(location_let.node)
        || value.span != t::span(location_let.value?)
        || *r != t::span(location_require.node)
        || operation != "invoice.BillingV1.charge"
        || !matches!(send.target,Some(EffectTarget::Operation(actual)) if actual==billing)
        || delivery != "delivery"
        || *s != t::span(send.node)
        || ir_when.span != t::span(send.when?)
        || *set_span != t::span(set.node)
        || !matches!(&record.expr,super::ir::IrExpr::Name(name) if name=="term")
        || !matches!(&changes.expr,super::ir::IrExpr::Object(entries) if entries.len()==2)
    {
        return None;
    }
    let guard = send_guards.get(&t::span(send.node))?;
    if guard.predicate.span != t::span(send.when?) || guard.rule.is_empty() {
        return None;
    }
    let origin = t::source(program, db, scenario.node, "member_terms")?;
    let when = t::site(
        program,
        db,
        "member_terms",
        send.when?,
        send.node,
        "retry-send",
    )?;
    let mut set_site = t::site(program, db, "member_terms", set.node, set.node, "retry-set")?;
    set_site["model"] = json!("member_terms.Term");
    let mut work_site = t::query_site(
        program,
        db,
        work_any,
        "employee.Employee",
        "header",
        "tenant-root",
        &[],
        &[],
        vec![t::frame(program, db, work_call, "employee.can_work")?],
    )?;
    let mut role_site = t::query_site(
        program,
        db,
        role_any,
        "customer.CompanyRole",
        "header",
        "contained-child",
        &["parent"],
        &[],
        vec![t::frame(program, db, role_call, "customer.has_role")?],
    )?;
    work_site["queryNode"] =
        t::interval(program.types.checked_collection_calls.get(&work_any)?.query);
    role_site["queryNode"] =
        t::interval(program.types.checked_collection_calls.get(&role_any)?.query);
    let query_sites = vec![work_site, role_site];
    Some(
        json!({"version":1,"owner":"member_terms.retry_collection","source":origin,
        "parameters":[{"name":"term","model":"member_terms.Term","nullable":false}],
        "sites":{
            "header":[t::site(program,db,"member_terms",guard0.cond?,guard0.node,"retry-header")?,
                t::site(program,db,"member_terms",guard1.cond?,guard1.node,"retry-header")?],
            "locationFirst":t::site(program,db,"member_terms",location_let.value?,location_let.node,"retry-location-first")?,
            "locationRequire":t::site(program,db,"member_terms",location_require.cond?,location_require.node,"retry-location-require")?,
            "send":when.clone(),"set":set_site},
        "roleSite":t::site(program,db,"member_terms",scenario.by?,scenario.node,"retry-role")?,
        "membershipSite":t::site(program,db,"member_terms",guard0.cond?,guard0.node,"retry-membership")?,
        "querySites":query_sites,
        "sendRule":{"rule":guard.rule,"source":when["source"],
            "node":when["node"],"statement":when["statement"]}}),
    )
}

pub(super) fn collect_retry_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_retry(context, item, send_guards)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let header = scenario.guards.first()?.cond?;
    let work = t::symbol(context.original(), "employee.can_work")?;
    let role = t::symbol(context.original(), "customer.has_role")?;
    let calls = [(work, "employee.can_work"), (role, "customer.has_role")]
        .into_iter()
        .map(|(id, name)| {
            let call = t::selected_derive(context.original(), header, id)?;
            Some((
                NativeSite {
                    calls: Vec::new(),
                    span: t::span(call),
                    default_selection: false,
                },
                name.to_string(),
            ))
        })
        .collect::<Option<HashMap<_, _>>>()?;
    let file = context.db().get(scenario.node.file)?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "member_terms".into(),
        },
        entry_module,
    )?;
    let id = sha256_hex(
        format!(
            "member-retry-void/v1:{}:{}:{}",
            source.sha256, scenario.node.start, scenario.node.end
        )
        .as_bytes(),
    );
    Some(NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan { retained_guarded_handler: None, source_loops: None, source_emissions: None,
            version: 1,
            source: source.clone(),
            event_decision: None,
            term_decision: None,
            leave_request_decision: None,
            leave_decide_decision: None,
            refer_reject_decision: None,
            member_retry_decision: Some(decision),
            rent_movement_refund_decision: None,
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
