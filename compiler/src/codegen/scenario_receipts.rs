//! Match complete checked disclosure paths to actual executable native IR sites.
//! This helper never activates capture or publishes a plan on its own.
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::analysis::scenario_disclosure::{
    DependencyRole, DisclosureChoice, DisclosureSource, ScenarioDisclosure,
};
use crate::analysis::{ResolvedType, Scalar};
use crate::source::{Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrExpr, IrGuard, IrItem, IrItemKind, IrProgram, IrStmt,
    IrType, TypedExpr,
};
use super::js::{JsModel, JsModelField, JsModelFieldType};

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptSource {
    pub path: String,
    pub sha256: String,
    pub module: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptDisclosurePlan {
    pub version: u8,
    pub source: ReceiptSource,
    pub returns: Vec<ReceiptReturn>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptReturn {
    pub id: String,
    pub source: ReceiptSource,
    pub influences: Vec<ReceiptInfluence>,
    pub dependencies: Vec<ReceiptDependency>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptInfluence {
    pub id: String,
    pub kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ReceiptRole {
    Data,
    Control,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptDependency {
    pub id: String,
    pub source: ReceiptSource,
    pub role: ReceiptRole,
    pub model: String,
    pub field: String,
    #[serde(rename = "type")]
    pub type_id: String,
}

#[derive(Debug, Clone)]
pub(super) struct NativeDependency {
    pub id: String,
    pub model: String,
    pub field: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NativeDecisionKind {
    If,
    Match,
    And,
    Or,
    Coalesce,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct NativeSite {
    pub calls: Vec<Span>,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub(super) struct NativeReturn {
    pub id: String,
    pub span: Span,
    pub decisions: Vec<(String, DisclosureChoice)>,
    pub implicit: bool,
}

#[derive(Debug, Clone)]
pub(super) struct NativeScenarioReceipt {
    pub plan: ReceiptDisclosurePlan,
    /// One observation site may supply both data and control identities.
    pub dependencies: HashMap<NativeSite, Vec<NativeDependency>>,
    pub decisions: HashMap<NativeSite, NativeDecisionKind>,
    pub decision_keys: HashMap<NativeSite, String>,
    pub calls: HashMap<NativeSite, String>,
    pub returns: Vec<NativeReturn>,
}

/// `models` must be the actual descriptors emitted by the owning emitter.
/// `entry_module` is the actual artifact callable module, not an inferred
/// package path: native scenario implementations currently execute in entry.
pub(super) fn collect_native_scenario_receipt(
    ir: &IrProgram,
    item: &IrItem,
    models: &[JsModel],
    entry_module: &str,
) -> Option<NativeScenarioReceipt> {
    let IrItemKind::Scenario {
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        result,
        read: false,
        expose_excluded: false,
        by,
        guards,
        effects,
        ..
    } = &item.kind
    else {
        return None;
    };
    if !result.as_ref().is_none_or(native_result_type) || entry_module.is_empty() {
        return None;
    }
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&item.id)? else {
        return None;
    };
    if checked.scenario != item.id || checked.returns.is_empty() || checked.returns.len() > 200 {
        return None;
    }
    let module = ir.modules.get(item.module.0 as usize)?;
    if module.id != item.module || checked.source.module != module.name {
        return None;
    }
    if checked.node.file != module.file
        || checked.node.kind != SyntaxKind::Scenario as u8
        || checked.node.file != item.span.file
        || checked.node.start > item.span.start
        || checked.node.end < item.span.end
    {
        return None;
    }
    let source = transport_source(&checked.source, entry_module)?;
    let sites = Sites::collect(ir, by, guards, effects)?;
    let mut recipe = NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            version: 1,
            source,
            returns: Vec::new(),
        },
        dependencies: HashMap::new(),
        decisions: HashMap::new(),
        decision_keys: HashMap::new(),
        calls: sites.calls.clone(),
        returns: Vec::new(),
    };
    let mut source_origins = HashMap::new();
    source_origins.insert(
        (checked.node.file, checked.source.module.clone()),
        checked.source.clone(),
    );
    let mut return_ids = HashSet::new();
    let mut matched_returns = HashSet::new();
    let mut dependency_ids =
        HashMap::<String, (NativeSite, String, String, String, ReceiptRole)>::new();
    // State's v1 own-data parser bounds each array/global dependency inventory
    // at 200 and the closed plan traversal at 20,000 JSON nodes.
    let mut data_nodes: usize = 7;
    for returned in &checked.returns {
        if !returned.influences.is_empty()
            || returned.node.file != checked.node.file
            || returned.id.is_empty()
            || !return_ids.insert(returned.id.clone())
        {
            return None;
        }
        if returned.dependencies.len() > 200 {
            return None;
        }
        data_nodes = data_nodes.checked_add(8 + 10 * returned.dependencies.len())?;
        if data_nodes > 20_000 {
            return None;
        }
        let return_span = node_span(returned.node);
        let implicit = returned.node == checked.node;
        // The checked whole declaration anchor owns implicit void fallthrough;
        // its containing name span is the actual emitter attribution site.
        if (implicit && result.is_some())
            || (!implicit
                && (returned.node.kind != SyntaxKind::Return as u8
                    || !sites.returns.contains(&return_span)))
        {
            return None;
        }
        if returned.source != checked.source {
            return None;
        }
        if !implicit {
            matched_returns.insert(return_span);
        }
        let mut native_return = NativeReturn {
            id: returned.id.clone(),
            span: if implicit { item.span } else { return_span },
            decisions: Vec::new(),
            implicit,
        };
        let mut plan_return = ReceiptReturn {
            id: returned.id.clone(),
            source: transport_source(&returned.source, entry_module)?,
            influences: Vec::new(),
            dependencies: Vec::new(),
        };
        for decision in &returned.decisions {
            let site = checked_site(decision.node, &decision.calls)?;
            let span = site.span;
            if native_return
                .decisions
                .iter()
                .any(|(seen, _)| recipe.decision_keys.get(&site) == Some(seen))
            {
                return None;
            }
            let kind = *sites.decisions.get(&site)?;
            let expected = match kind {
                NativeDecisionKind::If => SyntaxKind::If,
                NativeDecisionKind::Match => SyntaxKind::Match,
                _ => SyntaxKind::Binary,
            };
            if decision.node.kind != expected as u8 {
                return None;
            }
            if !valid_choice(kind, &decision.choice, sites.matches.get(&site)) {
                return None;
            }
            if recipe
                .decisions
                .insert(site.clone(), kind)
                .is_some_and(|old| old != kind)
            {
                return None;
            }
            let key = if let Some(key) = recipe.decision_keys.get(&site) {
                key.clone()
            } else {
                // The checked opaque return identity already incorporates exact
                // declaring source bytes and canonical call-chain origins.
                let mut stamp =
                    format!("receipt-choice:{}:{}:{}", returned.id, span.start, span.end);
                for anchor in site.calls.iter().chain(std::iter::once(&span)) {
                    let owner = owning_module(ir, *anchor)?;
                    stamp.push_str(&format!(":{}:{}:{}", owner.name, anchor.start, anchor.end));
                }
                let key = sha256_hex(stamp.as_bytes());
                recipe.decision_keys.insert(site, key.clone());
                key
            };
            native_return.decisions.push((key, decision.choice.clone()));
        }
        for dependency in &returned.dependencies {
            if dependency.node.kind != SyntaxKind::Member as u8
                || dependency.id.is_empty()
                || !source_matches(ir, &dependency.source, node_span(dependency.node))
                || !supported_type_id(&dependency.type_id)
                || !direct_field_name(&dependency.field_name)
            {
                return None;
            }
            let source_key = (dependency.node.file, dependency.source.module.clone());
            if let Some(previous) = source_origins.get(&source_key) {
                if previous != &dependency.source {
                    return None;
                }
            } else {
                source_origins.insert(source_key, dependency.source.clone());
            }
            if dependency.calls.is_empty() && dependency.source != checked.source {
                return None;
            }
            if plan_return
                .dependencies
                .iter()
                .any(|read| read.id == dependency.id)
            {
                return None;
            }
            let site = checked_site(dependency.node, &dependency.calls)?;
            let expressions = sites.members.get(&site)?;
            if expressions.len() != 1 {
                return None;
            }
            let IrExpr::Member { base, field } = &expressions[0].expr else {
                return None;
            };
            if field != &dependency.field_name
                || !matches!(base.expr, IrExpr::Name(_))
                || base.ty
                    != (ResolvedType::Record {
                        symbol: dependency.model,
                        stored: true,
                    })
            {
                return None;
            }
            let owner = ir.items.get(dependency.model.0 as usize)?;
            let stored = ir.items.get(dependency.field.0 as usize)?;
            let IrItemKind::Model { fields, .. } = &owner.kind else {
                return None;
            };
            let IrItemKind::Field {
                owner: field_owner,
                ty: IrType::Known(ty),
                required_array,
                ..
            } = &stored.kind
            else {
                return None;
            };
            if owner.id != dependency.model
                || stored.id != dependency.field
                || *field_owner != owner.id
                || !fields.contains(&stored.id)
                || owner.canonical != dependency.model_name
                || stored.name != dependency.field_name
                || *required_array
                || ty != &dependency.ty
            {
                return None;
            }
            let descriptors: Vec<_> = models
                .iter()
                .filter(|model| model.name == owner.canonical)
                .collect();
            if descriptors.len() != 1 {
                return None;
            }
            let declared: Vec<_> = descriptors[0]
                .fields
                .iter()
                .filter(|field| field.name == stored.name)
                .collect();
            if declared.len() != 1 || inventory_type(declared[0])?.as_str() != dependency.type_id {
                return None;
            }
            let role = match dependency.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            let identity = (
                site.clone(),
                dependency.model_name.clone(),
                dependency.field_name.clone(),
                dependency.type_id.clone(),
                role,
            );
            if let Some(previous) = dependency_ids.get(&dependency.id) {
                if previous.0 != identity.0
                    || previous.1 != identity.1
                    || previous.2 != identity.2
                    || previous.3 != identity.3
                    || previous.4 != identity.4
                {
                    return None;
                }
            } else {
                dependency_ids.insert(dependency.id.clone(), identity);
                if dependency_ids.len() > 200 {
                    return None;
                }
            }
            let observed = recipe.dependencies.entry(site).or_default();
            if !observed.iter().any(|read| read.id == dependency.id) {
                observed.push(NativeDependency {
                    id: dependency.id.clone(),
                    model: dependency.model_name.clone(),
                    field: dependency.field_name.clone(),
                });
            }
            plan_return.dependencies.push(ReceiptDependency {
                id: dependency.id.clone(),
                source: transport_source(&dependency.source, entry_module)?,
                role,
                model: dependency.model_name.clone(),
                field: dependency.field_name.clone(),
                type_id: dependency.type_id.clone(),
            });
        }
        recipe.returns.push(native_return);
        recipe.plan.returns.push(plan_return);
    }
    if matched_returns != sites.returns {
        return None;
    }
    Some(recipe)
}

fn transport_source(source: &DisclosureSource, entry_module: &str) -> Option<ReceiptSource> {
    if source.path.is_empty()
        || source.sha256.len() != 64
        || !source
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    Some(ReceiptSource {
        path: source.path.clone(),
        sha256: source.sha256.clone(),
        module: entry_module.to_string(),
    })
}

fn node_span(node: crate::analysis::NodeKey) -> Span {
    Span::new(node.file, node.start, node.end)
}

fn direct_field_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn native_result_type(ty: &ResolvedType) -> bool {
    let base = match ty {
        ResolvedType::Nullable(inner) => inner.as_ref(),
        ty => ty,
    };
    let primitive = |ty: &ResolvedType| {
        matches!(
            ty,
            ResolvedType::Scalar(
                Scalar::Int
                    | Scalar::Text
                    | Scalar::Bool
                    | Scalar::Decimal
                    | Scalar::Money
                    | Scalar::Date
                    | Scalar::Datetime
                    | Scalar::Duration
                    | Scalar::User
            )
        )
    };
    primitive(base)
        || matches!(base, ResolvedType::Enum { cases, .. } if !cases.is_empty())
        || matches!(base, ResolvedType::Array { element, .. } if primitive(element))
}

/// Exact first State scalar profile; nominal aliases never become text here.
pub(super) fn supported_type_id(type_id: &str) -> bool {
    let base = type_id.strip_suffix('?').unwrap_or(type_id);
    let base = base.strip_suffix("[]").unwrap_or(base);
    matches!(
        base,
        "int" | "text" | "bool" | "decimal" | "money" | "date" | "datetime" | "duration" | "user"
    ) || base
        .strip_prefix("enum(")
        .and_then(|body| body.strip_suffix(')'))
        .is_some_and(|body| {
            !body.is_empty()
                && body.split(',').all(direct_field_name)
                && body.split(',').collect::<HashSet<_>>().len() == body.split(',').count()
        })
}

fn inventory_type(field: &JsModelField) -> Option<String> {
    if field.array_required == Some(true) {
        return None;
    }
    // Use the identical valueType-first contract as State's binder. The
    // alternate primitive tag never rescues an unsupported nominal claim.
    if let Some(type_id) = &field.value_type {
        return supported_type_id(type_id).then(|| type_id.clone());
    }
    let base = match &field.field {
        JsModelFieldType::String => "text".to_string(),
        JsModelFieldType::Integer => "int".to_string(),
        JsModelFieldType::Boolean => "bool".to_string(),
        JsModelFieldType::Decimal => "decimal".to_string(),
        JsModelFieldType::Money => "money".to_string(),
        JsModelFieldType::Date => "date".to_string(),
        JsModelFieldType::Datetime => "datetime".to_string(),
        JsModelFieldType::Duration => "duration".to_string(),
        JsModelFieldType::User => "user".to_string(),
        JsModelFieldType::Enum { values } => format!("enum({})", values.join(",")),
        _ => return None,
    };
    let type_id = format!(
        "{base}{}{}",
        if field.array_required.is_some() {
            "[]"
        } else {
            ""
        },
        if field.nullable { "?" } else { "" }
    );
    supported_type_id(&type_id).then_some(type_id)
}

fn valid_choice(
    kind: NativeDecisionKind,
    choice: &DisclosureChoice,
    cases: Option<&HashSet<String>>,
) -> bool {
    match (kind, choice) {
        (NativeDecisionKind::If, DisclosureChoice::Then | DisclosureChoice::Else) => true,
        (NativeDecisionKind::Match, DisclosureChoice::Match(case)) => {
            cases.is_some_and(|cases| cases.contains(case))
        }
        (
            NativeDecisionKind::And | NativeDecisionKind::Or | NativeDecisionKind::Coalesce,
            DisclosureChoice::RhsEvaluated | DisclosureChoice::RhsSkipped,
        ) => true,
        _ => false,
    }
}

#[derive(Default)]
struct Sites<'a> {
    members: HashMap<NativeSite, Vec<&'a TypedExpr>>,
    decisions: HashMap<NativeSite, NativeDecisionKind>,
    matches: HashMap<NativeSite, HashSet<String>>,
    calls: HashMap<NativeSite, String>,
    returns: HashSet<Span>,
}

enum Visit<'a> {
    Statement(&'a IrStmt),
    Expression(&'a TypedExpr),
    Guard(&'a IrGuard),
}

impl<'a> Sites<'a> {
    fn collect(
        ir: &'a IrProgram,
        by: &'a [IrGuard],
        guards: &'a [IrStmt],
        effects: &'a [IrStmt],
    ) -> Option<Self> {
        let mut out = Self::default();
        let mut pending = Vec::new();
        pending.extend(
            by.iter()
                .map(|guard| (Visit::Guard(guard), Walk::default())),
        );
        pending.extend(
            guards
                .iter()
                .chain(effects)
                .map(|statement| (Visit::Statement(statement), Walk::default())),
        );
        let mut visited = 0;
        while let Some((site, context)) = pending.pop() {
            visited += 1;
            if visited > 16384 || pending.len() > 16384 {
                return None;
            }
            if context.depth >= 64 {
                return None;
            }
            let mut child = context.clone();
            child.depth += 1;
            macro_rules! push {
                ($site:expr) => {
                    pending.push(($site, child.clone()))
                };
            }
            macro_rules! extend {
                ($sites:expr) => {
                    pending.extend($sites.map(|site| (site, child.clone())))
                };
            }
            match site {
                Visit::Guard(guard) => match guard {
                    IrGuard::Role(_) => {}
                    IrGuard::Subject { person, .. } => push!(Visit::Expression(person)),
                    IrGuard::Expr(expr) => push!(Visit::Expression(expr)),
                    IrGuard::And(guards) | IrGuard::Or(guards) => {
                        extend!(guards.iter().map(Visit::Guard))
                    }
                    IrGuard::Not(guard) => push!(Visit::Guard(guard)),
                },
                Visit::Statement(statement) => match statement {
                    IrStmt::Let { value, .. } => push!(Visit::Expression(value)),
                    IrStmt::Require { cond, .. } => push!(Visit::Expression(cond)),
                    IrStmt::Return { value, span } => {
                        if !out.returns.insert(*span) {
                            return None;
                        }
                        extend!(value.iter().map(Visit::Expression));
                    }
                    IrStmt::If {
                        cond,
                        then_branch,
                        else_branch,
                        span,
                    } => {
                        if out
                            .decisions
                            .insert(context.site(*span), NativeDecisionKind::If)
                            .is_some()
                        {
                            return None;
                        }
                        push!(Visit::Expression(cond));
                        extend!(then_branch.iter().chain(else_branch).map(Visit::Statement));
                    }
                    IrStmt::Match {
                        subject,
                        arms,
                        span,
                    } => {
                        if out
                            .decisions
                            .insert(context.site(*span), NativeDecisionKind::Match)
                            .is_some()
                        {
                            return None;
                        }
                        let cases: HashSet<_> = arms.iter().map(|arm| arm.case.clone()).collect();
                        if cases.len() != arms.len() {
                            return None;
                        }
                        out.matches.insert(context.site(*span), cases);
                        push!(Visit::Expression(subject));
                        for arm in arms {
                            extend!(arm.body.iter().map(Visit::Statement));
                        }
                    }
                    _ => return None,
                },
                Visit::Expression(expression) => match &expression.expr {
                    IrExpr::Member { base, .. } => {
                        out.members
                            .entry(context.site(expression.span))
                            .or_default()
                            .push(expression);
                        push!(Visit::Expression(base));
                    }
                    IrExpr::Binary { op, left, right } => {
                        let kind = match op {
                            IrBinOp::And => Some(NativeDecisionKind::And),
                            IrBinOp::Or => Some(NativeDecisionKind::Or),
                            IrBinOp::Coalesce => Some(NativeDecisionKind::Coalesce),
                            _ => None,
                        };
                        if let Some(kind) = kind
                            && out
                                .decisions
                                .insert(context.site(expression.span), kind)
                                .is_some()
                        {
                            return None;
                        }
                        push!(Visit::Expression(left));
                        push!(Visit::Expression(right));
                    }
                    IrExpr::Array(items) => {
                        if !native_result_type(&expression.ty) {
                            return None;
                        }
                        extend!(items.iter().map(Visit::Expression));
                    }
                    IrExpr::Unary { operand, .. } => push!(Visit::Expression(operand)),
                    IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                        extend!(args.iter().map(Visit::Expression));
                        if let IrCallTarget::DeriveFn(canonical) = target {
                            if context.owners.contains(canonical) || context.calls.len() >= 64 {
                                return None;
                            }
                            let mut candidates =
                                ir.items.iter().filter(|item| item.canonical == *canonical);
                            let callee = candidates.next()?;
                            if candidates.next().is_some() {
                                return None;
                            }
                            let IrItemKind::DeriveFn {
                                params,
                                expr: Some(body),
                                ..
                            } = &callee.kind
                            else {
                                return None;
                            };
                            if params.len() > 256 {
                                return None;
                            }
                            let slots = match &expression.expr {
                                IrExpr::BoundCall { slots, .. } => slots.clone(),
                                _ => (0..args.len()).map(Some).collect(),
                            };
                            if slots.len() != params.len()
                                || slots.iter().flatten().any(|index| *index >= args.len())
                                || (0..args.len()).any(|index| {
                                    slots.iter().filter(|slot| **slot == Some(index)).count() != 1
                                })
                            {
                                return None;
                            }
                            let call_site = context.site(expression.span);
                            if out.calls.insert(call_site, canonical.clone()).is_some() {
                                return None;
                            }
                            let mut nested = child.clone();
                            nested.calls.push(expression.span);
                            nested.owners.push(canonical.clone());
                            if owning_module(ir, body.span)?.id != callee.module {
                                return None;
                            }
                            pending.push((Visit::Expression(body), nested.clone()));
                            for (id, slot) in params.iter().zip(slots) {
                                let param = ir.items.get(id.0 as usize)?;
                                let IrItemKind::Param { owner, default, .. } = &param.kind else {
                                    return None;
                                };
                                if param.id != *id || *owner != callee.id {
                                    return None;
                                }
                                if slot.is_none() {
                                    let default = match default.as_ref()? {
                                        IrDefault::Literal(expr)
                                        | IrDefault::Computed { expr, .. } => expr,
                                    };
                                    if owning_module(ir, default.span)?.id != callee.module {
                                        return None;
                                    }
                                    pending.push((Visit::Expression(default), nested.clone()));
                                }
                            }
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
                    | IrExpr::Datetime(_)
                    | IrExpr::Name(_) => {}
                    IrExpr::HasRole { person, .. } => {
                        extend!(person.iter().map(|person| Visit::Expression(person)))
                    }
                    _ => return None,
                },
            }
        }
        Some(out)
    }
}

#[derive(Clone, Default)]
struct Walk {
    calls: Vec<Span>,
    owners: Vec<String>,
    depth: usize,
}
impl Walk {
    fn site(&self, span: Span) -> NativeSite {
        NativeSite {
            calls: self.calls.clone(),
            span,
        }
    }
}
fn checked_site(
    node: crate::analysis::NodeKey,
    calls: &[crate::analysis::NodeKey],
) -> Option<NativeSite> {
    if calls.len() > 64 || calls.iter().any(|call| call.kind != SyntaxKind::Call as u8) {
        return None;
    }
    Some(NativeSite {
        calls: calls.iter().copied().map(node_span).collect(),
        span: node_span(node),
    })
}
fn owning_module(ir: &IrProgram, span: Span) -> Option<&super::ir::IrModule> {
    let mut candidates = ir.modules.iter().filter(|module| {
        module.file == span.file && module.span.start <= span.start && span.end <= module.span.end
    });
    let owner = candidates.next()?;
    candidates.next().is_none().then_some(owner)
}
fn source_matches(ir: &IrProgram, source: &DisclosureSource, span: Span) -> bool {
    owning_module(ir, span).is_some_and(|module| module.name == source.module)
        && !source.path.is_empty()
        && source.sha256.len() == 64
        && source
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
