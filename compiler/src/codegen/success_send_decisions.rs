//! Closed source profiles for Success renewal and follow-up notices.
//! Each owns one Require, a source-only time IF, and one guarded Mail/Notice.
//! Dispatch retains only its authored version, status, role and Employee
//! conditions; no clock or arbitrary helper can enter these sealed profiles.
use std::collections::HashMap;

use serde_json::{Value, json};

use crate::analysis::effects::{EffectTarget, EffectVerb, HandlerSource};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::resolve::{Binding, ContextVar, ModelOwner, SymbolId, SymbolKind};
use crate::analysis::types::SelectedCallTarget;
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt, TypedExpr};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};
use super::send_guards::{PreparedSendGuard, PreparedSendInput};
use super::term_decisions as t;

const REQUIRE: &str =
    "event.account.version==event.revision and event.account.active and event.account.renewal!=null";
const IF_TEXT: &str = "account_manager(event.account.manager) and can_work(event.account.manager,event.account.location) and local_instant(event.account.renewal,\"00:00\",event.account.location.timezone,fold=earlier)<=now";
const WHEN: &str = "event.account.version==event.revision and event.account.active and account_manager(event.account.manager) and can_work(event.account.manager,event.account.location)";
const SUBJECT: &str =
    "format(\"Account renewal due\"@{nl=\"Klantverlenging nodig\"},locale=null)";
const BODY: &str = "format(\"Review the recorded renewal date; renewal remains a separate agreement action.\"@{nl=\"Controleer de vastgelegde verlengingsdatum; verlenging blijft een afzonderlijke overeenkomstactie.\"},locale=null)";


const FOLLOWUP_REQUIRE: &str = "event.followup.version==event.revision and event.followup.parent.version==event.account_revision and not event.followup.done and event.followup.parent.active";
const FOLLOWUP_IF: &str = "account_manager(event.followup.assignee) and can_work(event.followup.assignee,event.followup.parent.location) and event.followup.due<=now";
const FOLLOWUP_WHEN: &str = "event.followup.version==event.revision and event.followup.parent.version==event.account_revision and not event.followup.done and event.followup.parent.active and account_manager(event.followup.assignee) and can_work(event.followup.assignee,event.followup.parent.location)";

fn followup(owner: &IrItem) -> Option<bool> {
    match owner.canonical.as_str() {
        "success.renewal_due" => Some(false),
        "success.remind" => Some(true),
        _ => None,
    }
}


fn same_item(context: &FreshSourceContext<'_>, id: SymbolId) -> Option<()> {
    let original = context.ir().items.get(id.0 as usize)?;
    let fresh = context.fresh().items.get(id.0 as usize)?;
    (original.canonical == fresh.canonical
        && format!("{:?}", original.kind) == format!("{:?}", fresh.kind))
    .then_some(())
}

/// Complete inventory of guarded IR SENDs: collect every one, then require
/// exactly one. A reset-to-None walk can re-arm on a third SEND and falsely
/// prove uniqueness with the wrong span.
fn ir_send(statements: &[IrStmt]) -> Option<&IrStmt> {
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

/// First `text` member access (for example `event.account`) inside `within`.
fn first_member(
    program: &CheckedProgram,
    db: &SourceDb,
    within: NodeKey,
    text: &str,
) -> Option<NodeKey> {
    program
        .types
        .node_types
        .iter()
        .filter(|(node, _)| {
            node.kind == SyntaxKind::Member as u8
                && node.file == within.file
                && node.start >= within.start
                && node.end <= within.end
                && t::text(db, **node) == Some(text)
        })
        .map(|(node, _)| *node)
        .min_by_key(|node| node.start)
}

fn plain(node: NodeKey) -> Value {
    json!({"start":node.start,"end":node.end})
}

/// Membership sites for the owner frame: the single `active_member` call
/// inside the exact `can_work` body, cited once from the staging IF and once
/// from the dispatch `when=`. A modified helper or duplicated call site
/// cannot inherit this owner binding.
pub(super) fn collect_success_notice_membership_sites(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<Value>> {
    followup(owner)?;
    prepare_success_notice_send_guard(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let [top] = scenario.effects.as_slice() else {
        return None;
    };
    let (can_work, work_expr) = t::derive(
        program,
        db,
        "employee.can_work",
        "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))",
        &[("person", "user"), ("location", "rent_catalog.Location")],
        "bool",
    )?;
    let mut members = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, selected)| {
            node.file == work_expr.file
                && node.start >= work_expr.start
                && node.end <= work_expr.end
                && matches!(&selected.target,
                    SelectedCallTarget::Builtin { id, overload }
                    if id == "active_member" && *overload == 0)
        });
    let (member, selected) = members.next()?;
    if members.next().is_some()
        || t::text(db, *member) != Some("active_member(person,team)")
        || selected.arguments.len() != 2
        || selected.slots != [Some(0), Some(1)]
        || t::text(db, selected.arguments[0]) != Some("person")
        || t::text(db, selected.arguments[1]) != Some("team")
        || program.types.node_types.get(member)? != &ResolvedType::Scalar(Scalar::Bool)
        || program.types.node_types.get(&selected.arguments[0])?
            != &ResolvedType::Scalar(Scalar::User)
    {
        return None;
    }
    let team_ty = program.types.node_types.get(&selected.arguments[1])?;
    if !matches!(team_ty, ResolvedType::Team) {
        return None;
    }
    let checked = context.program().types.selected_calls.get(member)?;
    if !matches!(&checked.target,
        SelectedCallTarget::Builtin { id, overload }
        if id == "active_member" && *overload == 0)
        || checked.arguments != selected.arguments
        || checked.slots != selected.slots
    {
        return None;
    }
    let member_source = t::source(program, db, *member, "employee")?;
    let [send, _] = top.then_effects.as_slice() else {
        return None;
    };
    let mut sites = Vec::new();
    for (guard, statement, stage, position) in [
        (top.cond?, top.node, "body-condition", json!([{"kind":"body","index":0}])),
        (
            send.when?,
            send.node,
            "send-dispatch",
            json!([{"kind":"body","index":0},{"kind":"then","index":0}]),
        ),
    ] {
        let outer = unique_call_in(program, guard, can_work)?;
        let owner_source = t::source(program, db, guard, "success")?;
        let call = json!({
            "source":member_source,"node":plain(*member),
            "target":{"kind":"builtin","id":"active_member","overload":0},
            "arguments":[
                {"node":plain(selected.arguments[0]),"type":"user"},
                {"node":plain(selected.arguments[1]),"type":"Team"}],
            "slots":[0,1],"defaults":[],
            "chain":[
                {"source":owner_source,"node":plain(outer),"derive":"employee.can_work"}]
        });
        sites.push(
            json!({"version":1,"source":owner_source,"owner":owner.canonical,
            "node":plain(guard),"statement":plain(statement),
            "stage":stage,"position":position,"calls":[call]}),
        );
    }
    Some(sites)
}

/// The single call of `target` inside `within`: same spelling with a
/// retargeted callee or a duplicated call cannot inherit the guard.
fn unique_call_in(
    program: &CheckedProgram,
    within: NodeKey,
    target: SymbolId,
) -> Option<NodeKey> {
    let mut calls = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, selected)| {
            node.kind == SyntaxKind::Call as u8
                && node.file == within.file
                && node.start >= within.start
                && node.end <= within.end
                && matches!(selected.target,
                    SelectedCallTarget::DeriveFn(id) | SelectedCallTarget::Role(id) if id == target)
        })
        .map(|(node, _)| *node);
    let call = calls.next()?;
    calls.next().is_none().then_some(call)
}

pub(super) fn prepare_success_notice_send_guard(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    let followup = followup(owner)?;
    let root_model = if followup { "success.FollowUp" } else { "success.Account" };
    let root_field = if followup { "followup" } else { "account" };
    let root_path = if followup { "event.followup" } else { "event.account" };
    let event_name = if followup { "success.FollowUpDue" } else { "success.RenewalDue" };
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let account = t::symbol(program, "success.Account")?;
    let notice = t::symbol(program, "success.Notice")?;
    let customer = t::symbol(program, "customer.Customer")?;
    let event = t::symbol(program, event_name)?;
    let root = t::symbol(program, root_model)?;
    let role = t::symbol(program, "success.account_manager")?;
    let can_work = t::symbol(program, "employee.can_work")?;
    let employee = t::symbol(program, "employee.Employee")?;
    let location = t::symbol(program, "rent_catalog.Location")?;
    t::checked_closure(
        context,
        scenario.node,
        &[can_work],
        &[account, root, notice, employee, location],
    )?;
    for id in [
        account, root, notice, customer, event, role, can_work, employee, location,
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
        || program.effects.models.get(&account)?.owner != ModelOwner::ChildOf(customer)
        || program.effects.models.get(&notice)?.owner != ModelOwner::ChildOf(account)
        || followup && program.effects.models.get(&root)?.owner != ModelOwner::ChildOf(account)
        || !matches!(
            program.symbols.get(role.0 as usize)?.kind,
            SymbolKind::Role
        )
    {
        return None;
    }
    let SymbolKind::Event { fields } = &program.symbols.get(event.0 as usize)?.kind else {
        return None;
    };
    if fields.len() != (if followup { 3 } else { 2 })
        || program.symbols.get(fields[0].0 as usize)?.name != root_field
        || program.symbols.get(fields[1].0 as usize)?.name != "revision"
        || !program
            .types
            .symbol_types
            .get(&fields[0])
            .is_some_and(|ty| t::record_is(program, ty, root_model))
        || program.types.symbol_types.get(&fields[1]) != Some(&ResolvedType::Scalar(Scalar::Int))
        || followup && (program.symbols.get(fields[2].0 as usize)?.name != "account_revision"
            || program.types.symbol_types.get(&fields[2]) != Some(&ResolvedType::Scalar(Scalar::Int)))
    {
        return None;
    }
    let (can_work_id, work_expr) = t::derive(
        program,
        db,
        "employee.can_work",
        "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))",
        &[("person", "user"), ("location", "rent_catalog.Location")],
        "bool",
    )?;
    if can_work_id != can_work {
        return None;
    }
    // The helper body evaluates exactly one `any(Employee ...)` collection:
    // a modified helper with extra reads cannot inherit this approval.
    let mut anys = program
        .types
        .checked_collection_calls
        .values()
        .filter(|fact| {
            fact.node.file == work_expr.file
                && fact.node.start >= work_expr.start
                && fact.node.end <= work_expr.end
                && fact.builtin == "any"
                && fact.model == employee
        });
    anys.next()?;
    if anys.next().is_some() {
        return None;
    }
    let [header] = scenario.guards.as_slice() else {
        return None;
    };
    let [top] = scenario.effects.as_slice() else {
        return None;
    };
    if header.verb != EffectVerb::Require
        || !t::no_children(header)
        || header.cond.and_then(|node| t::text(db, node)) != Some(if followup { FOLLOWUP_REQUIRE } else { REQUIRE })
        || top.verb != EffectVerb::If
        || top.cond.and_then(|node| t::text(db, node)) != Some(if followup { FOLLOWUP_IF } else { IF_TEXT })
        || !top.else_effects.is_empty()
        || program.types.node_types.get(&header.cond?) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let [send, create] = top.then_effects.as_slice() else {
        return None;
    };
    if send.verb != EffectVerb::Send
        || !t::no_children(send)
        || send.target_node.and_then(|node| t::text(db, node)) != Some("Mail.send")
        || send.binding.as_deref() != Some("notice")
        || send.when.and_then(|node| t::text(db, node)) != Some(if followup { FOLLOWUP_WHEN } else { WHEN })
        || !t::args_match(
            db,
            send,
            &[
                ("to", Some(if followup { "event.followup.email" } else { "event.account.email" })),
                ("subject", Some(if followup { "format(\"Account follow-up\"@{nl=\"Klantopvolging\"},locale=null)" } else { SUBJECT })),
                ("body", Some(if followup { "event.followup.title" } else { BODY })),
            ],
        )
        || program.types.node_types.get(&send.when?) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let notice_args = if followup {
        vec![("parent", Some("event.followup.parent")), ("followup", Some("event.followup")),
            ("revision", Some("event.revision")), ("account_revision", Some("event.account_revision")),
            ("recipient", Some("event.followup.email")), ("subject", Some("\"Account follow-up\"")),
            ("body", Some("event.followup.title")), ("delivery", Some("notice"))]
    } else {
        vec![("parent", Some("event.account")), ("revision", Some("event.revision")),
            ("account_revision", Some("event.revision")), ("recipient", Some("event.account.email")),
            ("subject", Some("\"Account renewal due\"")),
            ("body", Some("\"Review the recorded renewal date; renewal remains a separate agreement action.\"")),
            ("delivery", Some("notice"))]
    };
    if create.verb != EffectVerb::Create || !t::no_children(create)
        || !matches!(create.target, Some(EffectTarget::Model(id)) if id == notice)
        || create.binding.as_deref() != Some("outcome") || !t::args_match(db, create, &notice_args) {
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
    if ir_event != event_name || !by.is_empty() || !params.is_empty() {
        return None;
    }
    let [
        IrStmt::Require {
            cond: _ir_header,
            span: header_span,
            ..
        },
    ] = ir_guards.as_slice()
    else {
        return None;
    };
    if *header_span != t::span(header.node) {
        return None;
    }
    let send_ir = ir_send(ir_effects)?;
    let IrStmt::Send {
        operation,
        deployment_binding,
        args,
        binding: Some(ir_binding),
        when: Some(ir_when),
        span: ir_span,
        ..
    } = send_ir
    else {
        return None;
    };
    if operation != "std.EmailV1.send"
        || deployment_binding.as_deref() != Some("success.Mail")
        || ir_binding != "notice"
        || *ir_span != t::span(send.node)
        || ir_when.span != t::span(send.when?)
        || !matches!(&args.expr, IrExpr::Object(fields) if fields.len() == 3)
    {
        return None;
    }
    // Every `when=` root is the trusted event payload, the exact role, or
    // the exact derive. No clock or foreign root may reach dispatch: the
    // outer `if` time comparison stages only, it never re-evaluates.
    let predicate = send.when?;
    let trees = context.trees();
    let tree = &trees.iter().find(|(file, _)| *file == predicate.file)?.1;
    let predicate_node = tree
        .descendants()
        .find(|node| NodeKey::of(*node) == predicate)?;
    let mut event_uses = Vec::new();
    let mut role_seen = false;
    let mut derive_seen = false;
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
        match bound {
            Binding::Context(ContextVar::Event) if t::text(db, key) == Some("event") => {
                event_uses.push(key);
            }
            Binding::Symbol(id) if *id == role && t::text(db, key) == Some("account_manager") => {
                role_seen = true;
            }
            Binding::Symbol(id) if *id == can_work && t::text(db, key) == Some("can_work") => {
                derive_seen = true;
            }
            _ => return None,
        }
    }
    if event_uses.is_empty() || !role_seen || !derive_seen {
        return None;
    }
    let event_ty = ResolvedType::Record {
        symbol: event,
        stored: false,
    };
    for use_key in &event_uses {
        if program.types.node_types.get(use_key) != Some(&event_ty) {
            return None;
        }
    }
    // Exactly one role call and one helper call inside the guard predicate,
    // each resolving to the checked target: retargeted or duplicated calls
    // cannot carry the guard.
    unique_call_in(program, predicate, role)?;
    unique_call_in(program, predicate, can_work)?;
    // Staging (require) names the row first; the guard predicate reuses it.
    // Declaration sites live in the staged header, occurrences in `when=`.
    let header_cond = header.cond?;
    let header_account = first_member(program, db, header_cond, root_path)?;
    let header_revision = first_member(program, db, header_cond, "event.revision")?;
    let when_account = first_member(program, db, predicate, root_path)?;
    let when_revision = first_member(program, db, predicate, "event.revision")?;
    let row_ty = ResolvedType::Record {
        symbol: root,
        stored: true,
    };
    let event_value = |field: &str, ty: ResolvedType, at: NodeKey| {
        TypedExpr::new(
            IrExpr::Member {
                base: Box::new(TypedExpr::new(
                    IrExpr::Name("event".into()),
                    event_ty.clone(),
                    t::span(event_uses[0]),
                )),
                field: field.into(),
            },
            ty,
            t::span(at),
        )
    };
    let mut inputs = vec![
        PreparedSendInput {
            name: "eventTerm".into(),
            type_id: root_model.into(),
            value: event_value(root_field, row_ty, header_account),
            declaration: header_account,
            symbol: None,
            owner: owner.id,
            ordinal: 0,
            narrowing: None,
        },
        PreparedSendInput {
            name: "eventRevision".into(),
            type_id: "int".into(),
            value: event_value(
                "revision",
                ResolvedType::Scalar(Scalar::Int),
                header_revision,
            ),
            declaration: header_revision,
            symbol: None,
            owner: owner.id,
            ordinal: 1,
            narrowing: None,
        },
    ];
    if followup {
        let declaration = first_member(program, db, header_cond, "event.account_revision")?;
        inputs.push(PreparedSendInput { name:"eventAccountRevision".into(), type_id:"int".into(),
            value:event_value("account_revision", ResolvedType::Scalar(Scalar::Int), declaration),
            declaration, symbol:None, owner:owner.id, ordinal:2, narrowing:None });
    }
    let source = t::source(program, db, predicate, "success")?;
    let rule = format!(
        "{}.sendWhen.{}.{}.{}",
        owner.canonical, source["sha256"].as_str()?,
        predicate.start,
        predicate.end
    );
    let node_plain = plain(predicate);
    let statement_plain = plain(send.node);
    let require_site = t::site(program, db, "success", header.cond?, header.node, "success-renewal-require")?;
    let if_site = t::site(program, db, "success", top.cond?, top.node, "success-renewal-if")?;
    let send_site = t::site(program, db, "success", send.when?, send.node, "success-renewal-send")?;
    let create_site = t::site(program, db, "success", create.node, create.node, "success-renewal-create")?;
    let decision = json!({"version":1,"owner":owner.canonical,"source":source.clone(),
        "sites":{"require":require_site,"if":if_site,"send":send_site,"create":create_site},
        "sendRule":{"rule":rule.clone(),"source":source.clone(),
            "node":node_plain.clone(),"statement":statement_plain.clone()}});
    let descriptor = json!({"rule":rule,"owner":owner.canonical,"source":source,
        "node":node_plain,"statement":statement_plain,
        "target":"std.EmailV1.send","binding":"success.Mail","sourceBinding":"notice",
        "inputs":inputs.iter().map(|input| json!({"name":input.name,"type":input.type_id})).collect::<Vec<_>>(),
        "eventSource":{"event":event_name,"handler":owner.canonical,
            "modelField":{"name":root_field,"model":root_model,
                "declaration":plain(header_account),
                "occurrence":plain(when_account),
                "fields":if followup { vec!["assignee","done","due","email","title"] } else { vec!["active","email","location","manager","renewal"] }},
            "revisionField":{"name":"revision","type":"int",
                "declaration":plain(header_revision),
                "occurrence":plain(when_revision)},
            "predicate":plain(predicate),
            "ownerDecision":decision}});
    Some((
        t::span(send.node),
        PreparedSendGuard {
            rule,
            predicate: ir_when.clone(),
            descriptor,
            inputs,
            event_source: Some(super::send_guards::PreparedSendEventSource {
                model_slot: "eventTerm",
                revision_slot: "eventRevision",
                model_field: root_field.into(),
                revision_field: "revision".into(),
                lexical_alias: None,
            }),
        },
    ))
}

/// Native receipt for the exact renewal SEND owner. The guard profile above
/// must match first (fail-closed); the embedded ownerDecision is verified
/// here for sendRule correspondence before it joins the State plan. Full
/// site/source validation happens in State's checkSuccessRenewalDecisionPlan
/// and the Cloudflare occurrence gate.
pub(super) fn collect_success_notice_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    send_guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    followup(item)?;
    let (span, guard) = prepare_success_notice_send_guard(context, item)?;
    if send_guards.get(&span).is_none_or(|registered| registered.rule != guard.rule) {
        return None;
    }
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&item.id)?;
    let file = db.get(scenario.node.file)?;
    // Logical source stays `success` for decision, sites and guard; only the
    // outer plan/return source is transported to the physical entry module.
    let logical = t::source(program, db, scenario.node, "success")?;
    let source = transport_source(
        &DisclosureSource {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            module: "success".into(),
        },
        entry_module,
    )?;
    if source.path != file.path
        || source.sha256 != file.sha256
        || guard.descriptor["source"] != logical
    {
        return None;
    }
    let decision = guard.descriptor.pointer("/eventSource/ownerDecision")?.clone();
    if decision["owner"] != item.canonical || decision["source"] != logical ||
        decision["sendRule"]["rule"] != guard.descriptor["rule"] ||
        decision["sendRule"]["source"] != guard.descriptor["source"] ||
        decision["sendRule"]["node"] != guard.descriptor["node"] ||
        decision["sendRule"]["statement"] != guard.descriptor["statement"] ||
        decision.pointer("/sites/require").is_none() || decision.pointer("/sites/if").is_none() ||
        decision.pointer("/sites/send").is_none() || decision.pointer("/sites/create").is_none()
    {
        return None;
    }
    let id = sha256_hex(
        format!(
            "success-renewal-void/v1:{}:{}:{}",
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
            rent_notice_decision: None,
            invoice_issue_decision: None,
            observe_venue_decision: None,
            success_renewal_decision: Some(decision),
            purchase_receive_all: None, event_notice_audit: None,
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
