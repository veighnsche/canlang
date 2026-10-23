//! Exact declared-event correspondence for the three booking notices.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{Effect, EffectTarget, EffectVerb, HandlerSource};
use crate::analysis::resolve::{ModelOwner, SymbolKind};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::{ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};

use super::ir::{IrEventSource, IrItem, IrItemKind, IrStmt};
use super::source_context::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};
use super::send_guards::PreparedSendGuard;
use super::term_decisions as t;

const CORRESPONDENCE: &str = r#"scenario correspondence on=ReservationChanged
   require event.booking.version==event.revision
   do
    cancel event.booking.source
    if event.booking.status==confirmed
     let subject=format("Workspace confirmed"@{nl="Werkplek bevestigd"},locale=null)
     let body=format("{location}; {resource}; {from,date} {from,time} – {until,date} {until,time}; {arrival}; {terms}; /workspace/my-bookings"@{nl="{location}; {resource}; {from,date} {from,time} – {until,date} {until,time}; {arrival}; {terms}; /workspace/my-bookings"}(location=event.booking.parent.location.name,resource=event.booking.parent.name,from=event.booking.from,until=event.booking.until,arrival=event.booking.parent.location.arrival,terms=event.booking.terms),locale=null)
     send Mail.send {to=event.booking.email,subject,body} when=event.booking.status==confirmed and event.booking.version==event.revision as delivery
     create Notice {parent=event.booking,kind=confirmation,revision=event.revision,subject,body,delivery} as notice
     if event.booking.from>now+1h
      schedule event.booking.source at=event.booking.from-1h event=Reminder {booking=event.booking,revision=event.revision}
    if event.booking.status in [cancelled,expired,Booking.status.no_show]
     let subject=format("Workspace booking changed"@{nl="Werkplekreservering gewijzigd"},locale=null)
     let body=event.booking.terms
     send Mail.send {to=event.booking.email,subject,body} when=event.booking.version==event.revision as delivery
     create Notice {parent=event.booking,kind=cancellation,revision=event.revision,subject,body,delivery} as notice"#;
const REMIND: &str = r#"scenario remind on=Reminder
   require event.booking.status==confirmed and event.booking.version==event.revision
   do
    let subject=format("Workspace arrival reminder"@{nl="Herinnering werkplekaankomst"},locale=null)
    let body=event.booking.parent.location.arrival
    send Mail.send {to=event.booking.email,subject,body} when=event.booking.status==confirmed and event.booking.version==event.revision as delivery
    create Notice {parent=event.booking,kind=reminder,revision=event.revision,subject,body,delivery} as notice"#;

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
    let source = t::source(context.original(), context.db(), node, "rent_reservations")?;
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        return None;
    }
    let id = sha256_hex(
        format!(
            "rent-notice/v1:{kind}:{}:{}:{}:{}:{}",
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

fn no_children(effect: &Effect) -> bool {
    t::no_children(effect)
}

fn ordinary_leaf(source: &Effect, ir: &IrStmt, verb: EffectVerb) -> Option<()> {
    let span = t::span(source.node);
    let ir_span = match ir {
        IrStmt::Let { span, .. }
        | IrStmt::Create { span, .. }
        | IrStmt::Send { span, .. }
        | IrStmt::Cancel { span, .. } => *span,
        _ => return None,
    };
    if source.verb != verb || !no_children(source) || ir_span != span {
        return None;
    }
    Some(())
}

fn let_pair(source: &Effect, ir: &IrStmt, name: &str) -> Option<()> {
    ordinary_leaf(source, ir, EffectVerb::Let)?;
    match ir {
        IrStmt::Let {
            name: ir_name,
            value,
            ..
        } if ir_name == name
            && source.binding.as_deref() == Some(name)
            && value.span == t::span(source.value?) =>
        {
            Some(())
        }
        _ => None,
    }
}

fn send_pair(
    context: &FreshSourceContext<'_>,
    source: &Effect,
    ir: &IrStmt,
    guards: &HashMap<Span, PreparedSendGuard>,
    kind: &str,
    event_name: &str,
) -> Option<(Value, Value)> {
    ordinary_leaf(source, ir, EffectVerb::Send)?;
    let IrStmt::Send {
        operation,
        when: Some(ir_when),
        binding: Some(binding),
        ..
    } = ir
    else {
        return None;
    };
    if operation != "std.EmailV1.send"
        || binding != "delivery"
        || source
            .target_node
            .and_then(|node| t::text(context.db(), node))
            != Some("Mail.send")
        || source.binding.as_deref() != Some("delivery")
        || !t::args_match(
            context.db(),
            source,
            &[
                ("to", Some("event.booking.email")),
                ("subject", None),
                ("body", None),
            ],
        )
        || ir_when.span != t::span(source.when?)
    {
        return None;
    }
    let guard = guards.get(&t::span(source.node))?;
    if guard.rule.is_empty()
        || guard.predicate.span != t::span(source.when?)
        || guard.event_source.as_ref()?.model_field != "booking"
        || guard.descriptor["eventSource"]["event"] != event_name
        || guard.descriptor["target"] != "std.EmailV1.send"
        || guard.descriptor["binding"] != "rent_reservations.Mail"
        || guard.descriptor["sourceBinding"] != "delivery"
        || guard
            .inputs
            .iter()
            .map(|input| (input.name.as_str(), input.type_id.as_str()))
            .collect::<Vec<_>>()
            != [
                ("eventTerm", "rent_reservations.Booking"),
                ("eventRevision", "int"),
            ]
    {
        return None;
    }
    let mut send = site(context, source.when?, source.node, kind)?;
    send["operation"] = json!("std.EmailV1.send");
    let rule = json!({"kind":kind,"rule":guard.rule,"source":send["source"],
        "node":send["node"],"statement":send["statement"]});
    Some((send, rule))
}

fn create_pair(
    context: &FreshSourceContext<'_>,
    source: &Effect,
    ir: &IrStmt,
    notice: crate::analysis::resolve::SymbolId,
    kind: &str,
) -> Option<Value> {
    ordinary_leaf(source, ir, EffectVerb::Create)?;
    let IrStmt::Create {
        model,
        binding: Some(binding),
        ..
    } = ir
    else {
        return None;
    };
    if model != "rent_reservations.Notice"
        || binding != "notice"
        || !matches!(source.target,Some(EffectTarget::Model(id)) if id==notice)
        || source.binding.as_deref() != Some("notice")
        || !t::args_match(
            context.db(),
            source,
            &[
                ("parent", Some("event.booking")),
                ("kind", Some(kind)),
                ("revision", Some("event.revision")),
                ("subject", None),
                ("body", None),
                ("delivery", None),
            ],
        )
    {
        return None;
    }
    let mut value = site(context, source.node, source.node, kind)?;
    value["model"] = json!("rent_reservations.Notice");
    Some(value)
}

fn prepare_notice(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    let (event_name, exact) = match owner.canonical.as_str() {
        "rent_reservations.correspondence" => {
            ("rent_reservations.ReservationChanged", CORRESPONDENCE)
        }
        "rent_reservations.remind" => ("rent_reservations.Reminder", REMIND),
        _ => return None,
    };
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    if t::text(context.db(), scenario.node) != Some(exact) {
        return None;
    }
    let resource = t::symbol(program, "rent_reservations.Resource")?;
    let booking = t::symbol(program, "rent_reservations.Booking")?;
    let notice = t::symbol(program, "rent_reservations.Notice")?;
    let location = t::symbol(program, "rent_catalog.Location")?;
    let event = t::symbol(program, event_name)?;
    let reminder = t::symbol(program, "rent_reservations.Reminder")?;
    t::checked_closure(
        context,
        scenario.node,
        &[],
        &[resource, booking, notice, location],
    )?;
    for id in [resource, booking, notice, location, event, reminder] {
        same_item(context, id)?;
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || !matches!(scenario.on,Some(HandlerSource::Event(id)) if id==event)
        || scenario.read
        || scenario.scope_authority
        || scenario.by.is_some()
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || !scenario.params.is_empty()
        || program.effects.models.get(&resource)?.owner != ModelOwner::Team
        || program.effects.models.get(&location)?.owner != ModelOwner::Team
        || program.effects.models.get(&booking)?.owner != ModelOwner::ChildOf(resource)
        || program.effects.models.get(&notice)?.owner != ModelOwner::ChildOf(booking)
    {
        return None;
    }
    let SymbolKind::Event { fields } = &program.symbols.get(event.0 as usize)?.kind else {
        return None;
    };
    if fields.len() != 2
        || program.symbols.get(fields[0].0 as usize)?.name != "booking"
        || program.symbols.get(fields[1].0 as usize)?.name != "revision"
        || !t::record_is(
            program,
            program.types.symbol_types.get(&fields[0])?,
            "rent_reservations.Booking",
        )
        || program.types.symbol_types.get(&fields[1])? != &ResolvedType::Scalar(Scalar::Int)
    {
        return None;
    }
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(IrEventSource::Declared(ir_event)),
        hook: None,
        cohort: None,
        read: false,
        result: None,
        by,
        params,
        guards: ir_guards,
        effects: ir_effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if ir_event != event_name || !by.is_empty() || !params.is_empty() {
        return None;
    }
    let [header] = scenario.guards.as_slice() else {
        return None;
    };
    let [
        IrStmt::Require {
            cond: ir_cond,
            span: ir_span,
        },
    ] = ir_guards.as_slice()
    else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || !no_children(header)
        || header.message.is_some()
        || ir_span != &t::span(header.node)
        || ir_cond.span != t::span(header.cond?)
        || program.types.node_types.get(&header.cond?) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let header = site(context, header.cond?, header.node, "header")?;
    let mut sites = serde_json::Map::new();
    sites.insert("header".into(), header);
    let mut send_rules = Vec::new();
    if owner.canonical == "rent_reservations.remind" {
        let [subject, body, send, create] = scenario.effects.as_slice() else {
            return None;
        };
        let [ir_subject, ir_body, ir_send, ir_create] = ir_effects.as_slice() else {
            return None;
        };
        let_pair(subject, ir_subject, "subject")?;
        let_pair(body, ir_body, "body")?;
        sites.insert(
            "reminderSubject".into(),
            site(context, subject.value?, subject.node, "reminder-subject")?,
        );
        sites.insert(
            "reminderBody".into(),
            site(context, body.value?, body.node, "reminder-body")?,
        );
        let (send_site, rule) = send_pair(context, send, ir_send, guards, "reminder", event_name)?;
        sites.insert("reminderSend".into(), send_site);
        send_rules.push(rule);
        sites.insert(
            "reminderCreate".into(),
            create_pair(context, create, ir_create, notice, "reminder")?,
        );
    } else {
        let [cancel, confirmed, cancelled] = scenario.effects.as_slice() else {
            return None;
        };
        let [ir_cancel, ir_confirmed, ir_cancelled] = ir_effects.as_slice() else {
            return None;
        };
        ordinary_leaf(cancel, ir_cancel, EffectVerb::Cancel)?;
        let IrStmt::Cancel {
            owner_package, key, ..
        } = ir_cancel
        else {
            return None;
        };
        if owner_package != "rent_reservations" || key.span != t::span(cancel.value?) {
            return None;
        }
        sites.insert(
            "cancel".into(),
            site(context, cancel.node, cancel.node, "cancel")?,
        );
        let IrStmt::If {
            cond: confirmed_cond,
            then_branch: confirmed_branch,
            else_branch: confirmed_else,
            span: confirmed_span,
        } = ir_confirmed
        else {
            return None;
        };
        let IrStmt::If {
            cond: cancelled_cond,
            then_branch: cancelled_branch,
            else_branch: cancelled_else,
            span: cancelled_span,
        } = ir_cancelled
        else {
            return None;
        };
        if confirmed.verb != EffectVerb::If
            || cancelled.verb != EffectVerb::If
            || !confirmed.else_effects.is_empty()
            || !cancelled.else_effects.is_empty()
            || !confirmed.match_arms.is_empty()
            || !cancelled.match_arms.is_empty()
            || !confirmed_else.is_empty()
            || !cancelled_else.is_empty()
            || *confirmed_span != t::span(confirmed.node)
            || *cancelled_span != t::span(cancelled.node)
            || confirmed_cond.span != t::span(confirmed.cond?)
            || cancelled_cond.span != t::span(cancelled.cond?)
        {
            return None;
        }
        sites.insert(
            "confirmedIf".into(),
            site(context, confirmed.cond?, confirmed.node, "confirmed-if")?,
        );
        sites.insert(
            "cancelledIf".into(),
            site(context, cancelled.cond?, cancelled.node, "cancelled-if")?,
        );
        let [subject, body, send, create, schedule_if] = confirmed.then_effects.as_slice() else {
            return None;
        };
        let [ir_subject, ir_body, ir_send, ir_create, ir_schedule_if] = confirmed_branch.as_slice()
        else {
            return None;
        };
        let_pair(subject, ir_subject, "subject")?;
        let_pair(body, ir_body, "body")?;
        sites.insert(
            "confirmationSubject".into(),
            site(
                context,
                subject.value?,
                subject.node,
                "confirmation-subject",
            )?,
        );
        sites.insert(
            "confirmationBody".into(),
            site(context, body.value?, body.node, "confirmation-body")?,
        );
        let (send_site, rule) =
            send_pair(context, send, ir_send, guards, "confirmation", event_name)?;
        sites.insert("confirmationSend".into(), send_site);
        send_rules.push(rule);
        sites.insert(
            "confirmationCreate".into(),
            create_pair(context, create, ir_create, notice, "confirmation")?,
        );
        let IrStmt::If {
            cond: schedule_cond,
            then_branch: schedule_branch,
            else_branch: schedule_else,
            span: schedule_span,
        } = ir_schedule_if
        else {
            return None;
        };
        let [schedule] = schedule_if.then_effects.as_slice() else {
            return None;
        };
        let [ir_schedule] = schedule_branch.as_slice() else {
            return None;
        };
        if schedule_if.verb != EffectVerb::If
            || !schedule_if.else_effects.is_empty()
            || !schedule_if.match_arms.is_empty()
            || !schedule_else.is_empty()
            || *schedule_span != t::span(schedule_if.node)
            || schedule_cond.span != t::span(schedule_if.cond?)
            || schedule.verb != EffectVerb::Schedule
            || !no_children(schedule)
            || !matches!(schedule.target,Some(EffectTarget::Event(id)) if id==reminder)
            || !t::args_match(
                context.db(),
                schedule,
                &[
                    ("booking", Some("event.booking")),
                    ("revision", Some("event.revision")),
                ],
            )
        {
            return None;
        }
        let IrStmt::Schedule {
            owner_package,
            event: scheduled,
            key,
            at,
            span,
            ..
        } = ir_schedule
        else {
            return None;
        };
        if owner_package != "rent_reservations"
            || scheduled != "rent_reservations.Reminder"
            || *span != t::span(schedule.node)
            || key.span != t::span(schedule.key?)
            || at.span != t::span(schedule.at?)
        {
            return None;
        }
        sites.insert(
            "scheduleIf".into(),
            site(context, schedule_if.cond?, schedule_if.node, "schedule-if")?,
        );
        let mut scheduled_site = site(context, schedule.node, schedule.node, "schedule")?;
        scheduled_site["event"] = json!("rent_reservations.Reminder");
        sites.insert("schedule".into(), scheduled_site);
        let [subject, body, send, create] = cancelled.then_effects.as_slice() else {
            return None;
        };
        let [ir_subject, ir_body, ir_send, ir_create] = cancelled_branch.as_slice() else {
            return None;
        };
        let_pair(subject, ir_subject, "subject")?;
        let_pair(body, ir_body, "body")?;
        sites.insert(
            "cancellationSubject".into(),
            site(
                context,
                subject.value?,
                subject.node,
                "cancellation-subject",
            )?,
        );
        sites.insert(
            "cancellationBody".into(),
            site(context, body.value?, body.node, "cancellation-body")?,
        );
        let (send_site, rule) =
            send_pair(context, send, ir_send, guards, "cancellation", event_name)?;
        sites.insert("cancellationSend".into(), send_site);
        send_rules.push(rule);
        sites.insert(
            "cancellationCreate".into(),
            create_pair(context, create, ir_create, notice, "cancellation")?,
        );
    }
    Some(json!({"version":1,"owner":owner.canonical,"source":
        t::source(program,context.db(),scenario.node,"rent_reservations")?,
        "event":event_name,"sites":sites,"sendRules":send_rules}))
}

pub(super) fn collect_notice_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_notice(context, item, send_guards)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
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
            "rent-notice-void/v1:{}:{}:{}",
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
            member_retry_decision: None,
            rent_movement_refund_decision: None,
            invoice_collect_decision: None,
            rent_notice_decision: Some(decision),
            invoice_issue_decision: None, observe_venue_decision: None, success_renewal_decision: None, purchase_receive_all: None, event_notice_audit: None,
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
