//! Source-bound SEND guard for the CanInvoice provider-receipt path.
//!
//! The failure-notice `Mail.send` is staged inside a `for attempt` scan, so
//! its guard root is a `for`-item alias the generic SEND transport refuses.
//! This module seals the exact guard: the frozen failing Attempt row with the
//! original payload and transport. State re-materializes the current Attempt
//! at dispatch and refuses settled, disabled or superseded rows before the
//! provider is called.
use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{EffectVerb, HandlerSource};
use crate::analysis::resolve::{Binding, SymbolId};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::{NodeKey, ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt, TypedExpr};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};
use super::send_guards::{PreparedSendGuard, PreparedSendInput};
use super::term_decisions as t;
fn traced<T>(step: &str, value: Option<T>) -> Option<T> {
    if value.is_none() && std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() {
        eprintln!("SEND-GUARD-TRACE {} MISS {}", "APPLY", step);
    }
    value
}


fn site(
    context: &FreshSourceContext<'_>,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-1"); }
        return None;
    }
    let source = t::source(context.original(), context.db(), node, "invoice")?;
    let id = sha256_hex(
        format!(
            "invoice-apply/v1:{kind}:{}:{}:{}:{}:{}",
            source["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"source":source,"node":t::interval(node),"statement":t::interval(statement)}))
}

const WHEN: &str = "attempt.parent.state==issued and attempt.parent.balance.minor>0 and attempt.status==failed";
const SUBJECT: &str = "format(\"Invoice payment needs attention\"@{nl=\"Factuurbetaling vereist aandacht\"},locale=null)";
const BODY: &str = "format(\"{url}\",{url=app_url(format(\"/finance/invoice/{invoice}\",{invoice=attempt.parent.id}))})";

fn same_item(context: &FreshSourceContext<'_>, id: SymbolId) -> Option<()> {
    let original = context.ir().items.get(id.0 as usize)?;
    let fresh = context.fresh().items.get(id.0 as usize)?;
    (original.canonical == fresh.canonical
        && format!("{:?}", original.kind) == format!("{:?}", fresh.kind))
    .then_some(())
}

fn source_send<'a>(
    effects: &'a [crate::analysis::effects::Effect],
) -> Option<(
    &'a crate::analysis::effects::Effect,
    Vec<&'a crate::analysis::effects::Effect>,
)> {
    fn visit<'a>(
        effects: &'a [crate::analysis::effects::Effect],
        ancestors: &mut Vec<&'a crate::analysis::effects::Effect>,
        out: &mut Vec<(
            &'a crate::analysis::effects::Effect,
            Vec<&'a crate::analysis::effects::Effect>,
        )>,
    ) {
        for effect in effects {
            if effect.verb == EffectVerb::Send {
                out.push((effect, ancestors.clone()));
            }
            ancestors.push(effect);
            visit(&effect.then_effects, ancestors, out);
            visit(&effect.else_effects, ancestors, out);
            for arm in &effect.match_arms {
                visit(&arm.effects, ancestors, out);
            }
            ancestors.pop();
        }
    }
    let mut out = Vec::new();
    visit(effects, &mut Vec::new(), &mut out);
    let [(send, ancestors)] = out.as_slice() else {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-2"); }
        return None;
    };
    Some((send, ancestors.clone()))
}

fn ir_send<'a>(statements: &'a [IrStmt]) -> Option<&'a IrStmt> {
    let mut found = None;
    fn visit<'a>(statements: &'a [IrStmt], found: &mut Option<&'a IrStmt>) {
        for statement in statements {
            match statement {
                IrStmt::Send { when: Some(_), .. } => {
                    if found.is_some() {
                        *found = None;
                        return;
                    }
                    *found = Some(statement);
                }
                IrStmt::If { then_branch, else_branch, .. } => {
                    visit(then_branch, found);
                    visit(else_branch, found);
                }
                IrStmt::For { body, .. } => visit(body, found),
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        visit(&arm.body, found);
                    }
                }
                _ => {}
            }
        }
    }
    visit(statements, &mut found);
    found
}

pub(super) fn prepare_apply_result_send_guard(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    if owner.canonical != "invoice.apply_result" {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-3"); }
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = traced("scenario-data", program.effects.scenarios.get(&owner.id))?;
    let attempt_model = traced(concat!("symbol-", "invoice.Attempt"), t::symbol(program, "invoice.Attempt"))?;
    let invoice_model = traced(concat!("symbol-", "invoice.Invoice"), t::symbol(program, "invoice.Invoice"))?;
    let receipt_event = traced(concat!("symbol-", "invoice.ProviderReceipt"), t::symbol(program, "invoice.ProviderReceipt"))?;
    t::checked_closure(context, scenario.node, &[], &[attempt_model, invoice_model])?;
    for id in [attempt_model, invoice_model, receipt_event] {
        same_item(context, id)?;
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || !matches!(scenario.on, Some(HandlerSource::Event(id)) if id == receipt_event)
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.is_some()
        || !scenario.params.is_empty()
        || !scenario.guards.is_empty()
        || traced("model-&attempt_model", program.effects.models.get(&attempt_model))?.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(invoice_model)
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-4"); }
        return None;
    }
    let (send, ancestors) = source_send(&scenario.effects)?;
    let predicate = send.when?;
    // The SEND stages inside one `for attempt` scan over the provider's own
    // reference row; sibling checks only narrow that scan.
    let mut fors = ancestors.iter().filter(|effect| effect.verb == EffectVerb::For);
    let for_effect = fors.next()?;
    if fors.next().is_some()
        || for_effect.item.as_deref() != Some("attempt")
        || for_effect.domain.and_then(|node| t::text(db, node))
            != Some("Attempt as item where item.reference==event.value.reference")
        || for_effect.limit.and_then(|node| t::text(db, node)) != Some("1")
        || ancestors.iter().any(|effect| {
            !matches!(
                effect.verb,
                EffectVerb::For | EffectVerb::Require | EffectVerb::If
            )
        })
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-5"); }
        return None;
    }
    if send.verb != EffectVerb::Send
        || !t::no_children(send)
        || send.target_node.and_then(|node| t::text(db, node)) != Some("Mail.send")
        || send.binding.as_deref() != Some("notice")
        || send.when.and_then(|node| t::text(db, node)) != Some(WHEN)
        || !t::args_match(
            db,
            send,
            &[
                ("to", Some("attempt.parent.recipient_email")),
                ("subject", Some(SUBJECT)),
                ("body", Some(BODY)),
            ],
        )
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-6"); }
        return None;
    }
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(ir_event)),
        hook: None,
        cohort: None,
        result: None,
        read: false,
        by,
        params,
        guards: ir_guards,
        effects: ir_effects,
        ..
    } = &owner.kind
    else {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-7"); }
        return None;
    };
    if ir_event != "invoice.ProviderReceipt" || !by.is_empty() || !params.is_empty() || !ir_guards.is_empty() {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-8"); }
        return None;
    }
    let ir = ir_send(ir_effects)?;
    let IrStmt::Send {
        operation,
        deployment_binding,
        binding: Some(ir_binding),
        when: Some(ir_when),
        span: ir_span,
        ..
    } = ir
    else {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-9"); }
        return None;
    };
    if operation != "std.EmailV1.send"
        || ir_binding != "notice"
        || deployment_binding.as_deref() != Some("invoice.Mail")
        || *ir_span != t::span(send.node)
        || ir_when.span != t::span(predicate)
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-10"); }
        return None;
    }
    // Every predicate root is the single `for attempt` item; the sibling
    // provider-value reads never reach the guard.
    let trees = context.trees();
    let tree = &trees.iter().find(|(file, _)| *file == predicate.file)?.1;
    let predicate_node = tree
        .descendants()
        .find(|node| NodeKey::of(*node) == predicate)?;
    let mut attempt_uses = Vec::new();
    for node in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::NameRef)
    {
        let key = NodeKey::of(node);
        let Some(bound) = context.resolved().node_binding.get(&key) else {
            // Field selectors stay outside name resolution; only bound roots
            // can carry guard transport.
            continue;
        };
        if matches!(bound, Binding::Builtin { .. } | Binding::Context(_)) {
            // The dispatch clock re-evaluates at dispatch; only `now` may
            // reach a Tier-1 guard this way.
            if t::text(db, key) != Some("now") {
                if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT builtin"); }
                return None;
            }
            continue;
        };
        if t::text(db, key) != Some("attempt") {
            if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-11"); }
            return None;
        }
        let Binding::ForItem { node: declaration } = bound else {
            if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-12"); }
            return None;
        };
        attempt_uses.push((key, *declaration));
    }
    if attempt_uses.is_empty() {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-13"); }
        return None;
    }
    let declaration = attempt_uses[0].1;
    if declaration != for_effect.node
        || attempt_uses.iter().any(|(_, other)| other != &declaration)
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-14"); }
        return None;
    }
    let attempt_ty = traced("node-type", program.types.node_types.get(&attempt_uses[0].0))?.clone();
    if !t::record_is(program, &attempt_ty, "invoice.Attempt") {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-15"); }
        return None;
    }
    for (use_key, _) in &attempt_uses {
        if program.types.node_types.get(use_key) != Some(&attempt_ty) {
            if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-16"); }
            return None;
        }
    }
    let source = traced(concat!("source-", "invoice"), t::source(program, db, predicate, "invoice"))?;
    let rule = format!(
        "invoice.apply_result.sendWhen.{}.{}.{}",
        source["sha256"].as_str()?,
        predicate.start,
        predicate.end
    );
    let input = PreparedSendInput {
        name: "attempt".into(),
        type_id: "invoice.Attempt".into(),
        value: TypedExpr::new(
            IrExpr::Name("attempt".into()),
            attempt_ty,
            t::span(attempt_uses[0].0),
        ),
        declaration,
        symbol: None,
        owner: owner.id,
        ordinal: 0,
        narrowing: None,
    };
    let descriptor = json!({"rule":rule,"owner":"invoice.apply_result","source":source,
        "node":t::interval(predicate),"statement":t::interval(send.node),
        "target":"std.EmailV1.send","binding":"invoice.Mail","sourceBinding":"notice",
        "inputs":[{"name":"attempt","type":"invoice.Attempt"}]});
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

fn prepare_apply(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    prepare_apply_result_send_guard(context, owner)?;
    let program = context.original();
    let scenario = traced("scenario-data", program.effects.scenarios.get(&owner.id))?;
    let (send, ancestors) = source_send(&scenario.effects)?;
    let for_effect = ancestors
        .iter()
        .find(|effect| effect.verb == EffectVerb::For)?;
    let guard = guards.get(&t::span(send.node))?;
    if guard.rule.is_empty()
        || guard.predicate.span != t::span(send.when?)
        || guard.descriptor["target"] != "std.EmailV1.send"
        || guard.descriptor["binding"] != "invoice.Mail"
        || guard.descriptor["sourceBinding"] != "notice"
        || guard.inputs.len() != 1
        || guard.inputs[0].name != "attempt"
        || guard.inputs[0].type_id != "invoice.Attempt"
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-17"); }
        return None;
    }
    let origin = t::source(program, context.db(), scenario.node, "invoice")?;
    let when = site(context, send.when?, send.node, "send")?;
    let mut for_site = site(context, for_effect.node, for_effect.node, "for")?;
    for_site["model"] = json!("invoice.Attempt");
    Some(
        json!({"version":1,"owner":"invoice.apply_result","source":origin,
        "sites":{"for":for_site,"send":when.clone()},
        "sendRule":{"rule":guard.rule,"source":when["source"],"node":when["node"],
            "statement":when["statement"]}}),
    )
}

pub(super) fn collect_apply_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    if item.canonical != "invoice.apply_result" {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE APPLY REJECT shape-18"); }
        return None;
    }
    let decision = prepare_apply(context, item, send_guards)?;
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
            "invoice-apply-void/v1:{}:{}:{}",
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
            rent_movement_refund_decision: None,
            invoice_collect_decision: None,
            rent_notice_decision: None,
            invoice_issue_decision: None,
            apply_result_decision: Some(decision), observe_venue_decision: None, create_term_decision: None,
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
