//! Source-bound event decisions with owner collection observations.
//!
//! The transport is reusable, while this first admission is deliberately the
//! exact authored maintenance reminder. A different helper, query domain,
//! dispatch guard, or write cannot acquire an owner decision by resemblance.
use serde_json::{Value, json};
use std::collections::HashMap;

use crate::analysis::effects::{Effect, EffectTarget, EffectVerb, HandlerSource};
use crate::analysis::resolve::{Binding, ContextVar, ModelOwner, SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::types::SelectedCallTarget;
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt, TypedExpr};
use super::source_context::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};
use super::send_guards::{PreparedSendEventSource, PreparedSendGuard, PreparedSendInput};

const GUARD: &str = "inspection_pending(inspection) and inspection.template_version==event.revision and inspection.parent.revision==event.revision and inspection.inspector==inspection.parent.assignee and local_instant(inspection.due,\"09:00\",inspection.parent.parent.location.timezone,fold=earlier)<=now and plan_eligible(inspection.parent) and inspection.asset_epoch==inspection.parent.asset_epoch";
const PENDING: &str = "inspection.result==pending and not inspection.cancelled and not inspection_superseded(inspection)";
const SUPERSEDED: &str =
    "any(inspection.parent.parent.Cancellation as change,matches_cancellation(change,inspection))";
const CANCELLATION: &str = "change.parent==inspection.parent.parent and inspection.due>change.cutoff and ((change.reason==plan_revised and change.plan==inspection.parent and inspection.template_version<=change.through) or (change.reason==asset_retired and inspection.asset_epoch<=change.through))";
const ELIGIBLE: &str = "plan.active and not plan.parent.retired and plan.asset_epoch==plan.parent.inspection_epoch and technician(plan.assignee) and can_work(plan.assignee,plan.parent.location)";
const CAN_WORK: &str = "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))";

fn slice<'a>(db: &'a SourceDb, key: NodeKey) -> Option<&'a str> {
    db.get(key.file)?
        .text
        .get(key.start as usize..key.end as usize)
}

fn span(key: NodeKey) -> Span {
    Span::new(key.file, key.start, key.end)
}

fn interval(key: NodeKey) -> Value {
    json!({"start":key.start,"end":key.end,"kind":key.kind})
}

fn plain_interval(key: NodeKey) -> Value {
    json!({"start":key.start,"end":key.end})
}

fn source(program: &CheckedProgram, db: &SourceDb, key: NodeKey, module: &str) -> Option<Value> {
    let owner = program
        .modules
        .iter()
        .find(|owner| owner.name == module && owner.file == key.file)?;
    let text = db.get(owner.file)?;
    if key.end as usize > text.text.len() || text.sha256 != sha256_hex(text.text.as_bytes()) {
        return None;
    }
    Some(json!({"path":text.path,"sha256":text.sha256,"module":module}))
}

fn site(
    program: &CheckedProgram,
    db: &SourceDb,
    module: &str,
    node: NodeKey,
    statement: NodeKey,
    kind: &str,
) -> Option<Value> {
    let origin = source(program, db, node, module)?;
    if node.file != statement.file || node.start < statement.start || node.end > statement.end {
        return None;
    }
    let id = sha256_hex(
        format!(
            "event-decision/v1:{kind}:{}:{}:{}:{}:{}",
            origin["sha256"].as_str()?,
            node.start,
            node.end,
            statement.start,
            statement.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"source":origin,"node":interval(node),"statement":interval(statement)}))
}

fn symbol(program: &CheckedProgram, canonical: &str) -> Option<SymbolId> {
    let mut found = program
        .symbols
        .iter()
        .filter(|symbol| symbol.canonical == canonical);
    let id = found.next()?.id;
    found.next().is_none().then_some(id)
}

fn record_is(program: &CheckedProgram, ty: &ResolvedType, name: &str) -> bool {
    matches!(ty, ResolvedType::Record {symbol,stored:true}
        if program.symbols.get(symbol.0 as usize).is_some_and(|s| s.canonical == name))
}

fn derive_expr(
    program: &CheckedProgram,
    db: &SourceDb,
    canonical: &str,
    expected: &str,
    params: &[&str],
) -> Option<(SymbolId, NodeKey)> {
    let id = symbol(program, canonical)?;
    let data = program.effects.derives.get(&id)?;
    let declaration = program.symbols.get(id.0 as usize)?;
    let expr = data.expr?;
    let module_name = canonical.split('.').next()?;
    let module = program.modules.iter().find(|m| m.name == module_name)?;
    if data.derive != id
        || data.module != declaration.module
        || declaration.module != module.id
        || slice(db, expr)?.trim() != expected
        || data.params.len() != params.len()
        || program.types.node_types.get(&expr) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.symbol_results.get(&id) != Some(&Some(ResolvedType::Scalar(Scalar::Bool)))
        || data.params.iter().zip(params).any(|(param, expected)| {
            param.default.is_some()
                || !program
                    .types
                    .symbol_types
                    .get(&param.param)
                    .is_some_and(|ty| {
                        if *expected == "user" {
                            *ty == ResolvedType::Scalar(Scalar::User)
                        } else {
                            record_is(program, ty, expected)
                        }
                    })
        })
    {
        return None;
    }
    Some((id, expr))
}

fn unique_call(program: &CheckedProgram, within: NodeKey, target: SymbolId) -> Option<NodeKey> {
    let mut calls = program.types.selected_calls.iter().filter(|(node, selected)| {
        node.kind == SyntaxKind::Call as u8 && node.file == within.file
            && node.start >= within.start && node.end <= within.end
            && matches!(selected.target, SelectedCallTarget::DeriveFn(id) | SelectedCallTarget::Role(id) if id == target)
    }).map(|(node,_)| *node);
    let call = calls.next()?;
    calls.next().is_none().then_some(call)
}

fn unique_any(program: &CheckedProgram, within: NodeKey, model: SymbolId) -> Option<NodeKey> {
    let mut calls = program
        .types
        .checked_collection_calls
        .values()
        .filter(|fact| {
            fact.node.file == within.file
                && fact.node.start >= within.start
                && fact.node.end <= within.end
                && fact.builtin == "any"
                && fact.model == model
                && fact
                    .predicate
                    .as_ref()
                    .is_some_and(|predicate| predicate.ty == ResolvedType::Scalar(Scalar::Bool))
        })
        .map(|fact| fact.node);
    let call = calls.next()?;
    calls.next().is_none().then_some(call)
}

fn model_graph(program: &CheckedProgram) -> Option<()> {
    let inspection = symbol(program, "maintain.Inspection")?;
    let plan = symbol(program, "maintain.Plan")?;
    let asset = symbol(program, "maintain.Asset")?;
    let cancellation = symbol(program, "maintain.Cancellation")?;
    let employee = symbol(program, "employee.Employee")?;
    let location = symbol(program, "rent_catalog.Location")?;
    (program.effects.models.get(&inspection)?.owner == ModelOwner::ChildOf(plan)
        && program.effects.models.get(&plan)?.owner == ModelOwner::ChildOf(asset)
        && program.effects.models.get(&cancellation)?.owner == ModelOwner::ChildOf(asset)
        && program.effects.models.get(&asset)?.owner == ModelOwner::Team
        && program.effects.models.get(&employee)?.owner == ModelOwner::Team
        && program.effects.models.get(&location)?.owner == ModelOwner::Team)
        .then_some(())
}

fn no_children(effect: &Effect) -> bool {
    effect.then_effects.is_empty() && effect.else_effects.is_empty() && effect.match_arms.is_empty()
}

fn checked_closure_diagnostics(
    context: &FreshSourceContext<'_>,
    scenario: NodeKey,
    helpers: &[SymbolId],
    models: &[SymbolId],
    event: SymbolId,
    role: SymbolId,
) -> Option<()> {
    let program = context.original();
    let mut spans = vec![
        span(scenario),
        span(program.effects.records.get(&event)?.node),
        span(program.effects.roles.get(&role)?.node),
    ];
    for helper in helpers {
        spans.push(span(program.effects.derives.get(helper)?.node));
    }
    for model in models {
        spans.push(span(program.effects.models.get(model)?.node));
    }
    let overlaps = |a: Span, b: Span| a.file == b.file && a.start < b.end && b.start < a.end;
    if context.ir_diagnostics().iter().any(|diagnostic| {
        diagnostic.severity == crate::diagnostic::Severity::Error
            && spans.iter().any(|source| {
                overlaps(*source, diagnostic.primary)
                    || diagnostic
                        .related
                        .iter()
                        .any(|related| overlaps(*source, related.span))
            })
    }) {
        return None;
    }
    Some(())
}

fn checked_args(db: &SourceDb, effect: &Effect, entries: &[(&str, &str)]) -> bool {
    effect.args.len() == entries.len()
        && effect.args.iter().zip(entries).all(|(arg, (name, value))| {
            arg.key == *name && arg.value.and_then(|node| slice(db, node)) == Some(*value)
        })
}

fn frame(
    program: &CheckedProgram,
    db: &SourceDb,
    module: &str,
    call: NodeKey,
    derive: &str,
) -> Option<Value> {
    Some(
        json!({"source":source(program,db,call,module)?,"callSite":interval(call),"derive":derive}),
    )
}

fn query_site(
    program: &CheckedProgram,
    db: &SourceDb,
    decision: &str,
    call: NodeKey,
    model: &str,
    domain_kind: &str,
    owner_path: &[&str],
    chain: Vec<Value>,
    module: &str,
) -> Option<Value> {
    let fact = program.types.checked_collection_calls.get(&call)?;
    let alias = fact.alias;
    let predicate = fact.predicate.as_ref()?.node;
    let origin = source(program, db, call, module)?;
    if slice(db, call)?.trim()
        != match model {
            "maintain.Cancellation" => SUPERSEDED,
            "employee.Employee" => CAN_WORK,
            _ => return None,
        }
        || fact.model != symbol(program, model)?
        || fact.query.file != call.file
        || alias.file != call.file
        || predicate.file != call.file
    {
        return None;
    }
    let id = sha256_hex(
        format!(
            "event-query/v1:{decision}:{model}:{}:{}:{}:{chain:?}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"decision":decision,"source":origin,
        "callSite":interval(call),"aliasSite":interval(alias),"predicateSite":interval(predicate),
        "model":model,"domainKind":domain_kind,"ownerPath":owner_path,"deriveChain":chain}))
}

fn role_site(
    program: &CheckedProgram,
    db: &SourceDb,
    decision: &str,
    call: NodeKey,
    chain: Vec<Value>,
) -> Option<Value> {
    let origin = source(program, db, call, "maintain")?;
    let id = sha256_hex(
        format!(
            "event-role/v1:{decision}:{}:{}:{}:{chain:?}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"decision":decision,"source":origin,
        "callSite":interval(call),"role":"maintain.technician","deriveChain":chain}))
}

/// Construct one complete source-bound owner decision and guarded SEND Rule.
/// Every helper body is an exact checked expression; the original and fresh
/// IR cohorts have already been matched by `FreshSourceContext`/SEND setup.
pub(super) fn prepare_maintain_remind(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<(Span, PreparedSendGuard)> {
    if owner.canonical != "maintain.remind" {
        return None;
    }
    let program = context.original();
    let db = context.db();
    let resolved = context.resolved();
    model_graph(program)?;
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let event_id = symbol(program, "maintain.Reminder")?;
    let inspection_id = symbol(program, "maintain.Inspection")?;
    let plan_id = symbol(program, "maintain.Plan")?;
    let cancellation_id = symbol(program, "maintain.Cancellation")?;
    let employee_id = symbol(program, "employee.Employee")?;
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || !matches!(scenario.on, Some(HandlerSource::Event(id)) if id == event_id)
        || scenario.read
        || scenario.by.is_some()
        || scenario.result.is_some()
        || scenario.cohort.is_some()
        || !scenario.params.is_empty()
        || !scenario.guards.is_empty()
    {
        return None;
    }
    let SymbolKind::Event { fields } = &program.symbols.get(event_id.0 as usize)?.kind else {
        return None;
    };
    if fields.len() != 2 {
        return None;
    }
    let row_field = fields.iter().find(|field| {
        program
            .symbols
            .get(field.0 as usize)
            .is_some_and(|symbol| symbol.name == "inspection")
    })?;
    let revision_field = fields.iter().find(|field| {
        program
            .symbols
            .get(field.0 as usize)
            .is_some_and(|symbol| symbol.name == "revision")
    })?;
    let (row_type_node, revision_type_node) = match (
        &program.symbols.get(row_field.0 as usize)?.kind,
        &program.symbols.get(revision_field.0 as usize)?.kind,
    ) {
        (
            SymbolKind::Field {
                owner: a,
                type_node: row,
            },
            SymbolKind::Field {
                owner: b,
                type_node: revision,
            },
        ) if *a == event_id && *b == event_id => (*row, *revision),
        _ => return None,
    };
    if !program
        .types
        .symbol_types
        .get(row_field)
        .is_some_and(|ty| record_is(program, ty, "maintain.Inspection"))
        || program.types.symbol_types.get(revision_field)
            != Some(&ResolvedType::Scalar(Scalar::Int))
    {
        return None;
    }
    let [binding, branch] = scenario.effects.as_slice() else {
        return None;
    };
    let [send, set] = branch.then_effects.as_slice() else {
        return None;
    };
    let let_value = binding.value?;
    let if_value = branch.cond?;
    let when_value = send.when?;
    if binding.verb != EffectVerb::Let
        || binding.binding.as_deref() != Some("inspection")
        || slice(db, let_value)? != "event.inspection"
        || !no_children(binding)
        || branch.verb != EffectVerb::If
        || slice(db, if_value)?.trim() != GUARD
        || !branch.else_effects.is_empty()
        || !branch.match_arms.is_empty()
        || send.verb != EffectVerb::Send
        || !no_children(send)
        || send.binding.as_deref() != Some("notice")
        || slice(db, when_value)?.trim() != GUARD
        || !checked_args(
            db,
            send,
            &[
                ("to", "inspection.reminder_email"),
                (
                    "subject",
                    "format(\"Inspection due\"@{nl=\"Inspectie gepland\"},locale=null)",
                ),
                ("body", "inspection.parent.name"),
            ],
        )
        || set.verb != EffectVerb::Set
        || !no_children(set)
        || !matches!(set.target, Some(EffectTarget::Record {model:Some(id)}) if id == inspection_id)
        || !checked_args(db, set, &[("reminded_at", "now")])
        || program.types.node_types.get(&if_value) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&when_value) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || !program
            .types
            .node_types
            .get(&let_value)
            .is_some_and(|ty| record_is(program, ty, "maintain.Inspection"))
    {
        return None;
    }
    let mut event_roots = resolved
        .node_binding
        .iter()
        .filter(|(node, binding)| {
            node.file == let_value.file
                && node.start >= let_value.start
                && node.end <= let_value.end
                && matches!(binding, Binding::Context(ContextVar::Event))
        })
        .map(|(node, _)| *node);
    let event_root = event_roots.next()?;
    if event_roots.next().is_some() || slice(db, event_root)? != "event" {
        return None;
    }

    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(name)),
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
        return None;
    };
    let [
        IrStmt::Let {
            name: ir_name,
            value: ir_let,
            span: ir_let_span,
        },
        IrStmt::If {
            cond: ir_if,
            then_branch,
            else_branch,
            span: ir_if_span,
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Send {
            operation,
            args,
            when: Some(ir_when),
            binding: ir_binding,
            span: ir_send_span,
            deployment_binding,
            ..
        },
        IrStmt::Set {
            record,
            changes,
            when: None,
            span: ir_set_span,
        },
    ] = then_branch.as_slice()
    else {
        return None;
    };
    if name != "maintain.Reminder"
        || !by.is_empty()
        || !guards.is_empty()
        || ir_name != "inspection"
        || *ir_let_span != span(binding.node)
        || ir_let.span != span(let_value)
        || !matches!(&ir_let.expr,IrExpr::Member {base,field} if field == "inspection"
            && matches!(&base.expr,IrExpr::Name(name) if name == "event"))
        || !else_branch.is_empty()
        || *ir_if_span != span(branch.node)
        || ir_if.span != span(if_value)
        || operation != "std.EmailV1.send"
        || ir_binding.as_deref() != Some("notice")
        || deployment_binding.as_deref() != Some("maintain.Mail")
        || *ir_send_span != span(send.node)
        || ir_when.span != span(when_value)
        || *ir_set_span != span(set.node)
        || !matches!(&record.expr,IrExpr::Name(name) if name == "inspection")
        || !record_is(program, &record.ty, "maintain.Inspection")
        || !matches!(&changes.expr,IrExpr::Object(entries) if entries.len() == 1
            && entries[0].0 == "reminded_at" && matches!(&entries[0].1.expr,IrExpr::Member {base,field}
                if field == "now" && matches!(&base.expr,IrExpr::Name(name) if name == "c")))
        || !matches!(&args.expr,IrExpr::Object(entries) if entries.len() == 3
            && entries.iter().map(|entry| entry.0.as_str()).eq(["to","subject","body"]))
    {
        return None;
    }

    let (pending, pending_expr) = derive_expr(
        program,
        db,
        "maintain.inspection_pending",
        PENDING,
        &["maintain.Inspection"],
    )?;
    let (superseded, superseded_expr) = derive_expr(
        program,
        db,
        "maintain.inspection_superseded",
        SUPERSEDED,
        &["maintain.Inspection"],
    )?;
    let (matches_cancellation, _match_expr) = derive_expr(
        program,
        db,
        "maintain.matches_cancellation",
        CANCELLATION,
        &["maintain.Cancellation", "maintain.Inspection"],
    )?;
    let (eligible, eligible_expr) = derive_expr(
        program,
        db,
        "maintain.plan_eligible",
        ELIGIBLE,
        &["maintain.Plan"],
    )?;
    let (can_work, can_work_expr) = derive_expr(
        program,
        db,
        "employee.can_work",
        CAN_WORK,
        &["user", "rent_catalog.Location"],
    )?;
    let role = symbol(program, "maintain.technician")?;
    if !matches!(
        program.symbols.get(role.0 as usize)?.kind,
        SymbolKind::Role { .. }
    ) {
        return None;
    }
    let pending_inner = unique_call(program, pending_expr, superseded)?;
    let match_inner = unique_call(program, superseded_expr, matches_cancellation)?;
    let eligible_role = unique_call(program, eligible_expr, role)?;
    let eligible_work = unique_call(program, eligible_expr, can_work)?;
    let cancellation_any = unique_any(program, superseded_expr, cancellation_id)?;
    let employee_any = unique_any(program, can_work_expr, employee_id)?;
    checked_closure_diagnostics(
        context,
        scenario.node,
        &[
            pending,
            superseded,
            matches_cancellation,
            eligible,
            can_work,
        ],
        &[
            inspection_id,
            plan_id,
            cancellation_id,
            employee_id,
            symbol(program, "maintain.Asset")?,
            symbol(program, "rent_catalog.Location")?,
        ],
        event_id,
        role,
    )?;
    if match_inner.start < cancellation_any.start
        || eligible_role.start > eligible_work.start
        || !record_is(
            program,
            program
                .types
                .symbol_types
                .get(&program.effects.derives.get(&eligible)?.params[0].param)?,
            "maintain.Plan",
        )
        || plan_id
            != program
                .effects
                .models
                .get(&inspection_id)
                .and_then(|m| match m.owner {
                    ModelOwner::ChildOf(id) => Some(id),
                    _ => None,
                })?
    {
        return None;
    }
    let source_guard = source(program, db, when_value, "maintain")?;
    let mut query_sites = Vec::new();
    let mut role_sites = Vec::new();
    for (decision, guard) in [("if", if_value), ("when", when_value)] {
        let pending_outer = unique_call(program, guard, pending)?;
        let eligible_outer = unique_call(program, guard, eligible)?;
        let cancel_chain = vec![
            frame(
                program,
                db,
                "maintain",
                pending_outer,
                "maintain.inspection_pending",
            )?,
            frame(
                program,
                db,
                "maintain",
                pending_inner,
                "maintain.inspection_superseded",
            )?,
        ];
        let employee_chain = vec![
            frame(
                program,
                db,
                "maintain",
                eligible_outer,
                "maintain.plan_eligible",
            )?,
            frame(program, db, "maintain", eligible_work, "employee.can_work")?,
        ];
        query_sites.push(query_site(
            program,
            db,
            decision,
            cancellation_any,
            "maintain.Cancellation",
            "event-child",
            &["parent", "parent"],
            cancel_chain,
            "maintain",
        )?);
        query_sites.push(query_site(
            program,
            db,
            decision,
            employee_any,
            "employee.Employee",
            "tenant-root",
            &[],
            employee_chain,
            "employee",
        )?);
        role_sites.push(role_site(
            program,
            db,
            decision,
            eligible_role,
            vec![frame(
                program,
                db,
                "maintain",
                eligible_outer,
                "maintain.plan_eligible",
            )?],
        )?);
    }
    let let_site = site(program, db, "maintain", let_value, binding.node, "let")?;
    let if_site = site(program, db, "maintain", if_value, branch.node, "if")?;
    let when_site = site(program, db, "maintain", when_value, send.node, "when")?;
    let send_site = site(program, db, "maintain", send.node, send.node, "send")?;
    let mut set_site = site(program, db, "maintain", set.node, set.node, "set")?;
    set_site["target"] = json!("eventTerm");
    set_site["field"] = json!("reminded_at");
    set_site["value"] = json!("now");
    let owner_decision = json!({"version":1,"owner":"maintain.remind","event":"maintain.Reminder",
        "rowField":"inspection","rowModel":"maintain.Inspection","revisionField":"revision",
        "letSite":let_site,"ifSite":if_site,"whenSite":when_site,"sendSite":send_site,
        "setSite":set_site,"querySites":query_sites,"roleSites":role_sites});

    let mut revision_uses = program
        .types
        .node_types
        .iter()
        .filter(|(node, ty)| {
            node.kind == SyntaxKind::Member as u8
                && node.file == when_value.file
                && node.start >= when_value.start
                && node.end <= when_value.end
                && **ty == ResolvedType::Scalar(Scalar::Int)
                && slice(db, **node) == Some("event.revision")
        })
        .map(|(node, _)| *node)
        .collect::<Vec<_>>();
    revision_uses.sort_by_key(|node| node.start);
    let [revision_use, _second_use] = revision_uses.as_slice() else {
        return None;
    };
    let row_ty = ResolvedType::Record {
        symbol: inspection_id,
        stored: true,
    };
    let event_ty = ResolvedType::Record {
        symbol: event_id,
        stored: false,
    };
    let event_value = |field: &str, ty: ResolvedType, at: NodeKey| {
        TypedExpr::new(
            IrExpr::Member {
                base: Box::new(TypedExpr::new(
                    IrExpr::Name("event".into()),
                    event_ty.clone(),
                    span(event_root),
                )),
                field: field.into(),
            },
            ty,
            span(at),
        )
    };
    let inputs = vec![
        PreparedSendInput {
            name: "eventTerm".into(),
            type_id: "maintain.Inspection".into(),
            value: event_value("inspection", row_ty, let_value),
            declaration: row_type_node,
            symbol: None,
            owner: owner.id,
            ordinal: 0,
            narrowing: None,
        },
        PreparedSendInput {
            name: "eventRevision".into(),
            type_id: "int".into(),
            value: event_value("revision", ResolvedType::Scalar(Scalar::Int), *revision_use),
            declaration: revision_type_node,
            symbol: None,
            owner: owner.id,
            ordinal: 1,
            narrowing: None,
        },
    ];
    let rule = format!(
        "{}.sendWhen.{}.{}.{}",
        owner.canonical,
        source_guard["sha256"].as_str()?,
        when_value.start,
        when_value.end
    );
    let event_source = json!({"event":"maintain.Reminder","handler":"maintain.remind",
        "modelField":{"name":"inspection","model":"maintain.Inspection",
            "fields":["asset_epoch","cancelled","due","inspector","reminder_email","result","template_version"],
            "declaration":{"start":row_type_node.start,"end":row_type_node.end},
            "occurrence":{"start":let_value.start,"end":let_value.end}},
        "revisionField":{"name":"revision","type":"int",
            "declaration":{"start":revision_type_node.start,"end":revision_type_node.end},
            "occurrence":{"start":revision_use.start,"end":revision_use.end}},
        "predicate":{"start":when_value.start,"end":when_value.end},
        "ownerDecision":owner_decision});
    let descriptor = json!({"rule":rule,"owner":owner.canonical,"source":source_guard,
        "node":{"start":when_value.start,"end":when_value.end},
        "statement":{"start":send.node.start,"end":send.node.end},
        "target":operation,"binding":deployment_binding,"sourceBinding":send.binding,
        "inputs":[{"name":"eventTerm","type":"maintain.Inspection"},{"name":"eventRevision","type":"int"}],
        "eventSource":event_source});
    Some((
        span(send.node),
        PreparedSendGuard {
            rule,
            predicate: ir_when.clone(),
            descriptor,
            inputs,
            event_source: Some(PreparedSendEventSource {
                model_slot: "eventTerm",
                revision_slot: "eventRevision",
                model_field: "inspection".into(),
                revision_field: "revision".into(),
                lexical_alias: Some("inspection".into()),
            }),
        },
    ))
}

/// An event decision owns its complete Boolean read lifetime in State. The
/// ordinary return has no borrowed query or scalar dependency; its only
/// selection is the single implicit void fallthrough after the authenticated
/// IF/SEND/SET sequence.
pub(super) fn collect_maintain_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
    guards: &HashMap<Span, PreparedSendGuard>,
) -> Option<NativeScenarioReceipt> {
    let (span, expected) = prepare_maintain_remind(context, item)?;
    if collect_maintain_membership_sites(context, item)?.len() != 2 {
        return None;
    }
    let actual = guards.get(&span)?;
    if actual.rule != expected.rule
        || actual.descriptor != expected.descriptor
        || actual.inputs.len() != 2
        || actual.event_source.as_ref()?.lexical_alias.as_deref() != Some("inspection")
    {
        return None;
    }
    let decision = actual
        .descriptor
        .get("eventSource")?
        .get("ownerDecision")?
        .clone();
    if decision
        != expected
            .descriptor
            .get("eventSource")?
            .get("ownerDecision")?
            .clone()
    {
        return None;
    }
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let authored = context.db().get(scenario.node.file)?;
    let origin = DisclosureSource {
        path: authored.path.clone(),
        sha256: authored.sha256.clone(),
        module: "maintain".into(),
    };
    let source = transport_source(&origin, entry_module)?;
    let id = sha256_hex(
        format!(
            "event-void-return/v1:{}:{}:{}",
            source.sha256, scenario.node.start, scenario.node.end
        )
        .as_bytes(),
    );
    let returned = ReceiptReturn {
        id: id.clone(),
        source: source.clone(),
        influences: Vec::new(),
        dependencies: Vec::new(),
        intrinsics: Vec::new(),
        projection: None,
    };
    Some(NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan { retained_guarded_handler: None, source_loops: None, source_emissions: None,
            version: 1,
            source,
            event_decision: Some(decision),
            term_decision: None,
            leave_request_decision: None, leave_decide_decision: None, refer_reject_decision: None, member_retry_decision: None, rent_movement_refund_decision: None,
            invoice_collect_decision: None, rent_notice_decision: None, invoice_issue_decision: None, observe_venue_decision: None, success_renewal_decision: None, purchase_receive_all: None, event_notice_audit: None,queries: Vec::new(),
            returns: vec![returned],
        },
        dependencies: HashMap::new(),
        intrinsics: HashMap::new(),
        decisions: HashMap::new(),
        decision_keys: HashMap::new(),
        calls: HashMap::new(),
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

/// The two invocations of `employee.can_work` share one physical
/// `active_member` source node. The distinct outer IF and SEND sites supply
/// its execution stage; each stage has exactly one selected occurrence.
pub(super) fn collect_maintain_membership_sites(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<Value>> {
    let _guard = prepare_maintain_remind(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let [_, branch] = scenario.effects.as_slice() else {
        return None;
    };
    let [send, _] = branch.then_effects.as_slice() else {
        return None;
    };
    let (_, eligible_expr) = derive_expr(
        program,
        db,
        "maintain.plan_eligible",
        ELIGIBLE,
        &["maintain.Plan"],
    )?;
    let (can_work, can_work_expr) = derive_expr(
        program,
        db,
        "employee.can_work",
        CAN_WORK,
        &["user", "rent_catalog.Location"],
    )?;
    let eligible = symbol(program, "maintain.plan_eligible")?;
    let work_call = unique_call(program, eligible_expr, can_work)?;
    let mut members = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, selected)| {
            node.file == can_work_expr.file
                && node.start >= can_work_expr.start
                && node.end <= can_work_expr.end
                && matches!(&selected.target, SelectedCallTarget::Builtin { id, overload }
                if id == "active_member" && *overload == 0)
        });
    let (member, selected) = members.next()?;
    if members.next().is_some()
        || slice(db, *member)?.trim() != "active_member(person,team)"
        || selected.arguments.len() != 2
        || selected.slots != [Some(0), Some(1)]
        || slice(db, selected.arguments[0])? != "person"
        || slice(db, selected.arguments[1])? != "team"
        || program.types.node_types.get(member) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&selected.arguments[0])
            != Some(&ResolvedType::Scalar(Scalar::User))
        || program.types.node_types.get(&selected.arguments[1]) != Some(&ResolvedType::Team)
    {
        return None;
    }
    let checked = context.program().types.selected_calls.get(member)?;
    if !matches!(&checked.target, SelectedCallTarget::Builtin { id, overload }
            if id == "active_member" && *overload == 0)
        || checked.arguments != selected.arguments
        || checked.slots != selected.slots
    {
        return None;
    }
    let member_source = source(program, db, *member, "employee")?;
    let mut sites = Vec::new();
    for (guard, statement, stage, position) in [
        (
            branch.cond?,
            branch.node,
            "body-condition",
            json!([{"kind":"body","index":1}]),
        ),
        (
            send.when?,
            send.node,
            "send-dispatch",
            json!([{"kind":"body","index":1},{"kind":"then","index":0}]),
        ),
    ] {
        let outer = unique_call(program, guard, eligible)?;
        let owner_source = source(program, db, guard, "maintain")?;
        let call = json!({
            "source":member_source,"node":plain_interval(*member),
            "target":{"kind":"builtin","id":"active_member","overload":0},
            "arguments":[
                {"node":plain_interval(selected.arguments[0]),"type":"user"},
                {"node":plain_interval(selected.arguments[1]),"type":"Team"}],
            "slots":[0,1],"defaults":[],
            "chain":[
                {"source":owner_source,"node":plain_interval(outer),"derive":"maintain.plan_eligible"},
                {"source":owner_source,"node":plain_interval(work_call),"derive":"employee.can_work"}]
        });
        sites.push(
            json!({"version":1,"source":owner_source,"owner":"maintain.remind",
            "node":plain_interval(guard),"statement":plain_interval(statement),
            "stage":stage,"position":position,"calls":[call]}),
        );
    }
    Some(sites)
}
