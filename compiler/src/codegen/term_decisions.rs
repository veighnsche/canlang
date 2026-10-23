//! One source-bound owner decision for the authored membership term request.
//!
//! The ordinary disclosure planner cannot represent the optional Capture
//! helper FIRST followed by a Renewal FIRST and a null-only schedule. This
//! profile proves the complete original flow before issuing a private owner
//! callback; unrelated FIRST calls keep their normal refusal.
use serde_json::{Value, json};

use crate::analysis::effects::{Effect, EffectTarget, EffectVerb};
use crate::analysis::resolve::{ModelOwner, SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::types::{CheckedQueryClauseKind, SelectedCallTarget};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItem, IrItemKind, IrQueryDomain, IrStmt};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::{
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptReturn, transport_source,
};

const GUARDS: [&str; 3] = [
    "cycle>0 and not membership.revoked and membership.plan.active",
    "(member_manager and any(membership.plan.locations as location,can_work(actor,location))) or membership.account==actor or has_role(actor,membership.parent,billing)",
    "cycle_boundary(membership,cycle)>now",
];
const LOCATION_REQUIRE: &str = "location!=null and actor.email_verified and capture.parent==membership.parent and capture.account==membership.account and capture.account==actor";
const CAPTURE_REQUIRE: &str =
    "capture==latest_capture(membership.parent,actor,location,\"membership\")";
const PREVIOUS_REQUIRE: &str = "previous==null or previous.capture==capture";
pub(super) const CAN_WORK: &str = "any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))";
pub(super) const HAS_ROLE: &str =
    "any(org.CompanyRole as grant,grant.account==person and grant.role==role and grant.active)";
const CYCLE_BOUNDARY: &str = "local_instant(add_months(membership.anchor,offset*membership.months),\"00:00\",membership.timezone,fold=earlier)";
const LATEST_CAPTURE: &str = "first(customer.Capture as capture where capture.account==person and capture.captured+capture.window>=now and ((capture.advocate!=null and capture.advocate.parent.active and capture.advocate.account!=person and location in capture.advocate.parent.locations and product in capture.advocate.parent.products) or (capture.partner!=null and capture.partner.active and capture.partner.account!=person and location in capture.partner.locations and product in capture.partner.products)) order=-capture.captured)";

fn slice<'a>(db: &'a SourceDb, key: NodeKey) -> Option<&'a str> {
    db.get(key.file)?
        .text
        .get(key.start as usize..key.end as usize)
}
pub(super) fn text<'a>(db: &'a SourceDb, key: NodeKey) -> Option<&'a str> {
    Some(slice(db, key)?.trim())
}
pub(super) fn span(key: NodeKey) -> Span {
    Span::new(key.file, key.start, key.end)
}
pub(super) fn interval(key: NodeKey) -> Value {
    json!({"start":key.start,"end":key.end,"kind":key.kind})
}
fn plain_interval(key: NodeKey) -> Value {
    json!({"start":key.start,"end":key.end})
}
pub(super) fn symbol(program: &CheckedProgram, canonical: &str) -> Option<SymbolId> {
    let mut hits = program
        .symbols
        .iter()
        .filter(|item| item.canonical == canonical);
    let id = hits.next()?.id;
    hits.next().is_none().then_some(id)
}
pub(super) fn record_is(program: &CheckedProgram, ty: &ResolvedType, canonical: &str) -> bool {
    matches!(ty, ResolvedType::Record {symbol,stored:true}
        if program.symbols.get(symbol.0 as usize).is_some_and(|item| item.canonical == canonical))
}
fn nullable_record_is(program: &CheckedProgram, ty: &ResolvedType, canonical: &str) -> bool {
    matches!(ty, ResolvedType::Nullable(inner) if record_is(program,inner,canonical))
}
pub(super) fn source(program: &CheckedProgram, db: &SourceDb, key: NodeKey, module: &str) -> Option<Value> {
    let owner = program
        .modules
        .iter()
        .find(|owner| owner.name == module && owner.file == key.file)?;
    let file = db.get(owner.file)?;
    (key.end as usize <= file.text.len() && file.sha256 == sha256_hex(file.text.as_bytes()))
        .then(|| json!({"path":file.path,"sha256":file.sha256,"module":module}))
}
pub(super) fn site(
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
            "term-decision/v1:{kind}:{}:{}:{}:{}:{}",
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
pub(super) fn no_children(effect: &Effect) -> bool {
    effect.then_effects.is_empty() && effect.else_effects.is_empty() && effect.match_arms.is_empty()
}
pub(super) fn args_match(db: &SourceDb, effect: &Effect, expected: &[(&str, Option<&str>)]) -> bool {
    effect.args.len() == expected.len()
        && effect.args.iter().zip(expected).all(|(arg, (key, value))| {
            arg.key == *key
                && match (arg.value, value) {
                    (None, None) => true,
                    (Some(node), Some(expected)) => text(db, node) == Some(*expected),
                    _ => false,
                }
        })
}
pub(super) fn derive(
    program: &CheckedProgram,
    db: &SourceDb,
    canonical: &str,
    text: &str,
    parameters: &[(&str, &str)],
    result: &str,
) -> Option<(SymbolId, NodeKey)> {
    let id = symbol(program, canonical)?;
    let data = program.effects.derives.get(&id)?;
    let expr = data.expr?;
    let module_name = canonical.split('.').next()?;
    let module = program.modules.iter().find(|m| m.name == module_name)?;
    let declaration = program.symbols.get(id.0 as usize)?;
    if data.derive != id
        || data.module != declaration.module
        || data.module != module.id
        || slice(db, expr)?.trim() != text
        || data.params.len() != parameters.len()
        || data
            .params
            .iter()
            .zip(parameters)
            .any(|(param, (name, ty))| {
                program
                    .symbols
                    .get(param.param.0 as usize)
                    .is_none_or(|item| item.name != *name)
                    || param.default.is_some()
                    || !program
                        .types
                        .symbol_types
                        .get(&param.param)
                        .is_some_and(|actual| match *ty {
                            "user" => *actual == ResolvedType::Scalar(Scalar::User),
                            "int" => *actual == ResolvedType::Scalar(Scalar::Int),
                            "text" => *actual == ResolvedType::Scalar(Scalar::Text),
                            "customer.CompanyRole.role" => {
                                matches!(actual, ResolvedType::Enum { .. })
                                    && symbol(program, "customer.CompanyRole.role")
                                        .and_then(|field| program.types.symbol_types.get(&field))
                                        == Some(actual)
                            }
                            model => record_is(program, actual, model),
                        })
            })
    {
        return None;
    }
    let actual = program.types.symbol_results.get(&id)?.as_ref()?;
    let okay = match result {
        "bool" => *actual == ResolvedType::Scalar(Scalar::Bool),
        "datetime" => *actual == ResolvedType::Scalar(Scalar::Datetime),
        model => nullable_record_is(program, actual, model),
    };
    okay.then_some((id, expr))
}
pub(super) fn selected_derive(program: &CheckedProgram, within: NodeKey, target: SymbolId) -> Option<NodeKey> {
    let mut hits = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, call)| {
            node.kind == SyntaxKind::Call as u8
                && node.file == within.file
                && within.start <= node.start
                && node.end <= within.end
                && matches!(call.target,SelectedCallTarget::DeriveFn(id) if id == target)
        })
        .map(|(node, _)| *node);
    let hit = hits.next()?;
    hits.next().is_none().then_some(hit)
}
pub(super) fn selected_collection(
    program: &CheckedProgram,
    within: NodeKey,
    builtin: &str,
    model: &str,
) -> Option<NodeKey> {
    let model_id = symbol(program, model)?;
    if builtin == "first" {
        let mut hits = program
            .types
            .selected_calls
            .iter()
            .filter(|(node, call)| {
                node.kind == SyntaxKind::Call as u8
                    && node.file == within.file
                    && within.start <= node.start
                    && node.end <= within.end
                    && matches!(&call.target,SelectedCallTarget::Builtin{id,overload}
                    if id=="first" && *overload==0)
                    && call.arguments.len() == 1
                    && program
                        .types
                        .checked_queries
                        .get(&call.arguments[0])
                        .is_some_and(|query| {
                            matches!(&query.domain_type,ResolvedType::Array{element,..}
                        if **element==ResolvedType::Record{symbol:model_id,stored:true})
                        })
            })
            .map(|(node, _)| *node);
        let hit = hits.next()?;
        return hits.next().is_none().then_some(hit);
    }
    let mut hits = program
        .types
        .checked_collection_calls
        .values()
        .filter(|fact| {
            fact.node.file == within.file
                && within.start <= fact.node.start
                && fact.node.end <= within.end
                && fact.builtin == builtin
                && fact.model == model_id
                && fact
                    .predicate
                    .as_ref()
                    .is_some_and(|predicate| predicate.ty == ResolvedType::Scalar(Scalar::Bool))
        })
        .map(|fact| fact.node);
    let hit = hits.next()?;
    hits.next().is_none().then_some(hit)
}
pub(super) fn frame(program: &CheckedProgram, db: &SourceDb, call: NodeKey, derive: &str) -> Option<Value> {
    let module = &program
        .modules
        .iter()
        .find(|module| {
            module.file == call.file
                && module.span.start <= call.start
                && call.end <= module.span.end
        })?
        .name;
    Some(
        json!({"source":source(program,db,call,module)?,"callSite":interval(call),"derive":derive}),
    )
}
pub(super) fn query_site(
    program: &CheckedProgram,
    db: &SourceDb,
    call: NodeKey,
    model: &str,
    stage: &str,
    domain_kind: &str,
    owner_path: &[&str],
    order: &[&str],
    derive_chain: Vec<Value>,
) -> Option<Value> {
    let (alias, predicate) = if let Some(fact) = program
        .types
        .checked_collection_calls
        .get(&call)
        .filter(|fact| fact.builtin == "any")
    {
        if fact.model != symbol(program, model)?
            || fact.query.file != call.file
            || fact.alias.file != call.file
            || fact.predicate.as_ref()?.node.file != call.file
            || fact.builtin != "any"
            || !order.is_empty()
        {
            return None;
        }
        (fact.alias, fact.predicate.as_ref()?.node)
    } else {
        let selected = program.types.selected_calls.get(&call)?;
        if !matches!(&selected.target,SelectedCallTarget::Builtin{id,overload}
                if id=="first" && *overload==0)
            || selected.arguments.len() != 1
        {
            return None;
        }
        let query = program.types.checked_queries.get(&selected.arguments[0])?;
        if !matches!(&query.domain_type,ResolvedType::Array{element,..}
                if record_is(program,element,model))
            || query.clauses.len() != 3
        {
            return None;
        }
        let [alias, where_clause, order_clause] = query.clauses.as_slice() else {
            return None;
        };
        if !matches!(&alias.kind, CheckedQueryClauseKind::As { .. })
            || !matches!(where_clause.kind, CheckedQueryClauseKind::Where)
            || !matches!(order_clause.kind, CheckedQueryClauseKind::Order)
            || where_clause.expressions.len() != 1
            || order_clause.expressions.len() != 1
            || text(db, order_clause.expressions[0])
                != Some(match model {
                    "sales_attribution.Capture" => "-capture.captured",
                    "member_terms.Renewal" => "request.id",
                    _ => return None,
                })
        {
            return None;
        }
        (alias.node, where_clause.expressions[0])
    };
    let module = model.split('.').next()?;
    let origin = source(program, db, call, module)?;
    let id = sha256_hex(
        format!(
            "term-query/v1:{stage}:{model}:{}:{}:{}:{derive_chain:?}",
            origin["sha256"].as_str()?,
            call.start,
            call.end
        )
        .as_bytes(),
    );
    Some(json!({"id":id,"stage":stage,"model":model,"source":origin,
        "callSite":interval(call),"aliasSite":interval(alias),
        "predicateSite":interval(predicate),
        "domainKind":domain_kind,"ownerPath":owner_path,"order":order,
        "deriveChain":derive_chain}))
}
pub(super) fn original_ir_match(context: &FreshSourceContext<'_>, item: &IrItem) -> Option<()> {
    let fresh = context.fresh().items.get(item.id.0 as usize)?;
    (fresh.canonical == item.canonical
        && format!("{:?}", fresh.kind) == format!("{:?}", item.kind)
        && format!("{:?}", context.fresh().modules) == format!("{:?}", context.ir().modules))
    .then_some(())
}
pub(super) fn checked_closure(
    context: &FreshSourceContext<'_>,
    scenario: NodeKey,
    helper_ids: &[SymbolId],
    model_ids: &[SymbolId],
) -> Option<()> {
    let program = context.original();
    let mut spans = vec![span(scenario)];
    for id in helper_ids {
        spans.push(span(program.effects.derives.get(id)?.node));
    }
    for id in model_ids {
        spans.push(span(program.effects.models.get(id)?.node));
    }
    let overlaps = |a: Span, b: Span| a.file == b.file && a.start < b.end && b.start < a.end;
    (!context.ir_diagnostics().iter().any(|diagnostic| {
        diagnostic.severity == crate::diagnostic::Severity::Error
            && spans.iter().any(|site| {
                overlaps(*site, diagnostic.primary)
                    || diagnostic
                        .related
                        .iter()
                        .any(|related| overlaps(*site, related.span))
            })
    }))
    .then_some(())
}

pub(super) fn prepare_term(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<Value> {
    if owner.canonical != "member_terms.term" {
        return None;
    }
    original_ir_match(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let membership = symbol(program, "member_terms.Membership")?;
    let renewal = symbol(program, "member_terms.Renewal")?;
    let customer = symbol(program, "customer.Customer")?;
    let plan = symbol(program, "member_plans.Plan")?;
    let capture = symbol(program, "sales_attribution.Capture")?;
    let role = symbol(program, "customer.CompanyRole")?;
    let employee = symbol(program, "employee.Employee")?;
    let location = symbol(program, "rent_catalog.Location")?;
    let advocate = symbol(program, "refer.Advocate")?;
    let program_model = symbol(program, "refer.Program")?;
    let partner = symbol(program, "affiliate.Partner")?;
    let event = symbol(program, "member_terms.RenewalDue")?;
    if scenario.scenario != owner.id
        || scenario.module != owner.module
        || scenario.on.is_some()
        || scenario.read
        || scenario.scope_authority
        || scenario.cohort.is_some()
        || scenario.result.is_some()
        || scenario.params.len() != 3
        || scenario.guards.len() != 3
        || scenario.effects.len() != 4
        || scenario.by.and_then(|node| slice(db, node)) != Some("member_manager or authenticated")
        || program.effects.models.get(&membership)?.owner != ModelOwner::ChildOf(customer)
        || program.effects.models.get(&renewal)?.owner != ModelOwner::ChildOf(membership)
        || program.effects.models.get(&capture)?.owner != ModelOwner::ChildOf(customer)
        || program.effects.models.get(&role)?.owner != ModelOwner::ChildOf(customer)
        || program.effects.models.get(&advocate)?.owner != ModelOwner::ChildOf(program_model)
        || [plan, customer, employee, location, program_model, partner]
            .iter()
            .any(|id| {
                program
                    .effects
                    .models
                    .get(id)
                    .is_none_or(|model| model.owner != ModelOwner::Team)
            })
        || !matches!(
            program.symbols.get(event.0 as usize)?.kind,
            SymbolKind::Event { .. }
        )
    {
        return None;
    }
    for (param, (name, ty)) in scenario.params.iter().zip([
        ("membership", "member_terms.Membership"),
        ("cycle", "int"),
        ("capture", "sales_attribution.Capture?"),
    ]) {
        if program.symbols.get(param.param.0 as usize)?.name != name
            || !program
                .types
                .symbol_types
                .get(&param.param)
                .is_some_and(|actual| match ty {
                    "int" => *actual == ResolvedType::Scalar(Scalar::Int),
                    "sales_attribution.Capture?" => {
                        nullable_record_is(program, actual, "sales_attribution.Capture")
                    }
                    model => record_is(program, actual, model),
                })
            || (name != "capture" && param.default.is_some())
            || (name == "capture" && param.default.and_then(|node| text(db, node)) != Some("null"))
        {
            return None;
        }
    }
    let [guard0, guard1, guard2] = scenario.guards.as_slice() else {
        return None;
    };
    let mut header = Vec::new();
    for (index, guard) in [guard0, guard1, guard2].iter().enumerate() {
        let cond = guard.cond?;
        if guard.verb != EffectVerb::Require
            || !no_children(guard)
            || slice(db, cond)?.trim() != GUARDS[index]
            || program.types.node_types.get(&cond) != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
        header.push(site(
            program,
            db,
            "member_terms",
            cond,
            guard.node,
            "header",
        )?);
    }
    let [capture_if, previous_let, previous_require, create_if] = scenario.effects.as_slice()
    else {
        return None;
    };
    let [location_let, location_require, capture_require] = capture_if.then_effects.as_slice()
    else {
        return None;
    };
    let [create, schedule] = create_if.then_effects.as_slice() else {
        return None;
    };
    if capture_if.verb != EffectVerb::If
        || capture_if.cond.and_then(|node| text(db, node)) != Some("capture!=null")
        || !capture_if.else_effects.is_empty()
        || !capture_if.match_arms.is_empty()
        || location_let.verb != EffectVerb::Let
        || location_let.binding.as_deref() != Some("location")
        || location_let.value.and_then(|node| text(db, node))
            != Some("first(membership.plan.locations as site order=site.id)")
        || !no_children(location_let)
        || location_require.verb != EffectVerb::Require
        || !no_children(location_require)
        || location_require.cond.and_then(|node| text(db, node)) != Some(LOCATION_REQUIRE)
        || capture_require.verb != EffectVerb::Require
        || !no_children(capture_require)
        || capture_require.cond.and_then(|node| text(db, node)) != Some(CAPTURE_REQUIRE)
        || previous_let.verb != EffectVerb::Let
        || !no_children(previous_let)
        || previous_let.binding.as_deref() != Some("previous")
        || previous_let.value.and_then(|node| text(db, node))
            != Some(
                "first(membership.Renewal as request where request.cycle==cycle order=request.id)",
            )
        || previous_require.verb != EffectVerb::Require
        || !no_children(previous_require)
        || previous_require.cond.and_then(|node| text(db, node)) != Some(PREVIOUS_REQUIRE)
        || create_if.verb != EffectVerb::If
        || create_if.cond.and_then(|node| text(db, node)) != Some("previous==null")
        || !create_if.else_effects.is_empty()
        || !create_if.match_arms.is_empty()
        || create.verb != EffectVerb::Create
        || !no_children(create)
        || !matches!(create.target,Some(EffectTarget::Model(id)) if id==renewal)
        || create.binding.as_deref() != Some("renewal")
        || !args_match(
            db,
            create,
            &[
                ("parent", Some("membership")),
                ("cycle", None),
                ("capture", None),
                ("requester", Some("actor")),
                ("consent", Some("membership.consent")),
            ],
        )
        || schedule.verb != EffectVerb::Schedule
        || !no_children(schedule)
        || !matches!(schedule.target,Some(EffectTarget::Event(id)) if id==event)
        || schedule.key.and_then(|node| text(db, node)) != Some("renewal.id")
        || schedule.at.and_then(|node| text(db, node)) != Some("now")
        || !args_match(db, schedule, &[("renewal", None)])
    {
        return None;
    }
    let (_, can_work_expr) = derive(
        program,
        db,
        "employee.can_work",
        CAN_WORK,
        &[("person", "user"), ("location", "rent_catalog.Location")],
        "bool",
    )?;
    let (_, has_role_expr) = derive(
        program,
        db,
        "customer.has_role",
        HAS_ROLE,
        &[
            ("person", "user"),
            ("org", "customer.Customer"),
            ("role", "customer.CompanyRole.role"),
        ],
        "bool",
    )?;
    let (_, boundary_expr) = derive(
        program,
        db,
        "member_terms.cycle_boundary",
        CYCLE_BOUNDARY,
        &[("membership", "member_terms.Membership"), ("offset", "int")],
        "datetime",
    )?;
    let (_, latest_expr) = derive(
        program,
        db,
        "sales_attribution.latest_capture",
        LATEST_CAPTURE,
        &[
            ("customer", "customer.Customer"),
            ("person", "user"),
            ("location", "rent_catalog.Location"),
            ("product", "text"),
        ],
        "sales_attribution.Capture",
    )?;
    let can_work_id = symbol(program, "employee.can_work")?;
    let has_role_id = symbol(program, "customer.has_role")?;
    let boundary_id = symbol(program, "member_terms.cycle_boundary")?;
    let latest_id = symbol(program, "sales_attribution.latest_capture")?;
    let outer_work = selected_derive(program, guard1.cond?, can_work_id)?;
    let outer_role = selected_derive(program, guard1.cond?, has_role_id)?;
    let outer_boundary = selected_derive(program, guard2.cond?, boundary_id)?;
    let outer_latest = selected_derive(program, capture_require.cond?, latest_id)?;
    let work_any = selected_collection(program, can_work_expr, "any", "employee.Employee")?;
    let role_any = selected_collection(program, has_role_expr, "any", "customer.CompanyRole")?;
    let latest_first =
        selected_collection(program, latest_expr, "first", "sales_attribution.Capture")?;
    let renewal_first = selected_collection(
        program,
        previous_let.value?,
        "first",
        "member_terms.Renewal",
    )?;
    let _ = (outer_boundary, boundary_expr);
    if text(db, work_any)? != CAN_WORK
        || text(db, role_any)? != HAS_ROLE
        || text(db, latest_first)? != LATEST_CAPTURE
        || text(db, renewal_first)?
            != "first(membership.Renewal as request where request.cycle==cycle order=request.id)"
    {
        return None;
    }
    let IrItemKind::Scenario {
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        result: None,
        read: false,
        scope_authority: false,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::Require { cond: g0, .. },
        IrStmt::Require { cond: g1, .. },
        IrStmt::Require { cond: g2, .. },
    ] = guards.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::If {
            cond: ci,
            then_branch: cb,
            else_branch: ce,
            ..
        },
        IrStmt::Let {
            name: pn,
            value: pv,
            ..
        },
        IrStmt::Require { cond: pr, .. },
        IrStmt::If {
            cond: ni,
            then_branch: nb,
            else_branch: ne,
            ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Let {
            name: ln,
            value: lv,
            ..
        },
        IrStmt::Require { cond: lr, .. },
        IrStmt::Require { cond: cr, .. },
    ] = cb.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Create {
            model: cm,
            input,
            when: None,
            binding: Some(binding),
            ..
        },
        IrStmt::Schedule { event: se, .. },
    ] = nb.as_slice()
    else {
        return None;
    };
    if [g0, g1, g2]
        .iter()
        .zip([guard0, guard1, guard2])
        .any(|(ir, source)| Some(ir.span) != source.cond.map(span))
        || ci.span != span(capture_if.cond?)
        || !ce.is_empty()
        || ln != "location"
        || lv.span != span(location_let.value?)
        || lr.span != span(location_require.cond?)
        || cr.span != span(capture_require.cond?)
        || pn != "previous"
        || pv.span != span(previous_let.value?)
        || pr.span != span(previous_require.cond?)
        || ni.span != span(create_if.cond?)
        || !ne.is_empty()
        || cm != "member_terms.Renewal"
        || binding != "renewal"
        || se != "member_terms.RenewalDue"
        || !matches!(&pv.expr,IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}
            if args.iter().any(|arg| matches!(&arg.expr,IrExpr::Query(query)
                if matches!(&query.domain,IrQueryDomain::Model(model) if model=="member_terms.Renewal")
                && query.parent.as_ref().is_some_and(|parent|
                    matches!(&parent.expr,IrExpr::Name(name) if name=="membership")))))
        || !matches!(&lv.expr,IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}
            if args.iter().any(|arg| matches!(&arg.expr,IrExpr::Query(query)
                if matches!(&query.domain,IrQueryDomain::Value{alias,..} if alias=="site"))))
        || !matches!(&input.expr,IrExpr::Object(entries) if entries.len()==5)
    {
        return None;
    }
    checked_closure(
        context,
        scenario.node,
        &[can_work_id, has_role_id, boundary_id, latest_id],
        &[
            membership,
            renewal,
            customer,
            plan,
            capture,
            role,
            employee,
            location,
            advocate,
            program_model,
            partner,
        ],
    )?;
    let owner_source = source(program, db, scenario.node, "member_terms")?;
    let work_frame = frame(program, db, outer_work, "employee.can_work")?;
    let role_frame = frame(program, db, outer_role, "customer.has_role")?;
    let capture_frame = frame(
        program,
        db,
        outer_latest,
        "sales_attribution.latest_capture",
    )?;
    let work_site = query_site(
        program,
        db,
        work_any,
        "employee.Employee",
        "header",
        "tenant-root",
        &[],
        &[],
        vec![work_frame],
    )?;
    let role_site = query_site(
        program,
        db,
        role_any,
        "customer.CompanyRole",
        "header",
        "contained-child",
        &["parent"],
        &[],
        vec![role_frame],
    )?;
    let capture_site = query_site(
        program,
        db,
        latest_first,
        "sales_attribution.Capture",
        "capture",
        "contained-child",
        &["parent"],
        &["-captured", "id"],
        vec![capture_frame],
    )?;
    let renewal_site = query_site(
        program,
        db,
        renewal_first,
        "member_terms.Renewal",
        "renewal",
        "contained-child",
        &[],
        &["id"],
        vec![],
    )?;
    let query_sites = vec![work_site, role_site, capture_site, renewal_site];
    let mut create_site = site(
        program,
        db,
        "member_terms",
        create.node,
        create.node,
        "create",
    )?;
    create_site["model"] = json!("member_terms.Renewal");
    let mut schedule_site = site(
        program,
        db,
        "member_terms",
        schedule.node,
        schedule.node,
        "schedule",
    )?;
    schedule_site["event"] = json!("member_terms.RenewalDue");
    let decision = json!({
        "version":1,"owner":"member_terms.term","source":owner_source,
        "parameters":[
            {"name":"membership","model":"member_terms.Membership","nullable":false},
            {"name":"cycle","type":"int"},
            {"name":"capture","model":"sales_attribution.Capture","nullable":true}
        ],
        "sites":{
            "header":header,"captureIf":site(program,db,"member_terms",capture_if.cond?,capture_if.node,"capture-if")?,
            "locationFirst":site(program,db,"member_terms",location_let.value?,location_let.node,"location-first")?,
            "captureRequires":[
                site(program,db,"member_terms",location_require.cond?,location_require.node,"capture-require")?,
                site(program,db,"member_terms",capture_require.cond?,capture_require.node,"capture-require")?],
            "renewalFirst":site(program,db,"member_terms",previous_let.value?,previous_let.node,"renewal-first")?,
            "previousRequire":site(program,db,"member_terms",previous_require.cond?,previous_require.node,"previous-require")?,
            "createIf":site(program,db,"member_terms",create_if.cond?,create_if.node,"create-if")?,
            "create":create_site,"schedule":schedule_site
        },
        "membershipSite":site(program,db,"member_terms",guard1.cond?,guard1.node,"membership")?,
        "querySites":query_sites
    });
    Some(decision)
}

pub(super) fn collect_term_receipt(
    context: &FreshSourceContext<'_>,
    item: &IrItem,
    entry_module: &str,
) -> Option<NativeScenarioReceipt> {
    let decision = prepare_term(context, item)?;
    let scenario = context.original().effects.scenarios.get(&item.id)?;
    let file = context.db().get(scenario.node.file)?;
    let origin = DisclosureSource {
        path: file.path.clone(),
        sha256: file.sha256.clone(),
        module: "member_terms".into(),
    };
    let source = transport_source(&origin, entry_module)?;
    let id = sha256_hex(
        format!(
            "term-void-return/v1:{}:{}:{}",
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
            event_decision: None,
            term_decision: Some(decision),
            leave_request_decision: None, leave_decide_decision: None, refer_reject_decision: None, member_retry_decision: None, rent_movement_refund_decision: None,
            invoice_collect_decision: None, rent_notice_decision: None, invoice_issue_decision: None, observe_venue_decision: None, success_renewal_decision: None, purchase_receive_all: None, event_notice_audit: None,queries: Vec::new(),
            returns: vec![returned],
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

/// The public derive may become a throwing stub only when the current
/// compilation has no checked call outside the owner-private term branch.
/// A full multi-app compilation still retains its ordinary FIRST refusal.
pub(super) fn latest_capture_private_only(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> bool {
    let program = context.original();
    let Some(latest) = symbol(program, "sales_attribution.latest_capture") else {
        return false;
    };
    let Some(scenario) = program.effects.scenarios.get(&owner.id) else {
        return false;
    };
    let calls = program
        .types
        .selected_calls
        .iter()
        .filter(|(_, call)| matches!(call.target,SelectedCallTarget::DeriveFn(id) if id==latest))
        .map(|(node, _)| *node)
        .collect::<Vec<_>>();
    matches!(calls.as_slice(),[call] if call.file==scenario.node.file
        && scenario.node.start<=call.start && call.end<=scenario.node.end)
}

/// The single nested active_member call executes only in the second authored
/// header Require, inside the owner callback. Its source call identity remains
/// the employee helper; its execution stage is the checked term guard.
pub(super) fn collect_term_membership_sites(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<Value>> {
    let decision = prepare_term(context, owner)?;
    let program = context.original();
    let db = context.db();
    let scenario = program.effects.scenarios.get(&owner.id)?;
    let guard = scenario.guards.get(1)?;
    let guard_node = guard.cond?;
    if decision["membershipSite"]["node"] != interval(guard_node) {
        return None;
    }
    let (work, work_expr) = derive(
        program,
        db,
        "employee.can_work",
        CAN_WORK,
        &[("person", "user"), ("location", "rent_catalog.Location")],
        "bool",
    )?;
    let outer = selected_derive(program, guard_node, work)?;
    let mut calls = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, selected)| {
            node.file == work_expr.file
                && work_expr.start <= node.start
                && node.end <= work_expr.end
                && matches!(&selected.target,SelectedCallTarget::Builtin{id,overload}
            if id=="active_member" && *overload==0)
        });
    let (member, selected) = calls.next()?;
    if calls.next().is_some()
        || text(db, *member) != Some("active_member(person,team)")
        || selected.arguments.len() != 2
        || selected.slots != [Some(0), Some(1)]
        || text(db, selected.arguments[0]) != Some("person")
        || text(db, selected.arguments[1]) != Some("team")
        || program.types.node_types.get(member) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || program.types.node_types.get(&selected.arguments[0])
            != Some(&ResolvedType::Scalar(Scalar::User))
        || program.types.node_types.get(&selected.arguments[1]) != Some(&ResolvedType::Team)
    {
        return None;
    }
    let supplied = context.program().types.selected_calls.get(member)?;
    if !matches!(&supplied.target,SelectedCallTarget::Builtin{id,overload}
            if id=="active_member" && *overload==0)
        || supplied.arguments != selected.arguments
        || supplied.slots != selected.slots
    {
        return None;
    }
    let member_source = source(program, db, *member, "employee")?;
    let owner_source = source(program, db, guard_node, "member_terms")?;
    let call = json!({"source":member_source,"node":plain_interval(*member),
        "target":{"kind":"builtin","id":"active_member","overload":0},
        "arguments":[
            {"node":plain_interval(selected.arguments[0]),"type":"user"},
            {"node":plain_interval(selected.arguments[1]),"type":"Team"}],
        "slots":[0,1],"defaults":[],
        "chain":[{"source":owner_source,"node":plain_interval(outer),"derive":"employee.can_work"}]});
    Some(vec![
        json!({"version":1,"source":owner_source,"owner":"member_terms.term",
        "node":plain_interval(guard_node),"statement":plain_interval(guard.node),
        "stage":"body-condition","position":[{"kind":"guard","index":1}],"calls":[call]}),
    ])
}
