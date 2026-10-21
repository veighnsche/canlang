//! The complete, source-bound movement-credit refund owner.
//!
//! Its booking and adjustment paths both send before creating a credit. The
//! baseline helper then reads all credits, so the owner lease must cover the
//! whole authored handler rather than just the adjustment FIRST.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{Effect, EffectTarget, EffectVerb};
use crate::analysis::resolve::{ModelOwner, SymbolId};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::types::{CheckedQueryClauseKind, SelectedCallTarget};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, sha256_hex};

use super::ir::{IrGuard, IrItem, IrItemKind, IrStmt};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, NativeSite, ReceiptDisclosurePlan, ReceiptReturn,
    transport_source,
};
use super::term_decisions as t;

const HEADER: &str = "can_work(actor,movement.parent.parent.location) and movement.state==adopted and movement.credit_due!=null and amount.currency==movement.credit_due.currency and amount.minor>0 and trim(reason)!=\"\"";
const REMAINING: &str = "amount<=movement.credit_due-sum(movement.MovementCredit as credit where credit.state!=failed select credit.amount,movement.credit_due.currency)";
const BRANCH: &str = "charge_source==booking.source";
const ADJUSTMENT: &str =
    "first(booking.Adjustment as row where row.source==charge_source and row.state==paid)";
const BOOKING_REQUIRE: &str = "booking.collected!=null and booking.refunded!=null and amount<=booking.collected-booking.refunded";
const ADJUSTMENT_REQUIRE: &str = "adjustment!=null and adjustment.collected!=null and adjustment.refunded!=null and amount<=adjustment.collected-adjustment.refunded";
const BASELINE: &str = "max([current]+(MovementCredit as credit where credit.charge_source==charge_source and credit.state!=failed select credit.baseline+credit.amount)) ?? current";
const CAN_WORK: &str = "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))";
const SEND: &str = "send Billing.refund {source=charge_source,amount,reason} as refund";
const CREATE: &str = "create MovementCredit {parent=movement,charge_source,amount,baseline=credit_baseline(charge_source,refunded),delivery=refund.id,reason} as credit";
const CREDIT_ARGS: &[(&str, Option<&str>)] = &[
    ("parent", Some("movement")),
    ("charge_source", None),
    ("amount", None),
    ("baseline", Some("credit_baseline(charge_source,refunded)")),
    ("delivery", Some("refund.id")),
    ("reason", None),
];

fn source_site(
    program: &CheckedProgram,
    db: &SourceDb,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    let mut site = t::site(program, db, "rent_reservations", node, statement, kind)?;
    site["id"] = json!(sha256_hex(
        format!(
            "rent-movement-refund/v1:{kind}:{}:{}:{}:{}:{}",
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
    let program = context.original();
    let call = t::selected_derive(program, within, target)?;
    let original = program.types.selected_calls.get(&call)?;
    let fresh = context.program().types.selected_calls.get(&call)?;
    (t::text(context.db(), call) == Some(expected)
        && format!("{original:?}") == format!("{fresh:?}"))
    .then_some(call)
}

fn selected_builtin(
    context: &FreshSourceContext<'_>,
    within: NodeKey,
    id: &str,
    expected: &str,
) -> Option<NodeKey> {
    let program = context.original();
    let mut hits = program.types.selected_calls.iter().filter(|(node, selected)| {
        node.file == within.file
            && within.start <= node.start
            && node.end <= within.end
            && matches!(&selected.target, SelectedCallTarget::Builtin{id: actual,..} if actual==id)
    });
    let (node, original) = hits.next()?;
    if hits.next().is_some()
        || t::text(context.db(), *node) != Some(expected)
        || format!("{original:?}")
            != format!("{:?}", context.program().types.selected_calls.get(node)?)
    {
        return None;
    }
    Some(*node)
}

fn query_site(
    context: &FreshSourceContext<'_>,
    within: NodeKey,
    call: NodeKey,
    stage: &str,
    model: &str,
    domain: &str,
    owner_path: &[&str],
    query_text: &str,
    chain: Vec<Value>,
) -> Option<Value> {
    let program = context.original();
    let db = context.db();
    let mut matches = program
        .types
        .checked_queries
        .iter()
        .filter(|(node, query)| {
            node.file == within.file
                && within.start <= node.start
                && node.end <= within.end
                && matches!(&query.domain_type, ResolvedType::Array{element,..}
                if t::record_is(program,element,model))
        });
    let (query_node, query) = matches.next()?;
    if matches.next().is_some()
        || t::text(db, *query_node) != Some(query_text)
        || t::text(db, query.domain) != Some(domain)
        || format!("{query:?}")
            != format!(
                "{:?}",
                context.program().types.checked_queries.get(query_node)?
            )
    {
        return None;
    }
    let (alias, predicate) = if stage == "header" {
        let fact = program.types.checked_collection_calls.get(&call)?;
        let fresh = context
            .program()
            .types
            .checked_collection_calls
            .get(&call)?;
        let [alias] = query.clauses.as_slice() else {
            return None;
        };
        if fact.query != *query_node
            || fact.model != t::symbol(program, model)?
            || fact.builtin != "any"
            || fact.alias != alias.node
            || !matches!(alias.kind, CheckedQueryClauseKind::As { .. })
            || format!("{fact:?}") != format!("{fresh:?}")
        {
            return None;
        }
        (alias.node, fact.predicate.as_ref()?.node)
    } else {
        match query.clauses.as_slice() {
            [alias, where_clause]
                if matches!(alias.kind, CheckedQueryClauseKind::As { .. })
                    && matches!(where_clause.kind, CheckedQueryClauseKind::Where) =>
            {
                let [predicate] = where_clause.expressions.as_slice() else {
                    return None;
                };
                (alias.node, *predicate)
            }
            [alias, where_clause, select]
                if matches!(alias.kind, CheckedQueryClauseKind::As { .. })
                    && matches!(where_clause.kind, CheckedQueryClauseKind::Where)
                    && matches!(select.kind, CheckedQueryClauseKind::Select) =>
            {
                let [predicate] = where_clause.expressions.as_slice() else {
                    return None;
                };
                (alias.node, *predicate)
            }
            _ => return None,
        }
    };
    if program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool)) {
        return None;
    }
    let source = t::source(
        program,
        db,
        call,
        if stage == "header" {
            "employee"
        } else {
            "rent_reservations"
        },
    )?;
    let id = sha256_hex(
        format!(
            "rent-movement-refund-query/v1:{stage}:{model}:{}:{}:{}",
            source["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":stage,"model":model,"source":source,
        "queryNode":t::interval(*query_node),"callSite":t::interval(call),
        "aliasSite":t::interval(alias),"predicateSite":t::interval(predicate),
        "domainKind":if owner_path.is_empty() {"team"} else {"child"},
        "ownerPath":owner_path,"order":[],"deriveChain":chain}))
}

fn effect_is(effect: &Effect, verb: EffectVerb, text: &str, db: &SourceDb) -> bool {
    effect.verb == verb
        && t::no_children(effect)
        && effect.value.and_then(|n| t::text(db, n)) == Some(text)
}

fn send_is(effect: &Effect, db: &SourceDb, operation: SymbolId) -> bool {
    effect.verb == EffectVerb::Send
        && t::no_children(effect)
        && t::text(db, effect.node) == Some(SEND)
        && matches!(effect.target,Some(EffectTarget::Operation(id)) if id==operation)
        && effect.target_node.and_then(|n| t::text(db, n)) == Some("Billing.refund")
        && effect.binding.as_deref() == Some("refund")
        && effect.when.is_none()
        && t::args_match(
            db,
            effect,
            &[
                ("source", Some("charge_source")),
                ("amount", None),
                ("reason", None),
            ],
        )
}

fn create_is(effect: &Effect, db: &SourceDb, credit: SymbolId) -> bool {
    effect.verb == EffectVerb::Create
        && t::no_children(effect)
        && t::text(db, effect.node) == Some(CREATE)
        && effect.when.is_none()
        && matches!(effect.target,Some(EffectTarget::Model(id)) if id==credit)
        && effect.binding.as_deref() == Some("credit")
        && t::args_match(db, effect, CREDIT_ARGS)
}

pub(super) fn prepare_refund(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<Value> {
    if owner.canonical != "rent_reservations.refund_movement_credit" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let location = t::symbol(program, "rent_catalog.Location")?;
    let employee = t::symbol(program, "employee.Employee")?;
    let resource = t::symbol(program, "rent_reservations.Resource")?;
    let booking = t::symbol(program, "rent_reservations.Booking")?;
    let movement = t::symbol(program, "rent_reservations.Movement")?;
    let adjustment = t::symbol(program, "rent_reservations.Adjustment")?;
    let credit = t::symbol(program, "rent_reservations.MovementCredit")?;
    let refund = t::symbol(program, "invoice.BillingV1.refund")?;
    let work = t::symbol(program, "employee.can_work")?;
    let baseline = t::symbol(program, "rent_reservations.credit_baseline")?;
    t::checked_closure(
        context,
        scenario.node,
        &[work, baseline],
        &[
            location, employee, resource, booking, movement, adjustment, credit,
        ],
    )?;
    for id in [
        work, baseline, location, employee, resource, booking, movement, adjustment, credit,
    ] {
        let original = context.ir().items.get(id.0 as usize)?;
        let fresh = context.fresh().items.get(id.0 as usize)?;
        if original.canonical != fresh.canonical
            || format!("{:?}", original.kind) != format!("{:?}", fresh.kind)
        {
            return None;
        }
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.and_then(|n| t::text(db, n)) != Some("billing")
        || scenario.params.len() != 4
        || scenario.guards.len() != 2
        || scenario.effects.len() != 2
        || program.effects.models.get(&resource)?.owner != ModelOwner::Team
        || program.effects.models.get(&employee)?.owner != ModelOwner::Team
        || program.effects.models.get(&location)?.owner != ModelOwner::Team
        || program.effects.models.get(&booking)?.owner != ModelOwner::ChildOf(resource)
        || program.effects.models.get(&movement)?.owner != ModelOwner::ChildOf(booking)
        || program.effects.models.get(&adjustment)?.owner != ModelOwner::ChildOf(booking)
        || program.effects.models.get(&credit)?.owner != ModelOwner::ChildOf(movement)
    {
        return None;
    }
    for (param, (name, ty)) in scenario.params.iter().zip([
        ("movement", "rent_reservations.Movement"),
        ("charge_source", "text"),
        ("amount", "money"),
        ("reason", "text"),
    ]) {
        let actual = program.types.symbol_types.get(&param.param)?;
        if program.symbols.get(param.param.0 as usize)?.name != name
            || param.default.is_some()
            || match ty {
                "text" => *actual != ResolvedType::Scalar(Scalar::Text),
                "money" => *actual != ResolvedType::Scalar(Scalar::Money),
                _ => !t::record_is(program, actual, ty),
            }
        {
            return None;
        }
    }
    let [header, remaining] = scenario.guards.as_slice() else {
        return None;
    };
    let [booking_let, branch] = scenario.effects.as_slice() else {
        return None;
    };
    let [
        booking_require,
        booking_refunded,
        booking_send,
        booking_create,
    ] = branch.then_effects.as_slice()
    else {
        return None;
    };
    let [
        adjustment_first,
        adjustment_require,
        adjustment_refunded,
        adjustment_send,
        adjustment_create,
    ] = branch.else_effects.as_slice()
    else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || !t::no_children(header)
        || header.cond.and_then(|n| t::text(db, n)) != Some(HEADER)
        || header.message.is_some()
        || remaining.verb != EffectVerb::Require
        || !t::no_children(remaining)
        || remaining.cond.and_then(|n| t::text(db, n)) != Some(REMAINING)
        || remaining.message.is_some()
        || booking_let.binding.as_deref() != Some("booking")
        || !effect_is(booking_let, EffectVerb::Let, "movement.parent", db)
        || branch.verb != EffectVerb::If
        || branch.cond.and_then(|n| t::text(db, n)) != Some(BRANCH)
        || !branch.match_arms.is_empty()
        || booking_require.verb != EffectVerb::Require
        || !t::no_children(booking_require)
        || booking_require.cond.and_then(|n| t::text(db, n)) != Some(BOOKING_REQUIRE)
        || booking_require.message.is_some()
        || booking_refunded.binding.as_deref() != Some("refunded")
        || !effect_is(booking_refunded, EffectVerb::Let, "booking.refunded", db)
        || !send_is(booking_send, db, refund)
        || !create_is(booking_create, db, credit)
        || adjustment_first.binding.as_deref() != Some("adjustment")
        || !effect_is(adjustment_first, EffectVerb::Let, ADJUSTMENT, db)
        || adjustment_require.verb != EffectVerb::Require
        || !t::no_children(adjustment_require)
        || adjustment_require.cond.and_then(|n| t::text(db, n)) != Some(ADJUSTMENT_REQUIRE)
        || adjustment_require.message.is_some()
        || adjustment_refunded.binding.as_deref() != Some("refunded")
        || !effect_is(
            adjustment_refunded,
            EffectVerb::Let,
            "adjustment.refunded",
            db,
        )
        || !send_is(adjustment_send, db, refund)
        || !create_is(adjustment_create, db, credit)
    {
        return None;
    }
    let work_expr = program.effects.derives.get(&work)?.expr?;
    let baseline_expr = program.effects.derives.get(&baseline)?.expr?;
    if t::text(db, work_expr) != Some(CAN_WORK)
        || t::text(db, baseline_expr) != Some(BASELINE)
        || program.types.symbol_results.get(&work)
            != Some(&Some(ResolvedType::Scalar(Scalar::Bool)))
        || program.types.symbol_results.get(&baseline)
            != Some(&Some(ResolvedType::Scalar(Scalar::Money)))
        || program.types.node_types.get(&header.cond?) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&remaining.cond?)
            != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&branch.cond?) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let work_call = selected_derive(
        context,
        header.cond?,
        work,
        "can_work(actor,movement.parent.parent.location)",
    )?;
    let booking_baseline_arg = booking_create
        .args
        .iter()
        .find(|arg| arg.key == "baseline")?
        .value?;
    let adjustment_baseline_arg = adjustment_create
        .args
        .iter()
        .find(|arg| arg.key == "baseline")?
        .value?;
    let booking_baseline = selected_derive(
        context,
        booking_baseline_arg,
        baseline,
        "credit_baseline(charge_source,refunded)",
    )?;
    let adjustment_baseline = selected_derive(
        context,
        adjustment_baseline_arg,
        baseline,
        "credit_baseline(charge_source,refunded)",
    )?;
    let header_call = selected_builtin(context, work_expr, "any", CAN_WORK)?;
    let remaining_call = selected_builtin(
        context,
        remaining.cond?,
        "sum",
        "sum(movement.MovementCredit as credit where credit.state!=failed select credit.amount,movement.credit_due.currency)",
    )?;
    let adjustment_call = selected_builtin(context, adjustment_first.value?, "first", ADJUSTMENT)?;
    let baseline_call = selected_builtin(
        context,
        baseline_expr,
        "max",
        "max([current]+(MovementCredit as credit where credit.charge_source==charge_source and credit.state!=failed select credit.baseline+credit.amount))",
    )?;
    let header_query = query_site(
        context,
        work_expr,
        header_call,
        "header",
        "employee.Employee",
        "Employee",
        &[],
        "Employee as e",
        vec![
            json!({"source":t::source(program,db,work_call,"rent_reservations")?,"callSite":t::interval(work_call),"derive":"employee.can_work"}),
        ],
    )?;
    let remaining_query = query_site(
        context,
        remaining.cond?,
        remaining_call,
        "remaining",
        "rent_reservations.MovementCredit",
        "movement.MovementCredit",
        &["movement"],
        "movement.MovementCredit as credit where credit.state!=failed select credit.amount",
        Vec::new(),
    )?;
    let adjustment_query = query_site(
        context,
        adjustment_first.value?,
        adjustment_call,
        "adjustment",
        "rent_reservations.Adjustment",
        "booking.Adjustment",
        &["movement", "parent"],
        "booking.Adjustment as row where row.source==charge_source and row.state==paid",
        Vec::new(),
    )?;
    let baseline_query = query_site(
        context,
        baseline_expr,
        baseline_call,
        "baseline",
        "rent_reservations.MovementCredit",
        "MovementCredit",
        &[],
        "MovementCredit as credit where credit.charge_source==charge_source and credit.state!=failed select credit.baseline+credit.amount",
        vec![
            json!({"source":t::source(program,db,booking_baseline,"rent_reservations")?,"callSite":t::interval(booking_baseline),"derive":"rent_reservations.credit_baseline"}),
        ],
    )?;
    let IrItemKind::Scenario {
        guards,
        effects,
        by,
        read: false,
        result: None,
        trusted: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if !matches!(by.as_slice(),[IrGuard::Role(role)] if role=="rent_reservations.billing") {
        return None;
    }
    let [
        IrStmt::Require {
            span: header_span, ..
        },
        IrStmt::Require {
            span: remaining_span,
            ..
        },
    ] = guards.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Let {
            name: booking_name,
            span: booking_span,
            ..
        },
        IrStmt::If {
            cond: branch_cond,
            then_branch,
            else_branch,
            span: branch_span,
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    if *header_span != t::span(header.node)
        || *remaining_span != t::span(remaining.node)
        || booking_name != "booking"
        || *booking_span != t::span(booking_let.node)
        || branch_cond.span != t::span(branch.cond?)
        || *branch_span != t::span(branch.node)
        || !matches!(then_branch.as_slice(),
            [IrStmt::Require{span:r,..},IrStmt::Let{name,span:l,..},
             IrStmt::Send{operation,binding:Some(send_binding),when:None,span:s,..},
             IrStmt::Create{model,binding:Some(create_binding),span:c,..}]
             if *r==t::span(booking_require.node) && name=="refunded" && *l==t::span(booking_refunded.node)
                 && operation=="invoice.BillingV1.refund" && send_binding=="refund" && *s==t::span(booking_send.node)
                 && model=="rent_reservations.MovementCredit" && create_binding=="credit" && *c==t::span(booking_create.node))
        || !matches!(else_branch.as_slice(),
            [IrStmt::Let{name:adjustment_name,span:a,..},IrStmt::Require{span:r,..},IrStmt::Let{name:refunded_name,span:l,..},
             IrStmt::Send{operation,binding:Some(send_binding),when:None,span:s,..},
             IrStmt::Create{model,binding:Some(create_binding),span:c,..}]
             if adjustment_name=="adjustment" && *a==t::span(adjustment_first.node)
                 && *r==t::span(adjustment_require.node) && refunded_name=="refunded" && *l==t::span(adjustment_refunded.node)
                 && operation=="invoice.BillingV1.refund" && send_binding=="refund" && *s==t::span(adjustment_send.node)
                 && model=="rent_reservations.MovementCredit" && create_binding=="credit" && *c==t::span(adjustment_create.node))
    {
        return None;
    }
    let origin = t::source(program, db, scenario.node, "rent_reservations")?;
    let mut booking_send_site = source_site(
        program,
        db,
        booking_send.node,
        booking_send.node,
        "booking-send",
    )?;
    booking_send_site["operation"] = json!("invoice.BillingV1.refund");
    let mut adjustment_send_site = source_site(
        program,
        db,
        adjustment_send.node,
        adjustment_send.node,
        "adjustment-send",
    )?;
    adjustment_send_site["operation"] = json!("invoice.BillingV1.refund");
    let mut booking_create_site = source_site(
        program,
        db,
        booking_create.node,
        booking_create.node,
        "booking-create",
    )?;
    booking_create_site["model"] = json!("rent_reservations.MovementCredit");
    let mut adjustment_create_site = source_site(
        program,
        db,
        adjustment_create.node,
        adjustment_create.node,
        "adjustment-create",
    )?;
    adjustment_create_site["model"] = json!("rent_reservations.MovementCredit");
    Some(json!({"version":1,"owner":owner.canonical,"source":origin,
        "parameters":[{"name":"movement","type":"rent_reservations.Movement"},
            {"name":"charge_source","type":"text"},{"name":"amount","type":"money"},{"name":"reason","type":"text"}],
        "sites":{"header":source_site(program,db,header.cond?,header.node,"header")?,
            "remaining":source_site(program,db,remaining.cond?,remaining.node,"remaining")?,
            "branch":source_site(program,db,branch.cond?,branch.node,"branch")?,
            "adjustmentFirst":source_site(program,db,adjustment_first.value?,adjustment_first.node,"adjustment-first")?,
            "bookingSend":booking_send_site,"bookingCreate":booking_create_site,
            "adjustmentSend":adjustment_send_site,"adjustmentCreate":adjustment_create_site,
            "bookingBaseline":source_site(program,db,booking_baseline,booking_create.node,"booking-baseline")?,
            "adjustmentBaseline":source_site(program,db,adjustment_baseline,adjustment_create.node,"adjustment-baseline")?},
        "roleSite":source_site(program,db,scenario.by?,scenario.node,"role")?,
        "membershipSite":source_site(program,db,header.cond?,header.node,"membership")?,
        "querySites":[header_query,remaining_query,adjustment_query,baseline_query]}))
}

pub(super) fn collect_refund_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_refund(context, item)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let work = t::symbol(context.original(), "employee.can_work")?;
    let work_call = selected_derive(
        context,
        scenario.guards.first()?.cond?,
        work,
        "can_work(actor,movement.parent.parent.location)",
    )?;
    let file = context.db().get(scenario.node.file)?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "rent_reservations".into(),
        },
        entry_module,
    )?;
    let id = sha256_hex(
        format!(
            "rent-movement-refund-void/v1:{}:{}:{}",
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
            invoice_overdue_decision: None,
            rent_movement_refund_decision: Some(decision),
            invoice_collect_decision: None, rent_notice_decision: None,queries: Vec::new(),
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
        calls: HashMap::from([(
            NativeSite {
                calls: Vec::new(),
                span: t::span(work_call),
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
