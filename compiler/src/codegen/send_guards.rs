//! Private original SEND predicate preparation; no execution authority.
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::analysis::effects::{Effect, EffectTarget, EffectVerb, HandlerSource, ScenarioData};
use crate::analysis::resolve::{self, Binding, Symbol, SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::{
    CheckedDecisionPosition, CheckedDecisionSite, CheckedDecisionStage, CheckedScenarioSource,
    DependencyRole, DisclosureFirstQuery, DisclosureQuery, ScenarioDisclosure,
};
use crate::analysis::types::{
    CheckedCollectionCall, CheckedQuery, SelectedCall, SelectedCallTarget,
};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, kids, name_text};
use crate::source::{SourceDb, Span};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{
    IrBinOp, IrExpr, IrItem, IrItemKind, IrProgram, IrQuery, IrQueryDomain, IrStmt, TypedExpr,
};
use super::scenario_decisions::serial_type;

#[derive(Debug)]
pub(super) struct SendGuardGap {
    pub reason: &'static str,
    pub span: Option<Span>,
}

fn gap(reason: &'static str, span: Option<Span>) -> SendGuardGap {
    SendGuardGap { reason, span }
}

#[derive(Clone)]
pub(super) struct PreparedSendInput {
    pub name: String,
    pub type_id: String,
    pub value: TypedExpr,
    /// Original lexical declaration; never reconstructed from an emitted name.
    pub declaration: NodeKey,
    pub symbol: Option<SymbolId>,
    pub owner: SymbolId,
    pub ordinal: usize,
    /// Only an earlier successful original first-row presence Require refines
    /// the captured type. The nullable lexical declaration remains retained.
    #[allow(dead_code)]
    pub narrowing: Option<PreparedFirstRowNarrowing>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub(super) struct PreparedFirstRowNarrowing {
    pub declared_type: ResolvedType,
    pub model: SymbolId,
    pub query_id: String,
    pub first_call: NodeKey,
    pub binding: NodeKey,
    pub presence: NodeKey,
    pub require: NodeKey,
    pub occurrence: NodeKey,
    pub source: crate::analysis::scenario_disclosure::DisclosureSource,
}

#[derive(Clone)]
pub(super) struct PreparedSendGuard {
    pub rule: String,
    pub predicate: TypedExpr,
    pub descriptor: serde_json::Value,
    pub inputs: Vec<PreparedSendInput>,
    pub event_source: Option<PreparedSendEventSource>,
}

/// The declared event row and revision are frozen by State.
/// This is separate from ordinary caller-supplied lexical SEND inputs.
#[derive(Clone)]
pub(super) struct PreparedSendEventSource {
    pub model_slot: &'static str,
    pub revision_slot: &'static str,
    pub model_field: String,
    pub revision_field: String,
    /// A source-proven `let alias=event.<model>` bound to the authenticated row.
    pub lexical_alias: Option<String>,
}

/// Only this module constructs a prepared inventory. All editable IR is sealed.
pub(super) struct PreparedSendGuards {
    guards: HashMap<Span, PreparedSendGuard>,
    by_owner: BTreeMap<String, serde_json::Value>,
    closure: String,
}

impl PreparedSendGuards {
    pub fn guards(&self, ir: &IrProgram) -> Option<&HashMap<Span, PreparedSendGuard>> {
        (self.closure == format!("{ir:?}")).then_some(&self.guards)
    }

    pub fn by_owner(&self, ir: &IrProgram) -> Option<&BTreeMap<String, serde_json::Value>> {
        (self.closure == format!("{ir:?}")).then_some(&self.by_owner)
    }
}

/// A prepared ordinary Declared handler may reuse the native SEND frame without
/// publishing query grants or inventing a return. Preparation sealed the full
/// fresh execution closure and each owner's complete original SEND inventory.
pub(super) fn retained_handler_receipt(
    context: &super::source_context::FreshSourceContext<'_>,
    prepared: &PreparedSendGuards,
    owner: &IrItem,
    entry: &str,
) -> Option<super::scenario_receipts::NativeScenarioReceipt> {
    use super::scenario_receipts::{
        NativeScenarioReceipt, ReceiptDisclosurePlan, transport_source,
    };
    let ir = context.ir();
    super::scenario_decisions::owner_handler_queries(context, owner)?;
    let IrItemKind::Scenario {
        event_source: Some(super::ir::IrEventSource::Declared(event)),
        ..
    } = &owner.kind
    else {
        return None;
    };
    let guards = prepared.by_owner(ir)?.get(&owner.canonical)?.as_array()?;
    if guards.is_empty() {
        return None;
    }
    let facts = context
        .original()
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    let source = transport_source(&facts.source, entry)?;
    let marker = serde_json::json!({"source":source,"owner":owner.canonical,"event":event,
        "node":{"start":facts.node.start,"end":facts.node.end},
        "rules":guards.iter().map(|guard|guard["rule"].clone()).collect::<Vec<_>>()});
    let mut marker = marker;
    let staged=guards.iter().filter(|guard|guard["evaluation"]=="source"
        &&guard["eventSource"].is_object()
        &&facts.decision_sites.as_deref().is_some_and(|sites|sites.iter().any(|site|
            site.stage==CheckedDecisionStage::SendDispatch&&guard["node"]["start"]==site.node.start&&guard["node"]["end"]==site.node.end
            &&site.calls.iter().all(|call|match &call.target{
                crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Builtin{id,..}=>context.catalog().and_then(|catalog|catalog.effects(id))==Some(crate::analysis::catalog::Effects::Pure),
                crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::DeriveFn(_)=>true,
                crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Role(_)=>false,
            }))))
        .map(|guard|guard["rule"].clone()).collect::<Vec<_>>();
    if !staged.is_empty() {
        marker["stagedRules"] = serde_json::Value::Array(staged);
    }
    if let Some(queries) = super::authority_query_sites::prepare_owner_with_context(context, owner)
        && !queries.sites.is_empty()
    {
        marker["queries"] = queries.plan;
    }
    Some(NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            retained_guarded_handler: Some(marker),
            source_loops: None,
            source_emissions: None,
            version: 1,
            source,
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
            observe_venue_decision: None,
            success_renewal_decision: None,
            purchase_receive_all: None,
            event_notice_audit: None,
            queries: Vec::new(),
            returns: Vec::new(),
        },
        dependencies: HashMap::new(),
        intrinsics: HashMap::new(),
        decisions: HashMap::new(),
        decision_keys: HashMap::new(),
        calls: HashMap::new(),
        returns: Vec::new(),
        current_revision: None,
    })
}

// Source-proof internals contain maps. Compare the emitted execution closure in
// stable declaration order; the prepared snapshot additionally seals every field.
fn execution_closure(ir: &IrProgram) -> String {
    format!(
        "{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
        ir.modules,
        ir.items,
        ir.read_rules,
        ir.callback_read_rules,
        ir.invariants,
        ir.locks,
        ir.retention,
        ir.crud_when,
        ir.preferences_valid,
        ir.catalog_version,
        ir.referenced_builtins,
        ir.suites,
        ir.migrations
    )
}

pub(super) fn source_preparation_gap(
    error: super::source_context::SourcePreparationGap,
) -> SendGuardGap {
    use super::source_context::SourcePreparationGap;
    match error {
        SourcePreparationGap::Cohort => gap("checked source cohort mismatch", None),
        SourcePreparationGap::Analysis => gap("original SEND source no longer checks", None),
        SourcePreparationGap::Ir => gap("original whole IR execution closure mismatch", None),
        SourcePreparationGap::MissingSource => gap("missing original source", None),
        SourcePreparationGap::Cst(span) => gap("original SEND CST is invalid", Some(span)),
        SourcePreparationGap::Resolution => gap("original SEND lexical resolution failed", None),
    }
}

/// One typed declared-event source row, with its revision carried as
/// authenticated event provenance. The authored Rule never reads revision;
/// its null occurrence in the descriptor records that absence explicitly.
#[allow(clippy::too_many_arguments)]
fn declared_model_event_source(
    original: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    resolved: &resolve::ResolveTables,
    owner: &IrItem,
    predicate: NodeKey,
    predicate_node: &SyntaxNode,
    send: &IrStmt,
) -> Result<Option<(Vec<PreparedSendInput>, serde_json::Value)>, SendGuardGap> {
    let Some(scenario) = original.effects.scenarios.get(&owner.id) else {
        return Ok(None);
    };
    let Some(HandlerSource::Event(event_id)) = scenario.on else {
        return Ok(None);
    };
    let Some(event) = resolved.symbols.get(event_id.0 as usize) else {
        return Ok(None);
    };
    let SymbolKind::Event { fields } = &event.kind else {
        return Ok(None);
    };
    if event.module != owner.module
        || scenario.module != owner.module
        || scenario.read
        || scenario.by.is_some()
        || scenario.result.is_some()
        || scenario.cohort.is_some()
        || !scenario.params.is_empty()
        || fields.len() != 2
        || scenario.guards.len() != 1
        || scenario.effects.len() != 1
    {
        return Ok(None);
    }
    let header = &scenario.guards[0];
    let source_send = &scenario.effects[0];
    if header.verb != EffectVerb::Require
        || source_send.verb != EffectVerb::Send
        || source_send.when != Some(predicate)
        || !header.then_effects.is_empty()
        || !header.else_effects.is_empty()
        || !header.match_arms.is_empty()
        || !source_send.then_effects.is_empty()
        || !source_send.else_effects.is_empty()
        || !source_send.match_arms.is_empty()
    {
        return Ok(None);
    }
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(ir_event)),
        hook: None,
        cohort: None,
        result: None,
        read: false,
        by,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return Ok(None);
    };
    let [IrStmt::Require { cond, span, .. }] = guards.as_slice() else {
        return Ok(None);
    };
    let [
        IrStmt::Send {
            operation: _,
            when: Some(ir_when),
            span: send_span,
            binding: Some(_binding),
            ..
        },
    ] = effects.as_slice()
    else {
        return Ok(None);
    };
    let IrStmt::Send { span: actual, .. } = send else {
        return Ok(None);
    };
    if ir_event != &event.canonical
        || !by.is_empty()
        || *send_span != *actual
        || *span != Span::new(header.node.file, header.node.start, header.node.end)
        || cond.span
            != Span::new(
                header.cond.unwrap().file,
                header.cond.unwrap().start,
                header.cond.unwrap().end,
            )
        || ir_when.span != Span::new(predicate.file, predicate.start, predicate.end)
    {
        return Ok(None);
    }
    let Some(model_field) = resolved.symbols.get(fields[0].0 as usize) else {
        return Ok(None);
    };
    let Some(revision_field) = resolved.symbols.get(fields[1].0 as usize) else {
        return Ok(None);
    };
    let (
        SymbolKind::Field {
            owner: model_owner,
            type_node: model_decl,
        },
        SymbolKind::Field {
            owner: revision_owner,
            type_node: revision_decl,
        },
    ) = (&model_field.kind, &revision_field.kind)
    else {
        return Ok(None);
    };
    let Some(ResolvedType::Record {
        symbol: invoice,
        stored: true,
    }) = original.types.symbol_types.get(&model_field.id)
    else {
        return Ok(None);
    };
    let invoice_ty = ResolvedType::Record {
        symbol: *invoice,
        stored: true,
    };
    if *model_owner != event_id
        || *revision_owner != event_id
        || original.types.symbol_types.get(&revision_field.id)
            != Some(&ResolvedType::Scalar(Scalar::Int))
        || original.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return Ok(None);
    }
    let source = db
        .get(predicate.file)
        .ok_or_else(|| gap("missing invoice SEND source", Some(ir_when.span)))?;
    let mut invoice_uses = Vec::new();
    for member in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::Member)
    {
        if source
            .text
            .get(member.span.start as usize..member.span.end as usize)
            .map(str::trim)
            == Some(format!("event.{}", model_field.name).as_str())
        {
            let key = NodeKey::of(member);
            if original.types.node_types.get(&key) != Some(&invoice_ty) {
                return Ok(None);
            }
            invoice_uses.push(key);
        }
    }
    if invoice_uses.is_empty() {
        return Ok(None);
    }
    let roots = predicate_node
        .descendants()
        .filter(|node| {
            node.kind == SyntaxKind::NameRef
                && source
                    .text
                    .get(node.span.start as usize..node.span.end as usize)
                    .map(str::trim)
                    == Some("event")
        })
        .map(NodeKey::of)
        .collect::<Vec<_>>();
    if roots.len() != invoice_uses.len()
        || roots.iter().any(|key| {
            !matches!(
                resolved.node_binding.get(key),
                Some(Binding::Context(resolve::ContextVar::Event))
            )
        })
    {
        return Ok(None);
    }
    let event_ty = ResolvedType::Record {
        symbol: event_id,
        stored: false,
    };
    let make_input = |name: &str,
                      field: &str,
                      ty: ResolvedType,
                      declaration: NodeKey,
                      use_site: NodeKey,
                      root: NodeKey,
                      ordinal| PreparedSendInput {
        name: name.into(),
        type_id: input_type(&ty, original, ir, None, 0).unwrap_or_default(),
        value: TypedExpr::new(
            IrExpr::Member {
                base: Box::new(TypedExpr::new(
                    IrExpr::Name("event".into()),
                    event_ty.clone(),
                    Span::new(root.file, root.start, root.end),
                )),
                field: field.into(),
            },
            ty,
            Span::new(use_site.file, use_site.start, use_site.end),
        ),
        declaration,
        symbol: None,
        owner: owner.id,
        ordinal,
        narrowing: None,
    };
    let model_input = make_input(
        "eventTerm",
        &model_field.name,
        invoice_ty,
        *model_decl,
        invoice_uses[0],
        roots[0],
        0,
    );
    // Revision has a checked event declaration but no source predicate use.
    // It is still transported so State can compare it to the actual due Work
    // payload without silently adding a version test to the authored Rule.
    let revision_input = make_input(
        "eventRevision",
        &revision_field.name,
        ResolvedType::Scalar(Scalar::Int),
        *revision_decl,
        *revision_decl,
        roots[0],
        1,
    );
    if model_input.type_id
        != resolved
            .symbols
            .get(invoice.0 as usize)
            .map(|item| item.canonical.as_str())
            .unwrap_or("")
        || revision_input.type_id != "int"
    {
        return Ok(None);
    }
    let site = |node: NodeKey| serde_json::json!({"start":node.start,"end":node.end});
    let mut stored_fields = std::collections::BTreeSet::new();
    for member in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::Member)
    {
        let Some(base) = member
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Member)
        else {
            continue;
        };
        if !invoice_uses.contains(&NodeKey::of(base)) {
            continue;
        }
        let Some(name) = member
            .children
            .iter()
            .rev()
            .find(|node| node.kind == SyntaxKind::Name)
            .and_then(|node| {
                source
                    .text
                    .get(node.span.start as usize..node.span.end as usize)
            })
        else {
            return Ok(None);
        };
        if original.effects.models.get(invoice).is_some_and(|model| {
            model.fields.iter().any(|field| {
                resolved
                    .symbols
                    .get(field.field.0 as usize)
                    .is_some_and(|decl| decl.name == name)
            })
        }) {
            stored_fields.insert(name.to_owned());
        }
    }
    let descriptor = serde_json::json!({
        "event":event.canonical,"handler":owner.canonical,
        "modelField":{"name":model_field.name,"model":model_input.type_id,
            "fields":stored_fields,"declaration":site(*model_decl),
            "occurrence":site(invoice_uses[0])},
        "revisionField":{"name":revision_field.name,"type":"int",
            "declaration":site(*revision_decl),"occurrence":null},
        "predicate":site(predicate),
    });
    Ok(Some((vec![model_input, revision_input], descriptor)))
}

/// The three authored booking notices retain the declared Booking and revision
/// as dispatch Rule inputs. The complete handler is admitted separately by
/// the rent notice receipt; this only seals the exact SEND predicate transport.
#[allow(clippy::too_many_arguments)]
fn rent_notice_event_source(
    original: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    resolved: &resolve::ResolveTables,
    owner: &IrItem,
    predicate: NodeKey,
    predicate_node: &SyntaxNode,
    send: &IrStmt,
) -> Result<Option<(Vec<PreparedSendInput>, serde_json::Value)>, SendGuardGap> {
    let (event_name, expected) = match owner.canonical.as_str() {
        "rent_reservations.correspondence" => (
            "rent_reservations.ReservationChanged",
            [
                "event.booking.status==confirmed and event.booking.version==event.revision",
                "event.booking.version==event.revision",
            ]
            .as_slice(),
        ),
        "rent_reservations.remind" => (
            "rent_reservations.Reminder",
            ["event.booking.status==confirmed and event.booking.version==event.revision"]
                .as_slice(),
        ),
        _ => return Ok(None),
    };
    let Some(scenario) = original.effects.scenarios.get(&owner.id) else {
        return Ok(None);
    };
    let Some(HandlerSource::Event(event_id)) = scenario.on else {
        return Ok(None);
    };
    let Some(event) = resolved.symbols.get(event_id.0 as usize) else {
        return Ok(None);
    };
    let SymbolKind::Event { fields } = &event.kind else {
        return Ok(None);
    };
    let slice = |node: NodeKey| {
        db.get(node.file)
            .and_then(|file| file.text.get(node.start as usize..node.end as usize))
            .map(str::trim)
    };
    let Some(text) = slice(predicate) else {
        return Ok(None);
    };
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(ir_event)),
        hook: None,
        cohort: None,
        result: None,
        read: false,
        by,
        params,
        ..
    } = &owner.kind
    else {
        return Ok(None);
    };
    let IrStmt::Send {
        operation,
        when: Some(ir_when),
        binding: Some(binding),
        span,
        ..
    } = send
    else {
        return Ok(None);
    };
    if event.canonical != event_name
        || event.module != owner.module
        || scenario.module != owner.module
        || scenario.read
        || scenario.by.is_some()
        || scenario.result.is_some()
        || scenario.cohort.is_some()
        || !scenario.params.is_empty()
        || fields.len() != 2
        || !expected.contains(&text)
        || ir_event != event_name
        || !by.is_empty()
        || !params.is_empty()
        || operation != "std.EmailV1.send"
        || binding != "delivery"
        || ir_when.span != Span::new(predicate.file, predicate.start, predicate.end)
        || original.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || !matches!(send,IrStmt::Send { span: actual, .. } if actual == span)
    {
        return Ok(None);
    }
    let mut source_sends = Vec::new();
    fn find_sends<'a>(effects: &'a [Effect], out: &mut Vec<&'a Effect>) {
        for effect in effects {
            if effect.verb == EffectVerb::Send {
                out.push(effect);
            }
            find_sends(&effect.then_effects, out);
            find_sends(&effect.else_effects, out);
        }
    }
    find_sends(&scenario.effects, &mut source_sends);
    let mut selected = source_sends
        .into_iter()
        .filter(|effect| effect.when == Some(predicate));
    let Some(source_send) = selected.next() else {
        return Ok(None);
    };
    if selected.next().is_some()
        || source_send.target_node.and_then(slice) != Some("Mail.send")
        || source_send.binding.as_deref() != Some("delivery")
        || Span::new(
            source_send.node.file,
            source_send.node.start,
            source_send.node.end,
        ) != *span
        || source_send
            .args
            .iter()
            .map(|arg| arg.key.as_str())
            .collect::<Vec<_>>()
            != ["to", "subject", "body"]
    {
        return Ok(None);
    }
    let Some(model_field) = resolved.symbols.get(fields[0].0 as usize) else {
        return Ok(None);
    };
    let Some(revision_field) = resolved.symbols.get(fields[1].0 as usize) else {
        return Ok(None);
    };
    let (
        SymbolKind::Field {
            owner: model_owner,
            type_node: model_decl,
        },
        SymbolKind::Field {
            owner: revision_owner,
            type_node: revision_decl,
        },
    ) = (&model_field.kind, &revision_field.kind)
    else {
        return Ok(None);
    };
    let Some(ResolvedType::Record {
        symbol: booking,
        stored: true,
    }) = original.types.symbol_types.get(&model_field.id)
    else {
        return Ok(None);
    };
    let booking_ty = ResolvedType::Record {
        symbol: *booking,
        stored: true,
    };
    if *model_owner != event_id
        || *revision_owner != event_id
        || model_field.name != "booking"
        || revision_field.name != "revision"
        || resolved
            .symbols
            .get(booking.0 as usize)
            .map(|item| item.canonical.as_str())
            != Some("rent_reservations.Booking")
        || original.types.symbol_types.get(&revision_field.id)
            != Some(&ResolvedType::Scalar(Scalar::Int))
    {
        return Ok(None);
    }
    let Some(file) = db.get(predicate.file) else {
        return Ok(None);
    };
    let mut booking_uses = Vec::new();
    let mut revision_uses = Vec::new();
    for member in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::Member)
    {
        let key = NodeKey::of(member);
        let text = file
            .text
            .get(member.span.start as usize..member.span.end as usize)
            .map(str::trim);
        if text == Some("event.booking") && original.types.node_types.get(&key) == Some(&booking_ty)
        {
            booking_uses.push((key, member));
        } else if text == Some("event.revision")
            && original.types.node_types.get(&key) == Some(&ResolvedType::Scalar(Scalar::Int))
        {
            revision_uses.push((key, member));
        }
    }
    let required_bookings = if text.starts_with("event.booking.status") {
        2
    } else {
        1
    };
    if booking_uses.len() != required_bookings || revision_uses.len() != 1 {
        return Ok(None);
    }
    let root = |node: &SyntaxNode| {
        node.descendants()
            .find(|child| {
                child.kind == SyntaxKind::NameRef
                    && file
                        .text
                        .get(child.span.start as usize..child.span.end as usize)
                        == Some("event")
                    && matches!(
                        resolved.node_binding.get(&NodeKey::of(child)),
                        Some(Binding::Context(resolve::ContextVar::Event))
                    )
            })
            .map(NodeKey::of)
    };
    let Some(booking_root) = root(booking_uses[0].1) else {
        return Ok(None);
    };
    let Some(revision_root) = root(revision_uses[0].1) else {
        return Ok(None);
    };
    let event_ty = ResolvedType::Record {
        symbol: event_id,
        stored: false,
    };
    let make_input = |name: &str,
                      field: &str,
                      ty: ResolvedType,
                      declaration: NodeKey,
                      use_site: NodeKey,
                      root: NodeKey,
                      ordinal| PreparedSendInput {
        name: name.into(),
        type_id: input_type(&ty, original, ir, None, 0).unwrap_or_default(),
        value: TypedExpr::new(
            IrExpr::Member {
                base: Box::new(TypedExpr::new(
                    IrExpr::Name("event".into()),
                    event_ty.clone(),
                    Span::new(root.file, root.start, root.end),
                )),
                field: field.into(),
            },
            ty,
            Span::new(use_site.file, use_site.start, use_site.end),
        ),
        declaration,
        symbol: None,
        owner: owner.id,
        ordinal,
        narrowing: None,
    };
    let booking_input = make_input(
        "eventTerm",
        "booking",
        booking_ty,
        *model_decl,
        booking_uses[0].0,
        booking_root,
        0,
    );
    let revision_input = make_input(
        "eventRevision",
        "revision",
        ResolvedType::Scalar(Scalar::Int),
        *revision_decl,
        revision_uses[0].0,
        revision_root,
        1,
    );
    if booking_input.type_id != "rent_reservations.Booking" || revision_input.type_id != "int" {
        return Ok(None);
    }
    let site = |node: NodeKey| serde_json::json!({"start":node.start,"end":node.end});
    let descriptor = serde_json::json!({
        "event":event_name,"handler":owner.canonical,
        "modelField":{"name":"booking","model":"rent_reservations.Booking",
            "fields":if required_bookings == 2 {vec!["status","version"]} else {vec!["version"]},
            "declaration":site(*model_decl),"occurrence":site(booking_uses[0].0)},
        "revisionField":{"name":"revision","type":"int",
            "declaration":site(*revision_decl),"occurrence":site(revision_uses[0].0)},
        "predicate":site(predicate),
    });
    Ok(Some((vec![booking_input, revision_input], descriptor)))
}

/// Only checked agreement and appointment delivery handlers may transport a
/// declared event into a SEND Rule. State authenticates their Work event row.
#[allow(clippy::too_many_arguments)]
fn attendee_notice_event_source(
    original: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    resolved: &resolve::ResolveTables,
    owner: &IrItem,
    predicate: NodeKey,
    predicate_node: &SyntaxNode,
    send: &IrStmt,
) -> Result<Option<(Vec<PreparedSendInput>, serde_json::Value)>, SendGuardGap> {
    if owner.canonical != "events.attendee_notice" {
        return Ok(None);
    }
    let event_name = "events.AttendeeNotice";
    let expected = [
        "event.registration.parent.revision==event.revision and (event.kind!=confirmation or (event.registration.state==confirmed and not event.registration.parent.cancelled))",
    ];
    let Some(scenario) = original.effects.scenarios.get(&owner.id) else {
        return Ok(None);
    };
    let Some(HandlerSource::Event(event_id)) = scenario.on else {
        return Ok(None);
    };
    let Some(event) = resolved.symbols.get(event_id.0 as usize) else {
        return Ok(None);
    };
    let SymbolKind::Event { fields } = &event.kind else {
        return Ok(None);
    };
    let slice = |node: NodeKey| {
        db.get(node.file)
            .and_then(|file| file.text.get(node.start as usize..node.end as usize))
            .map(str::trim)
    };
    let Some(text) = slice(predicate) else {
        return Ok(None);
    };
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(ir_event)),
        hook: None,
        cohort: None,
        result: None,
        read: false,
        by,
        params,
        ..
    } = &owner.kind
    else {
        return Ok(None);
    };
    let IrStmt::Send {
        operation,
        when: Some(ir_when),
        binding: Some(binding),
        span,
        ..
    } = send
    else {
        return Ok(None);
    };
    if event.canonical != event_name
        || event.module != owner.module
        || scenario.module != owner.module
        || scenario.read
        || scenario.by.is_some()
        || scenario.result.is_some()
        || scenario.cohort.is_some()
        || !scenario.params.is_empty()
        || fields.len() != 4
        || !expected.contains(&text)
        || ir_event != event_name
        || !by.is_empty()
        || !params.is_empty()
        || operation != "std.EmailV1.send"
        || binding != "delivery"
        || ir_when.span != Span::new(predicate.file, predicate.start, predicate.end)
        || original.types.node_types.get(&predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || !matches!(send,IrStmt::Send { span: actual, .. } if actual == span)
    {
        return Ok(None);
    }
    let mut source_sends = Vec::new();
    fn find_sends<'a>(effects: &'a [Effect], out: &mut Vec<&'a Effect>) {
        for effect in effects {
            if effect.verb == EffectVerb::Send {
                out.push(effect);
            }
            find_sends(&effect.then_effects, out);
            find_sends(&effect.else_effects, out);
        }
    }
    find_sends(&scenario.effects, &mut source_sends);
    let mut selected = source_sends
        .into_iter()
        .filter(|effect| effect.when == Some(predicate));
    let Some(source_send) = selected.next() else {
        return Ok(None);
    };
    if selected.next().is_some()
        || source_send.target_node.and_then(slice) != Some("Mail.send")
        || source_send.binding.as_deref() != Some("delivery")
        || Span::new(
            source_send.node.file,
            source_send.node.start,
            source_send.node.end,
        ) != *span
        || source_send
            .args
            .iter()
            .map(|arg| arg.key.as_str())
            .collect::<Vec<_>>()
            != ["to", "subject", "body"]
    {
        return Ok(None);
    }
    let Some(model_field) = resolved.symbols.get(fields[0].0 as usize) else {
        return Ok(None);
    };
    let Some(revision_field) = resolved.symbols.get(fields[2].0 as usize) else {
        return Ok(None);
    };
    let (
        SymbolKind::Field {
            owner: model_owner,
            type_node: model_decl,
        },
        SymbolKind::Field {
            owner: revision_owner,
            type_node: revision_decl,
        },
    ) = (&model_field.kind, &revision_field.kind)
    else {
        return Ok(None);
    };
    let Some(ResolvedType::Record {
        symbol: booking,
        stored: true,
    }) = original.types.symbol_types.get(&model_field.id)
    else {
        return Ok(None);
    };
    let booking_ty = ResolvedType::Record {
        symbol: *booking,
        stored: true,
    };
    if *model_owner != event_id
        || *revision_owner != event_id
        || model_field.name != "registration"
        || revision_field.name != "revision"
        || resolved
            .symbols
            .get(booking.0 as usize)
            .map(|item| item.canonical.as_str())
            != Some("events.Registration")
        || original.types.symbol_types.get(&revision_field.id)
            != Some(&ResolvedType::Scalar(Scalar::Int))
    {
        return Ok(None);
    }
    let Some(file) = db.get(predicate.file) else {
        return Ok(None);
    };
    let mut booking_uses = Vec::new();
    let mut revision_uses = Vec::new();
    for member in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::Member)
    {
        let key = NodeKey::of(member);
        let text = file
            .text
            .get(member.span.start as usize..member.span.end as usize)
            .map(str::trim);
        if text == Some("event.registration")
            && original.types.node_types.get(&key) == Some(&booking_ty)
        {
            booking_uses.push((key, member));
        } else if text == Some("event.revision")
            && original.types.node_types.get(&key) == Some(&ResolvedType::Scalar(Scalar::Int))
        {
            revision_uses.push((key, member));
        }
    }
    let required_bookings = 3;
    if booking_uses.len() != required_bookings || revision_uses.len() != 1 {
        return Ok(None);
    }
    let root = |node: &SyntaxNode| {
        node.descendants()
            .find(|child| {
                child.kind == SyntaxKind::NameRef
                    && file
                        .text
                        .get(child.span.start as usize..child.span.end as usize)
                        == Some("event")
                    && matches!(
                        resolved.node_binding.get(&NodeKey::of(child)),
                        Some(Binding::Context(resolve::ContextVar::Event))
                    )
            })
            .map(NodeKey::of)
    };
    let Some(booking_root) = root(booking_uses[0].1) else {
        return Ok(None);
    };
    let Some(revision_root) = root(revision_uses[0].1) else {
        return Ok(None);
    };
    let event_ty = ResolvedType::Record {
        symbol: event_id,
        stored: false,
    };
    let make_input = |name: &str,
                      field: &str,
                      ty: ResolvedType,
                      declaration: NodeKey,
                      use_site: NodeKey,
                      root: NodeKey,
                      ordinal| PreparedSendInput {
        name: name.into(),
        type_id: input_type(&ty, original, ir, None, 0).unwrap_or_default(),
        value: TypedExpr::new(
            IrExpr::Member {
                base: Box::new(TypedExpr::new(
                    IrExpr::Name("event".into()),
                    event_ty.clone(),
                    Span::new(root.file, root.start, root.end),
                )),
                field: field.into(),
            },
            ty,
            Span::new(use_site.file, use_site.start, use_site.end),
        ),
        declaration,
        symbol: None,
        owner: owner.id,
        ordinal,
        narrowing: None,
    };
    let booking_input = make_input(
        "eventTerm",
        "registration",
        booking_ty,
        *model_decl,
        booking_uses[0].0,
        booking_root,
        0,
    );
    let revision_input = make_input(
        "eventRevision",
        "revision",
        ResolvedType::Scalar(Scalar::Int),
        *revision_decl,
        revision_uses[0].0,
        revision_root,
        1,
    );
    if booking_input.type_id != "events.Registration" || revision_input.type_id != "int" {
        return Ok(None);
    }
    let site = |node: NodeKey| serde_json::json!({"start":node.start,"end":node.end});
    let Some(kind_field) = resolved.symbols.get(fields[1].0 as usize) else {
        return Ok(None);
    };
    let SymbolKind::Field {
        owner: kind_owner,
        type_node: kind_decl,
    } = &kind_field.kind
    else {
        return Ok(None);
    };
    let Some(kind_ty @ ResolvedType::Enum { cases, .. }) =
        original.types.symbol_types.get(&kind_field.id)
    else {
        return Ok(None);
    };
    if *kind_owner != event_id
        || kind_field.name != "kind"
        || cases != &["confirmation", "change", "cancellation"]
    {
        return Ok(None);
    }
    let mut kind_uses = predicate_node.descendants().filter(|node| {
        node.kind == SyntaxKind::Member
            && file
                .text
                .get(node.span.start as usize..node.span.end as usize)
                .map(str::trim)
                == Some("event.kind")
    });
    let Some(kind_use) = kind_uses.next() else {
        return Ok(None);
    };
    if kind_uses.next().is_some()
        || original.types.node_types.get(&NodeKey::of(kind_use)) != Some(kind_ty)
    {
        return Ok(None);
    }
    let Some(kind_root) = root(kind_use) else {
        return Ok(None);
    };
    let mut kind_input = make_input(
        "eventKind",
        "kind",
        kind_ty.clone(),
        *kind_decl,
        NodeKey::of(kind_use),
        kind_root,
        2,
    );
    if kind_input.type_id != "events.Notice.kind" {
        return Ok(None);
    }
    kind_input.type_id = "enum(confirmation,change,cancellation)".into();
    let descriptor = serde_json::json!({
        "event":event_name,"handler":owner.canonical,
        "modelField":{"name":"registration","model":"events.Registration",
            "fields":["state"],
            "declaration":site(*model_decl),"occurrence":site(booking_uses[0].0)},
        "revisionField":{"name":"revision","type":"int",
            "declaration":site(*revision_decl),"occurrence":site(revision_uses[0].0)},
        "scalarFields":[{"name":"kind","slot":"eventKind","type":"events.Notice.kind",
            "declaration":site(*kind_decl),"occurrence":site(NodeKey::of(kind_use))}],
        "predicate":site(predicate),
    });
    Ok(Some((
        vec![booking_input, revision_input, kind_input],
        descriptor,
    )))
}

/// Only checked agreement and appointment delivery handlers may transport a
/// declared event into a SEND Rule. State authenticates their Work event row.
#[allow(clippy::too_many_arguments)]
fn private_delivery_event_source(
    original: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    resolved: &resolve::ResolveTables,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    owner: &IrItem,
    predicate: NodeKey,
    predicate_node: &SyntaxNode,
    send: &IrStmt,
) -> Result<Option<(Vec<PreparedSendInput>, serde_json::Value)>, SendGuardGap> {
    if owner.canonical == "events.attendee_notice" {
        return attendee_notice_event_source(
            original,
            ir,
            db,
            resolved,
            owner,
            predicate,
            predicate_node,
            send,
        );
    }
    if owner.canonical == "rent_reservations.correspondence"
        || owner.canonical == "rent_reservations.remind"
    {
        return rent_notice_event_source(
            original,
            ir,
            db,
            resolved,
            owner,
            predicate,
            predicate_node,
            send,
        );
    }
    if let Some(source) = declared_model_event_source(
        original,
        ir,
        db,
        resolved,
        owner,
        predicate,
        predicate_node,
        send,
    )? {
        return Ok(Some(source));
    }
    let Some(scenario) = original.effects.scenarios.get(&owner.id) else {
        return Ok(None);
    };
    let Some(HandlerSource::Event(event_id)) = scenario.on.as_ref() else {
        return Ok(None);
    };
    let Some(event) = resolved.symbols.get(event_id.0 as usize) else {
        return Ok(None);
    };
    let SymbolKind::Event { fields } = &event.kind else {
        return Ok(None);
    };
    let (model_field_name, model_name, created_name, reminder) =
        match (owner.canonical.as_str(), event.canonical.as_str()) {
            ("agreements.notice", "agreements.Notice") => (
                "term",
                "agreements.Term",
                "agreements.NoticeDelivery",
                false,
            ),
            ("agreements.due", "agreements.ObligationDue") => (
                "obligation",
                "agreements.Obligation",
                "agreements.NoticeDelivery",
                false,
            ),
            ("appointments.remind", "appointments.Reminder") => (
                "appointment",
                "appointments.Appointment",
                "appointments.Notice",
                true,
            ),
            _ => return Ok(None),
        };
    if event.module != owner.module
        || scenario.module != owner.module
        || scenario.read
        || scenario.by.is_some()
        || scenario.result.is_some()
        || scenario.cohort.is_some()
        || !scenario.params.is_empty()
        || fields.len() != 2
    {
        return Ok(None);
    }
    let (source_send, source_create, branch) = if reminder {
        let [source_send, source_create] = scenario.effects.as_slice() else {
            return Ok(None);
        };
        let [source_guard] = scenario.guards.as_slice() else {
            return Ok(None);
        };
        if source_guard.verb != EffectVerb::Require
            || source_guard.cond.is_none()
            || !source_guard.then_effects.is_empty()
            || !source_guard.else_effects.is_empty()
            || !source_guard.match_arms.is_empty()
        {
            return Ok(None);
        }
        (source_send, source_create, None)
    } else {
        let [branch] = scenario.effects.as_slice() else {
            return Ok(None);
        };
        let [source_send, source_create] = branch.then_effects.as_slice() else {
            return Ok(None);
        };
        if !scenario.guards.is_empty()
            || branch.verb != EffectVerb::If
            || branch.cond.is_none()
            || !branch.else_effects.is_empty()
            || !branch.match_arms.is_empty()
        {
            return Ok(None);
        }
        (source_send, source_create, Some(branch))
    };
    if source_send.verb != EffectVerb::Send
        || source_send.when != Some(predicate)
        || source_create.verb != EffectVerb::Create
        || !source_send.then_effects.is_empty()
        || !source_send.else_effects.is_empty()
        || !source_create.then_effects.is_empty()
        || !source_create.else_effects.is_empty()
    {
        return Ok(None);
    }
    let Some(EffectTarget::Model(created)) = source_create.target.as_ref() else {
        return Ok(None);
    };
    if resolved
        .symbols
        .get(created.0 as usize)
        .map(|symbol| symbol.canonical.as_str())
        != Some(created_name)
    {
        return Ok(None);
    }
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(ir_event)),
        hook: None,
        cohort: None,
        result: None,
        read: false,
        by,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return Ok(None);
    };
    let (ir_send, ir_create) = if reminder {
        let [IrStmt::Require { cond, span, .. }] = guards.as_slice() else {
            return Ok(None);
        };
        let [source_guard] = scenario.guards.as_slice() else {
            return Ok(None);
        };
        let Some(header_cond) = source_guard.cond else {
            return Ok(None);
        };
        if *span
            != Span::new(
                source_guard.node.file,
                source_guard.node.start,
                source_guard.node.end,
            )
            || cond.span != Span::new(header_cond.file, header_cond.start, header_cond.end)
        {
            return Ok(None);
        }
        let [ir_send, ir_create] = effects.as_slice() else {
            return Ok(None);
        };
        (ir_send, ir_create)
    } else {
        let [
            IrStmt::If {
                cond,
                then_branch,
                else_branch,
                span: branch_span,
            },
        ] = effects.as_slice()
        else {
            return Ok(None);
        };
        let Some(branch) = branch else {
            return Ok(None);
        };
        let Some(branch_cond) = branch.cond else {
            return Ok(None);
        };
        if !else_branch.is_empty()
            || *branch_span != Span::new(branch.node.file, branch.node.start, branch.node.end)
            || cond.span != Span::new(branch_cond.file, branch_cond.start, branch_cond.end)
        {
            return Ok(None);
        }
        let [ir_send, ir_create] = then_branch.as_slice() else {
            return Ok(None);
        };
        (ir_send, ir_create)
    };
    let IrStmt::Send {
        operation,
        when: Some(ir_when),
        span: send_span,
        ..
    } = ir_send
    else {
        return Ok(None);
    };
    let IrStmt::Create { model, .. } = ir_create else {
        return Ok(None);
    };
    let IrStmt::Send { span, .. } = send else {
        return Ok(None);
    };
    if ir_event != &event.canonical
        || !by.is_empty()
        || (!reminder && !guards.is_empty())
        || operation != "std.EmailV1.send"
        || model != created_name
        || *send_span != *span
        || ir_when.span != Span::new(predicate.file, predicate.start, predicate.end)
        || nodes.get(&predicate).is_none()
    {
        return Ok(None);
    }

    let mut term = None;
    let mut revision = None;
    for field in fields {
        let Some(symbol) = resolved.symbols.get(field.0 as usize) else {
            return Ok(None);
        };
        let SymbolKind::Field {
            owner: declared_event,
            type_node,
        } = symbol.kind
        else {
            return Ok(None);
        };
        if declared_event != *event_id || symbol.module != event.module {
            return Ok(None);
        }
        match symbol.name.as_str() {
            name if name == model_field_name => term = Some((symbol, type_node)),
            "revision" => revision = Some((symbol, type_node)),
            _ => return Ok(None),
        }
    }
    let (Some((term, term_declaration)), Some((revision, revision_declaration))) = (term, revision)
    else {
        return Ok(None);
    };
    let Some(ResolvedType::Record {
        symbol: term_model,
        stored: true,
    }) = original.types.symbol_types.get(&term.id)
    else {
        return Ok(None);
    };
    let term_ty = ResolvedType::Record {
        symbol: *term_model,
        stored: true,
    };
    if resolved
        .symbols
        .get(term_model.0 as usize)
        .map(|symbol| symbol.canonical.as_str())
        != Some(model_name)
        || original.types.symbol_types.get(&revision.id) != Some(&ResolvedType::Scalar(Scalar::Int))
    {
        return Ok(None);
    }

    // Every original `event` occurrence must be the direct receiver of one
    // checked declared field; aliases and other payload fields stay refused.
    let event_roots: HashSet<_> = predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::NameRef)
        .filter(|node| {
            matches!(
                resolved.node_binding.get(&NodeKey::of(node)),
                Some(Binding::Context(resolve::ContextVar::Event))
            )
        })
        .map(NodeKey::of)
        .collect();
    let mut matched_roots = HashSet::new();
    let mut term_use = None;
    let mut revision_use = None;
    for member in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::Member)
    {
        let Some(base) = member
            .children
            .iter()
            .find(|child| resolve::is_expression(child.kind))
        else {
            continue;
        };
        let root = NodeKey::of(base);
        if !event_roots.contains(&root) {
            continue;
        }
        let Some(name) = member
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)
            .and_then(|child| {
                db.get(child.span.file)
                    .and_then(|source| name_text(child, &source.text))
            })
        else {
            return Ok(None);
        };
        let key = NodeKey::of(member);
        match name {
            name if name == model_field_name
                && original.types.node_types.get(&key) == Some(&term_ty) =>
            {
                term_use.get_or_insert((key, root));
            }
            "revision"
                if original.types.node_types.get(&key)
                    == Some(&ResolvedType::Scalar(Scalar::Int)) =>
            {
                revision_use.get_or_insert((key, root));
            }
            _ => return Ok(None),
        }
        matched_roots.insert(root);
    }
    if event_roots.is_empty() || event_roots != matched_roots {
        return Ok(None);
    }
    let (Some((term_use, term_root)), Some((revision_use, revision_root))) =
        (term_use, revision_use)
    else {
        return Ok(None);
    };
    let Some(SymbolKind::Model {
        fields: stored_fields,
        ..
    }) = resolved
        .symbols
        .get(term_model.0 as usize)
        .map(|symbol| &symbol.kind)
    else {
        return Ok(None);
    };
    let mut direct_fields = HashSet::<String>::new();
    for member in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::Member)
    {
        let Some(base) = member
            .children
            .iter()
            .find(|child| resolve::is_expression(child.kind))
        else {
            continue;
        };
        if base.kind != SyntaxKind::Member {
            continue;
        }
        let Some(root) = base
            .children
            .iter()
            .find(|child| resolve::is_expression(child.kind))
        else {
            continue;
        };
        if !event_roots.contains(&NodeKey::of(root)) {
            continue;
        }
        let Some(base_field) = base
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)
            .and_then(|child| {
                db.get(child.span.file)
                    .and_then(|source| name_text(child, &source.text))
            })
        else {
            return Ok(None);
        };
        if base_field != model_field_name
            || original.types.node_types.get(&NodeKey::of(base)) != Some(&term_ty)
        {
            return Ok(None);
        }
        let Some(field) = member
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)
            .and_then(|child| {
                db.get(child.span.file)
                    .and_then(|source| name_text(child, &source.text))
            })
        else {
            return Ok(None);
        };
        if field == "version" || field == "parent" {
            continue;
        }
        if !stored_fields.iter().any(|id| resolved.symbols.get(id.0 as usize).is_some_and(|symbol|
            symbol.name == field && matches!(symbol.kind, SymbolKind::Field { owner: declared, .. } if declared == *term_model)))
            || !original.types.node_types.contains_key(&NodeKey::of(member))
        { return Ok(None); }
        direct_fields.insert(field.to_string());
    }
    let mut recipient_path = None;
    if reminder {
        let IrStmt::Send { args, .. } = ir_send else {
            return Ok(None);
        };
        let IrStmt::Create { input, .. } = ir_create else {
            return Ok(None);
        };
        let IrExpr::Object(send_entries) = &args.expr else {
            return Ok(None);
        };
        let IrExpr::Object(create_entries) = &input.expr else {
            return Ok(None);
        };
        let [(_, recipient), _, (_, body)] = send_entries.as_slice() else {
            return Ok(None);
        };
        if send_entries[0].0 != "to"
            || send_entries[1].0 != "subject"
            || send_entries[2].0 != "body"
        {
            return Ok(None);
        }
        let IrExpr::Member {
            base: contact,
            field: email_field,
        } = &recipient.expr
        else {
            return Ok(None);
        };
        let IrExpr::Member {
            base: appointment,
            field: contact_field,
        } = &contact.expr
        else {
            return Ok(None);
        };
        let IrExpr::Member {
            base: event_root,
            field: appointment_field,
        } = &appointment.expr
        else {
            return Ok(None);
        };
        if email_field != "email"
            || contact_field != "contact"
            || appointment_field != "appointment"
            || !matches!(&event_root.expr, IrExpr::Name(name) if name == "event")
            || appointment.ty != term_ty
            || db.get(recipient.span.file).and_then(|source| {
                source
                    .text
                    .get(recipient.span.start as usize..recipient.span.end as usize)
            }) != Some("event.appointment.contact.email")
            || db.get(body.span.file).and_then(|source| {
                source
                    .text
                    .get(body.span.start as usize..body.span.end as usize)
            }) != Some("event.appointment.parent.parent.instructions")
        {
            return Ok(None);
        }
        let ResolvedType::Record {
            symbol: contact_model,
            stored: true,
        } = contact.ty
        else {
            return Ok(None);
        };
        if resolved
            .symbols
            .get(contact_model.0 as usize)
            .map(|symbol| symbol.canonical.as_str())
            != Some("customer.Contact")
        {
            return Ok(None);
        }
        let contact_decl = stored_fields
            .iter()
            .filter_map(|id| resolved.symbols.get(id.0 as usize))
            .find(|field| {
                field.name == "contact"
                    && matches!(field.kind,
                SymbolKind::Field {owner: declared, ..} if declared == *term_model)
            });
        let Some(contact_decl) = contact_decl else {
            return Ok(None);
        };
        if original.types.symbol_types.get(&contact_decl.id) != Some(&contact.ty) {
            return Ok(None);
        }
        let Some(SymbolKind::Model {
            fields: contact_fields,
            ..
        }) = resolved
            .symbols
            .get(contact_model.0 as usize)
            .map(|symbol| &symbol.kind)
        else {
            return Ok(None);
        };
        let email_decl = contact_fields
            .iter()
            .filter_map(|id| resolved.symbols.get(id.0 as usize))
            .find(|field| {
                field.name == "email"
                    && matches!(field.kind,
                SymbolKind::Field {owner: declared, ..} if declared == contact_model)
            });
        let Some(email_decl) = email_decl else {
            return Ok(None);
        };
        if original.types.symbol_types.get(&email_decl.id) != Some(&recipient.ty) {
            return Ok(None);
        }
        let source_entry = create_entries.iter().find(|entry| entry.0 == "source");
        let Some((_, active_source)) = source_entry else {
            return Ok(None);
        };
        let IrExpr::Member {
            base: source_appointment,
            field: active_name,
        } = &active_source.expr
        else {
            return Ok(None);
        };
        if active_name != "active_source"
            || source_appointment.ty != term_ty
            || !matches!(&source_appointment.expr, IrExpr::Member {base, field}
                if field == "appointment" && matches!(&base.expr, IrExpr::Name(name) if name == "event"))
            || db.get(active_source.span.file).and_then(|source| {
                source
                    .text
                    .get(active_source.span.start as usize..active_source.span.end as usize)
            }) != Some("event.appointment.active_source")
            || !stored_fields.iter().any(|id| {
                resolved.symbols.get(id.0 as usize).is_some_and(|field| {
                    field.name == "active_source"
                        && matches!(field.kind,
                    SymbolKind::Field {owner: declared, ..} if declared == *term_model)
                        && original.types.symbol_types.get(id) == Some(&active_source.ty)
                })
            })
        {
            return Ok(None);
        }
        direct_fields.insert("contact".into());
        direct_fields.insert("active_source".into());
        let Some(ScenarioDisclosure::Complete(disclosure)) =
            original.scenario_disclosures().get(&owner.id)
        else {
            return Ok(None);
        };
        let mut dependency_pair = None;
        for returned in &disclosure.returns {
            let at = |span: Span, model: &str, field: &str| {
                let mut reads = returned.dependencies.iter().filter(|read| {
                    read.node.file == span.file
                        && read.node.start == span.start
                        && read.node.end == span.end
                        && read.role == DependencyRole::Data
                        && read.calls.is_empty()
                        && read.query_id.is_none()
                        && read.model_name == model
                        && read.field_name == field
                });
                let read = reads.next()?;
                reads.next().is_none().then_some(read)
            };
            let Some(source_read) = at(contact.span, model_name, "contact") else {
                return Ok(None);
            };
            let Some(leaf_read) = at(recipient.span, "customer.Contact", "email") else {
                return Ok(None);
            };
            let Some(source_index) = returned
                .dependencies
                .iter()
                .position(|read| read == source_read)
            else {
                return Ok(None);
            };
            let Some(leaf_index) = returned
                .dependencies
                .iter()
                .position(|read| read == leaf_read)
            else {
                return Ok(None);
            };
            if source_index >= leaf_index {
                return Ok(None);
            }
            let pair = (source_read.id.clone(), leaf_read.id.clone());
            if dependency_pair.as_ref().is_some_and(|prior| prior != &pair) {
                return Ok(None);
            }
            dependency_pair = Some(pair);
        }
        let Some((source_dependency_id, leaf_dependency_id)) = dependency_pair else {
            return Ok(None);
        };
        recipient_path = Some(serde_json::json!({
            "sourceDependencyId":source_dependency_id,"leafDependencyId":leaf_dependency_id,
            "sourceField":{"name":"contact","model":model_name,
                "node":{"start":contact.span.start,"end":contact.span.end}},
            "leafField":{"name":"email","model":"customer.Contact",
                "node":{"start":recipient.span.start,"end":recipient.span.end}},
        }));
    }
    let mut direct_fields = direct_fields.into_iter().collect::<Vec<_>>();
    direct_fields.sort();
    let event_ty = ResolvedType::Record {
        symbol: *event_id,
        stored: false,
    };
    let make_input = |name: &str,
                      field: &str,
                      ty: ResolvedType,
                      declaration: NodeKey,
                      use_site: NodeKey,
                      root: NodeKey,
                      ordinal| {
        PreparedSendInput {
            name: name.to_string(),
            type_id: input_type(&ty, original, ir, None, 0).unwrap_or_default(),
            value: TypedExpr::new(
                IrExpr::Member {
                    base: Box::new(TypedExpr::new(
                        IrExpr::Name("event".to_string()),
                        event_ty.clone(),
                        Span::new(root.file, root.start, root.end),
                    )),
                    field: field.to_string(),
                },
                ty,
                Span::new(use_site.file, use_site.start, use_site.end),
            ),
            declaration,
            symbol: None,
            owner: owner.id,
            ordinal,
            narrowing: None,
        }
    };
    let model_input = make_input(
        "eventTerm",
        model_field_name,
        term_ty,
        term_declaration,
        term_use,
        term_root,
        0,
    );
    let revision_input = make_input(
        "eventRevision",
        "revision",
        ResolvedType::Scalar(Scalar::Int),
        revision_declaration,
        revision_use,
        revision_root,
        1,
    );
    if model_input.type_id.is_empty() || revision_input.type_id != "int" {
        return Ok(None);
    }
    let site = |node: NodeKey| serde_json::json!({"start":node.start,"end":node.end});
    let mut descriptor = serde_json::json!({
        "event": event.canonical, "handler": owner.canonical,
        "modelField": {"name":model_field_name, "model":model_name,
            "fields":direct_fields,
            "declaration":site(term_declaration), "occurrence":site(term_use)},
        "revisionField": {"name":"revision", "type":"int",
            "declaration":site(revision_declaration), "occurrence":site(revision_use)},
        "predicate":site(predicate),
    });
    if let Some(path) = recipient_path {
        descriptor["recipientPath"] = path;
    }
    Ok(Some((vec![model_input, revision_input], descriptor)))
}

fn prepare_send_guard(
    original: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    resolved: &resolve::ResolveTables,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    owner: &IrItem,
    source_facts: &[CheckedDecisionSite],
    send: &IrStmt,
    site: &super::scenario_decisions::SerialDecisionSite,
) -> Result<(Span, PreparedSendGuard), SendGuardGap> {
    let IrStmt::Send {
        operation,
        when: Some(predicate),
        when_at_source,
        deployment_binding,
        binding,
        span,
        ..
    } = send
    else {
        unreachable!()
    };
    if predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        || site.owner != owner.canonical
        || site.statement.start != span.start
        || site.statement.end != span.end
    {
        return Err(gap(
            "original SEND owner/Boolean site mismatch",
            Some(*span),
        ));
    }
    let fact = source_facts
        .iter()
        .find(|fact| {
            fact.stage == crate::analysis::scenario_disclosure::CheckedDecisionStage::SendDispatch
                && fact.statement.file == span.file
                && fact.statement.start == span.start
                && fact.statement.end == span.end
                && fact.node.start == site.node.start
                && fact.node.end == site.node.end
        })
        .ok_or_else(|| gap("original SEND predicate node mismatch", Some(*span)))?;
    let source = db
        .get(span.file)
        .ok_or_else(|| gap("missing SEND source", Some(*span)))?;
    if site.source.path != source.path
        || site.source.sha256 != source.sha256
        || original
            .modules
            .get(owner.module.0 as usize)
            .is_none_or(|module| module.name != site.source.module)
    {
        return Err(gap("original SEND source identity mismatch", Some(*span)));
    }
    let node = nodes
        .get(&fact.node)
        .ok_or_else(|| gap("missing original SEND predicate CST", Some(*span)))?;
    let event_source = private_delivery_event_source(
        original, ir, db, resolved, nodes, owner, fact.node, node, send,
    )?;
    let mut inputs = free_inputs(
        FreeInputSource {
            program: original,
            ir,
            db,
            resolved,
            nodes,
            owner: owner.id,
        },
        fact.node,
        node,
        predicate,
        event_source.is_some(),
    )?;
    if let Some((event_inputs, _)) = &event_source {
        if inputs
            .iter()
            .any(|input| event_inputs.iter().any(|event| event.name == input.name))
        {
            return Err(gap(
                "event SEND slots collide with lexical inputs",
                Some(*span),
            ));
        }
        for mut input in event_inputs.iter().cloned() {
            input.ordinal = inputs.len();
            inputs.push(input);
        }
    }
    let rule = format!(
        "{}.sendWhen.{}.{}.{}",
        owner.canonical, site.source.sha256, site.node.start, site.node.end
    );
    let mut descriptor = serde_json::json!({
        "rule": rule, "owner": owner.canonical, "source": site.source,
        "node": site.node, "statement": site.statement,
        "target": operation, "binding": deployment_binding, "sourceBinding": binding,
        "inputs": inputs.iter().map(|input| serde_json::json!({"name":input.name,"type":input.type_id})).collect::<Vec<_>>(),
    });
    if let Some((_, event)) = &event_source {
        descriptor["eventSource"] = event.clone();
    }
    if *when_at_source {
        descriptor["evaluation"] = serde_json::json!("source");
    }
    Ok((
        *span,
        PreparedSendGuard {
            rule,
            predicate: predicate.clone(),
            descriptor,
            inputs,
            event_source: event_source.map(|(_, event)| PreparedSendEventSource {
                model_slot: "eventTerm",
                revision_slot: "eventRevision",
                model_field: event["modelField"]["name"]
                    .as_str()
                    .expect("checked event field")
                    .into(),
                revision_field: event["revisionField"]["name"]
                    .as_str()
                    .expect("checked event revision")
                    .into(),
                lexical_alias: None,
            }),
        },
    ))
}

fn prepare_owner_guards(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    guards: &mut HashMap<Span, PreparedSendGuard>,
) -> Result<Option<Vec<serde_json::Value>>, SendGuardGap> {
    let original = context.original();
    let ir = context.ir();
    let db = context.db();
    let resolved = context.resolved();
    let IrItemKind::Scenario {
        guards: leading,
        effects,
        ..
    } = &owner.kind
    else {
        return Ok(None);
    };
    let mut sends = Vec::new();
    collect_sends(leading, &mut sends, 0)?;
    collect_sends(effects, &mut sends, 0)?;
    if sends.is_empty() {
        return Ok(None);
    }
    if owner.canonical == "maintain.remind" {
        let (span, guard) = super::event_decisions::prepare_maintain_remind(context, owner)
            .ok_or_else(|| gap("exact event owner decision unavailable", Some(owner.span)))?;
        if sends.len() != 1
            || !matches!(sends[0], IrStmt::Send {span: actual,..} if *actual == span)
            || guards.insert(span, guard.clone()).is_some()
        {
            return Err(gap("event SEND dispatch census mismatch", Some(owner.span)));
        }
        return Ok(Some(vec![guard.descriptor]));
    }
    if owner.canonical == "invoice.issue" {
        let (span, guard) = super::invoice_issue_decisions::prepare_issue_send_guard(
            context, owner,
        )
        .ok_or_else(|| {
            gap(
                "exact invoice issue SEND owner unavailable",
                Some(owner.span),
            )
        })?;
        if sends.len() != 1
            || !matches!(sends[0], IrStmt::Send {span: actual,..} if *actual == span)
            || guards.insert(span, guard.clone()).is_some()
        {
            return Err(gap(
                "invoice issue SEND dispatch census mismatch",
                Some(owner.span),
            ));
        }
        return Ok(Some(vec![guard.descriptor]));
    }
    if owner.canonical == "events.observe_venue" {
        let (span, guard) =
            super::event_send_decisions::prepare_observe_venue_send_guard(context, owner)
                .ok_or_else(|| gap("exact event venue SEND owner unavailable", Some(owner.span)))?;
        if sends.len() != 1
            || !matches!(sends[0], IrStmt::Send {span: actual,..} if *actual == span)
            || guards.insert(span, guard.clone()).is_some()
        {
            return Err(gap(
                "event venue SEND dispatch census mismatch",
                Some(owner.span),
            ));
        }
        return Ok(Some(vec![guard.descriptor]));
    }
    if matches!(
        owner.canonical.as_str(),
        "success.renewal_due" | "success.remind"
    ) {
        let (span, guard) =
            super::success_send_decisions::prepare_success_notice_send_guard(context, owner)
                .ok_or_else(|| {
                    gap(
                        "exact success renewal SEND owner unavailable",
                        Some(owner.span),
                    )
                })?;
        if sends.len() != 1
            || !matches!(sends[0], IrStmt::Send {span: actual,..} if *actual == span)
            || guards.insert(span, guard.clone()).is_some()
        {
            return Err(gap(
                "success renewal SEND dispatch census mismatch",
                Some(owner.span),
            ));
        }
        return Ok(Some(vec![guard.descriptor]));
    }
    // A fresh IR refusal in this scenario, a consumed helper, or a schema
    // declaration invalidates its SEND proof. Unrelated owners cannot.
    if super::scenario_queries::checked_send_diagnostics(original, owner, context.ir_diagnostics())
        .is_none()
    {
        return Err(gap(
            "original SEND owner's checked closure has IR diagnostics",
            Some(owner.span),
        ));
    }
    let sites =
        super::scenario_decisions::serialize_original_decision_sources_with_context(context, owner)
            .ok_or_else(|| {
                gap(
                    "complete original SEND decision correspondence unavailable",
                    Some(owner.span),
                )
            })?;
    let sites = sites
        .iter()
        .filter(|site| site.stage == "send-dispatch")
        .collect::<Vec<_>>();
    if sites.len() != sends.len() {
        return Err(gap(
            "original SEND dispatch census mismatch",
            Some(owner.span),
        ));
    }
    let source_facts = original
        .scenario_disclosures()
        .get(&owner.id)
        .and_then(|disclosure| disclosure.source_facts())
        .and_then(|facts| facts.decision_sites.as_ref())
        .ok_or_else(|| gap("original SEND source facts unavailable", Some(owner.span)))?;
    let mut descriptors = Vec::new();
    for (send, site) in sends.into_iter().zip(sites) {
        let (span, guard) = prepare_send_guard(
            original,
            ir,
            db,
            resolved,
            nodes,
            owner,
            source_facts,
            send,
            site,
        )?;
        descriptors.push(guard.descriptor.clone());
        if guards.len() >= 200 || guards.insert(span, guard).is_some() {
            return Err(gap(
                "duplicate or excessive original SEND guard",
                Some(span),
            ));
        }
    }
    Ok(Some(descriptors))
}

pub(super) fn prepare_with_context(
    context: &super::source_context::FreshSourceContext<'_>,
) -> Result<PreparedSendGuards, SendGuardGap> {
    let program = context.program();
    let ir = context.ir();
    let original = context.original();
    let fresh = context.fresh();
    let trees = context.trees();
    if original.types.node_types != program.types.node_types
        || original.types.symbol_types != program.types.symbol_types
    {
        return Err(gap(
            "original SEND checked type correspondence mismatch",
            None,
        ));
    }
    if execution_closure(ir) != execution_closure(fresh)
        || ir.value_constraints != fresh.value_constraints
    {
        return Err(gap("original whole IR execution closure mismatch", None));
    }
    // Only a scenario containing a checked guarded SEND can supply lexical
    // nodes to a SEND Rule. Index those complete original scenario subtrees,
    // not unrelated declarations or applications in the same compilation.
    let mut owner_ranges = HashMap::<crate::source::SourceId, Vec<(u32, u32)>>::new();
    for owner in &ir.items {
        let IrItemKind::Scenario {
            guards: leading,
            effects,
            ..
        } = &owner.kind
        else {
            continue;
        };
        let mut sends = Vec::new();
        if collect_sends(leading, &mut sends, 0).is_err()
            || collect_sends(effects, &mut sends, 0).is_err()
            || sends.is_empty()
        {
            continue;
        }
        let Some(source) = original
            .scenario_disclosures()
            .get(&owner.id)
            .and_then(|disclosure| disclosure.source_facts())
        else {
            continue;
        };
        owner_ranges
            .entry(source.node.file)
            .or_default()
            .push((source.node.start, source.node.end));
    }
    let mut nodes = HashMap::new();
    for (file, tree) in trees {
        let Some(ranges) = owner_ranges.get(file) else {
            continue;
        };
        for node in tree.descendants() {
            let key = NodeKey::of(node);
            if !ranges
                .iter()
                .any(|(start, end)| key.start >= *start && key.end <= *end)
            {
                continue;
            }
            if nodes.len() >= 200000 && !nodes.contains_key(&key) {
                return Err(gap("SEND source census capacity exceeded", Some(node.span)));
            }
            nodes.insert(key, node);
        }
    }
    let mut guards = HashMap::new();
    let mut by_owner = BTreeMap::new();
    for owner in &ir.items {
        // Stage one owner's complete guard inventory atomically. A failure
        // at its second SEND cannot leave its first Rule installed.
        let mut owned = HashMap::new();
        let Ok(Some(descriptors)) = prepare_owner_guards(context, owner, &nodes, &mut owned) else {
            continue;
        };
        if owned.keys().any(|span| guards.contains_key(span)) {
            return Err(gap(
                "duplicate original SEND guard across owners",
                Some(owner.span),
            ));
        }
        guards.extend(owned);
        by_owner.insert(
            owner.canonical.clone(),
            serde_json::Value::Array(descriptors),
        );
    }
    Ok(PreparedSendGuards {
        guards,
        by_owner,
        closure: format!("{ir:?}"),
    })
}

fn collect_sends<'a>(
    statements: &'a [IrStmt],
    out: &mut Vec<&'a IrStmt>,
    depth: usize,
) -> Result<(), SendGuardGap> {
    if depth > 64 {
        return Err(gap("SEND statement depth exceeded", None));
    }
    for statement in statements {
        match statement {
            IrStmt::Send { when: Some(_), .. } => {
                if out.len() >= 200 {
                    return Err(gap("SEND dispatch capacity exceeded", None));
                }
                out.push(statement);
            }
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => {
                collect_sends(then_branch, out, depth + 1)?;
                collect_sends(else_branch, out, depth + 1)?;
            }
            IrStmt::For { body, .. } => collect_sends(body, out, depth + 1)?,
            IrStmt::Match { arms, .. } => {
                for arm in arms {
                    collect_sends(&arm.body, out, depth + 1)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn contained(outer: NodeKey, inner: NodeKey) -> bool {
    inner.file == outer.file && inner.start >= outer.start && inner.end <= outer.end
}

/// Existing versioned model inputs can capture one original loop binding,
/// only inside a source-sealed ordinary trusted event handler. This is a
/// codec join; the retained owner query and dispatch fence still own reads.
fn checked_for_item_type(
    source: FreeInputSource<'_>,
    predicate: NodeKey,
    key: NodeKey,
    loop_node: NodeKey,
) -> Option<ResolvedType> {
    fn original_loop(effects: &[Effect], node: NodeKey, depth: usize) -> Option<&Effect> {
        if depth > 64 {
            return None;
        }
        effects.iter().find_map(|effect| {
            if effect.node == node {
                return (effect.verb == EffectVerb::For).then_some(effect);
            }
            original_loop(&effect.then_effects, node, depth + 1)
                .or_else(|| original_loop(&effect.else_effects, node, depth + 1))
                .or_else(|| {
                    effect
                        .match_arms
                        .iter()
                        .find_map(|arm| original_loop(&arm.effects, node, depth + 1))
                })
        })
    }
    fn lowered_loop(effects: &[IrStmt], span: Span, depth: usize) -> Option<&IrStmt> {
        if depth > 64 {
            return None;
        }
        effects.iter().find_map(|effect| match effect {
            IrStmt::For {
                span: actual, body, ..
            } => {
                if *actual == span {
                    Some(effect)
                } else {
                    lowered_loop(body, span, depth + 1)
                }
            }
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => lowered_loop(then_branch, span, depth + 1)
                .or_else(|| lowered_loop(else_branch, span, depth + 1)),
            IrStmt::Match { arms, .. } => arms
                .iter()
                .find_map(|arm| lowered_loop(&arm.body, span, depth + 1)),
            _ => None,
        })
    }
    let scenario = source.program.effects.scenarios.get(&source.owner)?;
    let Some(HandlerSource::Event(event)) = scenario.on.as_ref() else {
        return None;
    };
    if scenario.by.is_some()
        || scenario.read
        || scenario.result.is_some()
        || scenario.cohort.is_some()
        || !matches!(
            source.resolved.symbols.get(event.0 as usize)?.kind,
            SymbolKind::Event { .. }
        )
        || !contained(scenario.node, loop_node)
        || !contained(loop_node, predicate)
        || !contained(predicate, key)
        || source.nodes.get(&loop_node)?.kind != SyntaxKind::For
    {
        return None;
    }
    let owner = source.ir.items.get(source.owner.0 as usize)?;
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(_)),
        hook: None,
        cohort: None,
        read: false,
        result: None,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let original = original_loop(&scenario.effects, loop_node, 0)?;
    let query = source
        .program
        .types
        .checked_queries
        .get(&original.domain?)?;
    let ResolvedType::Array { element, .. } = &query.result else {
        return None;
    };
    let ResolvedType::Record {
        symbol: model,
        stored: true,
    } = element.as_ref()
    else {
        return None;
    };
    if query.projection.is_some()
        || source.program.types.node_types.get(&query.node) != Some(&query.result)
        || !matches!(
            source.resolved.symbols.get(model.0 as usize)?.kind,
            SymbolKind::Model { .. }
        )
        || source.nodes.get(&query.domain)?.kind != SyntaxKind::NameRef
        || !matches!(source.resolved.node_binding.get(&query.domain),Some(Binding::Symbol(actual)) if actual==model)
        || source.program.types.node_types.get(&key) != Some(element.as_ref())
    {
        return None;
    }
    let limit = original.limit?;
    let IrStmt::For {
        item,
        domain,
        limit: Some(bound),
        ..
    } = lowered_loop(effects, send_key_span(loop_node), 0)?
    else {
        return None;
    };
    if Some(item) != original.item.as_ref()
        || domain.span != send_key_span(query.node)
        || domain.ty != query.result
        || bound.span != send_key_span(limit)
        || source.nodes.get(&limit)?.kind != SyntaxKind::Literal
        || source.program.types.node_types.get(&limit) != Some(&ResolvedType::Scalar(Scalar::Int))
        || !matches!(bound.expr,IrExpr::Int(value) if (1..=200).contains(&value))
    {
        return None;
    }
    Some(element.as_ref().clone())
}

fn declaration_type(
    source: FreeInputSource<'_>,
    predicate: NodeKey,
    key: NodeKey,
    binding: &Binding,
) -> Result<Option<ResolvedType>, SendGuardGap> {
    let FreeInputSource {
        program,
        resolved,
        nodes,
        owner,
        ..
    } = source;
    let fail = || {
        gap(
            "free SEND lexical declaration has no supported transport",
            Some(Span::new(key.file, key.start, key.end)),
        )
    };
    let ty = match binding {
        Binding::Context(resolve::ContextVar::Event) => {
            return Err(gap(
                "event SEND guard has no typed event-field transport",
                Some(Span::new(key.file, key.start, key.end)),
            ));
        }
        Binding::Context(_) | Binding::Builtin { .. } | Binding::Predicate => return Ok(None),
        Binding::Symbol(id) => {
            let symbol = resolved.symbols.get(id.0 as usize).ok_or_else(fail)?;
            let SymbolKind::Param {
                owner: declared_owner,
                ..
            } = symbol.kind
            else {
                return Ok(None);
            };
            if declared_owner != owner {
                return Err(fail());
            }
            program
                .types
                .symbol_types
                .get(id)
                .cloned()
                .ok_or_else(fail)?
        }
        Binding::ForItem { node } => {
            checked_for_item_type(source, predicate, key, *node).ok_or_else(fail)?
        }
        Binding::QueryAlias { node } if contained(predicate, *node) => return Ok(None),
        Binding::Let { node } => {
            if contained(predicate, *node) {
                return Ok(None);
            }
            let declaration = nodes.get(node).ok_or_else(fail)?;
            let initializer = kids(declaration)
                .into_iter()
                .find(|child| resolve::is_expression(child.kind))
                .ok_or_else(fail)?;
            program
                .types
                .node_types
                .get(&NodeKey::of(initializer))
                .cloned()
                .ok_or_else(fail)?
        }
        Binding::CreateAs { node } => {
            let declaration = nodes.get(node).ok_or_else(fail)?;
            if declaration.kind != SyntaxKind::Create {
                return Err(fail());
            }
            let target = kids(declaration)
                .into_iter()
                .find(|child| child.kind == SyntaxKind::Path)
                .ok_or_else(fail)?;
            let model = *resolved
                .node_symbol
                .get(&NodeKey::of(target))
                .ok_or_else(fail)?;
            if !matches!(
                resolved
                    .symbols
                    .get(model.0 as usize)
                    .ok_or_else(fail)?
                    .kind,
                SymbolKind::Model { .. }
            ) {
                return Err(fail());
            }
            ResolvedType::Record {
                symbol: model,
                stored: true,
            }
        }
        Binding::CohortChild { model, .. } => ResolvedType::Record {
            symbol: *model,
            stored: true,
        },
        // Defaults and callee bodies are not visited. External lexical query,
        // loop, effect-result and opaque imported values require their own codec.
        _ => return Err(fail()),
    };
    Ok(Some(ty))
}

#[derive(Clone, Copy)]
struct FreeInputSource<'a> {
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &'a SourceDb,
    resolved: &'a resolve::ResolveTables,
    nodes: &'a HashMap<NodeKey, &'a SyntaxNode>,
    owner: SymbolId,
}

/// Refine one captured first-row value only at its original SEND occurrence.
/// No guard-local check, copied nullable alias, scalar or nullable parameter
/// acquires this proof. The existing whole original/fresh seal precedes this
/// producer, and the native receiver must still supply the actual selected row.
fn narrowing_owner_mismatch(
    owner: &IrItem,
    scenario: &ScenarioData,
    facts: &CheckedScenarioSource,
    symbol: &Symbol,
    actual_model: &IrItem,
    source_owner: SymbolId,
    occurrence_type_ok: bool,
    model: SymbolId,
    module_name: &str,
    occurrence_kind: SyntaxKind,
) -> bool {
    owner.id != source_owner
        || owner.module != scenario.module
        || facts.scenario != source_owner
        || facts.node != scenario.node
        || facts.source.module != module_name
        || !matches!(symbol.kind, SymbolKind::Model { .. })
        || symbol.id != model
        || symbol.module != scenario.module
        || actual_model.id != model
        || actual_model.module != symbol.module
        || actual_model.canonical != symbol.canonical
        || !matches!(actual_model.kind, IrItemKind::Model { .. })
        || !occurrence_type_ok
        || occurrence_kind != SyntaxKind::NameRef
}

fn narrowing_header<'a>(
    source: FreeInputSource<'a>,
    occurrence: NodeKey,
    _declaration: NodeKey,
    model: SymbolId,
    _declared_type: &ResolvedType,
) -> Option<(
    &'a ScenarioData,
    &'a CheckedScenarioSource,
    &'a IrItem,
    ResolvedType,
)> {
    let scenario = source.program.effects.scenarios.get(&source.owner)?;
    let facts = source
        .program
        .scenario_disclosures()
        .get(&source.owner)?
        .source_facts()?;
    let owner = source.ir.items.get(source.owner.0 as usize)?;
    let IrItemKind::Scenario { .. } = &owner.kind else {
        return None;
    };
    let symbol = source.resolved.symbols.get(model.0 as usize)?;
    let actual_model = source.ir.items.get(model.0 as usize)?;
    let capture_type = ResolvedType::Record {
        symbol: model,
        stored: true,
    };
    let module_name = source
        .program
        .modules
        .get(scenario.module.0 as usize)
        .map(|module| module.name.as_str())?;
    let occurrence_kind = source.nodes.get(&occurrence).map(|node| node.kind)?;
    let occurrence_type_ok =
        source.program.types.node_types.get(&occurrence) == Some(&capture_type);
    if narrowing_owner_mismatch(
        owner,
        scenario,
        facts,
        symbol,
        actual_model,
        source.owner,
        occurrence_type_ok,
        model,
        module_name,
        occurrence_kind,
    ) {
        return None;
    }
    Some((scenario, facts, owner, capture_type))
}

fn select_narrowing_query(
    facts: &CheckedScenarioSource,
    declaration: NodeKey,
    model: SymbolId,
) -> Option<(&DisclosureQuery, &DisclosureFirstQuery)> {
    let mut queries = facts.queries.as_deref()?.iter().filter(|query| {
        query
            .first
            .as_ref()
            .is_some_and(|first| first.binding == declaration)
    });
    let query = queries.next()?;
    if queries.next().is_some()
        || query.model != model
        || query.source != facts.source
        || query.count.is_some()
        || query.projection.is_some()
    {
        return None;
    }
    Some((query, query.first.as_ref()?))
}

fn resolve_narrowing_positions(
    scenario: &ScenarioData,
    declaration: NodeKey,
    predicate: NodeKey,
) -> Option<((usize, &Effect), (usize, &Effect))> {
    let (let_index, let_effect) = scenario
        .effects
        .iter()
        .enumerate()
        .find(|(_, effect)| effect.node == declaration)?;
    let (send_index, send_effect) =
        scenario.effects.iter().enumerate().find(|(_, effect)| {
            effect.verb == EffectVerb::Send && effect.when == Some(predicate)
        })?;
    if let_index >= send_index
        || declaration.end > send_effect.node.start
        || !contained(send_effect.node, predicate)
    {
        return None;
    }
    Some(((let_index, let_effect), (send_index, send_effect)))
}

fn resolve_narrowing_call<'a>(
    source: FreeInputSource<'a>,
    _first: &DisclosureFirstQuery,
    query: &DisclosureQuery,
    let_value: NodeKey,
) -> Option<(
    NodeKey,
    &'a SelectedCall,
    &'a CheckedCollectionCall,
    &'a CheckedQuery,
    NodeKey,
)> {
    let call = first_send_group(source, let_value)?;
    let selected = source.program.types.selected_calls.get(&call)?;
    let collection = source.program.types.checked_collection_calls.get(&call)?;
    let [argument] = selected.arguments.as_slice() else {
        return None;
    };
    let checked_query = source.program.types.checked_queries.get(&query.node)?;
    let arg_group = first_send_group(source, *argument)?;
    Some((call, selected, collection, checked_query, arg_group))
}

fn narrowing_call_mismatch(
    source: FreeInputSource<'_>,
    call: NodeKey,
    selected: &SelectedCall,
    collection: &CheckedCollectionCall,
    checked_query: &CheckedQuery,
    arg_group: NodeKey,
    first: &DisclosureFirstQuery,
    query: &DisclosureQuery,
    model: SymbolId,
    declared_type: &ResolvedType,
    let_value: NodeKey,
) -> bool {
    call != first.call
        || collection.node != call
        || collection.builtin != "first"
        || collection.model != model
        || collection.query != query.node
        || Some(collection.alias) != query.alias
        || collection.predicate.is_some()
        || collection.overload != first.overload
        || !matches!(&selected.target,SelectedCallTarget::Builtin {id,overload}
            if id=="first" && *overload==first.overload)
        || selected.slots.as_slice() != [Some(0)]
        || arg_group != query.node
        || checked_query.node != query.node
        || checked_query.projection.is_some()
        || checked_query.domain != query.domain
        || source.program.types.node_types.get(&call) != Some(declared_type)
        || source.program.types.node_types.get(&let_value) != Some(declared_type)
}

fn resolve_narrowing_let<'a>(
    source: FreeInputSource<'a>,
    let_effect: &Effect,
    declaration: NodeKey,
    let_value: NodeKey,
) -> Option<Vec<&'a str>> {
    let let_node = source.nodes.get(&declaration)?;
    let let_values: Vec<_> = kids(let_node)
        .into_iter()
        .filter(|child| resolve::is_expression(child.kind))
        .map(NodeKey::of)
        .collect();
    let text = &source.db.get(declaration.file)?.text;
    let let_names: Vec<_> = kids(let_node)
        .into_iter()
        .filter_map(|child| name_text(child, text))
        .collect();
    if let_effect.verb != EffectVerb::Let
        || let_effect.binding.as_deref() != let_names.get(1).copied()
        || let_node.kind != SyntaxKind::Let
        || let_names.first().copied() != Some("let")
        || let_names.len() != 2
        || let_values.as_slice() != [let_value]
    {
        return None;
    }
    Some(let_names)
}

fn check_narrowing_seal(
    source: FreeInputSource<'_>,
    owner: &IrItem,
    facts: &CheckedScenarioSource,
    query: &DisclosureQuery,
    call: NodeKey,
    let_index: usize,
    send_index: usize,
    declaration: NodeKey,
    predicate: NodeKey,
    send_node: NodeKey,
    occurrence: NodeKey,
    capture_type: &ResolvedType,
    declared_type: &ResolvedType,
    binding_name: &str,
) -> Option<()> {
    let IrItemKind::Scenario {
        effects: actual_effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrStmt::Let {
        name: actual_name,
        value: actual_value,
        span: actual_let,
    } = actual_effects.get(let_index)?
    else {
        return None;
    };
    let IrStmt::Send {
        when: Some(actual_predicate),
        span: actual_send,
        ..
    } = actual_effects.get(send_index)?
    else {
        return None;
    };
    let original = facts
        .creates
        .as_deref()?
        .iter()
        .find(|created| created.source == facts.source)?;
    let sealed = super::scenario_receipts::checked_first_query_ir(
        source.ir,
        original,
        actual_value,
        call,
        source.db,
    )?;
    if *actual_let != send_key_span(declaration)
        || actual_name.as_str() != binding_name
        || actual_value.ty != *declared_type
        || actual_value.span != send_key_span(call)
        || *actual_send != send_key_span(send_node)
        || actual_predicate.span != send_key_span(predicate)
        || sealed != query
        || !same_send_occurrence(actual_predicate, occurrence, binding_name, capture_type)
        || !contained(predicate, occurrence)
    {
        return None;
    }
    Some(())
}

fn check_require_control(
    source: FreeInputSource<'_>,
    facts: &CheckedScenarioSource,
    sites: &[CheckedDecisionSite],
    owner: &IrItem,
    effect: &Effect,
    index: usize,
    _send_node: NodeKey,
    declaration: NodeKey,
    declared_type: &ResolvedType,
    binding_name: &str,
) -> Option<Option<NodeKey>> {
    let mut controls = sites.iter().filter(|site| {
        site.owner == source.owner
            && site.stage == CheckedDecisionStage::BodyRequire
            && site.statement == effect.node
            && Some(site.node) == effect.cond
    });
    let control = controls.next()?;
    if controls.next().is_some()
        || control.source != facts.source
        || control.position.as_slice() != [CheckedDecisionPosition::Body(index)]
    {
        return None;
    }
    let Some(presence) =
        compulsory_first_presence(source, control.node, declaration, declared_type, 0)
    else {
        return Some(None);
    };
    let IrItemKind::Scenario {
        effects: actual_effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrStmt::Require { cond, span, .. } = actual_effects.get(index)? else {
        return None;
    };
    if *span != send_key_span(effect.node)
        || !compiled_first_presence(
            source,
            cond,
            control.node,
            presence,
            binding_name,
            declared_type,
            0,
        )
    {
        return None;
    }
    Some(Some(presence))
}

fn find_compulsory_narrowing(
    source: FreeInputSource<'_>,
    scenario: &ScenarioData,
    facts: &CheckedScenarioSource,
    owner: &IrItem,
    query: &DisclosureQuery,
    call: NodeKey,
    declaration: NodeKey,
    predicate: NodeKey,
    send_node: NodeKey,
    occurrence: NodeKey,
    binding_name: &str,
    declared_type: &ResolvedType,
    model: SymbolId,
    send_index: usize,
    let_index: usize,
) -> Option<PreparedFirstRowNarrowing> {
    let sites = facts.decision_sites.as_deref()?;
    let mut dispatches = sites.iter().filter(|site| {
        site.owner == source.owner
            && site.stage == CheckedDecisionStage::SendDispatch
            && site.statement == send_node
            && site.node == predicate
    });
    let dispatch = dispatches.next()?;
    if dispatches.next().is_some()
        || dispatch.source != facts.source
        || dispatch.position.as_slice() != [CheckedDecisionPosition::Body(send_index)]
    {
        return None;
    }
    // An earlier top-level Require is compulsory if execution reaches SEND.
    // Only AND operands are compulsory within its true predicate; OR and a
    // local when= presence check cannot justify freezing a nonnull snapshot.
    for (index, effect) in scenario
        .effects
        .iter()
        .enumerate()
        .take(send_index)
        .skip(let_index + 1)
    {
        if effect.verb != EffectVerb::Require
            || effect.node.end > send_node.start
            || !effect.then_effects.is_empty()
            || !effect.else_effects.is_empty()
            || !effect.match_arms.is_empty()
        {
            continue;
        }
        let Some(presence) = check_require_control(
            source,
            facts,
            sites,
            owner,
            effect,
            index,
            send_node,
            declaration,
            declared_type,
            binding_name,
        )?
        else {
            continue;
        };
        return Some(PreparedFirstRowNarrowing {
            declared_type: declared_type.clone(),
            model,
            query_id: query.id.clone(),
            first_call: call,
            binding: declaration,
            presence,
            require: effect.node,
            occurrence,
            source: facts.source.clone(),
        });
    }
    None
}

fn checked_first_row_narrowing(
    source: FreeInputSource<'_>,
    predicate: NodeKey,
    occurrence: NodeKey,
    binding: &Binding,
    declared_type: &ResolvedType,
) -> Option<PreparedFirstRowNarrowing> {
    let Binding::Let { node: declaration } = binding else {
        return None;
    };
    let ResolvedType::Nullable(inner) = declared_type else {
        return None;
    };
    let ResolvedType::Record {
        symbol: model,
        stored: true,
    } = inner.as_ref()
    else {
        return None;
    };
    let (scenario, facts, owner, capture_type) =
        narrowing_header(source, occurrence, *declaration, *model, declared_type)?;
    let (query, first) = select_narrowing_query(facts, *declaration, *model)?;
    let ((let_index, let_effect), (send_index, send_effect)) =
        resolve_narrowing_positions(scenario, *declaration, predicate)?;
    let let_value = let_effect.value?;
    let (call, selected, collection, checked_query, arg_group) =
        resolve_narrowing_call(source, first, query, let_value)?;
    if narrowing_call_mismatch(
        source,
        call,
        selected,
        collection,
        checked_query,
        arg_group,
        first,
        query,
        *model,
        declared_type,
        let_value,
    ) {
        return None;
    }
    let let_names = resolve_narrowing_let(source, let_effect, *declaration, let_value)?;
    check_narrowing_seal(
        source,
        owner,
        facts,
        query,
        call,
        let_index,
        send_index,
        *declaration,
        predicate,
        send_effect.node,
        occurrence,
        &capture_type,
        declared_type,
        let_names[1],
    )?;
    find_compulsory_narrowing(
        source,
        scenario,
        facts,
        owner,
        query,
        call,
        *declaration,
        predicate,
        send_effect.node,
        occurrence,
        let_names[1],
        declared_type,
        *model,
        send_index,
        let_index,
    )
}

fn send_key_span(key: NodeKey) -> Span {
    Span::new(key.file, key.start, key.end)
}

fn same_send_occurrence(root: &TypedExpr, key: NodeKey, name: &str, ty: &ResolvedType) -> bool {
    let mut pending = vec![(root, 0usize)];
    let mut visits = 0;
    while let Some((value, depth)) = pending.pop() {
        visits += 1;
        if visits > 16384 || depth >= 64 {
            return false;
        }
        if value.span == send_key_span(key) {
            return value.ty == *ty && matches!(&value.expr,IrExpr::Name(actual) if actual==name);
        }
        match &value.expr {
            IrExpr::Member { base, .. }
            | IrExpr::Unary { operand: base, .. }
            | IrExpr::Lambda { body: base, .. }
            | IrExpr::DeliveryRead { record: base, .. } => pending.push((base, depth + 1)),
            IrExpr::Binary { left, right, .. } => {
                pending.extend([(left.as_ref(), depth + 1), (right.as_ref(), depth + 1)])
            }
            IrExpr::Call { args, .. }
            | IrExpr::BoundCall { args, .. }
            | IrExpr::Array(args)
            | IrExpr::Format { args, .. } => {
                pending.extend(args.iter().map(|value| (value, depth + 1)))
            }
            IrExpr::Object(entries) => {
                pending.extend(entries.iter().map(|(_, value)| (value, depth + 1)))
            }
            IrExpr::HasRole {
                person: Some(person),
                ..
            } => pending.push((person, depth + 1)),
            _ => {}
        }
    }
    false
}

/// Verify the same compulsory path in actual typed IR. Source-only proof does
/// not repair changed order, OR control or a different lexical occurrence.
fn compiled_first_presence(
    source: FreeInputSource<'_>,
    actual: &TypedExpr,
    key: NodeKey,
    presence: NodeKey,
    name: &str,
    declared_type: &ResolvedType,
    depth: usize,
) -> bool {
    if depth >= 64 || actual.ty != ResolvedType::Scalar(Scalar::Bool) {
        return false;
    }
    let Some(key) = first_send_group(source, key) else {
        return false;
    };
    let Some(node) = source.nodes.get(&key) else {
        return false;
    };
    if actual.span != send_key_span(key) || node.kind != SyntaxKind::Binary {
        return false;
    }
    let operands: Vec<_> = kids(node)
        .into_iter()
        .filter(|child| resolve::is_expression(child.kind))
        .map(NodeKey::of)
        .collect();
    let [left_key, right_key] = operands.as_slice() else {
        return false;
    };
    let Some(text) = source.db.get(key.file).map(|source| source.text.as_str()) else {
        return false;
    };
    let operator = kids(node)
        .into_iter()
        .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))
        .and_then(|node| node.token())
        .map(|token| token.text(text));
    if key == presence {
        let IrExpr::Binary {
            op: IrBinOp::Ne,
            left,
            right,
        } = &actual.expr
        else {
            return false;
        };
        return operator == Some("!=")
            && left.span == send_key_span(*left_key)
            && right.span == send_key_span(*right_key)
            && left.ty == *declared_type
            && matches!(&left.expr,IrExpr::Name(actual) if actual==name)
            && right.ty == ResolvedType::Null
            && matches!(right.expr, IrExpr::Null);
    }
    let IrExpr::Binary {
        op: IrBinOp::And,
        left,
        right,
    } = &actual.expr
    else {
        return false;
    };
    operator == Some("and")
        && (compiled_first_presence(
            source,
            left,
            *left_key,
            presence,
            name,
            declared_type,
            depth + 1,
        ) || compiled_first_presence(
            source,
            right,
            *right_key,
            presence,
            name,
            declared_type,
            depth + 1,
        ))
}

fn first_send_group(source: FreeInputSource<'_>, mut key: NodeKey) -> Option<NodeKey> {
    for _ in 0..64 {
        let node = source.nodes.get(&key)?;
        if node.kind != SyntaxKind::Group {
            return Some(key);
        }
        let values: Vec<_> = kids(node)
            .into_iter()
            .filter(|child| resolve::is_expression(child.kind))
            .map(NodeKey::of)
            .collect();
        let [value] = values.as_slice() else {
            return None;
        };
        key = *value;
    }
    None
}

fn check_presence_operands(
    source: FreeInputSource<'_>,
    key: NodeKey,
    left: NodeKey,
    right: NodeKey,
    binding: NodeKey,
    declared_type: &ResolvedType,
    text: &str,
) -> Option<NodeKey> {
    let value = first_send_group(source, left)?;
    let absent = first_send_group(source, right)?;
    let null = source.nodes.get(&absent)?;
    (source.nodes.get(&value)?.kind==SyntaxKind::NameRef
        && matches!(source.resolved.node_binding.get(&value),Some(Binding::Let {node}) if *node==binding)
        && source.program.types.node_types.get(&value)==Some(declared_type)
        && null.kind==SyntaxKind::Literal && text.get(absent.start as usize..absent.end as usize)?.trim()=="null"
        && source.program.types.node_types.get(&absent)==Some(&ResolvedType::Null))
        .then_some(key)
}

fn compulsory_first_presence(
    source: FreeInputSource<'_>,
    key: NodeKey,
    binding: NodeKey,
    declared_type: &ResolvedType,
    depth: usize,
) -> Option<NodeKey> {
    if depth >= 64 {
        return None;
    }
    let key = first_send_group(source, key)?;
    let node = source.nodes.get(&key)?;
    if node.kind != SyntaxKind::Binary
        || source.program.types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let text = &source.db.get(key.file)?.text;
    let operands: Vec<_> = kids(node)
        .into_iter()
        .filter(|child| resolve::is_expression(child.kind))
        .map(NodeKey::of)
        .collect();
    let [left, right] = operands.as_slice() else {
        return None;
    };
    let operator = kids(node)
        .into_iter()
        .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?
        .token()?
        .text(text);
    if operator == "and" {
        return compulsory_first_presence(source, *left, binding, declared_type, depth + 1)
            .or_else(|| {
                compulsory_first_presence(source, *right, binding, declared_type, depth + 1)
            });
    }
    if operator != "!=" {
        return None;
    }
    check_presence_operands(source, key, *left, *right, binding, declared_type, text)
}

fn collect_source_names(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    predicate_node: &SyntaxNode,
    event_source: bool,
) -> Result<
    (
        Vec<PreparedSendInput>,
        HashMap<String, String>,
        HashSet<Span>,
    ),
    SendGuardGap,
> {
    let original_source = source;
    let FreeInputSource {
        program,
        ir,
        db,
        resolved,
        nodes: _,
        owner,
    } = source;
    let mut inputs = Vec::<PreparedSendInput>::new();
    let mut identities = HashMap::<String, String>::new();
    let mut source_reads = HashSet::new();
    for node in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::NameRef)
    {
        let key = NodeKey::of(node);
        let Some(binding) = resolved.node_binding.get(&key) else {
            if program.types.resolved_cases.contains(&key) {
                continue;
            }
            return Err(gap(
                "SEND source name has no original binding",
                Some(node.span),
            ));
        };
        if event_source && matches!(binding, Binding::Context(resolve::ContextVar::Event)) {
            continue;
        }
        let Some(ty) = declaration_type(original_source, predicate_key, key, binding)? else {
            continue;
        };
        let source = db
            .get(key.file)
            .ok_or_else(|| gap("missing SEND name source", Some(node.span)))?;
        let name = kids(node)
            .into_iter()
            .find_map(|child| name_text(child, &source.text))
            .ok_or_else(|| gap("SEND lexical name missing original token", Some(node.span)))?
            .to_string();
        let (declaration, symbol) = match binding {
            Binding::Symbol(id) => {
                let SymbolKind::Param { type_node, .. } = resolved.symbols[id.0 as usize].kind
                else {
                    unreachable!("declaration_type admits only owning parameters")
                };
                (type_node, Some(*id))
            }
            Binding::Let { node }
            | Binding::CreateAs { node }
            | Binding::CohortChild { node, .. }
            | Binding::ForItem { node } => (*node, None),
            _ => unreachable!("declaration_type admits only original lexical declarations"),
        };
        let narrowing =
            checked_first_row_narrowing(original_source, predicate_key, key, binding, &ty);
        let capture_type = match &narrowing {
            Some(fact) => ResolvedType::Record {
                symbol: fact.model,
                stored: true,
            },
            None => ty,
        };
        let type_id = input_type(&capture_type, program, ir, symbol, 0).ok_or_else(|| {
            gap(
                "free SEND lexical type has no canonical finite codec",
                Some(node.span),
            )
        })?;
        source_reads.insert(node.span);
        let identity = format!("{binding:?}");
        if let Some(prior) = identities.get(&name) {
            if prior != &identity {
                return Err(gap(
                    "different free SEND bindings share an emitted name",
                    Some(node.span),
                ));
            }
            continue;
        }
        if inputs.len() >= 200 {
            return Err(gap("free SEND input capacity exceeded", Some(node.span)));
        }
        identities.insert(name.clone(), identity);
        inputs.push(PreparedSendInput {
            name: name.clone(),
            type_id,
            value: TypedExpr::new(IrExpr::Name(name), capture_type, node.span),
            declaration,
            symbol,
            owner,
            ordinal: inputs.len(),
            narrowing,
        });
    }
    Ok((inputs, identities, source_reads))
}

fn push_query_values<'e>(
    query: &'e IrQuery,
    pending: &mut Vec<(&'e TypedExpr, usize)>,
    depth: usize,
) {
    if let IrQueryDomain::Value { base, .. } = &query.domain {
        pending.push((base, depth + 1));
    }
    if let Some(order) = &query.value_order {
        pending.push((&order.key, depth + 1));
    }
    for value in [
        &query.parent,
        &query.where_pred,
        &query.limit,
        &query.archived,
        &query.select,
    ]
    .into_iter()
    .flatten()
    {
        pending.push((value, depth + 1));
    }
}

fn check_evaluated_name(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    _owner: SymbolId,
    value: &TypedExpr,
    name: &str,
    identities: &HashMap<String, String>,
    evaluated: &mut HashSet<Span>,
    event_source: bool,
) -> Result<(), SendGuardGap> {
    let resolved = source.resolved;
    let key = NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: SyntaxKind::NameRef as u8,
    };
    let binding = resolved.node_binding.get(&key).ok_or_else(|| {
        gap(
            "evaluated SEND name lacks original lexical source",
            Some(value.span),
        )
    })?;
    if event_source && matches!(binding, Binding::Context(resolve::ContextVar::Event)) {
        return Ok(());
    }
    if declaration_type(source, predicate_key, key, binding)?.is_some() {
        if !identities.contains_key(name) {
            return Err(gap(
                "evaluated SEND lexical name differs from source binding",
                Some(value.span),
            ));
        }
        evaluated.insert(value.span);
    }
    Ok(())
}

fn check_evaluated_names(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    predicate: &TypedExpr,
    identities: &HashMap<String, String>,
    event_source: bool,
) -> Result<HashSet<Span>, SendGuardGap> {
    let owner = source.owner;
    let mut pending = vec![(predicate, 0usize)];
    let mut evaluated = HashSet::new();
    let mut count = 0usize;
    while let Some((value, depth)) = pending.pop() {
        count += 1;
        if depth > 64 || count > 16384 {
            return Err(gap(
                "SEND evaluated name census capacity exceeded",
                Some(value.span),
            ));
        }
        match &value.expr {
            IrExpr::Name(name) => {
                check_evaluated_name(
                    source,
                    predicate_key,
                    owner,
                    value,
                    name,
                    identities,
                    &mut evaluated,
                    event_source,
                )?;
            }
            IrExpr::Member { base, .. }
            | IrExpr::Unary { operand: base, .. }
            | IrExpr::Lambda { body: base, .. }
            | IrExpr::DeliveryRead { record: base, .. } => pending.push((base, depth + 1)),
            IrExpr::Binary { left, right, .. } => {
                pending.push((left, depth + 1));
                pending.push((right, depth + 1));
            }
            IrExpr::Call { args, .. }
            | IrExpr::BoundCall { args, .. }
            | IrExpr::Array(args)
            | IrExpr::Format { args, .. } => {
                pending.extend(args.iter().map(|value| (value, depth + 1)))
            }
            IrExpr::Object(fields) => {
                pending.extend(fields.iter().map(|(_, value)| (value, depth + 1)))
            }
            IrExpr::Query(query) => {
                push_query_values(query, &mut pending, depth);
            }
            IrExpr::HasRole { person, .. } => {
                if let Some(value) = person {
                    pending.push((value, depth + 1));
                }
            }
            IrExpr::Int(_)
            | IrExpr::Decimal(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Money { .. }
            | IrExpr::DurationMs(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_) => {}
            _ => {
                return Err(gap(
                    "SEND predicate expression has no complete lexical transport",
                    Some(value.span),
                ));
            }
        }
    }
    Ok(evaluated)
}

fn free_inputs(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    predicate_node: &SyntaxNode,
    predicate: &TypedExpr,
    event_source: bool,
) -> Result<Vec<PreparedSendInput>, SendGuardGap> {
    let (inputs, identities, source_reads) =
        collect_source_names(source, predicate_key, predicate_node, event_source)?;
    let evaluated =
        check_evaluated_names(source, predicate_key, predicate, &identities, event_source)?;
    if source_reads != evaluated {
        return Err(gap(
            "source/evaluated free SEND name census differs",
            Some(predicate.span),
        ));
    }
    Ok(inputs)
}

/// Keep only exact catalog-produced nominal leaves and source-owned aliases.
/// The emitter additionally requires their sealed schema inventory.
fn input_type(
    ty: &ResolvedType,
    program: &CheckedProgram,
    ir: &IrProgram,
    symbol: Option<SymbolId>,
    depth: usize,
) -> Option<String> {
    if depth > 64 {
        return None;
    }
    match ty {
        ResolvedType::Nullable(inner) => Some(format!(
            "{}?",
            input_type(inner, program, ir, symbol, depth + 1)?
        )),
        ResolvedType::Array { element, .. } => Some(format!(
            "{}[]",
            input_type(element, program, ir, symbol, depth + 1)?
        )),
        _ => {
            if let Some(alias) = symbol.and_then(|id| ir.value_constraints.get(&id)?.alias) {
                let item = ir.items.get(alias.0 as usize)?;
                let original = program.symbols.get(alias.0 as usize)?;
                if item.id != alias
                    || original.id != alias
                    || item.canonical != original.canonical
                    || item.module != original.module
                    || ir.value_constraints.get(&alias)?.alias != Some(alias)
                {
                    return None;
                }
                return Some(item.canonical.clone());
            }
            if let Some(name) = crate::analysis::types::checked_standard_nominal_name(ty) {
                return Some(name.to_string());
            }
            serial_type(ty, program, ir, depth)
        }
    }
}
