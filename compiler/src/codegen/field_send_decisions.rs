//! Source-bound SEND guards for CanField visit completion.
//!
//! The generic SEND transport refuses parameter-rooted `send ... when=`
//! guards: a bare `job` parameter carries no checked owner-domain proof.
//! The exact `field.complete` Mail.send guard is proven here instead: one
//! top-level body, a single guarded SEND, the `job.state==done` predicate
//! bound to the declared `job:Job` parameter, the technician gate, and the
//! exact release/notice arguments. The sibling `record_inspection` call
//! keeps its own cross-operation refusal; this profile pins its nested
//! shape so an altered unsupported effect cannot inherit the SEND
//! admission, but it never lowers the call itself.
use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt, TypedExpr};
use super::scenario_decisions::FreshSourceContext;
use super::send_guards::{PreparedSendGuard, PreparedSendInput};
use super::term_decisions as t;
use crate::analysis::effects::{EffectTarget, EffectVerb};
use crate::analysis::resolve::{Binding, SymbolId, SymbolKind};
use crate::analysis::{NodeKey, ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};
use crate::syntax::SyntaxKind;
use serde_json::{Value, json};

const WHEN: &str = "job.state==done";
const OPERATION: &str = "std.EmailV1.send";
const RELEASE_OPERATION: &str = "shift.ScheduleV1.release";
const REQUIRE: &str = "job.employee.user==actor and job.employee.active and can_work(actor,job.location) and job.state in [in_progress,blocked] and not any(job.Replacement as candidate,candidate.state in [pending,unknown]) and trim(notes)!=\"\"";
const IF_COND: &str = "job.inspection!=null";
const THEN_REQUIRE: &str = "result!=null";
const ELSE_REQUIRE: &str = "count(answers)==0 and result==null";
const SUBJECT: &str = "format(\"Visit completed\"@{nl=\"Bezoek afgerond\"},locale=null)";

fn same_item(context: &FreshSourceContext<'_>, id: SymbolId) -> Option<()> {
    let original = context.ir().items.get(id.0 as usize)?;
    let fresh = context.fresh().items.get(id.0 as usize)?;
    (original.canonical == fresh.canonical
        && format!("{:?}", original.kind) == format!("{:?}", fresh.kind))
    .then_some(())
}

/// Walk top-level body effects to every SEND, keeping ancestor chains.
/// The completion body nests no `for`/`match`; only top-level sends are
/// admitted, so any nested guarded SEND refuses the census below.
fn source_sends<'a>(
    effects: &'a [crate::analysis::effects::Effect],
) -> Vec<(&'a crate::analysis::effects::Effect, bool)> {
    let mut out = Vec::new();
    fn visit<'a>(
        effects: &'a [crate::analysis::effects::Effect],
        nested: bool,
        out: &mut Vec<(&'a crate::analysis::effects::Effect, bool)>,
    ) {
        for effect in effects {
            if effect.verb == EffectVerb::Send {
                out.push((effect, nested));
            }
            visit(&effect.then_effects, true, out);
            visit(&effect.else_effects, true, out);
            for arm in &effect.match_arms {
                visit(&arm.effects, true, out);
            }
        }
    }
    visit(effects, false, &mut out);
    out
}

fn ir_send<'a>(statements: &'a [IrStmt]) -> Option<&'a IrStmt> {
    // Complete inventory: collect every guarded SEND, then require exactly
    // one. A third guarded SEND must never re-arm a reset scanner.
    fn visit<'a>(statements: &'a [IrStmt], out: &mut Vec<&'a IrStmt>) {
        for statement in statements {
            match statement {
                IrStmt::Send { when: Some(_), .. } => out.push(statement),
                IrStmt::If { then_branch, else_branch, .. } => {
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

pub(super) fn prepare_field_complete_send_guard(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    if owner.canonical != "field.complete" {
        return None;
    }
    t::original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let job_model = t::symbol(program, "field.Job")?;
    let report_model = t::symbol(program, "field.Report")?;
    t::checked_closure(context, scenario.node, &[], &[job_model])?;
    for id in [job_model, report_model] {
        same_item(context, id)?;
    }
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.expose_none
    {
        return None;
    }
    // Technician-only completion: the gate is part of the proof.
    let by = scenario.by?;
    if t::text(db, by) != Some("technician") {
        return None;
    }
    // The leading require selects the authorized actor and pre-state.
    if scenario.guards.len() != 1 {
        return None;
    }
    let require = &scenario.guards[0];
    if require.verb != EffectVerb::Require
        || !t::no_children(require)
        || t::text(db, require.cond?) != Some(REQUIRE)
    {
        return None;
    }
    // Five parameters in signature order; only the leading job roots
    // the guard.
    if scenario.params.len() != 5 {
        return None;
    }
    let names = ["job", "notes", "photo", "answers", "result"];
    let type_texts = ["Job", "text", "file?", "Inspection.answers", "Inspection.result?"];
    if scenario.params.len() != names.len() {
        return None;
    }
    for ((param, want), want_ty) in scenario.params.iter().zip(names).zip(type_texts) {
        let symbol = program.symbols.get(param.param.0 as usize)?;
        if symbol.name != *want
            || t::text(db, param.type_node) != Some(want_ty)
        {
            return None;
        }
    }
    // Answers ships an explicit empty default; every other parameter is
    // default-free (nullable markers are not defaults).
    for (index, param) in scenario.params.iter().enumerate() {
        if param.default.is_some() != (index == 3) {
            return None;
        }
    }
    let job_id = scenario.params.first()?.param;
    let job_ty = program.symbols.get(job_id.0 as usize)?;
    let SymbolKind::Param { .. } = job_ty.kind else {
        return None;
    };
    let original_type = program.types.symbol_types.get(&job_id)?.clone();
    if !t::record_is(program, &original_type, "field.Job") {
        return None;
    }
    // Full body shape: the inspection branch (with its unlowered call),
    // the report create, the done SET, the submitted emit, the unguarded
    // release, the delivery SET, and the guarded notice. Any added,
    // removed, or reordered top-level effect refuses admission.
    if scenario.effects.len() != 7 {
        return None;
    }
    let [branch, create, set_done, emit, release, set_delivery, mail] =
        scenario.effects.as_slice()
    else {
        return None;
    };
    if branch.verb != EffectVerb::If
        || t::text(db, branch.cond?) != Some(IF_COND)
        || branch.then_effects.len() != 2
        || branch.else_effects.len() != 1
    {
        return None;
    }
    let [then_require, call] = branch.then_effects.as_slice() else {
        return None;
    };
    let [else_require] = branch.else_effects.as_slice() else {
        return None;
    };
    if then_require.verb != EffectVerb::Require
        || !t::no_children(then_require)
        || t::text(db, then_require.cond?) != Some(THEN_REQUIRE)
        || else_require.verb != EffectVerb::Require
        || !t::no_children(else_require)
        || t::text(db, else_require.cond?) != Some(ELSE_REQUIRE)
    {
        return None;
    }
    // The nested call keeps its cross-operation refusal elsewhere; pin
    // its resolved canonical operation, target spelling, and complete
    // argument correspondence so an altered unsupported effect cannot
    // inherit this SEND admission. Source alias text alone could
    // retarget the call while keeping the spelling.
    let call_op = match call.target {
        Some(EffectTarget::Operation(id)) => id,
        _ => return None,
    };
    if program.symbols.get(call_op.0 as usize)?.canonical != "maintain.inspect"
        || !t::no_children(call)
        || call.verb != EffectVerb::Call
        || t::text(db, call.target_node?) != Some("record_inspection")
        || !t::args_match(
            db,
            call,
            &[
                ("inspection", Some("job.inspection")),
                ("answers", None),
                ("result", None),
                ("evidence", Some("notes")),
            ],
        )
    {
        return None;
    }
    if create.verb != EffectVerb::Create
        || !t::no_children(create)
        || !matches!(create.target, Some(EffectTarget::Model(id)) if id == report_model)
        || create.binding.as_deref() != Some("report")
        || !t::args_match(
            db,
            create,
            &[
                ("parent", Some("job")),
                ("notes", None),
                ("photo", None),
            ],
        )
    {
        return None;
    }
    // Record{model} identifies the model, not the target record
    // expression: pin the exact authored statement so `set otherJob`
    // can never inherit the done-state proof.
    if set_done.verb != EffectVerb::Set
        || !t::no_children(set_done)
        || !matches!(set_done.target, Some(EffectTarget::Record { model: Some(id) }) if id == job_model)
        || t::text(db, set_done.node) != Some("set job {state=done}")
        || !t::args_match(db, set_done, &[("state", Some("done"))])
    {
        return None;
    }
    if emit.verb != EffectVerb::Emit
        || !t::no_children(emit)
        || !t::args_match(db, emit, &[("report", None)])
    {
        return None;
    }
    let report_event = match emit.target {
        Some(EffectTarget::Event(id)) => id,
        _ => return None,
    };
    if program.symbols.get(report_event.0 as usize)?.canonical != "field.ReportSubmitted" {
        return None;
    }
    if release.verb != EffectVerb::Send
        || !t::no_children(release)
        || release.when.is_some()
        || release.binding.as_deref() != Some("release")
        || t::text(db, release.target_node?) != Some("StaffSchedule.release")
        || !t::args_match(
            db,
            release,
            &[
                ("source", Some("job.schedule_source??job.source")),
                ("revision", Some("job.schedule_revision")),
            ],
        )
    {
        return None;
    }
    if set_delivery.verb != EffectVerb::Set
        || !t::no_children(set_delivery)
        || !matches!(set_delivery.target, Some(EffectTarget::Record { model: Some(id) }) if id == job_model)
        || t::text(db, set_delivery.node) != Some("set job {release_delivery=release.id,released=false}")
        || !t::args_match(
            db,
            set_delivery,
            &[
                ("release_delivery", Some("release.id")),
                ("released", Some("false")),
            ],
        )
    {
        return None;
    }
    if mail.verb != EffectVerb::Send
        || !t::no_children(mail)
        || mail.binding.as_deref() != Some("notice")
        || t::text(db, mail.target_node?) != Some("Mail.send")
        || mail.when.and_then(|node| t::text(db, node)) != Some(WHEN)
        || !t::args_match(
            db,
            mail,
            &[
                ("to", Some("job.contact")),
                ("subject", Some(SUBJECT)),
                ("body", Some("notes")),
            ],
        )
    {
        return None;
    }
    let predicate = mail.when?;
    // Every predicate root is the single `job` parameter; nothing else
    // may reach the Tier-1 guard.
    let trees = context.trees();
    let tree = &trees.iter().find(|(file, _)| *file == predicate.file)?.1;
    let predicate_node = tree
        .descendants()
        .find(|node| NodeKey::of(*node) == predicate)?;
    let mut roots = Vec::new();
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
            return None;
        }
        let Binding::Symbol(id) = bound else {
            return None;
        };
        if *id != job_id || t::text(db, key) != Some("job") {
            return None;
        }
        roots.push(key);
    }
    if roots.is_empty() {
        return None;
    }
    let job_ty = program.types.node_types.get(&roots[0])?.clone();
    if !t::record_is(program, &job_ty, "field.Job") {
        return None;
    }
    let source = t::source(program, db, predicate, "field")?;
    let rule = format!(
        "field.complete.sendWhen.{}.{}.{}",
        source["sha256"].as_str()?,
        predicate.start,
        predicate.end
    );
    let input = PreparedSendInput {
        name: "job".into(),
        type_id: "field.Job".into(),
        value: TypedExpr::new(
            IrExpr::Name("job".into()),
            job_ty,
            t::span(roots[0]),
        ),
        declaration: scenario.params.first()?.node,
        symbol: Some(job_id),
        owner: owner.id,
        ordinal: 0,
        narrowing: None,
    };
    let descriptor = json!({"rule":rule,"owner":"field.complete","source":source,
        "node":t::interval(predicate),"statement":t::interval(mail.node),
        "target":OPERATION,"binding":"field.Mail","sourceBinding":"notice",
        "inputs":[{"name":"job","type":"field.Job"}]});
    // Mirror the lowered IR: one leading require, the exact seven-effect
    // body, five parameters, the technician gate, and a single guarded
    // SEND whose span and predicate match the checked source.
    let IrItemKind::Scenario {
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        result: None,
        read: false,
        params: ir_params,
        guards: ir_guards,
        effects: ir_effects,
        by: ir_by,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if ir_params.len() != 5 {
        return None;
    }
    let [super::ir::IrGuard::Role(role)] = ir_by.as_slice() else {
        return None;
    };
    if role != "field.technician" {
        return None;
    }
    let [IrStmt::Require { span: guard_span, .. }] = ir_guards.as_slice() else {
        return None;
    };
    let [
        IrStmt::If { span: if_span, .. },
        IrStmt::Create { span: create_span, model: create_model, .. },
        IrStmt::Set { span: set_span, .. },
        IrStmt::Emit { span: emit_span, .. },
        IrStmt::Send { span: release_span, operation: release_op, when: None, binding: release_binding, .. },
        IrStmt::Set { span: delivery_span, .. },
        IrStmt::Send { span: mail_span, operation, when: Some(ir_when), binding: Some(ir_binding), deployment_binding, .. },
    ] = ir_effects.as_slice()
    else {
        return None;
    };
    if *guard_span != t::span(require.node)
        || *if_span != t::span(branch.node)
        || *create_span != t::span(create.node)
        || create_model != "field.Report"
        || *set_span != t::span(set_done.node)
        || *emit_span != t::span(emit.node)
        || *release_span != t::span(release.node)
        || release_op != RELEASE_OPERATION
        || release_binding.as_deref() != Some("release")
        || *delivery_span != t::span(set_delivery.node)
        || *mail_span != t::span(mail.node)
        || operation != OPERATION
        || ir_binding != "notice"
        || deployment_binding.as_deref() != Some("field.Mail")
        || ir_when.span != t::span(predicate)
    {
        return None;
    }
    if !matches!(ir_send(ir_effects), Some(IrStmt::Send { span, .. }) if *span == t::span(mail.node))
    {
        return None;
    }
    let sends = source_sends(&scenario.effects);
    if sends.len() != 2
        || sends.iter().any(|(_, nested)| *nested)
        || !sends.iter().any(|(effect, _)| t::span(effect.node) == t::span(release.node))
        || !sends.iter().any(|(effect, _)| t::span(effect.node) == t::span(mail.node))
    {
        return None;
    }
    Some((
        t::span(mail.node),
        PreparedSendGuard {
            rule,
            predicate: ir_when.clone(),
            descriptor,
            inputs: vec![input],
            event_source: None,
        },
    ))
}
