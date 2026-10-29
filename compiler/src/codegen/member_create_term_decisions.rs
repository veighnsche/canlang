//! Source-bound SEND guard for the CanMember term-creation charge.
//!
//! The renewal `Billing.charge` guard roots at the freshly created `term`
//! row, a `create ... as` alias the generic SEND transport admits. This
//! module seals it exactly anyway: the frozen created Term row with the
//! original payload and transport. State re-materializes the current Term at
//! dispatch and refuses cancelled, revoked, expired or superseded terms
//! before the provider is called.
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
        eprintln!("SEND-GUARD-TRACE {} MISS {}", "CREATETERM", step);
    }
    value
}


const WHEN: &str = "term.cancellation==none and term.until>now and not term.parent.revoked and (not term.automatic or (term.parent.recurrence and term.parent.consent==term.consent and (term.parent.cancellation_at==null or term.from<term.parent.cancellation_at)))";
const VALUE: &str = "{source=term.source,customer=membership.parent.id,location=location.id,description=term.title,amount=term.price,due=local_date(from,membership.timezone),consent=term.consent,items=[{title=term.title,quantity=1,price=term.price,tax=money(0,term.price.currency),discount=money(0,term.price.currency),unit=\"term\",from,until,location=location.id,reference=term.source}]}";

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
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-1"); }
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

pub(super) fn prepare_create_term_send_guard(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    if owner.canonical != "member_terms.create_term" {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-2"); }
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = traced("scenario-data", program.effects.scenarios.get(&owner.id))?;
    let term_model = traced(concat!("symbol-", "member_terms.Term"), t::symbol(program, "member_terms.Term"))?;
    let membership_model = traced(concat!("symbol-", "member_terms.Membership"), t::symbol(program, "member_terms.Membership"))?;
    let renewal_event = traced(concat!("symbol-", "member_terms.RenewalDue"), t::symbol(program, "member_terms.RenewalDue"))?;
    t::checked_closure(
        context,
        scenario.node,
        &[],
        &[term_model, membership_model],
    )?;
    for id in [term_model, membership_model, renewal_event] {
        same_item(context, id)?;
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || !matches!(scenario.on, Some(HandlerSource::Event(id)) if id == renewal_event)
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.by.is_some()
        || !scenario.params.is_empty()
        || scenario.guards.len() != 1
        || traced("model-&term_model", program.effects.models.get(&term_model))?.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(membership_model)
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-3"); }
        return None;
    }
    let (send, ancestors) = source_send(&scenario.effects)?;
    let predicate = send.when?;
    // The SEND stages in the eligible branch of the nested renewal `if`s;
    // sibling skipped-path sets never reach it.
    if ancestors.len() != 2
        || ancestors.iter().any(|effect| effect.verb != EffectVerb::If)
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-4"); }
        return None;
    }
    if send.verb != EffectVerb::Send
        || !t::no_children(send)
        || send.target_node.and_then(|node| t::text(db, node)) != Some("Billing.charge")
        || send.binding.as_deref() != Some("charge")
        || send.when.and_then(|node| t::text(db, node)) != Some(WHEN)
        || !t::args_match(db, send, &[("value", Some(VALUE))])
        || program.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-5"); }
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
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-6"); }
        return None;
    };
    if ir_event != "member_terms.RenewalDue"
        || !by.is_empty()
        || !params.is_empty()
        || ir_guards.len() != 1
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-7"); }
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
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-8"); }
        return None;
    };
    if operation != "invoice.BillingV1.charge"
        || ir_binding != "charge"
        || deployment_binding.as_deref() != Some("member_terms.Billing")
        || *ir_span != t::span(send.node)
        || ir_when.span != t::span(predicate)
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-9"); }
        return None;
    }
    // Every predicate root is the single created `term` row.
    let trees = context.trees();
    let tree = &trees.iter().find(|(file, _)| *file == predicate.file)?.1;
    let predicate_node = tree
        .descendants()
        .find(|node| NodeKey::of(*node) == predicate)?;
    let mut term_uses = Vec::new();
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
                if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT builtin"); }
                return None;
            }
            continue;
        };
        if t::text(db, key) != Some("term") {
            if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-10"); }
            return None;
        }
        let Binding::CreateAs { node: declaration } = bound else {
            if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-11"); }
            return None;
        };
        term_uses.push((key, *declaration));
    }
    if term_uses.is_empty() {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-12"); }
        return None;
    }
    let declaration = term_uses[0].1;
    if declaration.end > send.node.start
        || term_uses.iter().any(|(_, other)| other != &declaration)
    {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-13"); }
        return None;
    }
    let term_ty = traced("node-type", program.types.node_types.get(&term_uses[0].0))?.clone();
    if !t::record_is(program, &term_ty, "member_terms.Term") {
        if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-14"); }
        return None;
    }
    for (use_key, _) in &term_uses {
        if program.types.node_types.get(use_key) != Some(&term_ty) {
            if std::env::var("CAN_SEND_GUARD_DEBUG").is_ok() { eprintln!("SEND-GUARD-TRACE CREATETERM REJECT shape-15"); }
            return None;
        }
    }
    let source = traced(concat!("source-", "member_terms"), t::source(program, db, predicate, "member_terms"))?;
    let rule = format!(
        "member_terms.create_term.sendWhen.{}.{}.{}",
        source["sha256"].as_str()?,
        predicate.start,
        predicate.end
    );
    let input = PreparedSendInput {
        name: "term".into(),
        type_id: "member_terms.Term".into(),
        value: TypedExpr::new(
            IrExpr::Name("term".into()),
            term_ty,
            t::span(term_uses[0].0),
        ),
        declaration,
        symbol: None,
        owner: owner.id,
        ordinal: 0,
        narrowing: None,
    };
    let descriptor = json!({"rule":rule,"owner":"member_terms.create_term","source":source,
        "node":t::interval(predicate),"statement":t::interval(send.node),
        "target":"invoice.BillingV1.charge","binding":"member_terms.Billing","sourceBinding":"charge",
        "inputs":[{"name":"term","type":"member_terms.Term"}]});
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

fn site(
    context: &FreshSourceContext<'_>,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        return None;
    }
    let source = t::source(context.original(), context.db(), node, "member_terms")?;
    let id = sha256_hex(
        format!(
            "member-create/v1:{kind}:{}:{}:{}:{}:{}",
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

fn prepare_create(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
    guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<Value> {
    prepare_create_term_send_guard(context, owner)?;
    let program = context.original();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let (send, ancestors) = source_send(&scenario.effects)?;
    let branch = ancestors.get(1)?;
    let guard = guards.get(&t::span(send.node))?;
    if guard.rule.is_empty()
        || guard.predicate.span != t::span(send.when?)
        || guard.descriptor["target"] != "invoice.BillingV1.charge"
        || guard.descriptor["binding"] != "member_terms.Billing"
        || guard.descriptor["sourceBinding"] != "charge"
        || guard.inputs.len() != 1
        || guard.inputs[0].name != "term"
        || guard.inputs[0].type_id != "member_terms.Term"
    {
        return None;
    }
    let origin = t::source(program, context.db(), scenario.node, "member_terms")?;
    let when = site(context, send.when?, send.node, "send")?;
    let branch_site = site(context, branch.node, branch.node, "branch")?;
    Some(
        json!({"version":1,"owner":"member_terms.create_term","source":origin,
        "sites":{"branch":branch_site,"send":when.clone()},
        "sendRule":{"rule":guard.rule,"source":when["source"],"node":when["node"],
            "statement":when["statement"]}}),
    )
}

pub(super) fn collect_create_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    if item.canonical != "member_terms.create_term" {
        return None;
    }
    let decision = prepare_create(context, item, send_guards)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
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
            "member-create-void/v1:{}:{}:{}",
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
            apply_result_decision: None,
            observe_venue_decision: None,
            create_term_decision: Some(decision),
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
