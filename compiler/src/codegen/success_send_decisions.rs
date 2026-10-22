//! Source-bound SEND guard for the CanSuccess renewal reminder.
//!
//! `success.renewal_due` is event-driven (`on=RenewalDue`): a top-level
//! `require` stages only rows whose version/active/renewal match, then one
//! `if` admits the current manager/location pair before a single guarded
//! `Mail.send` plus its `Notice` audit row. The authored `when=` keeps four
//! flat conjuncts live at dispatch (version, active, role, can_work); the
//! outer `if` time comparison (`local_instant(...)<=now`) is intentionally
//! NOT re-evaluated at dispatch, so this profile pins the exact `when=` text
//! and refuses any `now` root inside it.
use serde_json::{Value, json};

use crate::analysis::effects::{EffectVerb, HandlerSource};
use crate::analysis::resolve::{Binding, ContextVar, ModelOwner, SymbolId, SymbolKind};
use crate::analysis::types::SelectedCallTarget;
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt, TypedExpr};
use super::scenario_decisions::FreshSourceContext;
use super::send_guards::{PreparedSendGuard, PreparedSendInput};
use super::term_decisions as t;

const REQUIRE: &str =
    "event.account.version==event.revision and event.account.active and event.account.renewal!=null";
const IF_TEXT: &str = "account_manager(event.account.manager) and can_work(event.account.manager,event.account.location) and local_instant(event.account.renewal,\"00:00\",event.account.location.timezone,fold=earlier)<=now";
const WHEN: &str = "event.account.version==event.revision and event.account.active and account_manager(event.account.manager) and can_work(event.account.manager,event.account.location)";
const SUBJECT: &str =
    "format(\"Account renewal due\"@{nl=\"Klantverlenging nodig\"},locale=null)";
const BODY: &str = "format(\"Review the recorded renewal date; renewal remains a separate agreement action.\"@{nl=\"Controleer de vastgelegde verlengingsdatum; verlenging blijft een afzonderlijke overeenkomstactie.\"},locale=null)";

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

pub(super) fn prepare_renewal_due_send_guard(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    if owner.canonical != "success.renewal_due" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let account = t::symbol(program, "success.Account")?;
    let notice = t::symbol(program, "success.Notice")?;
    let customer = t::symbol(program, "customer.Customer")?;
    let event = t::symbol(program, "success.RenewalDue")?;
    let role = t::symbol(program, "success.account_manager")?;
    let can_work = t::symbol(program, "employee.can_work")?;
    let employee = t::symbol(program, "employee.Employee")?;
    let location = t::symbol(program, "rent_catalog.Location")?;
    t::checked_closure(
        context,
        scenario.node,
        &[can_work],
        &[account, event, notice, employee, location],
    )?;
    for id in [
        account, notice, customer, event, role, can_work, employee, location,
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
    if fields.len() != 2
        || program.symbols.get(fields[0].0 as usize)?.name != "account"
        || program.symbols.get(fields[1].0 as usize)?.name != "revision"
        || !program
            .types
            .symbol_types
            .get(&fields[0])
            .is_some_and(|ty| t::record_is(program, ty, "success.Account"))
        || program.types.symbol_types.get(&fields[1]) != Some(&ResolvedType::Scalar(Scalar::Int))
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
        || header.cond.and_then(|node| t::text(db, node)) != Some(REQUIRE)
        || top.verb != EffectVerb::If
        || top.cond.and_then(|node| t::text(db, node)) != Some(IF_TEXT)
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
        || send.when.and_then(|node| t::text(db, node)) != Some(WHEN)
        || !t::args_match(
            db,
            send,
            &[
                ("to", Some("event.account.email")),
                ("subject", Some(SUBJECT)),
                ("body", Some(BODY)),
            ],
        )
        || program.types.node_types.get(&send.when?) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || create.verb != EffectVerb::Create
        || !t::no_children(create)
        || create.target_node.and_then(|node| t::text(db, node)) != Some("Notice")
        || create.binding.as_deref() != Some("outcome")
        || !t::args_match(
            db,
            create,
            &[
                ("parent", Some("event.account")),
                ("revision", Some("event.revision")),
                ("account_revision", Some("event.revision")),
                ("recipient", Some("event.account.email")),
                ("subject", Some("\"Account renewal due\"")),
                (
                    "body",
                    Some(
                        "\"Review the recorded renewal date; renewal remains a separate agreement action.\"",
                    ),
                ),
                ("delivery", Some("notice")),
            ],
        )
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
    if ir_event != "success.RenewalDue" || !by.is_empty() || !params.is_empty() {
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
    let header_account = first_member(program, db, header_cond, "event.account")?;
    let header_revision = first_member(program, db, header_cond, "event.revision")?;
    let when_account = first_member(program, db, predicate, "event.account")?;
    let when_revision = first_member(program, db, predicate, "event.revision")?;
    let row_ty = ResolvedType::Record {
        symbol: account,
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
    let inputs = vec![
        PreparedSendInput {
            name: "eventTerm".into(),
            type_id: "success.Account".into(),
            value: event_value("account", row_ty, header_account),
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
    let source = t::source(program, db, predicate, "success")?;
    let rule = format!(
        "success.renewal_due.sendWhen.{}.{}.{}",
        source["sha256"].as_str()?,
        predicate.start,
        predicate.end
    );
    let descriptor = json!({"rule":rule,"owner":"success.renewal_due","source":source,
        "node":t::interval(predicate),"statement":t::interval(send.node),
        "target":"std.EmailV1.send","binding":"success.Mail","sourceBinding":"notice",
        "inputs":[{"name":"eventTerm","type":"success.Account"},
            {"name":"eventRevision","type":"int"}],
        "eventSource":{"event":"success.RenewalDue","handler":"success.renewal_due",
            "modelField":{"name":"account","model":"success.Account",
                "declaration":t::interval(header_account),
                "occurrence":t::interval(when_account),
                "fields":["active","email","location","manager","renewal"]},
            "revisionField":{"name":"revision","type":"int",
                "declaration":t::interval(header_revision),
                "occurrence":t::interval(when_revision)},
            "predicate":t::interval(predicate)}});
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
                model_field: "account".into(),
                revision_field: "revision".into(),
                lexical_alias: None,
            }),
        },
    ))
}
