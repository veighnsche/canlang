//! Source-bound SEND guards for CanEvent venue observation.
//!
//! The generic SEND transport refuses `for`-item roots: a `for change in
//! Change` alias is neither an owning parameter nor a lexical `let`, so the
//! exact observing `Rooms.confirm` guard needs its own source-bound rule.
//! The prepared Rule carries the frozen observing Change row; State
//! re-materializes the current row at dispatch and refuses stale or
//! ineligible changes before the provider is called.
use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{EffectVerb, HandlerSource};
use crate::analysis::resolve::{Binding, SymbolId};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::{NodeKey, ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt, TypedExpr};
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};
use super::send_guards::{PreparedSendGuard, PreparedSendInput};
use super::source_context::FreshSourceContext;
use super::term_decisions as t;

fn site(
    context: &FreshSourceContext<'_>,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        return None;
    }
    let source = t::source(context.original(), context.db(), node, "events")?;
    let id = sha256_hex(
        format!(
            "event-observe/v1:{kind}:{}:{}:{}:{}:{}",
            source["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes(),
    );
    Some(
        json!({"id":id,"source":source,"node":t::interval(node),"statement":t::interval(statement)}),
    )
}

const WHEN: &str = "change.parent.pending_change==change and not change.parent.cancelled and change.state==confirming";
const OPERATION: &str = "rent_reservations.RoomsV1.confirm";

fn same_item(context: &FreshSourceContext<'_>, id: SymbolId) -> Option<()> {
    let original = context.ir().items.get(id.0 as usize)?;
    let fresh = context.fresh().items.get(id.0 as usize)?;
    (original.canonical == fresh.canonical
        && format!("{:?}", original.kind) == format!("{:?}", fresh.kind))
    .then_some(())
}

/// Walk checked source effects through `for`/`if` nesting to the single
/// guarded SEND. Sibling emits, sets and schedules stay untouched.
fn source_send(
    effects: &[crate::analysis::effects::Effect],
) -> Option<(
    &crate::analysis::effects::Effect,
    Vec<&crate::analysis::effects::Effect>,
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
        return None;
    };
    Some((send, ancestors.clone()))
}

fn ir_send(statements: &[IrStmt]) -> Option<&IrStmt> {
    // Complete inventory: collect every guarded SEND, then require exactly
    // one. The earlier reset-to-None walk returned from its frame on the
    // second SEND while the outer loop continued, so a third guarded SEND
    // re-armed the slot and falsely proved uniqueness with the wrong span.
    fn visit<'a>(statements: &'a [IrStmt], out: &mut Vec<&'a IrStmt>) {
        for statement in statements {
            match statement {
                IrStmt::Send { when: Some(_), .. } => out.push(statement),
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    visit(then_branch, out);
                    visit(else_branch, out);
                }
                IrStmt::For { body, .. } => visit(body, out),
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        visit(&arm.body, out);
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    visit(statements, &mut out);
    let [send] = out.as_slice() else {
        return None;
    };
    Some(send)
}

pub(super) fn prepare_observe_venue_send_guard(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    if owner.canonical != "events.observe_venue" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let change_model = t::symbol(program, "events.Change")?;
    let event_model = t::symbol(program, "events.Event")?;
    let venue_event = t::symbol(program, "events.VenueObserved")?;
    t::checked_closure(context, scenario.node, &[], &[change_model, event_model])?;
    for id in [change_model, event_model, venue_event] {
        same_item(context, id)?;
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || !matches!(scenario.on, Some(HandlerSource::Event(id)) if id == venue_event)
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.is_some()
        || !scenario.params.is_empty()
        || !scenario.guards.is_empty()
        || program.effects.models.get(&change_model)?.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(event_model)
    {
        return None;
    }
    let (send, ancestors) = source_send(&scenario.effects)?;
    let predicate = send.when?;
    // The SEND stages inside one `for change` scan over the provider's own
    // source row; the three ancestor `if` gates narrow that scan to the
    // exact eligible Change. Pin their checked predicate text in order: a
    // removed or weakened gate could otherwise stage and mutate Change
    // rows the dispatch check would never see.
    const IFS: &[&str] = &[
        "event.value.revision>change.venue_revision",
        "change.parent.pending_change==change and not change.parent.cancelled and change.base_revision==change.parent.revision",
        "event.value.state==pending and change.state==holding and change.resource!=null",
    ];
    let mut fors = ancestors
        .iter()
        .filter(|effect| effect.verb == EffectVerb::For);
    let for_effect = fors.next()?;
    let ifs: Vec<&&crate::analysis::effects::Effect> = ancestors
        .iter()
        .filter(|effect| effect.verb == EffectVerb::If)
        .collect();
    if fors.next().is_some()
        || for_effect.item.as_deref() != Some("change")
        || for_effect.domain.and_then(|node| t::text(db, node))
            != Some("Change as row where row.source==event.value.source")
        || for_effect.limit.and_then(|node| t::text(db, node)) != Some("1")
        || ancestors
            .iter()
            .any(|effect| !matches!(effect.verb, EffectVerb::For | EffectVerb::If))
        || ifs.len() != IFS.len()
        || ifs.iter().zip(IFS.iter()).any(|(effect, want)| {
            effect.cond.and_then(|node| t::text(db, node)) != Some(want)
                || !effect.else_effects.is_empty()
        })
    {
        return None;
    }
    if send.verb != EffectVerb::Send
        || !t::no_children(send)
        || send.target_node.and_then(|node| t::text(db, node)) != Some("Rooms.confirm")
        || send.binding.as_deref() != Some("delivery")
        || send.when.and_then(|node| t::text(db, node)) != Some(WHEN)
        || !t::args_match(
            db,
            send,
            &[
                ("source", Some("change.source")),
                ("resource", Some("resource.id")),
            ],
        )
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
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
        return None;
    };
    if ir_event != "events.VenueObserved"
        || !by.is_empty()
        || !params.is_empty()
        || !ir_guards.is_empty()
    {
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
        return None;
    };
    if operation != OPERATION
        || ir_binding != "delivery"
        || deployment_binding.as_deref() != Some("events.Rooms")
        || *ir_span != t::span(send.node)
        || ir_when.span != t::span(predicate)
    {
        return None;
    }
    // Every predicate root is the single `for change` item; the sibling
    // `let resource` never reaches the guard.
    let trees = context.trees();
    let tree = &trees.iter().find(|(file, _)| *file == predicate.file)?.1;
    let predicate_node = tree
        .descendants()
        .find(|node| NodeKey::of(node) == predicate)?;
    let mut change_uses = Vec::new();
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
                return None;
            }
            continue;
        };
        if t::text(db, key) != Some("change") {
            return None;
        }
        let Binding::ForItem { node: declaration } = bound else {
            return None;
        };
        change_uses.push((key, *declaration));
    }
    if change_uses.is_empty() {
        return None;
    }
    let declaration = change_uses[0].1;
    if declaration != for_effect.node || change_uses.iter().any(|(_, other)| other != &declaration)
    {
        return None;
    }
    let change_ty = program.types.node_types.get(&change_uses[0].0)?.clone();
    if !t::record_is(program, &change_ty, "events.Change") {
        return None;
    }
    for (use_key, _) in &change_uses {
        if program.types.node_types.get(use_key) != Some(&change_ty) {
            return None;
        }
    }
    let source = t::source(program, db, predicate, "events")?;
    let rule = format!(
        "events.observe_venue.sendWhen.{}.{}.{}",
        source["sha256"].as_str()?,
        predicate.start,
        predicate.end
    );
    let input = PreparedSendInput {
        name: "change".into(),
        type_id: "events.Change".into(),
        value: TypedExpr::new(
            IrExpr::Name("change".into()),
            change_ty,
            t::span(change_uses[0].0),
        ),
        declaration,
        symbol: None,
        owner: owner.id,
        ordinal: 0,
        narrowing: None,
    };
    let descriptor = json!({"rule":rule,"owner":"events.observe_venue","source":source,
        "node":t::interval(predicate),"statement":t::interval(send.node),
        "target":OPERATION,"binding":"events.Rooms","sourceBinding":"delivery",
        "inputs":[{"name":"change","type":"events.Change"}]});
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

fn prepare_observe(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    prepare_observe_venue_send_guard(context, owner)?;
    let program = context.original();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let (send, ancestors) = source_send(&scenario.effects)?;
    let for_effect = ancestors
        .iter()
        .find(|effect| effect.verb == EffectVerb::For)?;
    let guard = guards.get(&t::span(send.node))?;
    if guard.rule.is_empty()
        || guard.predicate.span != t::span(send.when?)
        || guard.descriptor["target"] != OPERATION
        || guard.descriptor["binding"] != "events.Rooms"
        || guard.descriptor["sourceBinding"] != "delivery"
        || guard.inputs.len() != 1
        || guard.inputs[0].name != "change"
        || guard.inputs[0].type_id != "events.Change"
    {
        return None;
    }
    let origin = t::source(program, context.db(), scenario.node, "events")?;
    let when = site(context, send.when?, send.node, "send")?;
    let mut for_site = site(context, for_effect.node, for_effect.node, "for")?;
    for_site["model"] = json!("events.Change");
    // The single Change source scan is a checked owner query site: the
    // native runtime only serves the exact tagged occurrence, never an
    // ambient viewer read. The queryNode is the checked for-domain span;
    // remaining spans are the enclosing for occurrence, all pinned by the
    // State frame check below.
    let domain = for_effect.domain?;
    let scan_id = sha256_hex(
        format!(
            "event-observe-scan/v1:{}:{}:{}:{}:{}",
            origin["sha256"].as_str()?,
            domain.start,
            domain.end,
            for_effect.node.start,
            for_effect.node.end
        )
        .as_bytes(),
    );
    let scan_site = json!({
        "id": scan_id,
        "stage": "venueScan",
        "model": "events.Change",
        "source": origin,
        "queryNode": t::interval(domain),
        "callSite": t::interval(for_effect.node),
        "aliasSite": t::interval(for_effect.node),
        "predicateSite": t::interval(domain),
        "selectionSite": t::interval(for_effect.node),
        "domainKind": "tenant-root",
        "ownerPath": [],
        "order": [],
        "deriveChain": [],
    });
    Some(
        json!({"version":1,"owner":"events.observe_venue","source":origin,
        "sites":{"for":for_site,"send":when.clone()},
        "querySites":[scan_site],
        "sendRule":{"rule":guard.rule,"source":when["source"],"node":when["node"],
            "statement":when["statement"]}}),
    )
}

pub(super) fn collect_observe_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    if item.canonical != "events.observe_venue" {
        return None;
    }
    let decision = prepare_observe(context, item, send_guards)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let file = context.db().get(scenario.node.file)?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "events".into(),
        },
        entry_module,
    )?;
    let id = sha256_hex(
        format!(
            "event-observe-void/v1:{}:{}:{}",
            source.sha256, scenario.node.start, scenario.node.end
        )
        .as_bytes(),
    );
    Some(NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            retained_guarded_handler: None,
            source_loops: None,
            source_emissions: None,
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
            rent_notice_decision: None,
            invoice_issue_decision: None,
            observe_venue_decision: Some(decision),
            success_renewal_decision: None,
            purchase_receive_all: None,
            event_notice_audit: None,
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
