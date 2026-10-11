//! Checked return-specific provenance, before lowering erases lexical identities.
//!
//! These facts are not grants. Only `Complete` may become a disclosure plan.
//! A failed closure declines the whole scenario, including earlier returns.
use std::collections::{HashMap, HashSet};

use super::catalog::{nominal_schema, std_capability, std_operation};
use super::effects::{DeleteMode, Effect, EffectTables, EffectTarget, EffectVerb, HandlerSource};
use super::resolve::{
    Binding, ContextVar, ModelOwner, ResolveTables, ScopedName, SymbolKind, TypeRef,
};
use super::types::{
    CheckedQueryClauseKind, CheckedQueryProjectionField, CheckedQueryProjectionMapping,
    SelectedCallTarget, checked_standard_nominal_name,
};
use super::{ModuleId, NodeKey, ResolvedType, Scalar, SymbolId, TypeTable};
use crate::source::{SourceDb, SourceId, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisclosureSource {
    pub path: String,
    pub sha256: String,
    pub module: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DependencyRole {
    Data,
    Control,
}

/// Exact read occurrence, including the invocation chain for repeated derives.
#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureDependency {
    pub id: String,
    pub source: DisclosureSource,
    pub node: NodeKey,
    pub calls: Vec<NodeKey>,
    pub role: DependencyRole,
    pub model: SymbolId,
    pub field: SymbolId,
    pub model_name: String,
    pub field_name: String,
    pub ty: ResolvedType,
    pub type_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisclosureIntrinsicKind {
    OperationId,
    AdmittedInput {
        parameter: SymbolId,
        parameter_name: String,
    },
    AdmittedReferenceVersion {
        parameter: SymbolId,
        parameter_name: String,
        model: SymbolId,
        model_name: String,
    },
}

#[derive(Debug, Clone)]
pub struct DisclosureIntrinsic {
    pub id: String,
    pub source: DisclosureSource,
    pub node: NodeKey,
    pub calls: Vec<NodeKey>,
    pub role: DependencyRole,
    pub kind: DisclosureIntrinsicKind,
    pub ty: ResolvedType,
    pub type_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InfluenceKind {
    QueryExistence,
    QueryCardinality,
    QueryMembership,
    QueryOrder,
    AbsentReference,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureInfluence {
    pub id: String,
    pub source: DisclosureSource,
    pub node: NodeKey,
    pub kind: InfluenceKind,
    /// Exact owning scan occurrence; absent-reference influences have no query.
    pub query_id: Option<String>,
}

/// Closed source producer for a viewer model scan and its nominal projection.
/// This remains available when unrelated authorization/native admission declines.
#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureQuery {
    pub id: String,
    pub source: DisclosureSource,
    pub node: NodeKey,
    pub domain: NodeKey,
    pub model: SymbolId,
    pub model_name: String,
    pub alias: NodeKey,
    pub predicate: NodeKey,
    pub inputs: Vec<(NodeKey, SymbolId)>,
    pub dependencies: Vec<DisclosureDependency>,
    pub order: Vec<DisclosureQueryOrder>,
    pub limit: Option<u16>,
    pub archived: bool,
    pub cardinality_guard: NodeKey,
    pub return_node: NodeKey,
    pub projection: DisclosureQueryProjection,
    pub influences: Vec<DisclosureInfluence>,
}

impl DisclosureQuery {
    /// The checked projection return identity shared by admission and transport.
    pub fn return_id(&self) -> String {
        sha256_hex(
            format!(
                "query-return:{}:{}:{}",
                self.id, self.return_node.start, self.return_node.end
            )
            .as_bytes(),
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureQueryOrder {
    pub field: SymbolId,
    pub field_name: String,
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureQueryProjection {
    /// The actual local select query, not the model-domain scan.
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub contract: SymbolId,
    pub model: SymbolId,
    pub alias: NodeKey,
    pub fields: Vec<CheckedQueryProjectionField>,
}

/// Emitter recipe: observe this decision once at its existing evaluation site.
/// `calls` identifies the derive invocation, never a request to reevaluate it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisclosureDecision {
    pub node: NodeKey,
    pub calls: Vec<NodeKey>,
    pub choice: DisclosureChoice,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisclosureChoice {
    Then,
    Else,
    Match(String),
    RhsEvaluated,
    RhsSkipped,
    DefaultEvaluated,
    DefaultProvided,
}

#[derive(Debug, Clone)]
pub struct DisclosureReturn {
    pub id: String,
    pub source: DisclosureSource,
    pub node: NodeKey,
    pub decisions: Vec<DisclosureDecision>,
    pub dependencies: Vec<DisclosureDependency>,
    pub intrinsics: Vec<DisclosureIntrinsic>,
    pub influences: Vec<DisclosureInfluence>,
    /// Checked lexical producer of a newly-created singular stored result.
    /// This is source provenance; the native owner must bind its current row.
    pub(crate) model_result: Option<DisclosureModelResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DisclosureModelResult {
    Create {
        model: SymbolId,
        node: NodeKey,
    },
    Call {
        model: SymbolId,
        node: NodeKey,
        operation: SymbolId,
    },
}

impl DisclosureModelResult {
    pub(crate) fn model(self) -> SymbolId {
        match self {
            Self::Create { model, .. } | Self::Call { model, .. } => model,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureEffect {
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub kind: DisclosureEffectKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisclosureFileInput {
    pub field: SymbolId,
    pub parameter: SymbolId,
    pub value: NodeKey,
}

/// Original literal model defaults for the empty, root-model create profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisclosureCreateDefault {
    pub field: SymbolId,
    pub default: NodeKey,
    pub value: i128,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedScenarioCreateInput {
    pub name: String,
    /// Absent only for the exact implicit containment parent.
    pub field: Option<SymbolId>,
    pub key_node: NodeKey,
    pub value_node: NodeKey,
    pub ty: ResolvedType,
}

/// Original checked declaration, retained without evaluating initializers or
/// granting access to a runtime row. Field metadata stays in declaration order.
#[derive(Debug, Clone)]
pub struct CheckedScenarioCreatedModel {
    pub canonical: String,
    pub source: DisclosureSource,
    pub span: crate::source::Span,
    pub declaration: super::effects::ModelData,
    pub fields: Vec<CheckedScenarioCreatedField>,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioCreatedField {
    pub field: SymbolId,
    pub name: String,
    pub canonical: String,
    pub source: DisclosureSource,
    pub ty: ResolvedType,
    pub constraints: Option<super::resolve::CheckedValueConstraints>,
    pub reuse: Option<SymbolId>,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioCreate {
    pub node: NodeKey,
    pub target_node: NodeKey,
    pub source: DisclosureSource,
    pub model: SymbolId,
    pub binding: String,
    pub inputs: Vec<CheckedScenarioCreateInput>,
    pub definition: CheckedScenarioCreatedModel,
    /// Original checked subtree types, before lowering can erase local binding
    /// identity. This source seal grants no expression or runtime admission.
    pub(crate) expression_types: Vec<(NodeKey, ResolvedType)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DisclosureEffectKind {
    Create {
        model: SymbolId,
        crud: Option<SymbolId>,
        binding: String,
        defaults: Vec<DisclosureCreateDefault>,
        inputs: Vec<CheckedScenarioCreateInput>,
    },
    Delete {
        model: SymbolId,
        crud: SymbolId,
        receiver: NodeKey,
    },
    For {
        domain: NodeKey,
        limit: NodeKey,
        maximum: u16,
        item: String,
        parameter: SymbolId,
        model: SymbolId,
        body: Vec<NodeKey>,
    },
    Call {
        operation: SymbolId,
        input_keys: Vec<String>,
    },
    Set {
        model: SymbolId,
        fields: Vec<SymbolId>,
        file_inputs: Vec<DisclosureFileInput>,
    },
    Send {
        operation: String,
        deployment_binding: Option<String>,
        /// Durable dispatch predicate occurrence, not a parent branch selector.
        when: Option<NodeKey>,
    },
}

/// Clean checked source structure only; these facts establish neither
/// provenance completeness nor eligibility for native execution.
#[derive(Debug, Clone)]
pub struct CheckedScenarioSource {
    pub scenario: SymbolId,
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub read: bool,
    pub parameters: Vec<CheckedScenarioParameter>,
    pub result: Option<ResolvedType>,
    pub calls: Vec<CheckedScenarioSourceCall>,
    /// Bounded original owning expression types; source facts confer no admission.
    pub(crate) expression_types: Option<Vec<(NodeKey, ResolvedType)>>,
    /// Exact authored scenario creates, even when another closure leaf declines.
    /// Absence is missing evidence, never an empty create proof.
    pub creates: Option<Vec<CheckedScenarioCreate>>,
    /// Optional bounded source inventory, never permission or effect admission.
    pub decision_sites: Option<Vec<CheckedDecisionSite>>,
    /// Complete bounded query lineage only; absence is not an empty proof.
    pub queries: Option<Vec<DisclosureQuery>>,
    /// Private owning stored-field/Contract snapshots and two-parent Model
    /// source operands. File declarations here grant no receipt admission.
    pub(crate) stored_contracts: Option<Vec<CheckedStoredContractSchema>>,
}

#[derive(Debug, Clone)]
pub(crate) struct CheckedStoredContractSchema {
    pub id: SymbolId,
    pub canonical: String,
    pub module: ModuleId,
    pub span: crate::source::Span,
    pub source: DisclosureSource,
    pub model: bool,
    /// Exact implicit containment owner; never an authored stored field.
    pub parent: Option<SymbolId>,
    pub owner: Option<super::resolve::ModelOwner>,
    pub field_order: Vec<SymbolId>,
    pub fields: Vec<CheckedStoredContractField>,
}

#[derive(Debug, Clone)]
pub(crate) struct CheckedStoredContractField {
    pub id: SymbolId,
    pub canonical: String,
    pub name: String,
    pub owner: SymbolId,
    pub span: crate::source::Span,
    pub source: DisclosureSource,
    pub ty: ResolvedType,
    pub required_array: bool,
    pub declared: String,
    pub constraints: Option<super::resolve::CheckedValueConstraints>,
    /// Actual checked reusable field identity, separate from inherited bounds.
    pub reuse: Option<SymbolId>,
    pub trim: bool,
    pub min: Option<(NodeKey, i64, DisclosureSource)>,
    pub max: Option<(NodeKey, i64, DisclosureSource)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckedDecisionStage {
    LeadingRequire,
    BodyRequire,
    BodyCondition,
    ReadPolicy,
    ReadPredicate,
    SendDispatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckedDecisionPosition {
    Guard(usize),
    Body(usize),
    Then(usize),
    Else(usize),
    Match { arm: usize, statement: usize },
    Loop(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedDecisionSite {
    pub owner: SymbolId,
    pub source: DisclosureSource,
    pub node: NodeKey,
    pub statement: NodeKey,
    pub stage: CheckedDecisionStage,
    pub position: Vec<CheckedDecisionPosition>,
    pub calls: Vec<CheckedDecisionCall>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CheckedDecisionCallTarget {
    Builtin { id: String, overload: usize },
    DeriveFn(SymbolId),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedDecisionCallFrame {
    pub node: NodeKey,
    pub module: ModuleId,
    pub source: DisclosureSource,
    pub derive: SymbolId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedDecisionCall {
    pub node: NodeKey,
    pub module: ModuleId,
    pub source: DisclosureSource,
    pub target: CheckedDecisionCallTarget,
    pub arguments: Vec<(NodeKey, ResolvedType)>,
    pub slots: Vec<Option<usize>>,
    /// Only omitted defaults; supplied arguments do not visit these bodies.
    pub defaults: Vec<(SymbolId, NodeKey)>,
    pub chain: Vec<CheckedDecisionCallFrame>,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioParameter {
    pub parameter: SymbolId,
    pub node: NodeKey,
    pub type_node: NodeKey,
    pub ty: ResolvedType,
    pub default: Option<NodeKey>,
    pub constraints: Option<super::resolve::CheckedValueConstraints>,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioSourceCall {
    pub node: NodeKey,
    pub target_node: NodeKey,
    pub operation: SymbolId,
    pub inputs: Vec<CheckedScenarioCallInput>,
    pub binding: Option<String>,
    pub result: Option<ResolvedType>,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioCallInput {
    pub name: String,
    pub node: NodeKey,
    pub ty: ResolvedType,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioDisclosure {
    pub source_facts: Option<Box<CheckedScenarioSource>>,
    pub scenario: SymbolId,
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub returns: Vec<DisclosureReturn>,
    pub effects: Vec<DisclosureEffect>,
}

#[derive(Debug, Clone)]
pub struct DisclosureDecline {
    pub source_facts: Option<Box<CheckedScenarioSource>>,
    pub node: NodeKey,
    pub reason: &'static str,
    pub influences: Vec<DisclosureInfluence>,
}

#[derive(Debug, Clone)]
pub enum ScenarioDisclosure {
    Complete(CheckedScenarioDisclosure),
    Declined(DisclosureDecline),
}

impl ScenarioDisclosure {
    pub fn source_facts(&self) -> Option<&CheckedScenarioSource> {
        match self {
            Self::Complete(value) => value.source_facts.as_deref(),
            Self::Declined(value) => value.source_facts.as_deref(),
        }
    }
}

/// Invoke only for a clean checked cohort. Missing anchors/facts decline;
/// absence of a table row never proves an empty dependency closure.
pub fn analyze_scenario_disclosure(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    resolve: &ResolveTables,
    types: &TypeTable,
    effects: &EffectTables,
) -> HashMap<SymbolId, ScenarioDisclosure> {
    let mut nodes = HashMap::new();
    let mut pending: Vec<_> = trees.iter().map(|(_, tree)| tree).collect();
    while let Some(node) = pending.pop() {
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter());
    }
    let mut cx = Closure {
        db,
        resolve,
        types,
        effects,
        nodes,
        stack: HashSet::new(),
        steps: 0,
        depth: 0,
        statement_depth: 0,
        authorization: false,
        effect_proofs: Vec::new(),
        effect_visits: 0,
        loop_node: None,
        complete_children: HashSet::new(),
        complete_model_children: HashMap::new(),
        result_model: None,
    };
    let mut out = HashMap::new();
    // Resolve only proven acyclic children. A prior wave can establish a
    // parent, never its own recursive prerequisite; cap the call depth at 16.
    for _ in 0..=16 {
        cx.complete_children = out
            .iter()
            .filter_map(|(id, value)| match value {
                ScenarioDisclosure::Complete(_) => Some(*id),
                ScenarioDisclosure::Declined(_) => None,
            })
            .collect();
        cx.complete_model_children = out
            .iter()
            .filter_map(|(id, value)| {
                let ScenarioDisclosure::Complete(checked) = value else {
                    return None;
                };
                let model = stored_result_model(types.symbol_results.get(id)?.as_ref()?, resolve)?;
                (!checked.returns.is_empty()
                    && checked.returns.iter().all(|returned| {
                        returned
                            .model_result
                            .is_some_and(|origin| origin.model() == model)
                    }))
                .then_some((*id, model))
            })
            .collect();
        let prior_complete = cx.complete_children.len();
        for scenario in effects.scenarios.values() {
            if cx.complete_children.contains(&scenario.scenario) {
                continue;
            }
            cx.steps = 0;
            cx.stack.clear();
            cx.effect_proofs.clear();
            cx.loop_node = None;
            cx.effect_visits = 0;
            cx.result_model = None;
            let result = (|| {
                if scenario.on.is_some() {
                    return Err(cx.fail(scenario.node, "trusted handler"));
                }
                if let Some(plan) = cx.complete_query(scenario)? {
                    return Ok(plan);
                }
                let signature = types
                    .symbol_results
                    .get(&scenario.scenario)
                    .ok_or_else(|| cx.fail(scenario.node, "missing checked result signature"))?;
                cx.result_model = signature
                    .as_ref()
                    .and_then(|ty| stored_result_model(ty, resolve));
                if signature.as_ref().is_some_and(|ty| !result_type(ty))
                    && cx.result_model.is_none()
                {
                    return Err(cx.fail(scenario.node, "unsupported result shape"));
                }
                let source = cx.source(scenario.module, scenario.node)?;
                let mut flows = vec![Flow::default()];
                for param in &scenario.params {
                    let ty = types
                        .symbol_types
                        .get(&param.param)
                        .ok_or_else(|| cx.fail(param.node, "missing parameter type"))?;
                    let mut supplied = ValuePath::default();
                    if let ResolvedType::Record {
                        symbol,
                        stored: true,
                    } = ty
                        && matches!(
                            resolve.symbols.get(symbol.0 as usize).map(|s| &s.kind),
                            Some(SymbolKind::Model { .. })
                        )
                    {
                        supplied.record = Some(*symbol);
                        if !scenario.read && param.default.is_none() {
                            supplied.reference_origin =
                                Some(ReferenceOrigin::Parameter(param.param));
                            let parameter =
                                resolve.symbols.get(param.param.0 as usize).ok_or_else(|| {
                                    cx.fail(param.node, "missing admitted parameter declaration")
                                })?;
                            let model =
                                resolve.symbols.get(symbol.0 as usize).ok_or_else(|| {
                                    cx.fail(param.node, "missing admitted parameter model")
                                })?;
                            supplied.reference =
                                Some(DisclosureIntrinsicKind::AdmittedReferenceVersion {
                                    parameter: param.param,
                                    parameter_name: parameter.name.clone(),
                                    model: *symbol,
                                    model_name: model.canonical.clone(),
                                });
                        }
                    }
                    if let ResolvedType::Scalar(scalar) = ty
                        && primitive_type(ty)
                        && param.default.is_none()
                        && cx.direct_builtin_parameter_type(param.type_node, *scalar)
                        && !types
                            .value_constraints
                            .get(&param.param)
                            .is_some_and(|value| value.alias.is_some())
                    {
                        let parameter =
                            resolve.symbols.get(param.param.0 as usize).ok_or_else(|| {
                                cx.fail(param.node, "missing admitted primitive parameter")
                            })?;
                        supplied.input = Some((param.param, parameter.name.clone(), *scalar));
                    }
                    let mut next = Vec::new();
                    for flow in flows {
                        // Only prior declaration bindings exist while this default
                        // executes. An explicit input is already admitted and frozen.
                        let alternatives = match param.default {
                            Some(default) if !cx.admitted_actor_default(default, ty) => {
                                Some((default, cx.expr(default, scenario.module, &flow.env, &[])?))
                            }
                            _ => None,
                        };
                        if let Some((default, alternatives)) = alternatives
                            && alternatives.iter().any(|value| {
                                !value.reads.is_empty()
                                    || !value.intrinsics.is_empty()
                                    || !value.decisions.is_empty()
                            })
                        {
                            let provided = DisclosureDecision {
                                node: default,
                                calls: Vec::new(),
                                choice: DisclosureChoice::DefaultProvided,
                            };
                            let mut provided_flow = flow.clone();
                            let mut frozen = supplied.clone();
                            frozen.decisions.push(provided.clone());
                            provided_flow.env.insert(Local::Symbol(param.param), frozen);
                            provided_flow.evaluated.push(provided);
                            next.push(provided_flow);
                            for mut value in alternatives {
                                if !compatible(&flow.evaluated, &value.decisions) {
                                    continue;
                                }
                                let decision = DisclosureDecision {
                                    node: default,
                                    calls: Vec::new(),
                                    choice: DisclosureChoice::DefaultEvaluated,
                                };
                                let mut evaluated = flow.clone();
                                evaluated.evaluated.push(decision.clone());
                                for observed in &value.observed {
                                    if !evaluated.observed.contains(observed) {
                                        evaluated.observed.push(observed.clone());
                                    }
                                }
                                for choice in &value.decisions {
                                    if !evaluated.evaluated.contains(choice) {
                                        evaluated.evaluated.push(choice.clone());
                                    }
                                }
                                value.decisions.push(decision);
                                evaluated.env.insert(Local::Symbol(param.param), value);
                                next.push(evaluated);
                                if next.len() > 1024 {
                                    return Err(
                                        cx.fail(default, "parameter default evaluation path bound")
                                    );
                                }
                            }
                        } else {
                            let mut path = flow;
                            path.env
                                .insert(Local::Symbol(param.param), supplied.clone());
                            next.push(path);
                        }
                        if next.len() > 1024 {
                            return Err(
                                cx.fail(param.node, "parameter default evaluation path bound")
                            );
                        }
                    }
                    if next.iter().any(|flow| flow.env.len() > 256) {
                        return Err(cx.fail(param.node, "binding closure bound"));
                    }
                    flows = next;
                }
                if let Some(by) = scenario.by {
                    for flow in &flows {
                        cx.authorization_expr(by, scenario.module, &flow.env, &[])?;
                    }
                }
                let (guards, _) = cx.statements(&scenario.guards, scenario.module, flows, &[])?;
                let (continuing, mut returns) =
                    cx.statements(&scenario.effects, scenario.module, guards, &[])?;
                if !continuing.is_empty() {
                    if signature.is_some() {
                        return Err(cx.fail(scenario.node, "unaccounted result fallthrough"));
                    }
                    for path in continuing {
                        returns.push(cx.return_path(
                            scenario.node,
                            scenario.module,
                            path,
                            ValuePath::default(),
                        )?);
                    }
                }
                if returns.is_empty() {
                    return Err(cx.fail(scenario.node, "no established return path"));
                }
                if let Some(model) = cx.result_model
                    && returns.iter().any(|returned| {
                        returned
                            .model_result
                            .is_none_or(|origin| origin.model() != model)
                    })
                {
                    return Err(cx.fail(
                        scenario.node,
                        "result requires its newly-created model provenance",
                    ));
                }
                for path in &mut returns {
                    path.id = cx.opaque(
                        "return",
                        scenario.node,
                        &cx.decision_stamp(&path.decisions)?,
                    )?;
                    // Include the return anchor: two explicit returns under the
                    // same decisions must never collide.
                    path.id = sha256_hex(
                        format!("{}:{}:{}", path.id, path.node.start, path.node.end).as_bytes(),
                    );
                }
                Ok(CheckedScenarioDisclosure {
                    source_facts: None,
                    scenario: scenario.scenario,
                    node: scenario.node,
                    source,
                    returns,
                    effects: cx.effect_proofs.clone(),
                })
            })();
            out.insert(
                scenario.scenario,
                match result {
                    Ok(plan) => ScenarioDisclosure::Complete(plan),
                    Err(reason) => ScenarioDisclosure::Declined(reason),
                },
            );
        }
        if out
            .values()
            .filter(|value| matches!(value, ScenarioDisclosure::Complete(_)))
            .count()
            == prior_complete
        {
            break;
        }
    }
    // Source facts are collected once, independently of closure waves and
    // runtime admission. Declined read/composite/bound-call plans retain them.
    for scenario in effects.scenarios.values() {
        let facts = cx.checked_source_facts(scenario).map(Box::new);
        match out.get_mut(&scenario.scenario) {
            Some(ScenarioDisclosure::Complete(value)) => value.source_facts = facts,
            Some(ScenarioDisclosure::Declined(value)) => value.source_facts = facts,
            None => {}
        }
    }
    out
}

/// Collect original read/where expressions from a clean checked source cohort.
/// The ordinal belongs to the owning model's authored policy order. These
/// bounded facts identify selected calls and grant no runtime authority.
pub fn checked_read_decision_sites(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    resolve: &ResolveTables,
    types: &TypeTable,
    effects: &EffectTables,
    model: SymbolId,
    ordinal: usize,
) -> Option<Vec<CheckedDecisionSite>> {
    let declaration = resolve.symbols.get(model.0 as usize)?;
    let data = effects.models.get(&model)?;
    let policy = data.policies.get(ordinal)?;
    if declaration.id != model
        || data.model != model
        || !matches!(declaration.kind, SymbolKind::Model { .. })
        || declaration.module != data.module
        || policy.module != data.module
    {
        return None;
    }
    let mut nodes = HashMap::new();
    let mut pending = trees
        .iter()
        .map(|(_, tree)| (tree, 0usize))
        .collect::<Vec<_>>();
    while let Some((node, depth)) = pending.pop() {
        if nodes.len() >= 200000 || depth > 256 {
            return None;
        }
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter().map(|child| (child, depth + 1)));
    }
    let node = nodes.get(&policy.node)?;
    let text = &db.get(policy.node.file)?.text;
    if node.kind != SyntaxKind::Policy
        || super::attribute_value(node, "read", text).map(NodeKey::of) != policy.read
        || super::attribute_value(node, "where", text).map(NodeKey::of) != policy.where_predicate
    {
        return None;
    }
    let cx = Closure {
        db,
        resolve,
        types,
        effects,
        nodes,
        stack: HashSet::new(),
        steps: 0,
        depth: 0,
        statement_depth: 0,
        authorization: false,
        effect_proofs: Vec::new(),
        effect_visits: 0,
        loop_node: None,
        complete_children: HashSet::new(),
        complete_model_children: HashMap::new(),
        result_model: None,
    };
    let mut sites = Vec::new();
    let mut steps = 0;
    let mut call_count = 0;
    for key in std::iter::once(policy.read?).chain(policy.where_predicate) {
        if key.file != policy.node.file
            || key.start < policy.node.start
            || key.end > policy.node.end
            || key.start >= key.end
            || types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
        let mut calls = Vec::new();
        cx.checked_decision_expression(
            key,
            policy.module,
            &[],
            &mut HashSet::new(),
            &mut calls,
            &mut steps,
            &mut call_count,
            0,
        )?;
        sites.push(CheckedDecisionSite {
            owner: model,
            source: cx.source(policy.module, key).ok()?,
            node: key,
            statement: policy.node,
            stage: CheckedDecisionStage::ReadPolicy,
            position: Vec::new(),
            calls,
        });
    }
    Some(sites)
}

/// Original named-page model-query predicate, separate from policy grants.
/// Transitive call facts retain their actual selected expression provenance.
#[allow(clippy::too_many_arguments)]
pub fn checked_read_predicate_site(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    resolve: &ResolveTables,
    types: &TypeTable,
    effects: &EffectTables,
    module: ModuleId,
    page: NodeKey,
    query: NodeKey,
) -> Option<CheckedDecisionSite> {
    let checked = types.checked_queries.get(&query)?;
    let ResolvedType::Array { element, .. } = &checked.domain_type else {
        return None;
    };
    let ResolvedType::Record {
        symbol: owner,
        stored: true,
    } = element.as_ref()
    else {
        return None;
    };
    let owner = *owner;
    if !matches!(
        resolve.symbols.get(owner.0 as usize)?.kind,
        SymbolKind::Model { .. }
    ) || !effects
        .modules
        .get(&module)?
        .pages
        .iter()
        .any(|candidate| candidate.node == page)
        || query.file != page.file
        || query.start < page.start
        || query.end > page.end
    {
        return None;
    }
    let mut clauses = checked
        .clauses
        .iter()
        .filter(|clause| matches!(clause.kind, CheckedQueryClauseKind::Where));
    let clause = clauses.next()?;
    let [predicate] = clause.expressions.as_slice() else {
        return None;
    };
    if clauses.next().is_some()
        || types.node_types.get(predicate) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let mut nodes = HashMap::new();
    let mut pending = trees
        .iter()
        .map(|(_, tree)| (tree, 0usize))
        .collect::<Vec<_>>();
    while let Some((node, depth)) = pending.pop() {
        if nodes.len() >= 200000 || depth > 256 {
            return None;
        }
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter().map(|child| (child, depth + 1)));
    }
    if nodes.get(&page)?.kind != SyntaxKind::Page
        || nodes.get(&query)?.kind != SyntaxKind::Query
        || nodes.get(&clause.node)?.kind != SyntaxKind::QueryClause
        || predicate.file != query.file
        || predicate.start < query.start
        || predicate.end > query.end
    {
        return None;
    }
    let cx = Closure {
        db,
        resolve,
        types,
        effects,
        nodes,
        stack: HashSet::new(),
        steps: 0,
        depth: 0,
        statement_depth: 0,
        authorization: false,
        effect_proofs: Vec::new(),
        effect_visits: 0,
        loop_node: None,
        complete_children: HashSet::new(),
        complete_model_children: HashMap::new(),
        result_model: None,
    };
    let mut calls = Vec::new();
    let mut steps = 0;
    let mut count = 0;
    cx.checked_decision_expression(
        *predicate,
        module,
        &[],
        &mut HashSet::new(),
        &mut calls,
        &mut steps,
        &mut count,
        0,
    )?;
    Some(CheckedDecisionSite {
        owner,
        source: cx.source(module, *predicate).ok()?,
        node: *predicate,
        statement: query,
        stage: CheckedDecisionStage::ReadPredicate,
        position: Vec::new(),
        calls,
    })
}

fn checked_source_type(ty: &ResolvedType) -> bool {
    let mut pending = vec![(ty, 0usize)];
    let mut steps = 0usize;
    while let Some((ty, depth)) = pending.pop() {
        steps += 1;
        if steps > 4096 || depth > 64 {
            return false;
        }
        match ty {
            ResolvedType::Unknown | ResolvedType::Error | ResolvedType::Opaque(_) => return false,
            ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
                pending.push((inner, depth + 1));
            }
            ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. } => {
                if fields.len() > 4096 {
                    return false;
                }
                pending.extend(fields.iter().map(|(_, ty)| (ty, depth + 1)));
            }
            _ => {}
        }
        if pending.len() > 4096 {
            return false;
        }
    }
    true
}

/// Assignment correspondence used by the bounded create source proof. Unknown
/// values never qualify; concrete arrays may carry a stronger nonempty fact.
fn created_input_type_matches(
    actual: &ResolvedType,
    expected: &ResolvedType,
    depth: usize,
) -> bool {
    if depth > 64 || !checked_source_type(actual) || !checked_source_type(expected) {
        return false;
    }
    match (actual, expected) {
        (ResolvedType::Null, ResolvedType::Nullable(_)) => true,
        (ResolvedType::Nullable(actual), ResolvedType::Nullable(expected)) => {
            created_input_type_matches(actual, expected, depth + 1)
        }
        (_, ResolvedType::Nullable(expected)) => {
            created_input_type_matches(actual, expected, depth + 1)
        }
        (
            ResolvedType::Array {
                element: actual,
                ordered: actual_order,
                nonempty: actual_nonempty,
            },
            ResolvedType::Array {
                element: expected,
                ordered: expected_order,
                nonempty,
            },
        ) => {
            actual_order == expected_order
                && (!nonempty || *actual_nonempty)
                && created_input_type_matches(actual, expected, depth + 1)
        }
        (ResolvedType::StdNominal { .. }, ResolvedType::StdNominal { .. }) => {
            checked_standard_nominal_name(actual).is_some()
                && checked_standard_nominal_name(actual) == checked_standard_nominal_name(expected)
                && actual == expected
        }
        _ => actual == expected,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Local {
    Symbol(SymbolId),
    Let(NodeKey),
    For(NodeKey),
    Send(NodeKey),
    Call(NodeKey),
    Create(NodeKey),
}
type Env = HashMap<Local, ValuePath>;

/// Canonical stored Contract values retain their whole owning-field read.
/// These are local wire values, never stored record receivers or grants.
#[derive(Debug, Clone, Copy)]
enum ContractValue {
    Singular(SymbolId),
    Array(SymbolId),
    Reference,
}

#[derive(Debug, Clone)]
struct ContractPredicateAlias {
    node: NodeKey,
    contract: SymbolId,
    ty: ResolvedType,
    projection: Option<DisclosureQueryProjection>,
}

#[derive(Debug, Clone, Default)]
struct ValuePath {
    reads: Vec<DisclosureDependency>,
    intrinsics: Vec<DisclosureIntrinsic>,
    observed: Vec<(NodeKey, Vec<NodeKey>)>,
    decisions: Vec<DisclosureDecision>,
    record: Option<SymbolId>,
    model_result: Option<DisclosureModelResult>,
    reference: Option<DisclosureIntrinsicKind>,
    input: Option<(SymbolId, String, Scalar)>,
    members: Option<Vec<(String, ValuePath)>>,
    schema: Option<String>,
    delivery: Option<ResolvedType>,
    /// Exact Complete query child whose actual call occurrence owns this wire.
    /// This marker admits only direct cardinality consumption, never a row view.
    query_child: Option<SymbolId>,
    contract_value: Option<ContractValue>,
    /// Original input and at most two checked implicit containment edges.
    reference_origin: Option<ReferenceOrigin>,
}

#[derive(Debug, Clone, Copy)]
enum ReferenceOrigin {
    Parameter(SymbolId),
    Parent {
        parameter: SymbolId,
        model: SymbolId,
        depth: u8,
    },
    Field {
        parameter: SymbolId,
        model: SymbolId,
        field: SymbolId,
    },
}

impl ValuePath {
    fn join(&mut self, other: &Self) {
        for read in &other.observed {
            if !self.observed.contains(read) {
                self.observed.push(read.clone());
            }
        }
        for read in &other.reads {
            if !self.reads.iter().any(|r| r.id == read.id) {
                self.reads.push(read.clone());
            }
        }
        for intrinsic in &other.intrinsics {
            if !self.intrinsics.iter().any(|prior| prior.id == intrinsic.id) {
                self.intrinsics.push(intrinsic.clone());
            }
        }
        for decision in &other.decisions {
            if !self.decisions.contains(decision) {
                self.decisions.push(decision.clone());
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Flow {
    env: Env,
    controls: ValuePath,
    /// Dependencies of writes already executed on this path survive a common
    /// postdominator even when its scalar return no longer depends on a branch.
    writes: ValuePath,
    effect_guards: ValuePath,
    executed_effect: bool,
    repeated_observations: usize,
    evaluated: Vec<DisclosureDecision>,
    observed: Vec<(NodeKey, Vec<NodeKey>)>,
}

struct Closure<'a> {
    complete_children: HashSet<SymbolId>,
    complete_model_children: HashMap<SymbolId, SymbolId>,
    result_model: Option<SymbolId>,
    db: &'a SourceDb,
    resolve: &'a ResolveTables,
    types: &'a TypeTable,
    effects: &'a EffectTables,
    nodes: HashMap<NodeKey, &'a SyntaxNode>,
    stack: HashSet<SymbolId>,
    steps: usize,
    depth: usize,
    statement_depth: usize,
    authorization: bool,
    effect_proofs: Vec<DisclosureEffect>,
    effect_visits: usize,
    loop_node: Option<NodeKey>,
}

impl<'a> Closure<'a> {
    fn authorization_expr(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let prior = self.authorization;
        self.authorization = true;
        let result = self.expr(key, module, env, calls);
        self.authorization = prior;
        result
    }

    /// The canonical input-default producer owns this admitted, frozen value.
    /// This exception applies only to a checked Actor parameter default; body
    /// context reads still pass through ordinary closure inspection and decline.
    fn admitted_actor_default(&self, key: NodeKey, declared: &ResolvedType) -> bool {
        let user = |ty: &ResolvedType| match ty {
            ResolvedType::Scalar(Scalar::User) => true,
            ResolvedType::Nullable(inner) => {
                matches!(inner.as_ref(), ResolvedType::Scalar(Scalar::User))
            }
            _ => false,
        };
        if !user(declared) || !self.types.node_types.get(&key).is_some_and(user) {
            return false;
        }
        let mut key = key;
        for _ in 0..64 {
            let Some(node) = self.nodes.get(&key) else {
                return false;
            };
            if node.kind != SyntaxKind::Group {
                return node.kind == SyntaxKind::NameRef
                    && self.types.node_types.get(&key).is_some_and(user)
                    && matches!(
                        self.resolve.node_binding.get(&key),
                        Some(Binding::Context(ContextVar::Actor(_)))
                    );
            }
            let mut children = node.children.iter().filter(|child| expression(child.kind));
            let Some(child) = children.next() else {
                return false;
            };
            if children.next().is_some() {
                return false;
            }
            key = NodeKey::of(child);
        }
        false
    }

    /// Canonical required Model references are operands only, never ordinary
    /// disclosure return types or general stored-field traversal values.
    fn reference_operand_type_id(&self, ty: &ResolvedType) -> Option<String> {
        let (base, array) = match ty {
            ResolvedType::Array {
                element,
                ordered: true,
                nonempty: false,
            } => (element.as_ref(), true),
            ty => (ty, false),
        };
        let ResolvedType::Record {
            symbol,
            stored: true,
        } = base
        else {
            return None;
        };
        let declaration = self.resolve.symbols.get(symbol.0 as usize)?;
        if !matches!(declaration.kind, SymbolKind::Model { .. }) {
            return None;
        }
        Some(format!(
            "{}{}",
            declaration.canonical,
            if array { "[]" } else { "" }
        ))
    }

    /// A stored reference array must genuinely reuse the exact child Scope
    /// field, with the same inherited literal range and no receiving skew.
    fn reference_field_bounds(&self, field: SymbolId, parameter: SymbolId) -> bool {
        let Some(alias) = self.query_parameter_bounds(parameter) else {
            return false;
        };
        self.types.symbol_types.get(&field) == self.types.symbol_types.get(&parameter)
            && self.reference_array_source_bounds(field, alias)
    }

    fn reference_array_source_bounds(&self, field: SymbolId, alias: SymbolId) -> bool {
        if self.types.field_reuse_sources.get(&field) != Some(&alias)
            || !matches!(self.resolve.symbols.get(alias.0 as usize).map(|symbol| &symbol.kind),
                Some(SymbolKind::Field { owner, .. }) if matches!(self.resolve.symbols.get(owner.0 as usize).map(|symbol| &symbol.kind), Some(SymbolKind::Contract { .. })))
        {
            return false;
        }
        let literal_bounds = |start: SymbolId| -> Option<(u64, u64)> {
            let mut current = start;
            let mut seen = HashSet::new();
            let mut chain = Vec::new();
            loop {
                if !seen.insert(current) || seen.len() > 128 {
                    return None;
                }
                let SymbolKind::Field { owner, .. } =
                    self.resolve.symbols.get(current.0 as usize)?.kind
                else {
                    return None;
                };
                let data = self
                    .effects
                    .models
                    .get(&owner)
                    .and_then(|model| model.fields.iter().find(|data| data.field == current))
                    .or_else(|| {
                        self.effects.records.get(&owner).and_then(|record| {
                            record.fields.iter().find(|data| data.field == current)
                        })
                    })?;
                if self.types.symbol_types.get(&current) != self.types.symbol_types.get(&field) {
                    return None;
                }
                chain.push(data);
                let Some(next) = self.types.field_reuse_sources.get(&current) else {
                    break;
                };
                current = *next;
            }
            let mut min = None;
            let mut max = None;
            for data in chain.into_iter().rev() {
                for modifier in &data.modifiers {
                    let slot = match modifier.name.as_str() {
                        "min" => &mut min,
                        "max" => &mut max,
                        _ => continue,
                    };
                    let key = self.query_group(modifier.value?)?;
                    if self.nodes.get(&key)?.kind != SyntaxKind::Literal
                        || self.types.node_types.get(&key)
                            != Some(&ResolvedType::Scalar(Scalar::Int))
                    {
                        return None;
                    }
                    let value = self
                        .db
                        .get(key.file)?
                        .text
                        .get(key.start as usize..key.end as usize)?
                        .trim()
                        .parse::<u64>()
                        .ok()?;
                    // Repeating the inherited literal is harmless; changing it
                    // loses correspondence even when the new range narrows.
                    if slot.is_some_and(|prior| prior != value) {
                        return None;
                    }
                    *slot = Some(value);
                }
            }
            let (min, max) = (min?, max?);
            (min >= 1 && min <= max && max <= 200).then_some((min, max))
        };
        literal_bounds(field).is_some() && literal_bounds(field) == literal_bounds(alias)
    }

    /// Require the actual original parameter syntax, so a copied lexical value
    /// cannot acquire the new parent-edge permission from its carried marker.
    fn original_reference_parameter(&self, key: NodeKey, parameter: SymbolId) -> bool {
        self.nodes
            .get(&key)
            .is_some_and(|node| node.kind == SyntaxKind::NameRef)
            && matches!(self.query_binding(key), Some(Binding::Symbol(id)) if *id == parameter)
    }

    /// A mutation CALL may pass the original required reference or its two
    /// authored containment edges. Copied lexical values cannot acquire this
    /// lineage, and a parent link is never an ordinary declared field.
    fn checked_call_parent_path(
        &self,
        key: NodeKey,
        parameter: SymbolId,
        depth: usize,
    ) -> Option<(SymbolId, u8)> {
        if depth > 2 {
            return None;
        }
        let node = self.nodes.get(&key)?;
        if node.kind == SyntaxKind::NameRef {
            if !self.original_reference_parameter(key, parameter) {
                return None;
            }
            let SymbolKind::Param { owner, .. } =
                self.resolve.symbols.get(parameter.0 as usize)?.kind
            else {
                return None;
            };
            let param = self
                .effects
                .scenarios
                .get(&owner)?
                .params
                .iter()
                .find(|param| param.param == parameter)?;
            let ResolvedType::Record {
                symbol,
                stored: true,
            } = self.types.symbol_types.get(&parameter)?
            else {
                return None;
            };
            return (param.default.is_none()
                && self.types.node_types.get(&key) == self.types.symbol_types.get(&parameter)
                && matches!(
                    self.resolve.symbols.get(symbol.0 as usize)?.kind,
                    SymbolKind::Model { .. }
                ))
            .then_some((*symbol, 0));
        }
        if node.kind != SyntaxKind::Member || depth == 2 {
            return None;
        }
        let mut operands = node.children.iter().filter(|part| expression(part.kind));
        let base = NodeKey::of(operands.next()?);
        if operands.next().is_some()
            || node
                .children
                .iter()
                .rev()
                .find(|part| part.kind == SyntaxKind::Name)
                .and_then(|part| self.word(part))
                != Some("parent")
        {
            return None;
        }
        let (child, prior) = self.checked_call_parent_path(base, parameter, depth + 1)?;
        let declaration = self.resolve.symbols.get(child.0 as usize)?;
        let SymbolKind::Model {
            owner: ModelOwner::ChildOf(parent),
            fields,
            ..
        } = &declaration.kind
        else {
            return None;
        };
        let expected = ResolvedType::Record {
            symbol: *parent,
            stored: true,
        };
        if prior >= 2
            || fields.iter().any(|field| {
                self.resolve
                    .symbols
                    .get(field.0 as usize)
                    .is_none_or(|field| field.name == "parent")
            })
            || self.effects.models.get(&child)?.owner != ModelOwner::ChildOf(*parent)
            || self.types.node_types.get(&key) != Some(&expected)
            || self.types.node_types.get(&base)
                != Some(&ResolvedType::Record {
                    symbol: child,
                    stored: true,
                })
        {
            return None;
        }
        Some((*parent, prior + 1))
    }

    fn field_type_id(
        &self,
        key: NodeKey,
        field: SymbolId,
        ty: &ResolvedType,
    ) -> Result<String, DisclosureDecline> {
        if !result_type(ty) {
            return Err(self.fail(key, "unsupported stored field type"));
        }
        let owner = match self.resolve.symbols.get(field.0 as usize).map(|s| &s.kind) {
            Some(SymbolKind::Field { owner, .. }) => *owner,
            _ => return Err(self.fail(key, "missing stored field owner")),
        };
        let declaration = self
            .effects
            .models
            .get(&owner)
            .and_then(|model| {
                model
                    .fields
                    .iter()
                    .find(|candidate| candidate.field == field)
            })
            .ok_or_else(|| self.fail(key, "missing checked stored field declaration"))?;
        if declaration.required_array {
            return Err(self.fail(key, "required stored array is outside disclosure profile"));
        }
        let Some(alias) = self
            .types
            .value_constraints
            .get(&field)
            .and_then(|constraints| constraints.alias)
        else {
            return exact_type_id(ty, self.resolve)
                .ok_or_else(|| self.fail(key, "unsupported stored field type"));
        };
        let owner = self
            .resolve
            .symbols
            .get(alias.0 as usize)
            .ok_or_else(|| self.fail(key, "dangling stored field alias"))?;
        if owner.id != alias
            || !matches!(owner.kind, SymbolKind::Field { .. })
            || self
                .types
                .value_constraints
                .get(&alias)
                .and_then(|constraints| constraints.alias)
                != Some(alias)
            || !matches!(
                self.types.symbol_types.get(&alias),
                Some(ResolvedType::Scalar(Scalar::Text))
            )
            || self.types.judgments.is_empty()
        {
            return Err(self.fail(key, "unestablished alias inventory owner"));
        }
        let mut base = ty;
        let mut suffix = String::new();
        for _ in 0..64 {
            if let ResolvedType::Nullable(inner) = base {
                base = inner;
                suffix.push('?');
            } else {
                break;
            }
        }
        if !matches!(base, ResolvedType::Scalar(Scalar::Text)) {
            return Err(self.fail(key, "alias underlying type mismatch"));
        }
        Ok(format!("{}{suffix}", owner.canonical))
    }

    fn key_stamp(&self, key: NodeKey) -> Result<String, DisclosureDecline> {
        let source = self
            .db
            .get(key.file)
            .ok_or_else(|| self.fail(key, "missing source identity"))?;
        let mut owners = self.resolve.modules.iter().filter(|module| {
            module.file == key.file && module.span.start <= key.start && key.end <= module.span.end
        });
        let owner = owners
            .next()
            .ok_or_else(|| self.fail(key, "missing checked anchor module"))?;
        if owners.next().is_some() {
            return Err(self.fail(key, "ambiguous checked anchor module"));
        }
        Ok(format!(
            "{}:{}:{}:{}:{}",
            source.path, source.sha256, owner.name, key.start, key.end
        ))
    }

    fn call_stamp(&self, calls: &[NodeKey]) -> Result<String, DisclosureDecline> {
        calls
            .iter()
            .map(|key| self.key_stamp(*key))
            .collect::<Result<Vec<_>, _>>()
            .map(|parts| parts.join("/"))
    }

    fn decision_stamp(
        &self,
        decisions: &[DisclosureDecision],
    ) -> Result<String, DisclosureDecline> {
        decisions
            .iter()
            .map(|decision| {
                Ok(format!(
                    "{}:{}:{}",
                    self.key_stamp(decision.node)?,
                    self.call_stamp(&decision.calls)?,
                    match &decision.choice {
                        DisclosureChoice::Then => "then".to_string(),
                        DisclosureChoice::Else => "else".to_string(),
                        DisclosureChoice::Match(case) => format!("match:{}:{case}", case.len()),
                        DisclosureChoice::RhsEvaluated => "rhs-evaluated".to_string(),
                        DisclosureChoice::RhsSkipped => "rhs-skipped".to_string(),
                        DisclosureChoice::DefaultEvaluated => "default-evaluated".to_string(),
                        DisclosureChoice::DefaultProvided => "default-provided".to_string(),
                    }
                ))
            })
            .collect::<Result<Vec<_>, DisclosureDecline>>()
            .map(|parts| parts.join("/"))
    }

    fn fail(&self, node: NodeKey, reason: &'static str) -> DisclosureDecline {
        DisclosureDecline {
            source_facts: None,
            node,
            reason,
            influences: Vec::new(),
        }
    }

    fn checked_source_facts(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<CheckedScenarioSource> {
        let source = self.source(scenario.module, scenario.node).ok()?;
        let authored = self.db.get(scenario.node.file)?;
        if source.path.is_empty()
            || source.sha256 != sha256_hex(authored.text.as_bytes())
            || self
                .db
                .iter()
                .filter(|(_, value)| value.path == source.path)
                .count()
                != 1
            || scenario.params.len() > 200
        {
            return None;
        }
        let anchor = |node: NodeKey| {
            node.file == scenario.node.file
                && node.start >= scenario.node.start
                && node.end <= scenario.node.end
                && node.start <= node.end
                && self.nodes.contains_key(&node)
        };
        if !anchor(scenario.node) {
            return None;
        }
        let result = self.types.symbol_results.get(&scenario.scenario)?.clone();
        if result.as_ref().is_some_and(|ty| !checked_source_type(ty)) {
            return None;
        }
        let mut parameters = Vec::new();
        for param in &scenario.params {
            let ty = self.types.symbol_types.get(&param.param)?;
            if !anchor(param.node)
                || !anchor(param.type_node)
                || param.default.is_some_and(|node| !anchor(node))
                || !checked_source_type(ty)
            {
                return None;
            }
            parameters.push(CheckedScenarioParameter {
                parameter: param.param,
                node: param.node,
                type_node: param.type_node,
                ty: ty.clone(),
                default: param.default,
                constraints: self.types.value_constraints.get(&param.param).cloned(),
            });
        }
        let mut pending: Vec<_> = scenario
            .guards
            .iter()
            .chain(&scenario.effects)
            .map(|effect| (effect, 0usize))
            .collect();
        pending.reverse();
        let mut calls = Vec::new();
        let mut steps = 0usize;
        while let Some((effect, depth)) = pending.pop() {
            steps += 1;
            if steps > 16384 || depth > 64 || !anchor(effect.node) {
                return None;
            }
            if effect.verb == EffectVerb::Call {
                if calls.len() >= 200 || effect.args.len() > 200 {
                    return None;
                }
                let Some(EffectTarget::Operation(operation)) = effect.target.as_ref() else {
                    return None;
                };
                let target_node = effect.target_node?;
                if !anchor(target_node)
                    || self.types.node_types.get(&target_node)
                        != Some(&ResolvedType::Operation(*operation))
                    || self.resolve.symbols.get(operation.0 as usize).is_none()
                {
                    return None;
                }
                let result = self.types.effect_call_results.get(&effect.node)?.clone();
                if result.as_ref().is_some_and(|ty| !checked_source_type(ty)) {
                    return None;
                }
                let mut inputs = Vec::new();
                let mut names = HashSet::new();
                for argument in &effect.args {
                    let node = argument.value.unwrap_or(argument.key_node);
                    let ty = self.types.node_types.get(&node)?;
                    if !anchor(argument.key_node)
                        || !anchor(node)
                        || !names.insert(argument.key.as_str())
                        || !checked_source_type(ty)
                    {
                        return None;
                    }
                    inputs.push(CheckedScenarioCallInput {
                        name: argument.key.clone(),
                        node,
                        ty: ty.clone(),
                    });
                }
                calls.push(CheckedScenarioSourceCall {
                    node: effect.node,
                    target_node,
                    operation: *operation,
                    inputs,
                    binding: effect.binding.clone(),
                    result,
                });
            }
            // Preorder follows authored statement/branch/arm order, not hash
            // table iteration. This records source structure, not execution.
            for arm in effect.match_arms.iter().rev() {
                for child in arm.effects.iter().rev() {
                    pending.push((child, depth + 1));
                }
            }
            for child in effect.else_effects.iter().rev() {
                pending.push((child, depth + 1));
            }
            for child in effect.then_effects.iter().rev() {
                pending.push((child, depth + 1));
            }
            if pending.len() > 16384 {
                return None;
            }
        }
        Some(CheckedScenarioSource {
            scenario: scenario.scenario,
            node: scenario.node,
            source,
            read: scenario.read,
            parameters,
            result,
            calls,
            expression_types: self.checked_create_expression_types(scenario.node, scenario.module),
            creates: self.checked_create_sources(scenario),
            decision_sites: self.checked_decision_sites(scenario),
            queries: self.checked_query_sources(scenario),
            stored_contracts: self.checked_stored_contracts(scenario),
        })
    }

    fn checked_create_sources(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<CheckedScenarioCreate>> {
        let mut pending: Vec<_> = scenario
            .effects
            .iter()
            .rev()
            .map(|effect| (effect, 0))
            .collect();
        let mut creates = Vec::new();
        let mut steps = 0;
        while let Some((effect, depth)) = pending.pop() {
            steps += 1;
            if steps > 16384 || depth > 64 {
                return None;
            }
            if effect.verb == EffectVerb::Create {
                if creates.len() >= 200 {
                    return None;
                }
                creates.push(self.checked_create_source(effect, scenario.module)?);
            }
            for arm in effect.match_arms.iter().rev() {
                pending.extend(arm.effects.iter().rev().map(|child| (child, depth + 1)));
            }
            pending.extend(
                effect
                    .else_effects
                    .iter()
                    .rev()
                    .map(|child| (child, depth + 1)),
            );
            pending.extend(
                effect
                    .then_effects
                    .iter()
                    .rev()
                    .map(|child| (child, depth + 1)),
            );
        }
        let mut authored: Vec<_> = self
            .nodes
            .keys()
            .filter(|key| {
                key.kind == SyntaxKind::Create as u8
                    && key.file == scenario.node.file
                    && key.start >= scenario.node.start
                    && key.end <= scenario.node.end
            })
            .copied()
            .collect();
        authored.sort_by_key(|key| key.start);
        if !authored
            .iter()
            .copied()
            .eq(creates.iter().map(|created| created.node))
        {
            return None;
        }
        Some(creates)
    }

    /// Compare the authored object and its checked owning declaration before
    /// retaining any source facts. Public CRUD is a separate operation surface.
    fn checked_create_source(
        &self,
        effect: &Effect,
        module: ModuleId,
    ) -> Option<CheckedScenarioCreate> {
        let node = self.nodes.get(&effect.node)?;
        let Some(EffectTarget::Model(model)) = effect.target else {
            return None;
        };
        let definition = self.checked_created_model(model, module)?;
        let text = &self.db.get(effect.node.file)?.text;
        let parts = super::kids(node);
        let target = parts.iter().find(|part| part.kind == SyntaxKind::Path)?;
        let target_node = NodeKey::of(target);
        if node.kind != SyntaxKind::Create
            || self.resolve.node_symbol.get(&target_node) != Some(&model)
            || super::attribute_value(node, "when", text).map(NodeKey::of) != effect.when
            || effect.when.is_some()
            || !effect.then_effects.is_empty()
            || !effect.else_effects.is_empty()
            || !effect.match_arms.is_empty()
        {
            return None;
        }
        let binding = parts.windows(2).find_map(|pair| {
            super::is_name(pair[0], text, "as")
                .then(|| super::name_text(pair[1], text))
                .flatten()
        })?;
        if binding.is_empty() || effect.binding.as_deref() != Some(binding) {
            return None;
        }
        let object = parts.iter().find(|part| part.kind == SyntaxKind::Object)?;
        let entries: Vec<_> = object
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::ObjectEntry)
            .collect();
        if entries.len() != effect.args.len() || entries.len() > 200 {
            return None;
        }
        let mut inputs = Vec::new();
        let mut seen = HashSet::new();
        for (entry, argument) in entries.iter().zip(&effect.args) {
            let parts = super::kids(entry);
            let key = *parts.first()?;
            let name = super::name_text(key, text)?;
            let value = parts.iter().find(|part| expression(part.kind)).copied();
            let key_node = NodeKey::of(key);
            let value_node = value.map(NodeKey::of).unwrap_or(key_node);
            let ty = self.types.node_types.get(&value_node)?;
            if argument.key != name
                || argument.key_node != key_node
                || argument.value != value.map(NodeKey::of)
                || !seen.insert(name)
                || !checked_source_type(ty)
            {
                return None;
            }
            let field = if name == "parent" {
                let ModelOwner::ChildOf(parent) = definition.declaration.owner else {
                    return None;
                };
                if ty
                    != &(ResolvedType::Record {
                        symbol: parent,
                        stored: true,
                    })
                {
                    return None;
                }
                None
            } else {
                let field = definition.fields.iter().find(|field| field.name == name)?;
                let data = definition
                    .declaration
                    .fields
                    .iter()
                    .find(|data| data.field == field.field)?;
                if data.server.is_some() || !created_input_type_matches(ty, &field.ty, 0) {
                    return None;
                }
                Some(field.field)
            };
            inputs.push(CheckedScenarioCreateInput {
                name: name.into(),
                field,
                key_node,
                value_node,
                ty: ty.clone(),
            });
        }
        if matches!(definition.declaration.owner, ModelOwner::ChildOf(_))
            && !seen.contains("parent")
        {
            return None;
        }
        for (data, field) in definition.declaration.fields.iter().zip(&definition.fields) {
            if !seen.contains(field.name.as_str())
                && data.default.is_none()
                && data.server.is_none()
                && !matches!(field.ty, ResolvedType::Nullable(_))
                && (!matches!(field.ty, ResolvedType::Array { .. }) || data.required_array)
            {
                return None;
            }
        }
        Some(CheckedScenarioCreate {
            node: effect.node,
            target_node,
            source: self.source(module, effect.node).ok()?,
            model,
            binding: binding.into(),
            inputs,
            definition,
            expression_types: self.checked_create_expression_types(effect.node, module)?,
        })
    }

    fn checked_create_expression_types(
        &self,
        created: NodeKey,
        module: ModuleId,
    ) -> Option<Vec<(NodeKey, ResolvedType)>> {
        let mut owners = self.effects.scenarios.values().filter(|scenario| {
            scenario.module == module
                && scenario.node.file == created.file
                && scenario.node.start <= created.start
                && created.end <= scenario.node.end
        });
        let owner = owners.next()?;
        if owners.next().is_some() || !self.nodes.contains_key(&owner.node) {
            return None;
        }
        // Include shorthand Name nodes as well as expressions: their checked
        // binding type belongs to the authored key occurrence. Unknown/error
        // entries are retained faithfully and cannot become an admitted value.
        let mut retained: Vec<_> = self
            .types
            .node_types
            .iter()
            .filter(|(node, _)| {
                node.file == owner.node.file
                    && owner.node.start <= node.start
                    && node.end <= owner.node.end
                    && self.nodes.contains_key(node)
            })
            .map(|(node, ty)| (*node, ty.clone()))
            .collect();
        if retained.len() > 16384 {
            return None;
        }
        retained.sort_by_key(|(node, _)| (node.start, node.end, node.kind));
        Some(retained)
    }

    fn checked_created_model(
        &self,
        model: SymbolId,
        module: ModuleId,
    ) -> Option<CheckedScenarioCreatedModel> {
        let symbol = self.resolve.symbols.get(model.0 as usize)?;
        let SymbolKind::Model {
            fields: order,
            owner,
            ..
        } = &symbol.kind
        else {
            return None;
        };
        let data = self.effects.models.get(&model)?;
        // Resolver membership also includes separately declared derives. Only
        // original stored fields are writable/defaulted constructor slots.
        let mut stored_order = Vec::new();
        for id in order {
            let member = self.resolve.symbols.get(id.0 as usize)?;
            if member.id != *id || member.module != module {
                return None;
            }
            match member.kind {
                SymbolKind::Field { owner, .. } if owner == model => stored_order.push(*id),
                SymbolKind::DeriveField { model: owner, .. } if owner == model => {}
                _ => return None,
            }
        }
        let node = self.nodes.get(&data.node)?;
        let text = &self.db.get(data.node.file)?.text;
        let parts = super::kids(node);
        let name = parts
            .iter()
            .filter_map(|part| super::name_text(part, text))
            .find(|name| *name != "export")?;
        let parent = parts
            .windows(2)
            .find_map(|pair| super::is_name(pair[0], text, "in").then_some(pair[1]));
        let authored_owner = if let Some(parent) = parent {
            let segments = super::path_segments(parent, text);
            let [name] = segments.as_slice() else {
                return None;
            };
            if *name == "app" {
                ModelOwner::App
            } else {
                let id = match self
                    .resolve
                    .module_scopes
                    .get(module.0 as usize)?
                    .prod
                    .get(*name)?
                {
                    ScopedName::Local(id) => *id,
                    ScopedName::Imported {
                        target,
                        bound: false,
                    } => *target,
                    _ => return None,
                };
                if !matches!(
                    self.resolve.symbols.get(id.0 as usize)?.kind,
                    SymbolKind::Model { .. }
                ) {
                    return None;
                }
                ModelOwner::ChildOf(id)
            }
        } else {
            ModelOwner::Team
        };
        if node.kind != SyntaxKind::Model
            || symbol.id != model
            || symbol.module != module
            || symbol.name != name
            || data.model != model
            || data.module != module
            || symbol.canonical
                != format!(
                    "{}.{}",
                    self.resolve.modules.get(module.0 as usize)?.name,
                    name
                )
            || text.get(symbol.span.start as usize..symbol.span.end as usize) != Some(name)
            || *owner != authored_owner
            || data.owner != *owner
            || order.len() > 200
            || !stored_order
                .iter()
                .copied()
                .eq(data.fields.iter().map(|field| field.field))
        {
            return None;
        }
        let authored: Vec<_> = node
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::Field)
            .collect();
        if authored.len() != data.fields.len() {
            return None;
        }
        let mut fields = Vec::new();
        for (node, data) in authored.iter().zip(&data.fields) {
            let field = self.resolve.symbols.get(data.field.0 as usize)?;
            let SymbolKind::Field {
                owner, type_node, ..
            } = &field.kind
            else {
                return None;
            };
            let ty = self.types.symbol_types.get(&data.field)?;
            if *owner != model
                || field.module != module
                || field.id != data.field
                || *type_node != data.type_node
                || field.canonical != format!("{}.{}", symbol.canonical, field.name)
                || text.get(field.span.start as usize..field.span.end as usize)
                    != Some(field.name.as_str())
                || NodeKey::of(node) != data.node
                || !checked_source_type(ty)
                || !self.checked_created_field_type(data.type_node, module, ty, 0)
                || !self.checked_created_field(node, data, &field.name, ty)
            {
                return None;
            }
            fields.push(CheckedScenarioCreatedField {
                field: data.field,
                name: field.name.clone(),
                canonical: field.canonical.clone(),
                source: self.source(module, data.node).ok()?,
                ty: ty.clone(),
                constraints: self.types.value_constraints.get(&data.field).cloned(),
                reuse: self.types.field_reuse_sources.get(&data.field).copied(),
            });
        }
        if !self.checked_created_rules(data) {
            return None;
        }
        Some(CheckedScenarioCreatedModel {
            canonical: symbol.canonical.clone(),
            source: self.source(module, data.node).ok()?,
            span: symbol.span,
            declaration: data.clone(),
            fields,
        })
    }

    /// Match only the original create field vocabulary against its declared
    /// type owner. This does not infer a schema from an object value's shape.
    fn checked_created_field_type(
        &self,
        key: NodeKey,
        module: ModuleId,
        ty: &ResolvedType,
        depth: usize,
    ) -> bool {
        if depth > 64 {
            return false;
        }
        let Some(node) = self.nodes.get(&key) else {
            return false;
        };
        let Some(source) = self.db.get(key.file) else {
            return false;
        };
        let text = &source.text;
        match (node.kind, ty) {
            (SyntaxKind::NullableType, ResolvedType::Nullable(inner))
            | (SyntaxKind::ArrayType, ResolvedType::Array { element: inner, .. }) => node
                .children
                .iter()
                .find(|part| {
                    matches!(
                        part.kind,
                        SyntaxKind::NamedType
                            | SyntaxKind::NullableType
                            | SyntaxKind::ArrayType
                            | SyntaxKind::EnumType
                            | SyntaxKind::DeliveryType
                    )
                })
                .is_some_and(|part| {
                    self.checked_created_field_type(NodeKey::of(part), module, inner, depth + 1)
                }),
            (SyntaxKind::NamedType, _) => {
                let Some(path) = node
                    .children
                    .iter()
                    .find(|part| part.kind == SyntaxKind::Path)
                else {
                    return false;
                };
                let segments = super::path_segments(path, text);
                match self.resolve.node_typeref.get(&NodeKey::of(path)) {
                    Some(TypeRef::Scalar(name)) => {
                        super::types::std_schema_type(name).as_ref() == Some(ty)
                    }
                    Some(TypeRef::Symbol(id)) => {
                        self.types.symbol_types.get(id) == Some(ty)
                            // Bare owning Model/Contract names resolve to this
                            // exact record type; their declarations are not
                            // field/parameter entries in symbol_types.
                            || matches!(ty, ResolvedType::Record {symbol, stored: true} if symbol == id && matches!(self.resolve.symbols.get(id.0 as usize).map(|symbol| &symbol.kind), Some(SymbolKind::Model {..} | SymbolKind::Contract {..})))
                    }
                    Some(TypeRef::FieldChain {
                        fields, consumed, ..
                    }) => {
                        *consumed == segments.len()
                            && fields
                                .last()
                                .is_some_and(|field| self.types.symbol_types.get(field) == Some(ty))
                    }
                    Some(TypeRef::External) => {
                        let Some(ScopedName::External { provider, name }) =
                            segments.first().and_then(|name| {
                                self.resolve
                                    .module_scopes
                                    .get(module.0 as usize)?
                                    .prod
                                    .get(*name)
                            })
                        else {
                            return false;
                        };
                        if provider != "std" {
                            return false;
                        }
                        let Some(mut schema) = nominal_schema(name) else {
                            return false;
                        };
                        if segments.len() == 1 {
                            return checked_standard_nominal_name(ty) == Some(schema.name);
                        }
                        for (index, segment) in segments.iter().enumerate().skip(1) {
                            let Some((_, declared)) =
                                schema.fields.iter().find(|(name, _)| name == segment)
                            else {
                                return false;
                            };
                            if index == segments.len() - 1 {
                                return super::types::std_schema_type(declared).as_ref()
                                    == Some(ty);
                            }
                            let Some(nested) = nominal_schema(declared) else {
                                return false;
                            };
                            schema = nested;
                        }
                        false
                    }
                    _ => false,
                }
            }
            (SyntaxKind::EnumType, ResolvedType::Enum { cases, .. }) => node
                .children
                .iter()
                .filter(|part| part.kind == SyntaxKind::Path)
                .flat_map(|part| super::path_segments(part, text))
                .eq(cases.iter().map(String::as_str)),
            (SyntaxKind::DeliveryType, ResolvedType::StdDelivery { capability, op }) => {
                let Some(path) = node
                    .children
                    .iter()
                    .find(|part| part.kind == SyntaxKind::Path)
                else {
                    return false;
                };
                let segments = super::path_segments(path, text);
                let [binding, operation] = segments.as_slice() else {
                    return false;
                };
                let Some(ScopedName::External { provider, name }) = self
                    .resolve
                    .module_scopes
                    .get(module.0 as usize)
                    .and_then(|scope| scope.prod.get(*binding))
                else {
                    return false;
                };
                provider == "std"
                    && std_capability(name).is_some_and(|actual| actual.name == *capability)
                    && std_operation(name, operation).is_some_and(|actual| actual == *op)
            }
            _ => false,
        }
    }

    fn checked_created_field(
        &self,
        node: &SyntaxNode,
        data: &super::effects::FieldData,
        name: &str,
        ty: &ResolvedType,
    ) -> bool {
        let Some(source) = self.db.get(data.node.file) else {
            return false;
        };
        let text = &source.text;
        let parts = super::kids(node);
        if parts.first().and_then(|part| super::name_text(part, text)) != Some(name) {
            return false;
        }
        let Some(type_at) = parts
            .iter()
            .position(|part| NodeKey::of(part) == data.type_node)
        else {
            return false;
        };
        let mut at = type_at + 1;
        let required = parts
            .get(at)
            .is_some_and(|part| super::is_punct(part, text, "!"));
        at += usize::from(required);
        let mut default = None;
        let mut server = None;
        if parts
            .get(at)
            .is_some_and(|part| super::is_punct(part, text, "="))
        {
            default = parts
                .get(at + 1)
                .filter(|part| expression(part.kind))
                .map(|part| NodeKey::of(part));
            at += 2;
        } else if parts
            .get(at)
            .is_some_and(|part| super::is_name(part, text, "server"))
        {
            server = parts
                .get(at + 2)
                .filter(|part| expression(part.kind))
                .map(|part| NodeKey::of(part));
            at += 3;
        }
        let mut modifiers = Vec::new();
        while let Some(part) = parts.get(at) {
            if matches!(
                part.kind,
                SyntaxKind::DescriptionValue | SyntaxKind::Annotation
            ) {
                at += 1;
                continue;
            }
            let Some(name) = super::name_text(part, text) else {
                break;
            };
            let value = match name {
                "trim" | "unique" | "machine" => None,
                "min" | "max" => parts
                    .get(at + 2)
                    .filter(|part| expression(part.kind))
                    .map(|part| NodeKey::of(part)),
                _ => break,
            };
            modifiers.push(super::effects::ModifierData {
                name: name.into(),
                node: NodeKey::of(part),
                value,
            });
            at += if matches!(name, "min" | "max") { 3 } else { 1 };
        }
        required == data.required_array
            && default == data.default
            && server == data.server
            && modifiers == data.modifiers
            && default.into_iter().chain(server).all(|key| {
                self.types
                    .node_types
                    .get(&key)
                    .is_some_and(|actual| created_input_type_matches(actual, ty, 0))
            })
    }

    fn checked_created_rules(&self, data: &super::effects::ModelData) -> bool {
        let matches_nodes = |kind: SyntaxKind, retained: Vec<NodeKey>| {
            let mut authored: Vec<_> = self
                .nodes
                .iter()
                .filter_map(|(key, node)| {
                    if node.kind != kind || key.file != data.node.file {
                        return None;
                    }
                    let target = node
                        .children
                        .iter()
                        .find(|part| part.kind == SyntaxKind::Path)?;
                    (self.resolve.node_symbol.get(&NodeKey::of(target)) == Some(&data.model))
                        .then_some(*key)
                })
                .collect();
            authored.sort_by_key(|key| key.start);
            authored == retained
        };
        let selectors = |key: NodeKey, field_node: Option<NodeKey>, fields: &[String]| {
            let Some(node) = self.nodes.get(&key) else {
                return false;
            };
            let Some(source) = self.db.get(key.file) else {
                return false;
            };
            let value = super::attribute_value(node, "fields", &source.text);
            value.map(NodeKey::of) == field_node
                && value.is_some_and(|value| {
                    let Some(text) = source
                        .text
                        .get(value.span.start as usize..value.span.end as usize)
                    else {
                        return false;
                    };
                    text.split(',')
                        .map(str::trim)
                        .eq(fields.iter().map(String::as_str))
                })
        };
        let attribute = |key: NodeKey, name: &str, retained: Option<NodeKey>| {
            self.nodes
                .get(&key)
                .zip(self.db.get(key.file))
                .is_some_and(|(node, source)| {
                    super::attribute_value(node, name, &source.text).map(NodeKey::of) == retained
                })
        };
        matches_nodes(
            SyntaxKind::Invariant,
            data.invariants.iter().map(|rule| rule.node).collect(),
        ) && matches_nodes(
            SyntaxKind::Unique,
            data.uniques.iter().map(|rule| rule.node).collect(),
        ) && matches_nodes(
            SyntaxKind::Lock,
            data.locks.iter().map(|rule| rule.node).collect(),
        ) && matches_nodes(
            SyntaxKind::Retain,
            data.retains.iter().map(|rule| rule.node).collect(),
        ) && data.invariants.iter().all(|rule| {
            rule.target == data.model
                && rule.module == data.module
                && self.nodes.get(&rule.node).is_some_and(|node| {
                    node.children
                        .iter()
                        .find(|part| expression(part.kind) && part.kind != SyntaxKind::Path)
                        .map(NodeKey::of)
                        == rule.predicate
                })
        }) && data.uniques.iter().all(|rule| {
            rule.module == data.module
                && selectors(rule.node, rule.fields_node, &rule.fields)
                && attribute(rule.node, "where", rule.where_predicate)
        }) && data.locks.iter().all(|rule| {
            rule.module == data.module
                && selectors(rule.node, rule.fields_node, &rule.fields)
                && attribute(rule.node, "when", rule.when)
        }) && data
            .retains
            .iter()
            .all(|rule| rule.module == data.module && attribute(rule.node, "until", rule.until))
    }

    fn checked_stored_contracts(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<CheckedStoredContractSchema>> {
        let is_contract = |id: SymbolId| {
            self.resolve
                .symbols
                .get(id.0 as usize)
                .is_some_and(|symbol| matches!(symbol.kind, SymbolKind::Contract { .. }))
        };
        let mut pending = Vec::new();
        for parameter in &scenario.params {
            let Some(ResolvedType::Record { symbol, .. }) =
                self.types.symbol_types.get(&parameter.param)
            else {
                continue;
            };
            if matches!(
                self.resolve.symbols.get(symbol.0 as usize)?.kind,
                SymbolKind::Model { .. }
            ) {
                pending.push((*symbol, true));
                let mut child = *symbol;
                for _ in 0..2 {
                    let SymbolKind::Model {
                        owner: ModelOwner::ChildOf(parent),
                        ..
                    } = self.resolve.symbols.get(child.0 as usize)?.kind
                    else {
                        break;
                    };
                    if self.effects.models.get(&child)?.owner != ModelOwner::ChildOf(parent) {
                        return None;
                    }
                    pending.push((parent, true));
                    child = parent;
                }
            }
        }
        let mut seen = HashSet::new();
        let mut inventory = Vec::new();
        let mut field_count = 0usize;
        while let Some((id, model)) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            if seen.len() > 200 {
                return None;
            }
            let declaration = self.resolve.symbols.get(id.0 as usize)?;
            let (order, node) = match &declaration.kind {
                SymbolKind::Model { fields, .. } if model => {
                    (fields, self.effects.models.get(&id)?.node)
                }
                SymbolKind::Contract { fields } if !model => {
                    (fields, self.effects.records.get(&id)?.node)
                }
                _ => return None,
            };
            if declaration.id != id || order.len() > 200 {
                return None;
            }
            let source = self.source(declaration.module, node).ok()?;
            let parent = match declaration.kind {
                SymbolKind::Model {
                    owner: super::resolve::ModelOwner::ChildOf(parent),
                    ..
                } => Some(parent),
                _ => None,
            };
            let mut fields = Vec::new();
            for field in order {
                let member = self.resolve.symbols.get(field.0 as usize)?;
                if model
                    && matches!(member.kind, SymbolKind::DeriveField { model: owner, .. } if owner == id)
                {
                    continue;
                }
                let ty = self.types.symbol_types.get(field)?;
                let file_array = matches!(ty, ResolvedType::Array {
                    element, ordered: true, nonempty: false,
                } if element.as_ref() == &ResolvedType::Scalar(Scalar::File));
                if model
                    && !matches!(ty, ResolvedType::Record { symbol, .. } if is_contract(*symbol))
                    && self.reference_operand_type_id(ty).is_none()
                    && !result_type(ty)
                    && !file_array
                {
                    continue;
                }
                field_count += 1;
                if field_count > 4096 {
                    return None;
                }
                let SymbolKind::Field { owner, .. } = &member.kind else {
                    return None;
                };
                if member.id != *field || *owner != id || member.module != declaration.module {
                    return None;
                }
                let data = self
                    .effects
                    .models
                    .get(&id)
                    .and_then(|record| record.fields.iter().find(|data| data.field == *field))
                    .or_else(|| {
                        self.effects.records.get(&id).and_then(|record| {
                            record.fields.iter().find(|data| data.field == *field)
                        })
                    })?;
                if !self.checked_created_field_type(data.type_node, declaration.module, ty, 0)
                    || !self.checked_created_field(
                        self.nodes.get(&data.node)?,
                        data,
                        &member.name,
                        ty,
                    )
                    || (file_array
                        && (data.required_array
                            || data.default.is_some()
                            || data.server.is_some()
                            || self.types.field_reuse_sources.contains_key(field)))
                {
                    return None;
                }
                if model
                    && matches!(ty, ResolvedType::Array { .. })
                    && self.reference_operand_type_id(ty).is_some()
                    && self
                        .types
                        .field_reuse_sources
                        .get(field)
                        .is_none_or(|alias| !self.reference_array_source_bounds(*field, *alias))
                {
                    continue;
                }
                let member_source = self.source(member.module, data.node).ok()?;
                let mut trim = false;
                let mut min = None;
                let mut max = None;
                let mut current = *field;
                let mut reused = HashSet::new();
                let mut reused_order = Vec::new();
                loop {
                    if !reused.insert(current) || reused.len() > 64 {
                        return None;
                    }
                    reused_order.push(current);
                    let symbol = self.resolve.symbols.get(current.0 as usize)?;
                    let SymbolKind::Field { owner, .. } = &symbol.kind else {
                        return None;
                    };
                    let data = self
                        .effects
                        .models
                        .get(owner)
                        .and_then(|record| record.fields.iter().find(|data| data.field == current))
                        .or_else(|| {
                            self.effects.records.get(owner).and_then(|record| {
                                record.fields.iter().find(|data| data.field == current)
                            })
                        })?;
                    for modifier in &data.modifiers {
                        if modifier.name == "trim" {
                            trim = true;
                        }
                        let slot = match modifier.name.as_str() {
                            "min" => &mut min,
                            "max" => &mut max,
                            _ => continue,
                        };
                        if slot.is_none() {
                            let key = modifier.value?;
                            let text = &self.db.get(key.file)?.text;
                            let value = text
                                .get(key.start as usize..key.end as usize)?
                                .trim()
                                .parse()
                                .ok()?;
                            *slot = Some((key, value, self.source(symbol.module, key).ok()?));
                        }
                    }
                    let Some(next) = self.types.field_reuse_sources.get(&current) else {
                        break;
                    };
                    current = *next;
                }
                // Reference-array bounds retain their genuine reusable field owner.
                if self.reference_operand_type_id(ty).is_some() {
                    for reused_field in &reused_order {
                        let SymbolKind::Field { owner, .. } =
                            self.resolve.symbols.get(reused_field.0 as usize)?.kind
                        else {
                            return None;
                        };
                        if is_contract(owner) {
                            pending.push((owner, false));
                        }
                    }
                }
                let constraints = self.types.value_constraints.get(field).cloned();
                let mut declared = checked_stored_contract_type_id(
                    ty,
                    if self.reference_operand_type_id(ty).is_some() {
                        None
                    } else {
                        constraints.as_ref().and_then(|value| value.alias)
                    },
                    self.resolve,
                    0,
                )?;
                if data.required_array {
                    declared.push('!');
                }
                fields.push(CheckedStoredContractField {
                    id: *field,
                    canonical: member.canonical.clone(),
                    name: member.name.clone(),
                    owner: id,
                    span: member.span,
                    source: member_source,
                    ty: ty.clone(),
                    required_array: data.required_array,
                    declared,
                    constraints,
                    reuse: self.types.field_reuse_sources.get(field).copied(),
                    trim,
                    min,
                    max,
                });
                let mut base = ty;
                let mut depth = 0;
                while let ResolvedType::Nullable(inner)
                | ResolvedType::Array { element: inner, .. } = base
                {
                    depth += 1;
                    if depth > 64 {
                        return None;
                    }
                    base = inner;
                }
                if let ResolvedType::Record { symbol, .. } = base
                    && is_contract(*symbol)
                {
                    pending.push((*symbol, false));
                    if pending.len() > 4096 {
                        return None;
                    }
                }
            }
            if !model || !fields.is_empty() || parent.is_some() {
                inventory.push(CheckedStoredContractSchema {
                    id,
                    canonical: declaration.canonical.clone(),
                    module: declaration.module,
                    span: declaration.span,
                    source,
                    model,
                    parent,
                    owner: match declaration.kind {
                        SymbolKind::Model { owner, .. } => Some(owner),
                        _ => None,
                    },
                    field_order: order.clone(),
                    fields,
                });
            }
        }
        Some(inventory)
    }

    /// Prove the finite whole read declaration separately from its source inventory.
    /// Query candidates remain in the query inventory, never scalar observations.
    fn complete_query(
        &mut self,
        scenario: &super::effects::ScenarioData,
    ) -> Result<Option<CheckedScenarioDisclosure>, DisclosureDecline> {
        let Some(queries) = self.checked_query_sources(scenario) else {
            return Ok(None);
        };
        let [query] = queries.as_slice() else {
            return Ok(None);
        };
        let fail = || self.fail(scenario.node, "incomplete finite query declaration");
        if !scenario.read
            || scenario.on.is_some()
            || scenario.scope_authority
            || scenario.cohort.is_some()
            || scenario.params.len() != 2
            || scenario.params.iter().any(|param| param.default.is_some())
            || self.checked_source_facts(scenario).is_none()
        {
            return Err(fail());
        }
        let targets = query.inputs[0].1;
        let location = query.inputs[1].1;
        if targets == location
            || query.inputs[2].1 != targets
            || !scenario
                .params
                .iter()
                .all(|param| param.param == targets || param.param == location)
        {
            return Err(fail());
        }
        let record = ResolvedType::Record {
            symbol: query.model,
            stored: true,
        };
        let Some(ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        }) = self.types.symbol_types.get(&targets)
        else {
            return Err(fail());
        };
        if **element != record {
            return Err(fail());
        }
        // Parameters retain ordinary array omission semantics; the field-only
        // `!` is not borrowed. Exact positive finite bounds still refuse empty
        // inputs through their owning admission contract.
        let alias = self.query_parameter_bounds(targets).ok_or_else(|| {
            self.fail(
                scenario.node,
                "query parameter needs owning positive finite bounds",
            )
        })?;
        if !matches!(self.types.symbol_types.get(&location),
            Some(ResolvedType::Record {symbol, stored: true})
            if matches!(self.resolve.symbols.get(symbol.0 as usize).map(|s| &s.kind), Some(SymbolKind::Model {..})))
            || !matches!(self.types.symbol_results.get(&scenario.scenario),
                Some(Some(ResolvedType::Array {element, ordered: true, nonempty: false}))
                if matches!(element.as_ref(), ResolvedType::Record {symbol, ..} if *symbol == query.projection.contract)
                    && matches!(self.resolve.symbols.get(query.projection.contract.0 as usize).map(|s| &s.kind), Some(SymbolKind::Contract {..})))
        {
            return Err(fail());
        }
        for param in &scenario.params {
            let node = self.nodes.get(&param.type_node).ok_or_else(fail)?;
            if node.kind != SyntaxKind::NamedType {
                return Err(self.fail(
                    param.type_node,
                    "query parameter needs exact owning named type",
                ));
            }
            let mut paths = node
                .children
                .iter()
                .filter(|child| child.kind == SyntaxKind::Path);
            let path = paths.next().ok_or_else(fail)?;
            if paths.next().is_some() {
                return Err(fail());
            }
            let declaration = self.resolve.node_typeref.get(&NodeKey::of(path));
            let owns_type = if param.param == targets {
                matches!(declaration, Some(TypeRef::Symbol(id)) if *id == alias)
                    || matches!(declaration, Some(TypeRef::FieldChain {fields, ..}) if fields.last() == Some(&alias))
            } else {
                matches!((declaration, self.types.symbol_types.get(&location)),
                    (Some(TypeRef::Symbol(id)), Some(ResolvedType::Record {symbol, stored: true})) if id == symbol)
            };
            if !owns_type {
                return Err(self.fail(param.type_node, "query parameter named type correspondence"));
            }
        }
        let env = scenario
            .params
            .iter()
            .map(|param| (Local::Symbol(param.param), ValuePath::default()))
            .collect();
        let by = scenario.by.ok_or_else(fail)?;
        let authorization = self.authorization_expr(by, scenario.module, &env, &[])?;
        if authorization.iter().any(|path| {
            !path.reads.is_empty() || !path.intrinsics.is_empty() || !path.decisions.is_empty()
        }) {
            return Err(self.fail(by, "query authorization needs a closed role gate"));
        }
        for guard in &scenario.guards {
            let cond = guard
                .cond
                .ok_or_else(|| self.fail(guard.node, "missing query header guard"))?;
            if guard.verb != EffectVerb::Require
                || !guard.then_effects.is_empty()
                || !guard.else_effects.is_empty()
                || !guard.match_arms.is_empty()
                || !self.frozen_query_count_guard(scenario, cond, targets)
            {
                return Err(self.fail(
                    cond,
                    "query header needs original admitted count and literal comparison",
                ));
            }
        }
        Ok(Some(CheckedScenarioDisclosure {
            source_facts: None,
            scenario: scenario.scenario,
            node: scenario.node,
            source: self.source(scenario.module, scenario.node)?,
            returns: vec![DisclosureReturn {
                id: query.return_id(),
                source: query.source.clone(),
                node: query.return_node,
                decisions: Vec::new(),
                dependencies: Vec::new(),
                intrinsics: Vec::new(),
                influences: query.influences.clone(),
                model_result: None,
            }],
            effects: Vec::new(),
        }))
    }

    /// Match the checked field-reuse layers used by parameter lowering. Ordinary
    /// authored arrays keep bounds on their declarations, not value_constraints.
    fn query_parameter_bounds(&self, parameter: SymbolId) -> Option<SymbolId> {
        let alias = *self.types.field_reuse_sources.get(&parameter)?;
        let Some(ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        }) = self.types.symbol_types.get(&parameter)
        else {
            return None;
        };
        let mut current = alias;
        let mut seen = HashSet::new();
        let mut chain = Vec::new();
        loop {
            if !seen.insert(current) || chain.len() >= 128 {
                return None;
            }
            let SymbolKind::Field { owner, .. } =
                self.resolve.symbols.get(current.0 as usize)?.kind
            else {
                return None;
            };
            if !matches!(self.resolve.symbols.get(owner.0 as usize)?.kind,
                SymbolKind::Contract {ref fields} if fields.contains(&current))
                || !matches!(self.types.symbol_types.get(&current),
                    Some(ResolvedType::Array {element: source, ordered: true, ..}) if source == element)
            {
                return None;
            }
            let field = self
                .effects
                .records
                .get(&owner)?
                .fields
                .iter()
                .find(|field| field.field == current)?;
            chain.push(field);
            let Some(next) = self.types.field_reuse_sources.get(&current) else {
                break;
            };
            current = *next;
        }
        let mut min = None;
        let mut max = None;
        for field in chain.into_iter().rev() {
            for modifier in &field.modifiers {
                let minimum = match modifier.name.as_str() {
                    "min" => true,
                    "max" => false,
                    _ => continue,
                };
                let key = self.query_group(modifier.value?)?;
                if self.nodes.get(&key)?.kind != SyntaxKind::Literal
                    || self.types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Int))
                {
                    return None;
                }
                let value = self
                    .db
                    .get(key.file)?
                    .text
                    .get(key.start as usize..key.end as usize)?
                    .trim()
                    .parse::<u64>()
                    .ok()?;
                let slot = if minimum { &mut min } else { &mut max };
                // Receiving bounds must narrow the exact inherited literal range.
                if slot.is_some_and(|prior| {
                    if minimum {
                        value < prior
                    } else {
                        value > prior
                    }
                }) {
                    return None;
                }
                *slot = Some(value);
            }
        }
        matches!((min, max), (Some(min), Some(max)) if min >= 1 && min <= max && max <= 200)
            .then_some(alias)
    }

    fn frozen_query_count_guard(
        &self,
        scenario: &super::effects::ScenarioData,
        key: NodeKey,
        targets: SymbolId,
    ) -> bool {
        if self
            .types
            .node_types
            .get(&self.query_group(key).unwrap_or(key))
            != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return false;
        }
        ["==", "!=", ">", ">=", "<", "<="].iter().any(|operator| {
            let Some((left, right)) = self.query_binary(key, operator) else {
                return false;
            };
            [(left, right), (right, left)]
                .iter()
                .any(|(count, literal)| {
                    let Some(argument) = self.query_count(*count) else {
                        return false;
                    };
                    let Some(literal) = self.query_group(*literal) else {
                        return false;
                    };
                    self.query_parameter(scenario, argument) == Some(targets)
                        && self.types.node_types.get(&argument)
                            == self.types.symbol_types.get(&targets)
                        && self
                            .nodes
                            .get(&literal)
                            .is_some_and(|node| node.kind == SyntaxKind::Literal)
                        && self.types.node_types.get(&literal)
                            == Some(&ResolvedType::Scalar(Scalar::Int))
                        && self
                            .db
                            .get(literal.file)
                            .and_then(|file| {
                                file.text.get(literal.start as usize..literal.end as usize)
                            })
                            .and_then(|text| text.trim().parse::<u16>().ok())
                            .is_some_and(|value| value <= 200)
                })
        })
    }

    /// The currently released query ABI supports a genuine viewer scan and
    /// exact reference/version/scalar contract projection. The finite profile
    /// here is the authored Workbench lineage: admitted target membership,
    /// direct location equality, cardinality guard, then nominal select. It
    /// neither certifies preceding guards nor upgrades native admission.
    fn checked_query_sources(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<DisclosureQuery>> {
        let authored = self.nodes.get(&scenario.node)?;
        let mut pending = vec![*authored];
        let mut query_nodes = Vec::new();
        let mut visits = 0usize;
        while let Some(node) = pending.pop() {
            visits += 1;
            if visits > 16384 {
                return None;
            }
            if node.kind == SyntaxKind::Query {
                query_nodes.push(NodeKey::of(node));
            }
            pending.extend(node.children.iter());
        }
        if query_nodes.is_empty() {
            return Some(Vec::new());
        }
        if !scenario.read
            || scenario.on.is_some()
            || query_nodes.len() != 2
            || scenario.effects.len() != 3
        {
            return None;
        }
        let [binding, guard, returned] = scenario.effects.as_slice() else {
            return None;
        };
        if binding.verb != EffectVerb::Let
            || guard.verb != EffectVerb::Require
            || returned.verb != EffectVerb::Return
            || scenario.effects.iter().any(|effect| {
                !effect.then_effects.is_empty()
                    || !effect.else_effects.is_empty()
                    || !effect.match_arms.is_empty()
            })
        {
            return None;
        }
        let scan_key = binding.value?;
        let select_key = returned.value?;
        let scan = self.types.checked_queries.get(&scan_key)?;
        let select = self.types.checked_queries.get(&select_key)?;
        if scan.node != scan_key
            || select.node != select_key
            || !query_nodes.contains(&scan_key)
            || !query_nodes.contains(&select_key)
            || scan.projection.is_some()
            || scan.clauses.len() != 2
            || select.clauses.len() != 2
        {
            return None;
        }
        let [scan_alias, predicate_clause] = scan.clauses.as_slice() else {
            return None;
        };
        let [select_alias, select_clause] = select.clauses.as_slice() else {
            return None;
        };
        if !matches!(scan_alias.kind, CheckedQueryClauseKind::As { .. })
            || predicate_clause.kind != CheckedQueryClauseKind::Where
            || predicate_clause.expressions.len() != 1
            || !matches!(select_alias.kind, CheckedQueryClauseKind::As { .. })
            || select_clause.kind != CheckedQueryClauseKind::Select
            || select_clause.expressions.len() != 1
        {
            return None;
        }
        let Some(Binding::Symbol(model)) = self.query_binding(scan.domain) else {
            return None;
        };
        let model = *model;
        let owner = self.resolve.symbols.get(model.0 as usize)?;
        if !matches!(owner.kind, SymbolKind::Model { .. }) {
            return None;
        }
        let record_ty = ResolvedType::Record {
            symbol: model,
            stored: true,
        };
        if !matches!(&scan.domain_type, ResolvedType::Array { element, ordered: true, nonempty: false } if **element == record_ty)
            || self.types.node_types.get(&scan.domain) != Some(&scan.domain_type)
            || !matches!(&scan.result, ResolvedType::Array { element, ordered: true, .. } if **element == record_ty)
            || select.domain_type != scan.result
            || !matches!(self.query_binding(select.domain), Some(Binding::Let {node}) if *node == binding.node)
        {
            return None;
        }
        let predicate = predicate_clause.expressions[0];
        let conjunction = self.query_binary(predicate, "and")?;
        let membership = self.query_binary(conjunction.0, "in")?;
        if !self.query_row(membership.0, scan_alias.node, model) {
            return None;
        }
        let targets = self.query_parameter(scenario, membership.1)?;
        if !matches!(self.types.symbol_types.get(&targets), Some(ResolvedType::Array {element,..}) if **element == record_ty)
        {
            return None;
        }
        let equality = self.query_binary(conjunction.1, "==")?;
        let location = self.query_parameter(scenario, equality.1)?;
        // The predicate must compare a direct owning record reference field
        // with an admitted nonnullable reference of that same model.
        let field = self.query_member(equality.0, scan_alias.node, model)?;
        let field_ty = self.types.symbol_types.get(&field)?;
        let ResolvedType::Record {
            symbol: location_model,
            stored: true,
        } = self.types.symbol_types.get(&location)?
        else {
            return None;
        };
        let location_ty = ResolvedType::Record {
            symbol: *location_model,
            stored: true,
        };
        if field_ty != &location_ty
            && !matches!(field_ty, ResolvedType::Nullable(inner) if **inner == location_ty)
        {
            return None;
        }
        let cond = guard.cond?;
        let counts = self.query_binary(cond, "==")?;
        let visible_argument = self.query_count(counts.0)?;
        let targets_argument = self.query_count(counts.1)?;
        if !matches!(self.query_binding(visible_argument), Some(Binding::Let {node}) if *node == binding.node)
            || self.query_parameter(scenario, targets_argument) != Some(targets)
            || self.types.node_types.get(&visible_argument) != Some(&scan.result)
        {
            return None;
        }
        let projection = select.projection.as_deref()?;
        if projection.model != model
            || projection.alias != select_alias.node
            || select_clause.expressions[0] != projection.node
            || !matches!(self.types.symbol_results.get(&scenario.scenario)?.as_ref()?,
                ResolvedType::Array {element, nonempty: false, ..}
                if matches!(element.as_ref(), ResolvedType::Record {symbol,..} if *symbol == projection.contract))
            || !matches!(&select.result, ResolvedType::Array {element, ordered: true, ..}
                if **element == ResolvedType::Record {symbol: projection.contract, stored: false})
        {
            return None;
        }
        let contract = self.resolve.symbols.get(projection.contract.0 as usize)?;
        let SymbolKind::Contract { fields } = &contract.kind else {
            return None;
        };
        if fields.len() != projection.fields.len() || fields.len() > 200 {
            return None;
        }
        let id = self.opaque("query", scan_key, "").ok()?;
        let mut dependencies = vec![self.query_dependency(
            equality.0,
            scenario.module,
            model,
            field,
            DependencyRole::Control,
            &id,
        )?];
        let mut references = 0;
        let mut versions = 0;
        let mut seen = HashSet::new();
        for projected in &projection.fields {
            if !fields.contains(&projected.field)
                || !seen.insert(projected.field)
                || !matches!(self.resolve.symbols.get(projected.field.0 as usize)?.kind,
                    SymbolKind::Field {owner,..} if owner == projection.contract)
                || self.types.node_types.get(&projected.node) != Some(&projected.ty)
            {
                return None;
            }
            match projected.mapping {
                CheckedQueryProjectionMapping::StoredReference => {
                    if projected.ty != record_ty
                        || !self.query_row(projected.node, select_alias.node, model)
                    {
                        return None;
                    }
                    references += 1;
                }
                CheckedQueryProjectionMapping::Version => {
                    if projected.ty != ResolvedType::Scalar(Scalar::Int)
                        || !self.query_version(projected.node, select_alias.node, model)
                    {
                        return None;
                    }
                    versions += 1;
                }
                CheckedQueryProjectionMapping::DirectField { field } => {
                    if self.query_member(projected.node, select_alias.node, model) != Some(field)
                        || self.types.symbol_types.get(&field) != Some(&projected.ty)
                    {
                        return None;
                    }
                    dependencies.push(self.query_dependency(
                        projected.node,
                        scenario.module,
                        model,
                        field,
                        DependencyRole::Data,
                        &id,
                    )?);
                }
            }
        }
        if references != 1 || versions != 1 || dependencies.len() > 200 {
            return None;
        }
        let source = self.source(scenario.module, scan_key).ok()?;
        let influences = [
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder,
        ]
        .into_iter()
        .map(|kind| {
            Some(DisclosureInfluence {
                id: self
                    .opaque("query-influence", scan_key, &format!("{id}:{kind:?}"))
                    .ok()?,
                source: source.clone(),
                node: scan_key,
                kind,
                query_id: Some(id.clone()),
            })
        })
        .collect::<Option<Vec<_>>>()?;
        Some(vec![DisclosureQuery {
            id,
            source,
            node: scan_key,
            domain: scan.domain,
            model,
            model_name: owner.canonical.clone(),
            alias: scan_alias.node,
            predicate,
            inputs: vec![
                (membership.1, targets),
                (equality.1, location),
                (targets_argument, targets),
            ],
            dependencies,
            order: Vec::new(),
            limit: None,
            archived: false,
            cardinality_guard: guard.node,
            return_node: returned.node,
            projection: DisclosureQueryProjection {
                node: select_key,
                source: self.source(scenario.module, select_key).ok()?,
                contract: projection.contract,
                model,
                alias: projection.alias,
                fields: projection.fields.clone(),
            },
            influences,
        }])
    }

    fn query_group(&self, mut key: NodeKey) -> Option<NodeKey> {
        for _ in 0..64 {
            let node = self.nodes.get(&key)?;
            if node.kind != SyntaxKind::Group {
                return Some(key);
            }
            let mut children = node.children.iter().filter(|child| expression(child.kind));
            key = NodeKey::of(children.next()?);
            if children.next().is_some() {
                return None;
            }
        }
        None
    }

    fn query_binding(&self, key: NodeKey) -> Option<&Binding> {
        let key = self.query_group(key)?;
        let node = self.nodes.get(&key)?;
        if !matches!(
            node.kind,
            SyntaxKind::NameRef | SyntaxKind::Path | SyntaxKind::Name
        ) {
            return None;
        }
        self.resolve.node_binding.get(&key).or_else(|| {
            node.children
                .iter()
                .find_map(|child| self.resolve.node_binding.get(&NodeKey::of(child)))
        })
    }

    fn query_parameter(
        &self,
        scenario: &super::effects::ScenarioData,
        key: NodeKey,
    ) -> Option<SymbolId> {
        let Some(Binding::Symbol(parameter)) = self.query_binding(key) else {
            return None;
        };
        scenario
            .params
            .iter()
            .find(|param| param.param == *parameter && param.default.is_none())?;
        Some(*parameter)
    }

    fn query_row(&self, key: NodeKey, alias: NodeKey, model: SymbolId) -> bool {
        let Some(grouped) = self.query_group(key) else {
            return false;
        };
        matches!(self.query_binding(grouped), Some(Binding::QueryAlias {node}) if *node == alias)
            && self.types.node_types.get(&grouped)
                == Some(&ResolvedType::Record {
                    symbol: model,
                    stored: true,
                })
    }

    fn query_binary(&self, key: NodeKey, operator: &str) -> Option<(NodeKey, NodeKey)> {
        let node = self.nodes.get(&self.query_group(key)?)?;
        if node.kind != SyntaxKind::Binary {
            return None;
        }
        let mut children = node.children.iter().filter(|child| expression(child.kind));
        let left = NodeKey::of(children.next()?);
        let right = NodeKey::of(children.next()?);
        if children.next().is_some()
            || !node.children.iter().any(|child| {
                matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct)
                    && self.db.get(child.span.file).and_then(|source| {
                        source
                            .text
                            .get(child.span.start as usize..child.span.end as usize)
                    }) == Some(operator)
            })
        {
            return None;
        }
        Some((left, right))
    }

    fn query_member_name(&self, key: NodeKey, alias: NodeKey, model: SymbolId) -> Option<&str> {
        let node = self.nodes.get(&self.query_group(key)?)?;
        if node.kind != SyntaxKind::Member {
            return None;
        }
        let base = node.children.iter().find(|child| expression(child.kind))?;
        if !self.query_row(NodeKey::of(base), alias, model) {
            return None;
        }
        let name = node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        self.db
            .get(name.span.file)?
            .text
            .get(name.span.start as usize..name.span.end as usize)
    }

    fn query_member(&self, key: NodeKey, alias: NodeKey, model: SymbolId) -> Option<SymbolId> {
        let name = self.query_member_name(key, alias, model)?;
        let SymbolKind::Model { fields, .. } = &self.resolve.symbols.get(model.0 as usize)?.kind
        else {
            return None;
        };
        fields.iter().copied().find(|field| {
            self.resolve
                .symbols
                .get(field.0 as usize)
                .is_some_and(|symbol| {
                    symbol.name == name
                        && matches!(symbol.kind, SymbolKind::Field {owner,..} if owner == model)
                })
        })
    }

    fn query_version(&self, key: NodeKey, alias: NodeKey, model: SymbolId) -> bool {
        self.query_member_name(key, alias, model) == Some("version")
    }

    fn query_count(&self, key: NodeKey) -> Option<NodeKey> {
        let selected = self.types.selected_calls.get(&self.query_group(key)?)?;
        if !matches!(&selected.target, SelectedCallTarget::Builtin {id,..} if id == "count")
            || selected.arguments.len() != 1
            || selected.slots.as_slice() != [Some(0)]
        {
            return None;
        }
        Some(selected.arguments[0])
    }

    /// Each predicate is evaluated by Values at its existing per-element site.
    /// The parent retains only whole stored Contract reads and Complete child
    /// associations; local short-circuit choices never become parent decisions.
    fn query_child_collection(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
    ) -> Option<ValuePath> {
        self.contract_collection(key, module, env, &[], 0, &mut 0)
    }

    fn contract_collection(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        aliases: &[ContractPredicateAlias],
        depth: usize,
        visits: &mut usize,
    ) -> Option<ValuePath> {
        if aliases.len() >= 2 || depth > 64 {
            return None;
        }
        let fact = self
            .types
            .checked_contract_collection_calls
            .get(&key)?
            .clone();
        let selected = self.types.selected_calls.get(&key)?;
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        if fact.node != key
            || !matches!(&selected.target, SelectedCallTarget::Builtin {id, overload}
                if id == &fact.builtin && *overload == fact.overload && matches!(id.as_str(), "any" | "all"))
            || selected.arguments != fact.arguments
            || selected.slots.as_slice() != [Some(fact.slots[0]), Some(fact.slots[1])]
            || fact.slots[0] == fact.slots[1]
            || selected.arguments.len() != 2
            || self.query_group(*selected.arguments.get(fact.slots[0])?)? != fact.query
            || selected.arguments.get(fact.slots[1]) != Some(&fact.predicate.node)
            || fact.predicate.ty != boolean
            || self.types.node_types.get(&key) != Some(&boolean)
            || self.types.node_types.get(&fact.predicate.node) != Some(&boolean)
        {
            return None;
        }
        let checked = self.types.checked_queries.get(&fact.query)?;
        let [alias] = checked.clauses.as_slice() else {
            return None;
        };
        if checked.node != fact.query
            || checked.domain != fact.domain
            || alias.node != fact.alias
            || aliases.iter().any(|prior| prior.node == fact.alias)
            || !matches!(alias.kind, CheckedQueryClauseKind::As { .. })
            || !alias.expressions.is_empty()
            || checked.projection.is_some()
            || checked.result != checked.domain_type
            || !matches!(&checked.result, ResolvedType::Array {element, ordered:true,nonempty:false}
                if matches!(element.as_ref(), ResolvedType::Record {symbol,..} if *symbol == fact.contract))
            || self.types.node_types.get(&fact.domain) != Some(&checked.domain_type)
        {
            return None;
        }
        let ResolvedType::Array { element, .. } = &checked.result else {
            return None;
        };
        let alias_ty = element.as_ref().clone();
        let domain_ty = checked.domain_type.clone();
        let (mut value, projection) = if let Some(call) = fact.call {
            if !matches!(self.query_binding(fact.domain), Some(Binding::CallAs {node}) if *node == call)
                || aliases.iter().any(|prior| prior.projection.is_some())
            {
                return None;
            }
            let child = env.get(&Local::Call(call))?.query_child?;
            if !self.complete_children.contains(&child)
                || self.types.effect_call_results.get(&call)
                    != self.types.symbol_results.get(&child)
                || self
                    .types
                    .effect_call_results
                    .get(&call)
                    .and_then(Option::as_ref)
                    != Some(&domain_ty)
            {
                return None;
            }
            let scenario = self.effects.scenarios.get(&child)?.clone();
            self.complete_query(&scenario).ok()??;
            let queries = self.checked_query_sources(&scenario)?;
            let [query] = queries.as_slice() else {
                return None;
            };
            if query.projection.contract != fact.contract {
                return None;
            }
            (ValuePath::default(), Some(query.projection.clone()))
        } else {
            // The root stored Contract is observed once at its actual field
            // occurrence. Copies, helper results and unrelated queries cannot
            // supply this direct Contract-member array domain.
            if !aliases.is_empty() || self.nodes.get(&fact.domain)?.kind != SyntaxKind::Member {
                return None;
            }
            let mut values = self.expr(fact.domain, module, env, &[]).ok()?;
            if values.len() != 1 {
                return None;
            }
            let value = values.pop()?;
            if !matches!(value.contract_value, Some(ContractValue::Array(contract)) if contract == fact.contract)
                || value.reads.is_empty()
            {
                return None;
            }
            (value, None)
        };
        let mut local_aliases = aliases.to_vec();
        local_aliases.push(ContractPredicateAlias {
            node: fact.alias,
            contract: fact.contract,
            ty: alias_ty,
            projection,
        });
        if self.query_child_predicate(
            fact.predicate.node,
            (module, env, &local_aliases),
            depth + 1,
            visits,
            &mut value,
        )? != boolean
        {
            return None;
        }
        value.contract_value = None;
        Some(value)
    }

    fn query_child_predicate(
        &mut self,
        key: NodeKey,
        scope: (ModuleId, &Env, &[ContractPredicateAlias]),
        depth: usize,
        visits: &mut usize,
        value: &mut ValuePath,
    ) -> Option<ResolvedType> {
        let (module, env, aliases) = scope;
        *visits += 1;
        if depth > 64 || *visits > 4096 {
            return None;
        }
        let grouped = self.query_group(key)?;
        let node = *self.nodes.get(&grouped)?;
        let ty = self.types.node_types.get(&grouped)?.clone();
        if self.types.node_types.get(&key) != Some(&ty) {
            return None;
        }
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        let scalar = |ty: &ResolvedType| {
            primitive_type(ty) || matches!(ty, ResolvedType::Enum {cases,..} if !cases.is_empty())
        };
        match node.kind {
            SyntaxKind::Literal if scalar(&ty) => {}
            SyntaxKind::NameRef | SyntaxKind::Path
                if self.types.resolved_cases.contains(&grouped)
                    && matches!(ty, ResolvedType::Enum { .. }) => {}
            SyntaxKind::Member => {
                let mut children = node.children.iter().filter(|child| expression(child.kind));
                let base = NodeKey::of(children.next()?);
                if children.next().is_some() {
                    return None;
                }
                let Some(Binding::QueryAlias { node: bound }) = self.query_binding(base) else {
                    return None;
                };
                let alias = aliases.iter().find(|alias| alias.node == *bound)?;
                if self.types.node_types.get(&base) != Some(&alias.ty) {
                    return None;
                }
                let name = node
                    .children
                    .iter()
                    .rev()
                    .find(|child| child.kind == SyntaxKind::Name)?;
                let name = self
                    .db
                    .get(name.span.file)?
                    .text
                    .get(name.span.start as usize..name.span.end as usize)?;
                let field = self.contract_member(alias.contract, name, &ty)?;
                if let Some(projection) = &alias.projection {
                    let projected = projection
                        .fields
                        .iter()
                        .find(|member| member.field == field)?;
                    if projected.ty != ty
                        || !(scalar(&ty)
                            || matches!((&ty, &projected.mapping),
                            (ResolvedType::Record {symbol,stored:true}, CheckedQueryProjectionMapping::StoredReference)
                            if *symbol == projection.model))
                    {
                        return None;
                    }
                } else if !(scalar(&ty) || matches!(ty, ResolvedType::Record { stored: true, .. }))
                {
                    return None;
                }
            }
            SyntaxKind::Call if ty == boolean => {
                let nested =
                    self.contract_collection(grouped, module, env, aliases, depth + 1, visits)?;
                value.join(&nested);
            }
            SyntaxKind::Unary => {
                let mut children = node.children.iter().filter(|child| expression(child.kind));
                let child = NodeKey::of(children.next()?);
                if children.next().is_some() {
                    return None;
                }
                let child_ty =
                    self.query_child_predicate(child, scope, depth + 1, visits, value)?;
                let operator = node
                    .children
                    .iter()
                    .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?;
                let operator = self
                    .db
                    .get(operator.span.file)?
                    .text
                    .get(operator.span.start as usize..operator.span.end as usize)?;
                if !((matches!(operator, "not" | "!") && ty == boolean && child_ty == boolean)
                    || (operator == "-"
                        && ty == child_ty
                        && matches!(ty, ResolvedType::Scalar(Scalar::Int | Scalar::Decimal))))
                {
                    return None;
                }
            }
            SyntaxKind::Binary if ty == boolean => {
                let (operator, left, right) = ["and", "or", "==", "!=", "<", "<=", ">", ">="]
                    .into_iter()
                    .find_map(|operator| {
                        self.query_binary(grouped, operator)
                            .map(|(left, right)| (operator, left, right))
                    })?;
                let left = self.query_child_predicate(left, scope, depth + 1, visits, value)?;
                let right = self.query_child_predicate(right, scope, depth + 1, visits, value)?;
                if left != right
                    || !(match operator {
                        "and" | "or" => left == boolean,
                        "==" | "!=" => {
                            scalar(&left)
                                || matches!(left, ResolvedType::Record { stored: true, .. })
                        }
                        _ => scalar(&left) && left != boolean,
                    })
                {
                    return None;
                }
            }
            _ => return None,
        }
        Some(ty)
    }

    fn contract_member(
        &self,
        contract: SymbolId,
        name: &str,
        ty: &ResolvedType,
    ) -> Option<SymbolId> {
        let owner = self.resolve.symbols.get(contract.0 as usize)?;
        let SymbolKind::Contract { fields } = &owner.kind else {
            return None;
        };
        fields.iter().copied().find(|field| {
            self.resolve
                .symbols
                .get(field.0 as usize)
                .is_some_and(|symbol| {
                    symbol.name == name
                        && symbol.module == owner.module
                        && matches!(symbol.kind, SymbolKind::Field {owner,..} if owner == contract)
                        && self.types.symbol_types.get(field) == Some(ty)
                })
        })
    }

    fn query_dependency(
        &self,
        node: NodeKey,
        module: ModuleId,
        model: SymbolId,
        field: SymbolId,
        role: DependencyRole,
        query: &str,
    ) -> Option<DisclosureDependency> {
        // Group lowering erases wrappers. Retain the actual protected member
        // occurrence so capture cannot miss a grouped predicate/projection read.
        let node = self.query_group(node)?;
        let owner = self.resolve.symbols.get(model.0 as usize)?;
        let declaration = self.resolve.symbols.get(field.0 as usize)?;
        if !matches!(declaration.kind, SymbolKind::Field {owner,..} if owner == model)
            || [
                "id",
                "version",
                "created",
                "updated",
                "createdBy",
                "updatedBy",
                "archivedAt",
                "parent",
            ]
            .contains(&declaration.name.as_str())
        {
            return None;
        }
        let ty = self.types.symbol_types.get(&field)?;
        let type_id = match ty {
            ResolvedType::Record {
                symbol,
                stored: true,
            } => self
                .resolve
                .symbols
                .get(symbol.0 as usize)?
                .canonical
                .clone(),
            ResolvedType::Nullable(inner)
                if matches!(inner.as_ref(), ResolvedType::Record { stored: true, .. }) =>
            {
                let ResolvedType::Record { symbol, .. } = inner.as_ref() else {
                    return None;
                };
                format!(
                    "{}?",
                    self.resolve.symbols.get(symbol.0 as usize)?.canonical
                )
            }
            _ => self.field_type_id(node, field, ty).ok()?,
        };
        Some(DisclosureDependency {
            id: self
                .opaque(
                    if role == DependencyRole::Data {
                        "query-data"
                    } else {
                        "query-control"
                    },
                    node,
                    query,
                )
                .ok()?,
            source: self.source(module, node).ok()?,
            node,
            calls: Vec::new(),
            role,
            model,
            field,
            model_name: owner.canonical.clone(),
            field_name: declaration.name.clone(),
            ty: ty.clone(),
            type_id,
        })
    }

    fn checked_decision_sites(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<CheckedDecisionSite>> {
        let mut sites = Vec::new();
        let mut steps = 0usize;
        let mut calls = 0usize;
        let mut pending = Vec::new();
        for (index, effect) in scenario.effects.iter().enumerate().rev() {
            pending.push((effect, vec![CheckedDecisionPosition::Body(index)], false));
        }
        for (index, effect) in scenario.guards.iter().enumerate().rev() {
            pending.push((effect, vec![CheckedDecisionPosition::Guard(index)], true));
        }
        while let Some((effect, position, leading)) = pending.pop() {
            steps += 1;
            if steps > 16384 || position.len() > 64 || !self.nodes.contains_key(&effect.node) {
                return None;
            }
            let decision = match effect.verb {
                EffectVerb::Require => Some((
                    effect.cond?,
                    if leading {
                        CheckedDecisionStage::LeadingRequire
                    } else {
                        CheckedDecisionStage::BodyRequire
                    },
                )),
                EffectVerb::Send => effect
                    .when
                    .map(|node| (node, CheckedDecisionStage::SendDispatch)),
                EffectVerb::If => Some((effect.cond?, CheckedDecisionStage::BodyCondition)),
                _ => None,
            };
            if let Some((node, stage)) = decision {
                if sites.len() >= 200
                    || self.types.node_types.get(&node) != Some(&ResolvedType::Scalar(Scalar::Bool))
                {
                    return None;
                }
                let mut selected = Vec::new();
                self.checked_decision_expression(
                    node,
                    scenario.module,
                    &[],
                    &mut HashSet::new(),
                    &mut selected,
                    &mut steps,
                    &mut calls,
                    0,
                )?;
                sites.push(CheckedDecisionSite {
                    owner: scenario.scenario,
                    source: self.source(scenario.module, node).ok()?,
                    node,
                    statement: effect.node,
                    stage,
                    position: position.clone(),
                    calls: selected,
                });
            }
            for (arm_index, arm) in effect.match_arms.iter().enumerate().rev() {
                for (index, child) in arm.effects.iter().enumerate().rev() {
                    let mut nested = position.clone();
                    nested.push(CheckedDecisionPosition::Match {
                        arm: arm_index,
                        statement: index,
                    });
                    pending.push((child, nested, false));
                }
            }
            for (index, child) in effect.else_effects.iter().enumerate().rev() {
                let mut nested = position.clone();
                nested.push(CheckedDecisionPosition::Else(index));
                pending.push((child, nested, false));
            }
            for (index, child) in effect.then_effects.iter().enumerate().rev() {
                let mut nested = position.clone();
                nested.push(if effect.verb == EffectVerb::For {
                    CheckedDecisionPosition::Loop(index)
                } else {
                    CheckedDecisionPosition::Then(index)
                });
                pending.push((child, nested, false));
            }
            if pending.len() > 16384 {
                return None;
            }
        }
        Some(sites)
    }

    #[allow(clippy::too_many_arguments)]
    fn checked_decision_expression(
        &self,
        key: NodeKey,
        module: ModuleId,
        chain: &[CheckedDecisionCallFrame],
        stack: &mut HashSet<SymbolId>,
        out: &mut Vec<CheckedDecisionCall>,
        steps: &mut usize,
        calls: &mut usize,
        depth: usize,
    ) -> Option<()> {
        *steps += 1;
        if *steps > 16384 || depth > 64 || chain.len() > 16 {
            return None;
        }
        let node = self.nodes.get(&key)?;
        let source = self.source(module, key).ok()?;
        if matches!(node.kind, SyntaxKind::Error | SyntaxKind::BadToken) {
            return None;
        }
        // Structural traversal preserves every lazy operand's source. It does
        // not assert which operands execute, or evaluate any expression.
        for child in &node.children {
            self.checked_decision_expression(
                NodeKey::of(child),
                module,
                chain,
                stack,
                out,
                steps,
                calls,
                depth + 1,
            )?;
        }
        if node.kind != SyntaxKind::Call {
            return Some(());
        }
        *calls += 1;
        if *calls > 200 {
            return None;
        }
        if !checked_source_type(self.types.node_types.get(&key)?) {
            return None;
        }
        let selected = self.types.selected_calls.get(&key)?;
        let mut arguments = Vec::new();
        for argument in &selected.arguments {
            self.nodes.get(argument)?;
            self.source(module, *argument).ok()?;
            let ty = self.types.node_types.get(argument)?;
            if !checked_source_type(ty) {
                return None;
            }
            arguments.push((*argument, ty.clone()));
        }
        let mut seen = HashSet::new();
        for index in selected.slots.iter().flatten() {
            if *index >= arguments.len() || !seen.insert(*index) {
                return None;
            }
        }
        if seen.len() != arguments.len() {
            return None;
        }
        let mut defaults = Vec::new();
        let target = match &selected.target {
            SelectedCallTarget::Builtin { id, overload } => {
                if selected.slots.iter().any(Option::is_none) {
                    return None;
                }
                CheckedDecisionCallTarget::Builtin {
                    id: id.clone(),
                    overload: *overload,
                }
            }
            SelectedCallTarget::DeriveFn(id) => {
                let data = self.effects.derives.get(id)?;
                let declaration = self.resolve.symbols.get(id.0 as usize)?;
                if !matches!(declaration.kind, SymbolKind::DeriveFn { .. })
                    || declaration.module != data.module
                    || data.derive != *id
                    || data.params.len() != selected.slots.len()
                    || chain.len() >= 16
                    || stack.contains(id)
                {
                    return None;
                }
                for (param, slot) in data.params.iter().zip(&selected.slots) {
                    if slot.is_none() {
                        let default = param.default?;
                        self.nodes.get(&default)?;
                        self.source(data.module, default).ok()?;
                        if !checked_source_type(self.types.node_types.get(&default)?) {
                            return None;
                        }
                        defaults.push((param.param, default));
                    }
                }
                CheckedDecisionCallTarget::DeriveFn(*id)
            }
            _ => return None,
        };
        out.push(CheckedDecisionCall {
            node: key,
            module,
            source: source.clone(),
            target: target.clone(),
            arguments,
            slots: selected.slots.clone(),
            defaults: defaults.clone(),
            chain: chain.to_vec(),
        });
        if let CheckedDecisionCallTarget::DeriveFn(id) = target {
            let data = self.effects.derives.get(&id)?;
            let mut nested = chain.to_vec();
            nested.push(CheckedDecisionCallFrame {
                node: key,
                module,
                source,
                derive: id,
            });
            stack.insert(id);
            for (_, default) in defaults {
                self.checked_decision_expression(
                    default,
                    data.module,
                    &nested,
                    stack,
                    out,
                    steps,
                    calls,
                    0,
                )?;
            }
            self.checked_decision_expression(
                data.expr?,
                data.module,
                &nested,
                stack,
                out,
                steps,
                calls,
                0,
            )?;
            stack.remove(&id);
        }
        Some(())
    }

    fn source(
        &self,
        module: ModuleId,
        node: NodeKey,
    ) -> Result<DisclosureSource, DisclosureDecline> {
        let owner = self
            .resolve
            .modules
            .get(module.0 as usize)
            .ok_or_else(|| self.fail(node, "missing declaring module"))?;
        let source = self
            .db
            .get(node.file)
            .ok_or_else(|| self.fail(node, "missing source"))?;
        if owner.file != node.file || node.start > node.end || node.end as usize > source.text.len()
        {
            return Err(self.fail(node, "source/module anchor mismatch"));
        }
        Ok(DisclosureSource {
            path: source.path.clone(),
            sha256: source.sha256.clone(),
            module: owner.name.clone(),
        })
    }

    fn opaque(
        &self,
        kind: &str,
        node: NodeKey,
        discriminator: &str,
    ) -> Result<String, DisclosureDecline> {
        Ok(sha256_hex(
            format!(
                "scenario-disclosure/v1:{kind}:{}:{discriminator}",
                self.key_stamp(node)?
            )
            .as_bytes(),
        ))
    }

    fn control(&self, mut value: ValuePath) -> Result<ValuePath, DisclosureDecline> {
        for read in &mut value.reads {
            read.role = DependencyRole::Control;
            read.id = self.opaque("read-control", read.node, &self.call_stamp(&read.calls)?)?;
        }
        for intrinsic in &mut value.intrinsics {
            intrinsic.role = DependencyRole::Control;
            intrinsic.id = self.opaque(
                "intrinsic-control",
                intrinsic.node,
                &self.call_stamp(&intrinsic.calls)?,
            )?;
        }
        Ok(value)
    }

    fn influence(
        &self,
        node: NodeKey,
        module: ModuleId,
        kinds: &[InfluenceKind],
        reason: &'static str,
    ) -> DisclosureDecline {
        let mut declined = self.fail(node, reason);
        if let Ok(source) = self.source(module, node) {
            for kind in kinds {
                if let Ok(id) = self.opaque("influence", node, &format!("{kind:?}")) {
                    declined.influences.push(DisclosureInfluence {
                        id,
                        source: source.clone(),
                        node,
                        kind: *kind,
                        query_id: None,
                    });
                }
            }
        }
        declined
    }

    fn expr(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        if self.depth >= 64 {
            return Err(self.fail(key, "expression closure depth bound"));
        }
        self.depth += 1;
        let result = self.expr_inner(key, module, env, calls);
        self.depth -= 1;
        result
    }

    fn expr_inner(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        self.steps += 1;
        if self.steps > 16384 || calls.len() > 64 {
            return Err(self.fail(key, "closure resource bound"));
        }
        let node = *self
            .nodes
            .get(&key)
            .ok_or_else(|| self.fail(key, "missing expression anchor"))?;
        let ty = self
            .types
            .node_types
            .get(&key)
            .ok_or_else(|| self.fail(key, "missing checked expression type"))?;
        if matches!(
            ty,
            ResolvedType::Unknown | ResolvedType::Error | ResolvedType::Opaque(_)
        ) {
            return Err(self.fail(key, "unresolved expression type"));
        }
        let children: Vec<_> = node
            .children
            .iter()
            .filter(|n| expression(n.kind))
            .collect();
        match node.kind {
            SyntaxKind::Literal => Ok(vec![ValuePath::default()]),
            SyntaxKind::NameRef | SyntaxKind::Path => {
                // The checker may claim a builtin spelling as an enum case;
                // that checked type wins over its non-value builtin binding.
                if self.types.resolved_cases.contains(&key)
                    && matches!(ty, ResolvedType::Enum { .. })
                {
                    return Ok(vec![ValuePath::default()]);
                }
                let binding = self.resolve.node_binding.get(&key).or_else(|| {
                    node.children
                        .iter()
                        .find_map(|n| self.resolve.node_binding.get(&NodeKey::of(n)))
                });
                match binding {
                    Some(Binding::Symbol(id))
                        if matches!(
                            self.resolve
                                .symbols
                                .get(id.0 as usize)
                                .map(|symbol| &symbol.kind),
                            Some(SymbolKind::Role)
                        ) =>
                    {
                        if self.authorization {
                            Ok(vec![ValuePath::default()])
                        } else {
                            Err(self.fail(key, "authority-dependent role value"))
                        }
                    }
                    Some(Binding::Symbol(id))
                        if matches!(
                            self.resolve
                                .symbols
                                .get(id.0 as usize)
                                .map(|symbol| &symbol.kind),
                            Some(SymbolKind::Model { .. })
                        ) =>
                    {
                        Err(self.influence(
                            key,
                            module,
                            &[
                                InfluenceKind::QueryExistence,
                                InfluenceKind::QueryCardinality,
                                InfluenceKind::QueryMembership,
                                InfluenceKind::QueryOrder,
                            ],
                            "stored model query domain",
                        ))
                    }
                    Some(Binding::Symbol(id)) => {
                        let value = env
                            .get(&Local::Symbol(*id))
                            .cloned()
                            .ok_or_else(|| self.fail(key, "unaccounted symbol value"))?;
                        Ok(vec![self.input_value(key, module, calls, value)?])
                    }
                    Some(Binding::ForItem { node }) => env
                        .get(&Local::For(*node))
                        .cloned()
                        .map(|value| vec![value])
                        .ok_or_else(|| self.fail(key, "unaccounted loop item")),
                    Some(Binding::Let { node }) => env
                        .get(&Local::Let(*node))
                        .cloned()
                        .map(|p| vec![p])
                        .ok_or_else(|| self.fail(key, "unaccounted immutable binding")),
                    Some(Binding::CreateAs { node }) => env
                        .get(&Local::Create(*node))
                        .cloned()
                        .map(|value| vec![value])
                        .ok_or_else(|| self.fail(key, "unaccounted created binding")),
                    Some(Binding::SendAs { node }) => env
                        .get(&Local::Send(*node))
                        .cloned()
                        .map(|value| vec![value])
                        .ok_or_else(|| self.fail(key, "unaccounted send binding")),
                    Some(Binding::CallAs { .. }) => Err(self.fail(
                        key,
                        "bound child result consumption needs its owning provenance",
                    )),
                    Some(Binding::Predicate) => {
                        if self.authorization {
                            Ok(vec![ValuePath::default()])
                        } else {
                            Err(self.fail(key, "authority-dependent predicate value"))
                        }
                    }
                    None if self.types.resolved_cases.contains(&key) => {
                        Ok(vec![ValuePath::default()])
                    }
                    _ => Err(self.fail(key, "unsupported lexical value")),
                }
            }
            SyntaxKind::Object => self.object((key, node), ty, module, env, calls, None),
            SyntaxKind::Construct => {
                let head = children
                    .first()
                    .ok_or_else(|| self.fail(key, "missing schema construct head"))?;
                if !matches!(
                    self.resolve.node_typeref.get(&NodeKey::of(head)),
                    Some(TypeRef::External)
                ) {
                    return Err(self.fail(key, "unsupported construct owner"));
                }
                let alias = self
                    .word(head)
                    .ok_or_else(|| self.fail(key, "missing schema import alias"))?;
                let Some(ScopedName::External { provider, name }) = self
                    .resolve
                    .module_scopes
                    .get(module.0 as usize)
                    .and_then(|scope| scope.prod.get(alias))
                else {
                    return Err(self.fail(key, "missing checked schema import"));
                };
                if provider != "std"
                    || !matches!(
                        name.as_str(),
                        "TextRequest"
                            | "TextMessage"
                            | "WorkflowInput"
                            | "WorkflowDefinition"
                            | "ImageRequest"
                    )
                {
                    return Err(self.fail(key, "unsupported closed std schema"));
                }
                let schema = nominal_schema(name)
                    .ok_or_else(|| self.fail(key, "missing defining std schema"))?;
                let fields = checked_text_schema_fields(ty, Some(name.as_str()))
                    .ok_or_else(|| self.fail(key, "missing checked schema object type"))?;
                if fields.len() != schema.fields.len()
                    || fields
                        .iter()
                        .zip(schema.fields)
                        .any(|((name, _), (declared, _))| name != declared)
                {
                    return Err(self.fail(key, "checked schema fields disagree"));
                }
                let object = node
                    .children
                    .iter()
                    .find(|n| n.kind == SyntaxKind::Object)
                    .ok_or_else(|| self.fail(key, "missing checked schema object"))?;
                self.object((key, object), ty, module, env, calls, Some(name.clone()))
            }
            SyntaxKind::Group | SyntaxKind::Unary => {
                if children.len() != 1 {
                    return Err(self.fail(key, "invalid unary/group shape"));
                }
                self.expr(NodeKey::of(children[0]), module, env, calls)
            }
            SyntaxKind::Array => self.expr_array(key, module, env, calls, children),
            SyntaxKind::Binary => self.expr_binary(key, module, env, calls, node, children),
            SyntaxKind::Member => self.expr_member(key, module, env, calls, node, children),
            SyntaxKind::Call => self.call(key, module, env, calls),
            SyntaxKind::Query => Err(self.influence(
                key,
                module,
                &[
                    InfluenceKind::QueryExistence,
                    InfluenceKind::QueryCardinality,
                    InfluenceKind::QueryMembership,
                    InfluenceKind::QueryOrder,
                ],
                "query closure is not supported",
            )),
            _ => Err(self.fail(key, "unsupported expression closure")),
        }
    }

    fn expr_member(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
        node: &SyntaxNode,
        children: Vec<&SyntaxNode>,
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let ty = self
            .types
            .node_types
            .get(&key)
            .ok_or_else(|| self.fail(key, "missing checked expression type"))?;
        let base = children
            .first()
            .ok_or_else(|| self.fail(key, "missing member base"))?;
        let base_key = NodeKey::of(base);
        if matches!(
            self.types.node_types.get(&base_key),
            Some(ResolvedType::Nullable(_))
        ) {
            return Err(self.influence(
                key,
                module,
                &[InfluenceKind::AbsentReference],
                "nullable record traversal",
            ));
        }
        let field_name = node
            .children
            .iter()
            .rev()
            .find(|n| n.kind == SyntaxKind::Name)
            .and_then(|n| {
                self.db
                    .get(n.span.file)?
                    .text
                    .get(n.span.start as usize..n.span.end as usize)
            })
            .ok_or_else(|| self.fail(key, "missing member identity"))?;
        if matches!(
            self.types.node_types.get(&base_key),
            Some(ResolvedType::OperationContext)
        ) {
            if field_name != "id"
                || *ty != ResolvedType::Scalar(Scalar::Text)
                || !self.operation_context(base_key)
            {
                return Err(self.fail(key, "unsupported operation intrinsic"));
            }
            return Ok(vec![self.intrinsic(
                key,
                module,
                calls,
                DisclosureIntrinsicKind::OperationId,
                Scalar::Text,
            )?]);
        }
        let mut values = self.expr(base_key, module, env, calls)?;
        for value in &mut values {
            if let Some(origin) = value.contract_value {
                let ContractValue::Singular(contract) = origin else {
                    return Err(self.fail(key, "canonical wire is not a record receiver"));
                };
                if !matches!(self.types.node_types.get(&base_key),
                    Some(ResolvedType::Record {symbol,..}) if *symbol == contract)
                    || self.contract_member(contract, field_name, ty).is_none()
                {
                    return Err(self.fail(key, "canonical Contract member identity mismatch"));
                }
                value.contract_value = match ty {
                    ResolvedType::Record {
                        symbol,
                        stored: true,
                    } if matches!(
                        self.resolve
                            .symbols
                            .get(symbol.0 as usize)
                            .map(|symbol| &symbol.kind),
                        Some(SymbolKind::Model { .. })
                    ) =>
                    {
                        Some(ContractValue::Reference)
                    }
                    ResolvedType::Array {
                        element,
                        ordered: true,
                        nonempty: false,
                    } if matches!(element.as_ref(), ResolvedType::Record {symbol, ..}
                            if matches!(self.resolve.symbols.get(symbol.0 as usize).map(|symbol| &symbol.kind),
                                Some(SymbolKind::Contract { .. }))) =>
                    {
                        let ResolvedType::Record { symbol, .. } = element.as_ref() else {
                            unreachable!();
                        };
                        Some(ContractValue::Array(*symbol))
                    }
                    ty if result_type(ty) => None,
                    _ => return Err(self.fail(key, "unsupported canonical Contract member value")),
                };
                // Selecting a local member consumes the already observed whole
                // owning field. It must never synthesize a dotted stored read.
                continue;
            }
            if let Some(members) = &value.members {
                let receiver = self
                    .types
                    .node_types
                    .get(&base_key)
                    .ok_or_else(|| self.fail(key, "missing composite receiver type"))?;
                let fields = checked_text_schema_fields(receiver, value.schema.as_deref())
                    .ok_or_else(|| self.fail(key, "unestablished composite receiver"))?;
                if !fields
                    .iter()
                    .any(|(name, field_ty)| name == field_name && field_ty == ty)
                    || !result_type(ty)
                {
                    return Err(self.fail(key, "unsupported schema member selection"));
                }
                let mut selected = members
                    .iter()
                    .find(|(name, _)| name == field_name)
                    .map(|(_, value)| value.clone())
                    .ok_or_else(|| self.fail(key, "missing composite member provenance"))?;
                selected.observed = value.observed.clone();
                let mut decisions = value.decisions.clone();
                for decision in &selected.decisions {
                    if !decisions.contains(decision) {
                        decisions.push(decision.clone());
                    }
                }
                selected.decisions = decisions;
                *value = selected;
                continue;
            }
            if value.delivery.is_some() {
                return Err(self.fail(
                    key,
                    "delivery inspection needs its defining observation closure",
                ));
            }
            let model = value
                .record
                .ok_or_else(|| self.fail(key, "non-direct stored field traversal"))?;
            if field_name == "id" {
                let Some(ReferenceOrigin::Parameter(parameter)) = value.reference_origin else {
                    return Err(self.fail(key, "id needs required original scenario parameter"));
                };
                let owner = self
                    .resolve
                    .symbols
                    .get(model.0 as usize)
                    .ok_or_else(|| self.fail(key, "missing intrinsic id model"))?;
                let SymbolKind::Model { fields, .. } = &owner.kind else {
                    return Err(self.fail(key, "id needs checked stored model"));
                };
                let Some(SymbolKind::Param {
                    owner: scenario, ..
                }) = self
                    .resolve
                    .symbols
                    .get(parameter.0 as usize)
                    .map(|parameter| &parameter.kind)
                else {
                    return Err(self.fail(key, "missing intrinsic id input owner"));
                };
                let scenario = self
                    .effects
                    .scenarios
                    .get(scenario)
                    .ok_or_else(|| self.fail(key, "missing intrinsic id source scenario"))?;
                if !calls.is_empty()
                    || self.loop_node.is_some()
                    || self.checked_call_parent_path(base_key, parameter, 0) != Some((model, 0))
                    || owner.module != module
                    || scenario.module != module
                    || scenario.read
                    || scenario.on.is_some()
                    || key.file != scenario.node.file
                    || key.start < scenario.node.start
                    || key.end > scenario.node.end
                    || fields.iter().any(|field| {
                        self.resolve
                            .symbols
                            .get(field.0 as usize)
                            .is_none_or(|field| field.name == "id")
                    })
                    || *ty != ResolvedType::Scalar(Scalar::Text)
                {
                    return Err(self.fail(key, "intrinsic id source correspondence"));
                }
                // Reserved row identity is an owning stored observation. It is
                // neither an authored field nor a version/context intrinsic.
                value.reads.push(DisclosureDependency {
                    id: self.opaque("read-data", key, &self.call_stamp(calls)?)?,
                    source: self.source(module, key)?,
                    node: key,
                    calls: calls.to_vec(),
                    role: DependencyRole::Data,
                    model,
                    field: model,
                    model_name: owner.canonical.clone(),
                    field_name: "id".into(),
                    ty: ty.clone(),
                    type_id: "text".into(),
                });
                value.observed.push((key, calls.to_vec()));
                value.record = None;
                value.reference = None;
                value.reference_origin = None;
                continue;
            }
            if field_name == "parent" {
                let (parameter, depth) = match value.reference_origin {
                    Some(ReferenceOrigin::Parameter(parameter)) => (parameter, 0),
                    Some(ReferenceOrigin::Parent {
                        parameter,
                        model: original,
                        depth,
                    }) if original == model && depth == 1 => (parameter, depth),
                    _ => {
                        return Err(
                            self.fail(key, "parent needs required original scenario parameter")
                        );
                    }
                };
                let owner = self
                    .resolve
                    .symbols
                    .get(model.0 as usize)
                    .ok_or_else(|| self.fail(key, "missing implicit parent model"))?;
                let SymbolKind::Model {
                    owner: super::resolve::ModelOwner::ChildOf(parent),
                    fields,
                    ..
                } = &owner.kind
                else {
                    return Err(self.fail(key, "parent needs checked child containment"));
                };
                let expected = ResolvedType::Record {
                    symbol: *parent,
                    stored: true,
                };
                if !calls.is_empty()
                    || self.checked_call_parent_path(key, parameter, 0)
                        != Some((*parent, depth + 1))
                    || fields.iter().any(|field| {
                        self.resolve
                            .symbols
                            .get(field.0 as usize)
                            .is_some_and(|field| field.name == "parent")
                    })
                    || self.effects.models.get(&model).is_none_or(|model| {
                        model.owner != super::resolve::ModelOwner::ChildOf(*parent)
                    })
                    || *ty != expected
                {
                    return Err(self.fail(key, "implicit parent source correspondence"));
                }
                let type_id = self
                    .reference_operand_type_id(&expected)
                    .ok_or_else(|| self.fail(key, "missing implicit parent owning declaration"))?;
                value.reads.push(DisclosureDependency {
                    id: self.opaque("read-data", key, &self.call_stamp(calls)?)?,
                    source: self.source(module, key)?,
                    node: key,
                    calls: calls.to_vec(),
                    role: DependencyRole::Data,
                    model,
                    field: model,
                    model_name: owner.canonical.clone(),
                    field_name: "parent".into(),
                    ty: expected,
                    type_id,
                });
                value.observed.push((key, calls.to_vec()));
                value.record = Some(*parent);
                value.reference = None;
                value.reference_origin = Some(ReferenceOrigin::Parent {
                    parameter,
                    model: *parent,
                    depth: depth + 1,
                });
                continue;
            }
            if matches!(
                value.reference_origin,
                Some(ReferenceOrigin::Parent { depth: 2, .. })
            ) {
                return Err(self.fail(
                    key,
                    "two-parent reference needs direct child input consumer",
                ));
            }
            if field_name == "version" {
                if *ty != ResolvedType::Scalar(Scalar::Int) {
                    return Err(self.fail(key, "unestablished intrinsic version type"));
                }
                let kind = value.reference.clone().ok_or_else(|| {
                    self.fail(
                        key,
                        "version needs required original versioned scenario reference",
                    )
                })?;
                if !matches!(&kind, DisclosureIntrinsicKind::AdmittedReferenceVersion {model: original,..} if *original == model)
                {
                    return Err(self.fail(key, "original reference model mismatch"));
                }
                let intrinsic = self.intrinsic(key, module, calls, kind, Scalar::Int)?;
                value.join(&intrinsic);
                value.record = None;
                value.reference = None;
                continue;
            }
            let owner = self
                .resolve
                .symbols
                .get(model.0 as usize)
                .ok_or_else(|| self.fail(key, "missing model owner"))?;
            let SymbolKind::Model { fields, .. } = &owner.kind else {
                return Err(self.fail(key, "non-model field owner"));
            };
            let field = fields
                .iter()
                .find_map(|id| {
                    self.resolve
                        .symbols
                        .get(id.0 as usize)
                        .filter(|s| s.name == field_name)
                })
                .ok_or_else(|| self.fail(key, "reserved or unresolved stored field"))?;
            let field_ty = self
                .types
                .symbol_types
                .get(&field.id)
                .ok_or_else(|| self.fail(key, "missing stored field type"))?;
            if !matches!(field.kind, SymbolKind::Field { owner, .. } if owner == model) {
                return Err(self.fail(key, "derived field requires its complete body closure"));
            }
            if field_ty != ty || field.module != owner.module {
                return Err(self.fail(key, "stored field schema identity mismatch"));
            }
            let parent_origin = match value.reference_origin {
                Some(ReferenceOrigin::Parent {
                    parameter,
                    model: parent,
                    depth: 1,
                }) if parent == model => Some(parameter),
                _ => None,
            };
            if parent_origin.is_some()
                && (self.reference_operand_type_id(field_ty).is_none()
                    || !self
                        .nodes
                        .get(&base_key)
                        .is_some_and(|node| node.kind == SyntaxKind::Member)
                    || !value
                        .reads
                        .iter()
                        .any(|read| read.node == base_key && read.field_name == "parent"))
            {
                return Err(self.fail(
                    key,
                    "parent edge needs direct required Model reference field",
                ));
            }
            let type_id = if let Some(parameter) = parent_origin {
                let declaration = self
                    .effects
                    .models
                    .get(&model)
                    .and_then(|model| {
                        model
                            .fields
                            .iter()
                            .find(|candidate| candidate.field == field.id)
                    })
                    .ok_or_else(|| self.fail(key, "missing checked reference field declaration"))?;
                if declaration.default.is_some()
                    || declaration.server.is_some()
                    || !calls.is_empty()
                {
                    return Err(
                        self.fail(key, "reference operand needs required direct stored field")
                    );
                }
                if matches!(field_ty, ResolvedType::Array { .. }) {
                    let alias = self
                        .types
                        .field_reuse_sources
                        .get(&field.id)
                        .ok_or_else(|| {
                            self.fail(key, "reference array needs genuine Scope field reuse")
                        })?;
                    if !matches!(self.resolve.symbols.get(alias.0 as usize).map(|symbol| &symbol.kind),
                        Some(SymbolKind::Field { owner, .. }) if matches!(self.resolve.symbols.get(owner.0 as usize).map(|symbol| &symbol.kind), Some(SymbolKind::Contract { .. })))
                    {
                        return Err(self.fail(key, "reference array needs owning Scope field"));
                    }
                }
                value.reference_origin = Some(ReferenceOrigin::Field {
                    parameter,
                    model,
                    field: field.id,
                });
                self.reference_operand_type_id(field_ty)
                    .ok_or_else(|| self.fail(key, "reference operand canonical type"))?
            } else if let ResolvedType::Record {
                symbol: contract, ..
            } = field_ty
            {
                let contract = self
                    .resolve
                    .symbols
                    .get(contract.0 as usize)
                    .filter(|contract| {
                        matches!(contract.kind, SymbolKind::Contract { .. })
                            && contract.module == owner.module
                    })
                    .ok_or_else(|| {
                        self.fail(key, "missing owning canonical Contract declaration")
                    })?;
                let declaration = self
                    .effects
                    .models
                    .get(&model)
                    .and_then(|model| {
                        model
                            .fields
                            .iter()
                            .find(|candidate| candidate.field == field.id)
                    })
                    .ok_or_else(|| {
                        self.fail(key, "missing checked stored Contract field declaration")
                    })?;
                if declaration.required_array || !calls.is_empty() {
                    return Err(self.fail(key, "unsupported stored Contract field occurrence"));
                }
                value.contract_value = Some(ContractValue::Singular(contract.id));
                contract.canonical.clone()
            } else {
                self.field_type_id(key, field.id, field_ty)?
            };
            value.reads.push(DisclosureDependency {
                id: self.opaque("read-data", key, &self.call_stamp(calls)?)?,
                source: self.source(module, key)?,
                node: key,
                calls: calls.to_vec(),
                role: DependencyRole::Data,
                model,
                field: field.id,
                model_name: owner.canonical.clone(),
                field_name: field.name.clone(),
                ty: field_ty.clone(),
                type_id,
            });
            value.observed.push((key, calls.to_vec()));
            value.record = None;
            value.reference = None;
        }
        Ok(values)
    }

    fn expr_array(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
        children: Vec<&SyntaxNode>,
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let ty = self
            .types
            .node_types
            .get(&key)
            .ok_or_else(|| self.fail(key, "missing checked expression type"))?;
        let base = match ty {
            ResolvedType::Nullable(inner) => inner.as_ref(),
            ty => ty,
        };
        let ResolvedType::Array { element, .. } = base else {
            return Err(self.fail(key, "unsupported array expression type"));
        };
        let composite = matches!(element.as_ref(), ResolvedType::Object(_))
            || checked_standard_nominal_name(element) == Some("TextMessage");
        let empty_files =
            children.is_empty() && matches!(element.as_ref(), ResolvedType::Scalar(Scalar::File));
        if !primitive_type(element) && !composite && !empty_files {
            return Err(self.fail(key, "unsupported array expression type"));
        }
        let mut paths = vec![ValuePath::default()];
        for child in children {
            let element_ty = self
                .types
                .node_types
                .get(&NodeKey::of(child))
                .ok_or_else(|| self.fail(key, "missing checked array element type"))?;
            if !primitive_type(element_ty)
                && !matches!(element_ty, ResolvedType::Object(_))
                && checked_standard_nominal_name(element_ty) != Some("TextMessage")
            {
                return Err(self.fail(key, "unsupported array element type"));
            }
            let element = self.expr(NodeKey::of(child), module, env, calls)?;
            if composite
                && element
                    .iter()
                    .any(|value| value.schema.as_deref() != Some("TextMessage"))
            {
                return Err(self.fail(key, "array needs checked TextMessage values"));
            }
            paths = self.product(key, &paths, &element)?;
        }
        Ok(paths)
    }

    fn expr_binary(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
        node: &SyntaxNode,
        children: Vec<&SyntaxNode>,
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        if children.len() != 2 {
            return Err(self.fail(key, "invalid binary shape"));
        }
        let op = node
            .children
            .iter()
            .find(|n| matches!(n.kind, SyntaxKind::Name | SyntaxKind::Punct))
            .and_then(|n| {
                self.db
                    .get(n.span.file)?
                    .text
                    .get(n.span.start as usize..n.span.end as usize)
            })
            .ok_or_else(|| self.fail(key, "missing checked operator"))?;
        if matches!(op, "??" | "==" | "!=")
            && children.iter().any(|operand| {
                matches!(self.types.node_types.get(&NodeKey::of(operand)),
                            Some(ResolvedType::Nullable(inner))
                                if matches!(inner.as_ref(), ResolvedType::Record { .. }))
            })
        {
            return Err(self.influence(
                key,
                module,
                &[InfluenceKind::AbsentReference],
                "nullable reference selection or comparison",
            ));
        }
        let left = self.expr(NodeKey::of(children[0]), module, env, calls)?;
        if left.iter().any(|value| {
            matches!(
                value.reference_origin,
                Some(ReferenceOrigin::Parent { .. } | ReferenceOrigin::Field { .. })
            )
        }) {
            return Err(self.fail(
                key,
                "stored reference operand needs direct child or count consumer",
            ));
        }
        if matches!(op, "and" | "or" | "??") {
            let right = self.expr(NodeKey::of(children[1]), module, env, calls)?;
            if left.len().saturating_mul(right.len().saturating_add(1)) > 1024 {
                return Err(self.fail(key, "short-circuit path bound"));
            }
            let mut out = Vec::new();
            for lhs in left {
                let mut skipped = lhs.clone();
                skipped.join(&self.control(lhs.clone())?);
                skipped.decisions.push(DisclosureDecision {
                    node: key,
                    calls: calls.to_vec(),
                    choice: DisclosureChoice::RhsSkipped,
                });
                out.push(skipped);
                for rhs in &right {
                    if !compatible(&lhs.decisions, &rhs.decisions) {
                        continue;
                    }
                    let mut selected = lhs.clone();
                    selected.join(&self.control(lhs.clone())?);
                    selected.decisions.push(DisclosureDecision {
                        node: key,
                        calls: calls.to_vec(),
                        choice: DisclosureChoice::RhsEvaluated,
                    });
                    selected.join(rhs);
                    selected.record = None;
                    selected.reference = None;
                    out.push(selected);
                }
            }
            self.bounded(key, out)
        } else {
            if !matches!(
                op,
                "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">="
            ) {
                return Err(self.fail(key, "unsupported scalar operator"));
            }
            let right = self.expr(NodeKey::of(children[1]), module, env, calls)?;
            if right.iter().any(|value| {
                matches!(
                    value.reference_origin,
                    Some(ReferenceOrigin::Parent { .. } | ReferenceOrigin::Field { .. })
                )
            }) {
                return Err(self.fail(
                    key,
                    "stored reference operand needs direct child or count consumer",
                ));
            }
            self.product(key, &left, &right)
        }
    }
    fn bounded(
        &self,
        key: NodeKey,
        paths: Vec<ValuePath>,
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        if paths.len() > 1024 {
            Err(self.fail(key, "evaluation path bound"))
        } else {
            Ok(paths)
        }
    }

    fn product(
        &self,
        key: NodeKey,
        left: &[ValuePath],
        right: &[ValuePath],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        if left.len().saturating_mul(right.len()) > 1024 {
            return Err(self.fail(key, "evaluation path bound"));
        }
        let mut out = Vec::new();
        for lhs in left {
            for rhs in right {
                // A referenced immutable alias carries its already selected path.
                // Contradictory selections cannot occur in one execution.
                if !compatible(&lhs.decisions, &rhs.decisions) {
                    continue;
                }
                let mut merged = lhs.clone();
                merged.join(rhs);
                merged.record = None;
                merged.reference = None;
                merged.input = None;
                merged.contract_value = None;
                out.push(merged);
            }
        }
        Ok(out)
    }

    fn call(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let selected = self
            .types
            .selected_calls
            .get(&key)
            .ok_or_else(|| self.fail(key, "missing checked call selection"))?
            .clone();
        // State retains and reauthorizes the complete child association before
        // disclosing any parent result. Counting its exact returned wire needs
        // no fabricated parent scalar/row observation. Other uses still refuse
        // at CallAs, including aliases, helpers and field selection.
        if calls.is_empty()
            && let Some(argument) = self.query_count(key)
            && let Some(Binding::CallAs { node }) = self.query_binding(argument)
            && let Some(value) = env.get(&Local::Call(*node))
            && let Some(child) = value.query_child
            && self.complete_children.contains(&child)
            && self.types.effect_call_results.get(node) == self.types.symbol_results.get(&child)
            && self
                .types
                .effect_call_results
                .get(node)
                .and_then(Option::as_ref)
                == self.types.node_types.get(&argument)
            && self.types.node_types.get(&key) == Some(&ResolvedType::Scalar(Scalar::Int))
        {
            let mut retained = value.clone();
            retained.query_child = None;
            return Ok(vec![retained]);
        }
        if calls.is_empty()
            && let Some(argument) = self.query_count(key)
            && self
                .nodes
                .get(&self.query_group(argument).unwrap_or(argument))
                .is_some_and(|node| node.kind == SyntaxKind::Member)
            && matches!(self.types.node_types.get(&argument),
                Some(ResolvedType::Array {element, ordered:true, nonempty:false})
                if matches!(element.as_ref(), ResolvedType::Record {symbol, ..}
                    if matches!(self.resolve.symbols.get(symbol.0 as usize).map(|symbol| &symbol.kind),
                        Some(SymbolKind::Contract { .. }))))
            && self.types.node_types.get(&key) == Some(&ResolvedType::Scalar(Scalar::Int))
        {
            let mut values = self.expr(argument, module, env, calls)?;
            for value in &mut values {
                if !matches!(value.contract_value, Some(ContractValue::Array(_)))
                    || value.reads.is_empty()
                {
                    return Err(self.fail(key, "count needs its whole stored Contract origin"));
                }
                value.contract_value = None;
            }
            return Ok(values);
        }
        if calls.is_empty()
            && let Some(argument) = self.query_count(key)
            && self
                .nodes
                .get(&argument)
                .is_some_and(|node| node.kind == SyntaxKind::Member)
            && matches!(
                self.types.node_types.get(&argument),
                Some(ResolvedType::Array { .. })
            )
            && self
                .types
                .node_types
                .get(&argument)
                .is_some_and(|ty| self.reference_operand_type_id(ty).is_some())
            && self.types.node_types.get(&key) == Some(&ResolvedType::Scalar(Scalar::Int))
        {
            let mut values = self.expr(argument, module, env, calls)?;
            for value in &mut values {
                let Some(ReferenceOrigin::Field { field, .. }) = value.reference_origin else {
                    return Err(self.fail(key, "count needs original parent reference-array field"));
                };
                let alias = self
                    .types
                    .field_reuse_sources
                    .get(&field)
                    .ok_or_else(|| self.fail(key, "count needs bounded source Scope"))?;
                // The same genuine inherited bounds apply before any child call.
                if !self.reference_array_source_bounds(field, *alias) {
                    return Err(self.fail(key, "count needs exact positive finite source bounds"));
                }
                value.reference_origin = None;
            }
            return Ok(values);
        }
        if calls.is_empty()
            && let Some(value) = self.query_child_collection(key, module, env)
        {
            return Ok(vec![value]);
        }
        let mut argument_paths = vec![(ValuePath::default(), Vec::<ValuePath>::new())];
        for argument in &selected.arguments {
            let alternatives = self.expr(*argument, module, env, calls)?;
            if alternatives.iter().any(|value| {
                value.contract_value.is_some()
                    || matches!(
                        value.reference_origin,
                        Some(ReferenceOrigin::Parent { .. } | ReferenceOrigin::Field { .. })
                    )
            }) {
                return Err(self.fail(
                    key,
                    "canonical Contract wire needs its direct local consumer",
                ));
            }
            let mut next = Vec::new();
            for (evaluated, supplied) in argument_paths {
                for alternative in &alternatives {
                    if self
                        .product(
                            key,
                            std::slice::from_ref(&evaluated),
                            std::slice::from_ref(alternative),
                        )?
                        .is_empty()
                    {
                        continue;
                    }
                    let mut joined = evaluated.clone();
                    joined.join(alternative);
                    let mut args = supplied.clone();
                    args.push(alternative.clone());
                    next.push((joined, args));
                    if next.len() > 1024 {
                        return Err(self.fail(key, "call evaluation path bound"));
                    }
                }
            }
            if next.len() > 1024 {
                return Err(self.fail(key, "call evaluation path bound"));
            }
            argument_paths = next;
        }
        match selected.target {
            SelectedCallTarget::DeriveFn(id) => {
                if !self.stack.insert(id) {
                    return Err(self.fail(key, "recursive derive closure"));
                }
                let result = (|| {
                    let derive = self
                        .effects
                        .derives
                        .get(&id)
                        .ok_or_else(|| self.fail(key, "missing checked derive body"))?
                        .clone();
                    let body = derive
                        .expr
                        .ok_or_else(|| self.fail(derive.node, "missing derive expression"))?;
                    if derive.params.len() > 256 {
                        return Err(self.fail(derive.node, "derive binding closure bound"));
                    }
                    if selected.slots.len() != derive.params.len() {
                        return Err(self.fail(key, "checked call slot mismatch"));
                    }
                    let mut nested_calls = calls.to_vec();
                    nested_calls.push(key);
                    let mut out = Vec::new();
                    for (evaluated, arguments) in argument_paths {
                        let mut bindings = vec![(Env::new(), evaluated)];
                        for (param, slot) in derive.params.iter().zip(&selected.slots) {
                            let mut next = Vec::new();
                            for (local, prior) in bindings {
                                let values = if let Some(index) = slot {
                                    vec![arguments.get(*index).cloned().ok_or_else(|| {
                                        self.fail(key, "checked argument index mismatch")
                                    })?]
                                } else {
                                    self.expr(
                                        param.default.ok_or_else(|| {
                                            self.fail(param.node, "missing checked derive default")
                                        })?,
                                        derive.module,
                                        &local,
                                        &nested_calls,
                                    )?
                                };
                                for value in values {
                                    let mut local = local.clone();
                                    local.insert(Local::Symbol(param.param), value.clone());
                                    let mut prior = prior.clone();
                                    prior.join(&value);
                                    next.push((local, prior));
                                    if next.len() > 1024 {
                                        return Err(self.fail(key, "default evaluation path bound"));
                                    }
                                }
                            }
                            if next.len() > 1024 {
                                return Err(self.fail(key, "default evaluation path bound"));
                            }
                            bindings = next;
                        }
                        for (local, evaluated) in bindings {
                            for mut value in
                                self.expr(body, derive.module, &local, &nested_calls)?
                            {
                                if !compatible(&evaluated.decisions, &value.decisions) {
                                    continue;
                                }
                                // Argument reads matter only when the derive's
                                // returned value consumes them. Decisions are
                                // retained solely to identify actual evaluation.
                                let mut decisions = evaluated.decisions.clone();
                                for decision in &value.decisions {
                                    if !decisions.contains(decision) {
                                        decisions.push(decision.clone());
                                    }
                                }
                                value.decisions = decisions;
                                let mut observed = evaluated.observed.clone();
                                for read in &value.observed {
                                    if !observed.contains(read) {
                                        observed.push(read.clone());
                                    }
                                }
                                value.observed = observed;
                                out.push(value);
                                if out.len() > 1024 {
                                    return Err(self.fail(key, "derive evaluation path bound"));
                                }
                            }
                        }
                    }
                    self.bounded(key, out)
                })();
                self.stack.remove(&id);
                result
            }
            SelectedCallTarget::Builtin { id, .. } => {
                if matches!(id.as_str(), "count" | "first" | "any" | "sum") {
                    return Err(self.influence(
                        key,
                        module,
                        &[
                            InfluenceKind::QueryExistence,
                            InfluenceKind::QueryCardinality,
                            InfluenceKind::QueryMembership,
                        ],
                        "collection builtin closure",
                    ));
                }
                // These settled scalar constructors/math functions consume all
                // explicit operands. Catalog defaults are not source defaults.
                if !matches!(
                    id.as_str(),
                    "date" | "datetime" | "money" | "abs" | "round" | "min" | "max"
                ) || selected.slots.iter().any(Option::is_none)
                {
                    return Err(self.fail(key, "unsupported builtin closure"));
                }
                Ok(argument_paths
                    .into_iter()
                    .map(|(mut value, _)| {
                        value.record = None;
                        value.reference = None;
                        value
                    })
                    .collect())
            }
            SelectedCallTarget::Role(_) => {
                if self.authorization {
                    Ok(argument_paths.into_iter().map(|(value, _)| value).collect())
                } else {
                    Err(self.fail(key, "authority-dependent role call"))
                }
            }
            _ => Err(self.fail(key, "unsupported callable closure")),
        }
    }

    fn direct_builtin_parameter_type(&self, key: NodeKey, scalar: Scalar) -> bool {
        let Some(node) = self.nodes.get(&key) else {
            return false;
        };
        if node.kind != SyntaxKind::NamedType {
            return false;
        }
        let mut paths = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Path);
        let Some(path) = paths.next() else {
            return false;
        };
        paths.next().is_none()
            && matches!(self.resolve.node_typeref.get(&NodeKey::of(path)),
            Some(TypeRef::Scalar(name)) if name == scalar.as_str())
    }

    /// Every child slot is supplied explicitly. Owning literal defaults and
    /// checked scalar field reuse remain declaration facts, never reevaluated
    /// CALL arguments or an omitted-input admission.
    fn explicit_scalar_call_parameter(
        &self,
        parameter: &super::effects::ParamData,
        module: ModuleId,
        scalar: Scalar,
    ) -> bool {
        if parameter.default.is_some_and(|default| {
            self.nodes
                .get(&default)
                .is_none_or(|node| node.kind != SyntaxKind::Literal)
                || self.types.node_types.get(&default) != Some(&ResolvedType::Scalar(scalar))
        }) {
            return false;
        }
        if self.direct_builtin_parameter_type(parameter.type_node, scalar) {
            return true;
        }
        let Some(node) = self.nodes.get(&parameter.type_node) else {
            return false;
        };
        let Some(path) = node
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)
        else {
            return false;
        };
        if node.kind != SyntaxKind::NamedType {
            return false;
        }
        let checked_alias = |alias: SymbolId| {
            self.resolve
                .judgment_value_constraints
                .get(&alias)
                .is_some_and(|constraints| {
                    constraints.alias == Some(alias)
                        && self.types.value_constraints.get(&parameter.param) == Some(constraints)
                        && self.types.symbol_types.get(&alias)
                            == Some(&ResolvedType::Scalar(scalar))
                })
        };
        match self.resolve.node_typeref.get(&NodeKey::of(path)) {
            Some(TypeRef::FieldChain { fields, .. }) if fields.len() == 1 => {
                (self.types.field_reuse_sources.get(&parameter.param) == fields.first()
                    && self.types.symbol_types.get(&fields[0])
                        == Some(&ResolvedType::Scalar(scalar)))
                    || checked_alias(fields[0])
            }
            Some(TypeRef::Symbol(alias)) => checked_alias(*alias),
            Some(TypeRef::External) => {
                let Some(source) = self.db.get(path.span.file) else {
                    return false;
                };
                let segments = super::path_segments(path, &source.text);
                let [head, field] = segments.as_slice() else {
                    return false;
                };
                let Some(ScopedName::External { provider, name }) = self
                    .resolve
                    .module_scopes
                    .get(module.0 as usize)
                    .and_then(|scope| scope.prod.get(*head))
                else {
                    return false;
                };
                if provider != "std"
                    || !matches!(
                        (name.as_str(), *field),
                        ("TextMessage", "content")
                            | ("ImageRequest", "prompt" | "negative" | "width" | "height")
                    )
                {
                    return false;
                }
                nominal_schema(name)
                    .and_then(|schema| schema.fields.iter().find(|(name, _)| name == field))
                    .and_then(|(_, declared)| super::types::std_schema_type(declared))
                    == Some(ResolvedType::Scalar(scalar))
            }
            _ => false,
        }
    }

    fn input_value(
        &self,
        key: NodeKey,
        module: ModuleId,
        calls: &[NodeKey],
        mut value: ValuePath,
    ) -> Result<ValuePath, DisclosureDecline> {
        if let Some((parameter, parameter_name, scalar)) = value.input.take() {
            let intrinsic = self.intrinsic(
                key,
                module,
                calls,
                DisclosureIntrinsicKind::AdmittedInput {
                    parameter,
                    parameter_name,
                },
                scalar,
            )?;
            value.join(&intrinsic);
        }
        Ok(value)
    }

    fn operation_context(&self, mut key: NodeKey) -> bool {
        for _ in 0..64 {
            let Some(node) = self.nodes.get(&key) else {
                return false;
            };
            if node.kind != SyntaxKind::Group {
                return node.kind == SyntaxKind::NameRef
                    && matches!(
                        self.resolve.node_binding.get(&key),
                        Some(Binding::Context(ContextVar::Operation))
                    );
            }
            let mut children = node.children.iter().filter(|child| expression(child.kind));
            let Some(child) = children.next() else {
                return false;
            };
            if children.next().is_some() {
                return false;
            }
            key = NodeKey::of(child);
        }
        false
    }

    fn intrinsic(
        &self,
        node: NodeKey,
        module: ModuleId,
        calls: &[NodeKey],
        kind: DisclosureIntrinsicKind,
        scalar: Scalar,
    ) -> Result<ValuePath, DisclosureDecline> {
        Ok(ValuePath {
            intrinsics: vec![DisclosureIntrinsic {
                id: self.opaque("intrinsic-data", node, &self.call_stamp(calls)?)?,
                source: self.source(module, node)?,
                node,
                calls: calls.to_vec(),
                role: DependencyRole::Data,
                kind,
                ty: ResolvedType::Scalar(scalar),
                type_id: scalar.as_str().to_string(),
            }],
            observed: vec![(node, calls.to_vec())],
            ..ValuePath::default()
        })
    }

    fn word(&self, node: &SyntaxNode) -> Option<&'a str> {
        let name = if node.kind == SyntaxKind::NameRef {
            node.children
                .iter()
                .find(|child| child.kind == SyntaxKind::Name)?
        } else {
            node
        };
        self.db
            .get(name.span.file)?
            .text
            .get(name.span.start as usize..name.span.end as usize)
    }

    /// Shorthand entries have a checked lexical binding on their key token,
    /// rather than an invented expression node/type.
    fn lexical(
        &self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        if self.types.resolved_cases.contains(&key)
            && matches!(
                self.types.node_types.get(&key),
                Some(ResolvedType::Enum { .. })
            )
        {
            return Ok(vec![ValuePath::default()]);
        }
        let local = match self.resolve.node_binding.get(&key) {
            Some(Binding::Symbol(id)) => Local::Symbol(*id),
            Some(Binding::Let { node }) => Local::Let(*node),
            Some(Binding::CreateAs { node }) => Local::Create(*node),
            Some(Binding::ForItem { node }) => Local::For(*node),
            Some(Binding::SendAs { node }) => Local::Send(*node),
            Some(Binding::CallAs { .. }) => {
                return Err(self.fail(
                    key,
                    "bound child result consumption needs its owning provenance",
                ));
            }
            None if self.types.resolved_cases.contains(&key) => {
                return Ok(vec![ValuePath::default()]);
            }
            _ => return Err(self.fail(key, "unsupported shorthand binding")),
        };
        let value = env
            .get(&local)
            .cloned()
            .ok_or_else(|| self.fail(key, "missing shorthand provenance"))?;
        Ok(vec![self.input_value(key, module, calls, value)?])
    }

    fn object(
        &mut self,
        (key, node): (NodeKey, &SyntaxNode),
        ty: &ResolvedType,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
        schema: Option<String>,
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let fields = checked_text_schema_fields(ty, schema.as_deref())
            .ok_or_else(|| self.fail(key, "unsupported object type"))?;
        if fields.len() > 200 {
            return Err(self.fail(key, "object field bound"));
        }
        let mut paths = vec![ValuePath {
            members: Some(Vec::new()),
            schema,
            ..ValuePath::default()
        }];
        let mut seen = HashSet::new();
        for entry in node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::ObjectEntry)
        {
            let key_node = entry
                .children
                .first()
                .filter(|child| child.kind == SyntaxKind::Name)
                .ok_or_else(|| self.fail(key, "missing object key anchor"))?;
            let name = self
                .word(key_node)
                .ok_or_else(|| self.fail(key, "missing object key"))?;
            if !fields.iter().any(|(field, _)| field == name) || !seen.insert(name.to_string()) {
                return Err(self.fail(key, "object fields disagree with checked shape"));
            }
            let value = entry.children.iter().find(|child| expression(child.kind));
            let alternatives = match value {
                Some(value) => self.expr(NodeKey::of(value), module, env, calls)?,
                None => self.lexical(NodeKey::of(key_node), module, env, calls)?,
            };
            if alternatives
                .iter()
                .any(|value| value.record.is_some() || value.delivery.is_some())
            {
                return Err(self.fail(key, "opaque object member"));
            }
            if paths.len().saturating_mul(alternatives.len()) > 1024 {
                return Err(self.fail(key, "object evaluation path bound"));
            }
            let mut next = Vec::new();
            for path in &paths {
                for value in &alternatives {
                    if !compatible(&path.decisions, &value.decisions) {
                        continue;
                    }
                    let mut joined = path.clone();
                    joined.join(value);
                    joined
                        .members
                        .as_mut()
                        .unwrap()
                        .push((name.to_string(), value.clone()));
                    next.push(joined);
                }
            }
            paths = next;
        }
        for (name, field_ty) in fields {
            if seen.contains(name) {
                continue;
            }
            if !matches!(
                field_ty,
                ResolvedType::Nullable(_) | ResolvedType::Array { .. }
            ) {
                return Err(self.fail(key, "missing required checked object field"));
            }
            for path in &mut paths {
                path.members
                    .as_mut()
                    .unwrap()
                    .push((name.clone(), ValuePath::default()));
            }
        }
        self.bounded(key, paths)
    }

    fn proof(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        kind: DisclosureEffectKind,
    ) -> Result<(), DisclosureDecline> {
        let proof = DisclosureEffect {
            node: effect.node,
            source: self.source(module, effect.node)?,
            kind,
        };
        if let Some(prior) = self
            .effect_proofs
            .iter()
            .find(|prior| prior.node == effect.node)
        {
            if prior != &proof {
                return Err(self.fail(effect.node, "conflicting checked effect proof"));
            }
        } else {
            if self.effect_proofs.len() >= 200 {
                return Err(self.fail(effect.node, "effect proof bound"));
            }
            self.effect_proofs.push(proof);
        }
        Ok(())
    }

    /// The original empty constructor uses State-owned literal integer defaults.
    /// Other model/default/lifetime profiles retain their whole-decline boundary.
    fn literal_root_model(
        &self,
        model: SymbolId,
        module: ModuleId,
        anchor: NodeKey,
    ) -> Result<(SymbolId, Vec<DisclosureCreateDefault>), DisclosureDecline> {
        let fail = || self.fail(anchor, "root literal integer model profile required");
        let symbol = self
            .resolve
            .symbols
            .get(model.0 as usize)
            .ok_or_else(fail)?;
        let SymbolKind::Model {
            fields,
            owner: ModelOwner::Team,
            crud: Some(crud),
        } = &symbol.kind
        else {
            return Err(fail());
        };
        let data = self.effects.models.get(&model).ok_or_else(fail)?;
        let crud_data = self.effects.cruds.get(crud).ok_or_else(fail)?;
        if symbol.id != model || symbol.module != module || data.model != model || data.module != module
            || data.owner != ModelOwner::Team || fields.is_empty() || fields.len() > 200
            || !fields.iter().copied().eq(data.fields.iter().map(|field| field.field))
            || !data.invariants.is_empty() || !data.uniques.is_empty() || !data.locks.is_empty()
            || !data.retains.is_empty() || crud_data.crud != *crud || crud_data.model != model
            || crud_data.module != module || crud_data.when.is_some()
            || self.effects.scenarios.values().any(|scenario| {
                matches!(&scenario.on, Some(HandlerSource::Hook {model: target, ..}) if *target == model)
            })
        {
            return Err(fail());
        }
        let mut defaults = Vec::new();
        for field in &data.fields {
            let owned = self
                .resolve
                .symbols
                .get(field.field.0 as usize)
                .ok_or_else(fail)?;
            if !matches!(owned.kind, SymbolKind::Field {owner, ..} if owner == model)
                || owned.module != module
                || field.server.is_some()
                || field.required_array
                || !field.modifiers.is_empty()
                || self.types.symbol_types.get(&field.field)
                    != Some(&ResolvedType::Scalar(Scalar::Int))
            {
                return Err(fail());
            }
            let default = field.default.ok_or_else(fail)?;
            let node = self.nodes.get(&default).ok_or_else(fail)?;
            if node.kind != SyntaxKind::Literal
                || self.types.node_types.get(&default) != Some(&ResolvedType::Scalar(Scalar::Int))
                || default.file != field.node.file
                || default.start < field.node.start
                || default.end > field.node.end
            {
                return Err(fail());
            }
            let integer = node
                .children
                .iter()
                .find(|child| child.kind == SyntaxKind::Integer)
                .ok_or_else(fail)?;
            let source = self.db.get(default.file).ok_or_else(fail)?;
            let value = source
                .text
                .get(integer.span.start as usize..integer.span.end as usize)
                .and_then(|text| text.parse::<i128>().ok())
                .ok_or_else(fail)?;
            self.source(module, default)?;
            defaults.push(DisclosureCreateDefault {
                field: field.field,
                default,
                value,
            });
        }
        Ok((*crud, defaults))
    }

    fn create(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<(SymbolId, Vec<ValuePath>), DisclosureDecline> {
        let fail = || {
            self.fail(
                effect.node,
                "checked bound scenario create profile required",
            )
        };
        let checked = self
            .checked_create_source(effect, module)
            .ok_or_else(fail)?;
        let model = checked.model;
        if self.statement_depth != 1 || self.loop_node.is_some() || !calls.is_empty() {
            return Err(fail());
        }
        // Retain the accepted legacy constructor/default proof. Other checked
        // scenario creates use the owning declaration, not a public CRUD gate.
        let (crud, defaults) = if checked.inputs.is_empty() {
            match self.literal_root_model(model, module, effect.node) {
                Ok((crud, defaults))
                    if self
                        .effects
                        .cruds
                        .get(&crud)
                        .is_some_and(|data| data.create) =>
                {
                    (Some(crud), defaults)
                }
                _ => (None, Vec::new()),
            }
        } else {
            (None, Vec::new())
        };
        let mut paths = vec![ValuePath::default()];
        for input in &checked.inputs {
            // The authored creator attribution is evaluated by the genuine
            // scenario context. It is not a stored-field observation or grant.
            let alternatives = if self.admitted_actor_default(input.value_node, &input.ty) {
                vec![ValuePath::default()]
            } else if input.value_node == input.key_node {
                self.lexical(input.key_node, module, env, calls)?
            } else {
                self.expr(input.value_node, module, env, calls)?
            };
            let mut next = Vec::new();
            for path in paths {
                for value in &alternatives {
                    let value = self.input_value(input.value_node, module, calls, value.clone())?;
                    let mut joined = path.clone();
                    joined.join(&value);
                    next.push(joined);
                }
            }
            paths = self.bounded(effect.node, next)?;
        }
        self.proof(
            effect,
            module,
            DisclosureEffectKind::Create {
                model,
                crud,
                binding: checked.binding,
                defaults,
                inputs: checked.inputs,
            },
        )?;
        Ok((model, paths))
    }

    fn delete(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<(), DisclosureDecline> {
        let refusal = self.fail(effect.node, "direct root archive profile required");
        let fail = || refusal.clone();
        let node = *self.nodes.get(&effect.node).ok_or_else(fail)?;
        let Some(EffectTarget::Record { model: Some(model) }) = effect.target else {
            return Err(fail());
        };
        let receiver = node
            .children
            .iter()
            .find(|child| child.kind == SyntaxKind::Path)
            .ok_or_else(fail)?;
        let key = NodeKey::of(receiver);
        let parameter = match self.query_binding(key) {
            Some(Binding::Symbol(parameter)) => *parameter,
            _ => return Err(fail()),
        };
        let Some(SymbolKind::Param { owner, .. }) = self
            .resolve
            .symbols
            .get(parameter.0 as usize)
            .map(|symbol| &symbol.kind)
        else {
            return Err(fail());
        };
        if !self.effects.scenarios.get(owner).is_some_and(|scenario| {
            scenario
                .params
                .iter()
                .any(|input| input.param == parameter && input.default.is_none())
        }) {
            return Err(fail());
        }
        if node.kind != SyntaxKind::Delete
            || self.statement_depth != 1
            || self.loop_node.is_some()
            || !calls.is_empty()
            || effect.when.is_some()
            || !effect.args.is_empty()
            || !matches!(
                self.resolve
                    .symbols
                    .get(parameter.0 as usize)
                    .map(|symbol| &symbol.kind),
                Some(SymbolKind::Param { .. })
            )
            || self.types.symbol_types.get(&parameter)
                != Some(&ResolvedType::Record {
                    symbol: model,
                    stored: true,
                })
            || self.expr(key, module, env, calls)?.iter().any(|value| {
                value.record != Some(model)
                    || !matches!(value.reference_origin, Some(ReferenceOrigin::Parameter(original)) if original == parameter)
            })
        {
            return Err(fail());
        }
        let (crud, _) = self.literal_root_model(model, module, effect.node)?;
        if !self
            .effects
            .cruds
            .get(&crud)
            .is_some_and(|data| data.delete && data.delete_mode == DeleteMode::Archive)
        {
            return Err(fail());
        }
        self.proof(
            effect,
            module,
            DisclosureEffectKind::Delete {
                model,
                crud,
                receiver: key,
            },
        )
    }

    fn set(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let node = *self
            .nodes
            .get(&effect.node)
            .ok_or_else(|| self.fail(effect.node, "missing set anchor"))?;
        if node.kind != SyntaxKind::Set || effect.when.is_some() {
            return Err(self.fail(effect.node, "unsupported set shape"));
        }
        let Some(EffectTarget::Record { model: Some(model) }) = &effect.target else {
            return Err(self.fail(effect.node, "set needs checked stored target"));
        };
        let owner = self
            .resolve
            .symbols
            .get(model.0 as usize)
            .ok_or_else(|| self.fail(effect.node, "missing set model"))?;
        let SymbolKind::Model { fields, .. } = &owner.kind else {
            return Err(self.fail(effect.node, "set target is not a model"));
        };
        if owner.module != module {
            return Err(self.fail(effect.node, "foreign set model"));
        }
        let receiver = node
            .children
            .iter()
            .find(|child| child.kind == SyntaxKind::Path)
            .ok_or_else(|| self.fail(effect.node, "missing direct set receiver"))?;
        if receiver
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Name)
            .count()
            != 1
            || !matches!(self.types.node_types.get(&NodeKey::of(receiver)), Some(ResolvedType::Record {symbol,stored:true}) if symbol == model)
        {
            return Err(self.fail(effect.node, "set needs nonnullable direct stored receiver"));
        }
        let mut paths = self.expr(NodeKey::of(receiver), module, env, calls)?;
        if paths.iter().any(|path| path.record != Some(*model)) {
            return Err(self.fail(effect.node, "set receiver lacks binding provenance"));
        }
        let mut written = Vec::new();
        let mut file_inputs = Vec::new();
        for arg in &effect.args {
            let field = fields
                .iter()
                .filter_map(|id| self.resolve.symbols.get(id.0 as usize))
                .find(|field| field.name == arg.key)
                .ok_or_else(|| self.fail(arg.key_node, "unowned set field"))?;
            if !matches!(field.kind, SymbolKind::Field {owner,..} if owner == *model)
                || written.contains(&field.id)
            {
                return Err(self.fail(arg.key_node, "set needs distinct checked stored fields"));
            }
            let ty = self
                .types
                .symbol_types
                .get(&field.id)
                .ok_or_else(|| self.fail(arg.key_node, "missing set field type"))?;
            let base = match ty {
                ResolvedType::Nullable(inner) => inner.as_ref(),
                ty => ty,
            };
            let delivery = matches!(
                base,
                ResolvedType::Delivery { .. } | ResolvedType::StdDelivery { .. }
            );
            let file = matches!(base, ResolvedType::Scalar(Scalar::File));
            if !delivery && !file {
                if matches!(base, ResolvedType::Array { .. }) {
                    return Err(self.fail(arg.key_node, "set array outside scalar effect profile"));
                }
                self.field_type_id(arg.key_node, field.id, ty)?;
            }
            let values = if file {
                let value = arg.value.ok_or_else(|| {
                    self.fail(
                        arg.key_node,
                        "File assignment needs explicit original input",
                    )
                })?;
                file_inputs.push(self.file_assignment_input(
                    effect.node,
                    module,
                    env,
                    calls,
                    (NodeKey::of(receiver), field.id, value),
                )?);
                vec![ValuePath::default()]
            } else {
                match arg.value {
                    Some(value) => self.expr(value, module, env, calls)?,
                    None => self.lexical(arg.key_node, module, env, calls)?,
                }
            };
            if values.iter().any(|value| {
                if delivery {
                    value.delivery.as_ref() != Some(base)
                } else {
                    value.delivery.is_some() || value.record.is_some() || value.members.is_some()
                }
            }) {
                return Err(self.fail(arg.key_node, "set carrier or scalar provenance mismatch"));
            }
            paths = self.product(effect.node, &paths, &values)?;
            written.push(field.id);
        }
        if written.is_empty() {
            return Err(self.fail(effect.node, "empty set profile"));
        }
        self.proof(
            effect,
            module,
            DisclosureEffectKind::Set {
                model: *model,
                fields: written,
                file_inputs,
            },
        )?;
        Ok(paths)
    }

    /// Source correspondence only. The installed Files producer supplies the
    /// genuine finalized observation to the owning active root invocation.
    fn file_assignment_input(
        &self,
        statement: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
        assignment: (NodeKey, SymbolId, NodeKey),
    ) -> Result<DisclosureFileInput, DisclosureDecline> {
        let (receiver, field, value) = assignment;
        let fail = || self.fail(value, "File assignment needs original required root input");
        if !calls.is_empty()
            || self.loop_node.is_some()
            || self
                .nodes
                .get(&value)
                .is_none_or(|node| node.kind != SyntaxKind::NameRef)
            || self.types.node_types.get(&value) != Some(&ResolvedType::Scalar(Scalar::File))
        {
            return Err(fail());
        }
        let Some(Binding::Symbol(parameter)) = self.query_binding(value) else {
            return Err(fail());
        };
        let Some(SymbolKind::Param { owner, .. }) = self
            .resolve
            .symbols
            .get(parameter.0 as usize)
            .map(|symbol| &symbol.kind)
        else {
            return Err(fail());
        };
        let parent = self.effects.scenarios.get(owner).ok_or_else(fail)?;
        let param = parent
            .params
            .iter()
            .find(|param| param.param == *parameter)
            .ok_or_else(fail)?;
        let Some(Binding::Symbol(receiver_parameter)) = self.query_binding(receiver) else {
            return Err(fail());
        };
        let field_owner = match self
            .resolve
            .symbols
            .get(field.0 as usize)
            .map(|symbol| &symbol.kind)
        {
            Some(SymbolKind::Field { owner, .. }) => *owner,
            _ => return Err(fail()),
        };
        let declaration = self
            .effects
            .models
            .get(&field_owner)
            .and_then(|model| {
                model
                    .fields
                    .iter()
                    .find(|candidate| candidate.field == field)
            })
            .ok_or_else(fail)?;
        if parent.read
            || parent.on.is_some()
            || parent.cohort.is_some()
            || parent.scope_authority
            || parent.module != module
            || statement.file != parent.node.file
            || statement.start < parent.node.start
            || statement.end > parent.node.end
            || value.file != statement.file
            || value.start < statement.start
            || value.end > statement.end
            || param.default.is_some()
            || !self.direct_builtin_parameter_type(param.type_node, Scalar::File)
            || self.types.symbol_types.get(parameter) != Some(&ResolvedType::Scalar(Scalar::File))
            || self.types.field_reuse_sources.contains_key(parameter)
            || self.types.field_reuse_sources.contains_key(&field)
            || declaration.required_array
            || !env.contains_key(&Local::Symbol(*parameter))
            || !matches!(self.resolve.symbols.get(receiver_parameter.0 as usize).map(|symbol| &symbol.kind),
                Some(SymbolKind::Param { owner: receiver_owner, .. }) if receiver_owner == owner)
            || !parent
                .params
                .iter()
                .any(|param| param.param == *receiver_parameter && param.default.is_none())
        {
            return Err(fail());
        }
        self.source(module, value)?;
        Ok(DisclosureFileInput {
            field,
            parameter: *parameter,
            value,
        })
    }

    fn send(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<(Vec<ValuePath>, Option<ResolvedType>), DisclosureDecline> {
        let node = *self
            .nodes
            .get(&effect.node)
            .ok_or_else(|| self.fail(effect.node, "missing send anchor"))?;
        let text = &self
            .db
            .get(effect.node.file)
            .ok_or_else(|| self.fail(effect.node, "missing send source"))?
            .text;
        // SEND stores `when = expr` as direct statement children, unlike a
        // declaration's Attribute node. Match that original parser shape.
        let parts = super::kids(node);
        let mut authored_when = parts
            .windows(3)
            .filter(|parts| {
                super::is_name(parts[0], text, "when")
                    && super::is_punct(parts[1], text, "=")
                    && expression(parts[2].kind)
            })
            .map(|parts| NodeKey::of(parts[2]));
        let source_when = authored_when.next();
        if node.kind != SyntaxKind::Send
            || authored_when.next().is_some()
            || source_when != effect.when
        {
            return Err(self.fail(effect.node, "checked send source mismatch"));
        }
        if let Some(when) = effect.when {
            // Dispatch happens in the durable Rule lifetime. Retain its exact
            // checked source site without evaluating it as a parent selector:
            // false still yields the original skipped delivery and continues.
            let mut owners = self.effects.scenarios.values().filter(|scenario| {
                scenario.module == module
                    && scenario.node.file == effect.node.file
                    && scenario.node.start <= effect.node.start
                    && effect.node.end <= scenario.node.end
            });
            let owner = owners
                .next()
                .ok_or_else(|| self.fail(when, "missing send dispatch source owner"))?;
            if owners.next().is_some()
                || self.types.node_types.get(&when) != Some(&ResolvedType::Scalar(Scalar::Bool))
            {
                return Err(self.fail(when, "checked Boolean send dispatch required"));
            }
            let sites = self
                .checked_decision_sites(owner)
                .ok_or_else(|| self.fail(when, "missing checked send dispatch source site"))?;
            let mut matching = sites.iter().filter(|site| {
                site.stage == CheckedDecisionStage::SendDispatch && site.statement == effect.node
            });
            let site = matching
                .next()
                .ok_or_else(|| self.fail(when, "missing original send dispatch source site"))?;
            if matching.next().is_some()
                || site.owner != owner.scenario
                || site.node != when
                || site.source != self.source(module, effect.node)?
                || when.file != effect.node.file
                || when.start < effect.node.start
                || when.end > effect.node.end
            {
                return Err(self.fail(when, "send dispatch source correspondence"));
            }
        }
        let target = node
            .children
            .iter()
            .find(|child| expression(child.kind))
            .ok_or_else(|| self.fail(effect.node, "missing send target"))?;
        let (head, member) = if target.kind == SyntaxKind::Member {
            let head = target
                .children
                .iter()
                .find(|child| expression(child.kind))
                .ok_or_else(|| self.fail(effect.node, "missing send import head"))?;
            let member = target
                .children
                .iter()
                .rev()
                .find(|child| child.kind == SyntaxKind::Name)
                .and_then(|child| self.word(child))
                .ok_or_else(|| self.fail(effect.node, "missing send member"))?;
            (head, Some(member))
        } else {
            (target, None)
        };
        if head.kind != SyntaxKind::NameRef {
            return Err(self.fail(effect.node, "unsupported send target head"));
        }
        let alias = self
            .word(head)
            .ok_or_else(|| self.fail(effect.node, "missing send alias"))?;
        let host = self
            .resolve
            .modules
            .get(module.0 as usize)
            .ok_or_else(|| self.fail(effect.node, "missing importing module"))?;
        let imports: Vec<_> = host
            .imports
            .iter()
            .flat_map(|import| {
                import
                    .members
                    .iter()
                    .filter(|item| item.alias == alias)
                    .map(move |item| (import, item))
            })
            .collect();
        if imports.len() > 1 {
            return Err(self.fail(effect.node, "ambiguous send import"));
        }
        let binding = self.types.target_bindings.get(&NodeKey::of(head));
        let (operation, deployment_binding, delivery, input_names) = match binding {
            Some(Binding::External { provider, name }) => {
                let (import, item) = imports
                    .first()
                    .copied()
                    .ok_or_else(|| self.fail(effect.node, "missing external send import"))?;
                if provider != "std"
                    || &import.provider != provider
                    || &item.name != name
                    || import.from.is_none()
                {
                    return Err(self.fail(effect.node, "external send import provenance mismatch"));
                }
                let cap = std_capability(name)
                    .ok_or_else(|| self.fail(effect.node, "unowned external capability"))?;
                let op = member
                    .and_then(|member| std_operation(cap.name, member))
                    .ok_or_else(|| self.fail(effect.node, "unowned external operation"))?;
                (
                    format!("{}.{}", cap.name, op.name),
                    Some(format!("{}.{}", host.name, alias)),
                    ResolvedType::StdDelivery {
                        capability: cap.name,
                        op,
                    },
                    op.inputs
                        .iter()
                        .map(|(name, _)| name.to_string())
                        .collect::<Vec<_>>(),
                )
            }
            _ => {
                let Some(EffectTarget::Operation(id)) = &effect.target else {
                    return Err(self.fail(effect.node, "unsupported send operation"));
                };
                let operation = self
                    .resolve
                    .symbols
                    .get(id.0 as usize)
                    .ok_or_else(|| self.fail(effect.node, "missing send declaration"))?;
                let SymbolKind::CapabilityOp { params, .. } = &operation.kind else {
                    return Err(self.fail(effect.node, "send target is not capability operation"));
                };
                let deployment = if let Some((import, item)) = imports.first().copied() {
                    let Some(Binding::Symbol(head_id)) = binding else {
                        return Err(self.fail(effect.node, "unestablished send import binding"));
                    };
                    let head_symbol = self
                        .resolve
                        .symbols
                        .get(head_id.0 as usize)
                        .ok_or_else(|| self.fail(effect.node, "missing send import declaration"))?;
                    let expected_head = format!("{}.{}", import.provider, item.name);
                    let expected = member
                        .map(|member| format!("{expected_head}.{member}"))
                        .unwrap_or_else(|| expected_head.clone());
                    if head_symbol.canonical != expected_head || operation.canonical != expected {
                        return Err(self.fail(effect.node, "send declaration import mismatch"));
                    }
                    import
                        .from
                        .as_ref()
                        .map(|_| format!("{}.{}", host.name, alias))
                } else {
                    None
                };
                (
                    operation.canonical.clone(),
                    deployment,
                    ResolvedType::Delivery { op: *id },
                    params
                        .iter()
                        .map(|id| self.resolve.symbols[id.0 as usize].name.clone())
                        .collect::<Vec<_>>(),
                )
            }
        };
        let required_inputs = match &delivery {
            ResolvedType::StdDelivery { op, .. } => op
                .inputs
                .iter()
                // Same T14/B9 source rule as types::std_send_requires_input:
                // ordinary std arrays omit to empty in the owning supplier;
                // their required wire key is not an authored binding slot.
                .filter(|(_, declared)| {
                    !declared
                        .strip_suffix('?')
                        .unwrap_or(declared)
                        .ends_with("[]")
                })
                .map(|(name, _)| *name)
                .collect::<Vec<_>>(),
            _ => input_names.iter().map(String::as_str).collect(),
        };
        if required_inputs
            .iter()
            .any(|name| !effect.args.iter().any(|arg| arg.key == *name))
            || effect
                .args
                .iter()
                .any(|arg| !input_names.contains(&arg.key))
        {
            return Err(self.fail(effect.node, "send needs complete checked input slots"));
        }
        let mut seen = HashSet::new();
        let mut paths = vec![ValuePath::default()];
        for arg in &effect.args {
            if !seen.insert(&arg.key) {
                return Err(self.fail(arg.key_node, "duplicate send input"));
            }
            let values = match arg.value {
                Some(value) => self.expr(value, module, env, calls)?,
                None => self.lexical(arg.key_node, module, env, calls)?,
            };
            if values
                .iter()
                .any(|value| value.delivery.is_some() || value.record.is_some())
            {
                return Err(self.fail(arg.key_node, "opaque send input"));
            }
            paths = self.product(effect.node, &paths, &values)?;
        }
        self.proof(
            effect,
            module,
            DisclosureEffectKind::Send {
                operation,
                deployment_binding,
                when: effect.when,
            },
        )?;
        Ok((paths, effect.binding.as_ref().map(|_| delivery)))
    }

    /// Prepare the State-owned child lifetime; only direct cardinality uses of
    /// its exact returned wire can consume the bound result.
    fn static_call(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        if !calls.is_empty() {
            return Err(self.fail(
                effect.node,
                "bound or nested operand call outside source profile",
            ));
        }
        let target_node = effect
            .target_node
            .ok_or_else(|| self.fail(effect.node, "missing checked call operand"))?;
        let Some(EffectTarget::Operation(operation)) = &effect.target else {
            return Err(self.fail(effect.node, "static mutation scenario call required"));
        };
        if self.types.node_types.get(&target_node) != Some(&ResolvedType::Operation(*operation)) {
            return Err(self.fail(effect.node, "checked static call target mismatch"));
        }
        let child = self
            .effects
            .scenarios
            .get(operation)
            .ok_or_else(|| self.fail(effect.node, "call target is not a mutation scenario"))?
            .clone();
        if child.read && child.on.is_none() {
            return self.query_child_call(effect, module, env, calls, &child, *operation);
        }
        let child_model = self.complete_model_children.get(operation).copied();
        if (effect.binding.is_some() && child_model.is_none()) || child.on.is_some() {
            return Err(self.fail(
                effect.node,
                "read or trusted child call outside source profile",
            ));
        }
        let signature = self
            .types
            .symbol_results
            .get(operation)
            .ok_or_else(|| self.fail(effect.node, "missing child result signature"))?;
        if (signature.as_ref().is_some_and(|ty| !primitive_type(ty)) && child_model.is_none())
            || self.types.effect_call_results.get(&effect.node) != Some(signature)
        {
            return Err(self.fail(effect.node, "unsupported or mismatched child result"));
        }
        if !self.complete_children.contains(operation) {
            return Err(self.fail(effect.node, "child needs complete acyclic source closure"));
        }
        if effect.args.len() != child.params.len() || child.params.len() > 200 {
            return Err(self.fail(effect.node, "call requires complete scalar authored inputs"));
        }
        let mut slots = HashMap::new();
        for parameter in &child.params {
            let ty = self
                .types
                .symbol_types
                .get(&parameter.param)
                .ok_or_else(|| self.fail(effect.node, "missing child input type"))?;
            let ResolvedType::Scalar(scalar) = ty else {
                return Err(self.fail(
                    effect.node,
                    "child reference or composite input outside source profile",
                ));
            };
            if !primitive_type(ty)
                || !self.explicit_scalar_call_parameter(parameter, child.module, *scalar)
            {
                return Err(self.fail(
                    effect.node,
                    "child input needs explicit checked scalar declaration",
                ));
            }
            let declaration = self
                .resolve
                .symbols
                .get(parameter.param.0 as usize)
                .ok_or_else(|| self.fail(effect.node, "missing child parameter identity"))?;
            slots.insert(declaration.name.clone(), ty.clone());
        }
        let mut keys = Vec::new();
        let mut paths = vec![ValuePath::default()];
        for argument in &effect.args {
            let expected = slots
                .get(&argument.key)
                .ok_or_else(|| self.fail(argument.key_node, "unowned child input"))?;
            if keys.contains(&argument.key) {
                return Err(self.fail(argument.key_node, "duplicate child input"));
            }
            let key = argument.value.unwrap_or(argument.key_node);
            if self.types.node_types.get(&key) != Some(expected) {
                return Err(self.fail(key, "child input lacks exact checked scalar type"));
            }
            let values = match argument.value {
                Some(value) => self.expr(value, module, env, calls)?,
                None => self.lexical(argument.key_node, module, env, calls)?,
            };
            if values.iter().any(|value| {
                value.record.is_some() || value.delivery.is_some() || value.members.is_some()
            }) {
                return Err(self.fail(key, "opaque child input provenance"));
            }
            paths = self.product(effect.node, &paths, &values)?;
            keys.push(argument.key.clone());
        }
        self.proof(
            effect,
            module,
            DisclosureEffectKind::Call {
                operation: *operation,
                input_keys: keys,
            },
        )?;
        if let Some(model) = child_model
            && effect.binding.is_some()
        {
            for path in &mut paths {
                path.record = Some(model);
                path.model_result = Some(DisclosureModelResult::Call {
                    model,
                    node: effect.node,
                    operation: *operation,
                });
            }
        }
        Ok(paths)
    }

    /// Original caller parameters, or their exact one-parent reference fields,
    /// prepare this finite read child. Keep actual source reads separately from
    /// candidate dependencies in the child's query lifetime.
    fn query_child_call(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
        child: &super::effects::ScenarioData,
        operation: SymbolId,
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        if !self.complete_children.contains(&operation) || self.complete_query(child)?.is_none() {
            return Err(self.fail(
                effect.node,
                "read child needs complete acyclic finite query closure",
            ));
        }
        if self.types.effect_call_results.get(&effect.node)
            != self.types.symbol_results.get(&operation)
            || effect.args.len() != child.params.len()
        {
            return Err(self.fail(effect.node, "read child result or input signature mismatch"));
        }
        let mut keys = Vec::new();
        let mut parent_owner = None;
        let mut evaluated = ValuePath::default();
        for argument in &effect.args {
            let parameter = child
                .params
                .iter()
                .find(|parameter| {
                    self.resolve
                        .symbols
                        .get(parameter.param.0 as usize)
                        .is_some_and(|symbol| symbol.name == argument.key)
                })
                .ok_or_else(|| self.fail(argument.key_node, "unowned query child input"))?;
            if keys.contains(&argument.key) || parameter.default.is_some() {
                return Err(self.fail(
                    argument.key_node,
                    "query child needs explicit unique inputs",
                ));
            }
            let key = argument.value.unwrap_or(argument.key_node);
            let member = self
                .nodes
                .get(&key)
                .is_some_and(|node| node.kind == SyntaxKind::Member);
            let (input, source_field) = if member {
                let values = self.expr(key, module, env, calls)?;
                if values.len() != 1 {
                    return Err(self.fail(key, "query child reference operand path mismatch"));
                }
                let value = &values[0];
                let Some(ReferenceOrigin::Field {
                    parameter,
                    model,
                    field,
                }) = value.reference_origin
                else {
                    return Err(
                        self.fail(key, "query child needs exact original parent field operand")
                    );
                };
                if value.reads.len() != 2
                    || !value
                        .reads
                        .iter()
                        .any(|read| read.model == model && read.field == field)
                {
                    return Err(self.fail(key, "query child parent field source mismatch"));
                }
                evaluated.join(value);
                (parameter, Some(field))
            } else {
                let Some(Binding::Symbol(input)) = self.query_binding(key) else {
                    return Err(
                        self.fail(key, "query child needs original caller parameter operand")
                    );
                };
                (*input, None)
            };
            let Some(SymbolKind::Param { owner, .. }) = self
                .resolve
                .symbols
                .get(input.0 as usize)
                .map(|symbol| &symbol.kind)
            else {
                return Err(self.fail(
                    key,
                    "query child rejects copied or computed reference operands",
                ));
            };
            let owner = *owner;
            let parent =
                self.effects.scenarios.get(&owner).ok_or_else(|| {
                    self.fail(key, "query child input lacks owning parent scenario")
                })?;
            if parent.read
                || parent.on.is_some()
                || parent.cohort.is_some()
                || parent.scope_authority
                || parent.module != module
                || effect.node.file != parent.node.file
                || effect.node.start < parent.node.start
                || effect.node.end > parent.node.end
                || parent_owner.is_some_and(|previous| previous != owner)
                || !parent
                    .params
                    .iter()
                    .any(|param| param.param == input && param.default.is_none())
            {
                return Err(self.fail(
                    key,
                    "query child input needs same original nondefault parent",
                ));
            }
            let expected = self
                .types
                .symbol_types
                .get(&parameter.param)
                .ok_or_else(|| self.fail(key, "missing query child input type"))?;
            if self.types.node_types.get(&key) != Some(expected)
                || (source_field.is_none() && self.types.symbol_types.get(&input) != Some(expected))
            {
                return Err(self.fail(key, "query child input needs exact owning checked type"));
            }
            match expected {
                ResolvedType::Record { stored: true, .. } => {}
                ResolvedType::Array { .. }
                    if source_field.map_or_else(
                        || {
                            self.query_parameter_bounds(input).is_some()
                                && self.query_parameter_bounds(input)
                                    == self.query_parameter_bounds(parameter.param)
                        },
                        |field| self.reference_field_bounds(field, parameter.param),
                    ) => {}
                _ => {
                    return Err(self.fail(
                        key,
                        "query child input lacks exact protected reference or array owner",
                    ));
                }
            }
            parent_owner = Some(owner);
            keys.push(argument.key.clone());
        }
        self.proof(
            effect,
            module,
            DisclosureEffectKind::Call {
                operation,
                input_keys: keys,
            },
        )?;
        evaluated.query_child = Some(operation);
        Ok(vec![evaluated])
    }

    fn transition(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let node = *self
            .nodes
            .get(&effect.node)
            .ok_or_else(|| self.fail(effect.node, "missing transition anchor"))?;
        if node.kind != SyntaxKind::Transition || !effect.args.is_empty() {
            return Err(self.fail(effect.node, "unsupported transition shape"));
        }
        let mut receivers = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Path);
        let receiver = receivers
            .next()
            .ok_or_else(|| self.fail(effect.node, "missing transition receiver"))?;
        if receivers.next().is_some()
            || receiver
                .children
                .iter()
                .filter(|child| child.kind == SyntaxKind::Name)
                .count()
                != 1
        {
            return Err(self.fail(effect.node, "transition needs immutable direct receiver"));
        }
        let receiver_key = NodeKey::of(receiver);
        let model = match self.types.node_types.get(&receiver_key) {
            Some(ResolvedType::Record {
                symbol,
                stored: true,
            }) => *symbol,
            Some(ResolvedType::Nullable(_)) => {
                return Err(self.influence(
                    effect.node,
                    module,
                    &[InfluenceKind::AbsentReference],
                    "nullable transition receiver",
                ));
            }
            _ => return Err(self.fail(effect.node, "unestablished transition receiver type")),
        };
        if !matches!(effect.target, Some(EffectTarget::Record { model: Some(target) }) if target == model)
        {
            return Err(self.fail(effect.node, "transition checked target mismatch"));
        }
        let names: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Name)
            .collect();
        if names.len() != 4 {
            return Err(self.fail(effect.node, "missing transition literal endpoints"));
        }
        let word = |node: &SyntaxNode| {
            self.db.get(node.span.file).and_then(|source| {
                source
                    .text
                    .get(node.span.start as usize..node.span.end as usize)
            })
        };
        let field_name = word(names[1])
            .ok_or_else(|| self.fail(effect.node, "missing transition field spelling"))?;
        let from =
            word(names[2]).ok_or_else(|| self.fail(effect.node, "missing transition from case"))?;
        let to =
            word(names[3]).ok_or_else(|| self.fail(effect.node, "missing transition to case"))?;
        let owner = self
            .resolve
            .symbols
            .get(model.0 as usize)
            .ok_or_else(|| self.fail(effect.node, "missing transition model"))?;
        let SymbolKind::Model { fields, .. } = &owner.kind else {
            return Err(self.fail(effect.node, "non-model transition owner"));
        };
        let field = fields
            .iter()
            .filter_map(|id| self.resolve.symbols.get(id.0 as usize))
            .find(|field| field.name == field_name)
            .ok_or_else(|| self.fail(effect.node, "missing transition field"))?;
        if !matches!(field.kind, SymbolKind::Field { owner, .. } if owner == model) {
            return Err(self.fail(effect.node, "nonstored transition field"));
        }
        let declaration = self
            .effects
            .models
            .get(&model)
            .and_then(|owner| owner.fields.iter().find(|decl| decl.field == field.id))
            .ok_or_else(|| self.fail(effect.node, "missing checked machine declaration"))?;
        if declaration.default.is_none()
            || !declaration
                .modifiers
                .iter()
                .any(|modifier| modifier.name == "machine" && modifier.value.is_none())
        {
            return Err(self.fail(effect.node, "unestablished checked machine"));
        }
        let ty = self
            .types
            .symbol_types
            .get(&field.id)
            .ok_or_else(|| self.fail(effect.node, "missing checked machine type"))?;
        let ResolvedType::Enum { cases, .. } = ty else {
            return Err(self.fail(effect.node, "machine needs scalar enum"));
        };
        if !cases.iter().any(|case| case == from) || !cases.iter().any(|case| case == to) {
            return Err(self.fail(effect.node, "unestablished machine endpoints"));
        }
        let read = DisclosureDependency {
            id: self.opaque(
                "transition-control",
                effect.node,
                &format!(
                    "{}:{}:{}:{}",
                    field.canonical,
                    from,
                    to,
                    self.call_stamp(calls)?
                ),
            )?,
            source: self.source(module, effect.node)?,
            node: effect.node,
            calls: calls.to_vec(),
            role: DependencyRole::Control,
            model,
            field: field.id,
            model_name: owner.canonical.clone(),
            field_name: field.name.clone(),
            ty: ty.clone(),
            type_id: self.field_type_id(effect.node, field.id, ty)?,
        };
        let mut paths = self.expr(receiver_key, module, env, calls)?;
        for value in &mut paths {
            if value.record != Some(model) {
                return Err(self.fail(effect.node, "transition receiver closure mismatch"));
            }
            *value = self.control(value.clone())?;
            value.reads.push(read.clone());
            value.observed.push((effect.node, calls.to_vec()));
            value.record = None;
        }
        Ok(paths)
    }

    fn return_path(
        &self,
        node: NodeKey,
        module: ModuleId,
        flow: Flow,
        value: ValuePath,
    ) -> Result<DisclosureReturn, DisclosureDecline> {
        let mut merged = flow.controls;
        merged.join(&flow.writes);
        merged.join(&value);
        let mut observed = flow.observed;
        for read in &value.observed {
            if !observed.contains(read) {
                observed.push(read.clone());
            }
        }
        merged.reads.sort_by_key(|read| {
            observed
                .iter()
                .position(|entry| entry.0 == read.node && entry.1 == read.calls)
                .unwrap_or(usize::MAX)
        });
        merged.intrinsics.sort_by_key(|intrinsic| {
            observed
                .iter()
                .position(|entry| entry.0 == intrinsic.node && entry.1 == intrinsic.calls)
                .unwrap_or(usize::MAX)
        });
        if merged
            .reads
            .len()
            .saturating_add(merged.intrinsics.len())
            .saturating_add(flow.repeated_observations)
            > 200
        {
            return Err(self.fail(node, "return dependency bound"));
        }
        let mut decisions = flow.evaluated;
        for decision in merged.decisions {
            if !decisions.contains(&decision) {
                decisions.push(decision);
            }
        }
        merged.decisions = decisions;
        Ok(DisclosureReturn {
            id: String::new(),
            source: self.source(module, node)?,
            node,
            decisions: merged.decisions,
            dependencies: merged.reads,
            intrinsics: merged.intrinsics,
            influences: Vec::new(),
            model_result: value.model_result,
        })
    }

    /// One bounded, straight-line loop over the actual admitted reference
    /// array. This is source closure, not an array/query authority claim.
    fn bounded_input_loop(
        &mut self,
        effect: &Effect,
        module: ModuleId,
        flow: Flow,
        calls: &[NodeKey],
    ) -> Result<Vec<Flow>, DisclosureDecline> {
        if !calls.is_empty()
            || self.loop_node.is_some_and(|node| node != effect.node)
            || !effect.else_effects.is_empty()
            || !effect.match_arms.is_empty()
            || effect.then_effects.is_empty()
            || effect.then_effects.len() > 200
            || effect.then_effects.iter().any(|child| {
                child.verb != EffectVerb::Set
                    || !child.then_effects.is_empty()
                    || !child.else_effects.is_empty()
                    || !child.match_arms.is_empty()
            })
        {
            return Err(self.fail(effect.node, "unsupported bounded loop body"));
        }
        let mut domain = effect
            .domain
            .ok_or_else(|| self.fail(effect.node, "missing loop domain"))?;
        for _ in 0..65 {
            let node = self
                .nodes
                .get(&domain)
                .ok_or_else(|| self.fail(domain, "missing loop domain anchor"))?;
            if node.kind != SyntaxKind::Group {
                break;
            }
            let children: Vec<_> = node
                .children
                .iter()
                .filter(|child| expression(child.kind))
                .collect();
            if children.len() != 1 {
                return Err(self.fail(domain, "unsupported grouped loop domain"));
            }
            domain = NodeKey::of(children[0]);
        }
        let node = self
            .nodes
            .get(&domain)
            .ok_or_else(|| self.fail(domain, "missing loop domain"))?;
        if node.kind != SyntaxKind::NameRef {
            return Err(self.fail(domain, "loop needs direct admitted array input"));
        }
        let binding = self.resolve.node_binding.get(&domain).or_else(|| {
            node.children
                .iter()
                .find_map(|child| self.resolve.node_binding.get(&NodeKey::of(child)))
        });
        let Some(Binding::Symbol(parameter)) = binding else {
            return Err(self.fail(domain, "unestablished loop input"));
        };
        let parameter = *parameter;
        let declared = self
            .resolve
            .symbols
            .get(parameter.0 as usize)
            .ok_or_else(|| self.fail(domain, "missing loop parameter"))?;
        let SymbolKind::Param { owner, .. } = declared.kind else {
            return Err(self.fail(domain, "loop domain is not a parameter"));
        };
        let scenario = self
            .effects
            .scenarios
            .get(&owner)
            .ok_or_else(|| self.fail(domain, "loop domain is not a scenario input"))?;
        if declared.module != module
            || !flow.env.contains_key(&Local::Symbol(parameter))
            || scenario
                .params
                .iter()
                .find(|param| param.param == parameter)
                .is_none_or(|param| param.default.is_some())
        {
            return Err(self.fail(domain, "loop needs original admitted array input"));
        }
        let Some(ResolvedType::Array { element, .. }) = self.types.symbol_types.get(&parameter)
        else {
            return Err(self.fail(domain, "loop needs nonnullable stored-reference array"));
        };
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = element.as_ref()
        else {
            return Err(self.fail(domain, "loop needs stored-reference elements"));
        };
        let model = *model;
        if self.types.node_types.get(&domain) != self.types.symbol_types.get(&parameter)
            || !matches!(self.resolve.symbols.get(model.0 as usize), Some(symbol) if symbol.module == module && matches!(symbol.kind, SymbolKind::Model {..}))
        {
            return Err(self.fail(domain, "loop stored model correspondence"));
        }
        let limit = effect
            .limit
            .ok_or_else(|| self.fail(effect.node, "loop needs literal finite limit"))?;
        let limit_node = self
            .nodes
            .get(&limit)
            .ok_or_else(|| self.fail(limit, "missing loop limit"))?;
        let maximum = self
            .db
            .get(limit.file)
            .and_then(|file| file.text.get(limit.start as usize..limit.end as usize))
            .and_then(|text| text.trim().parse::<u16>().ok());
        let Some(maximum) = maximum.filter(|maximum| (1..=200).contains(maximum)) else {
            return Err(self.fail(limit, "loop limit exceeds observation bound"));
        };
        if limit_node.kind != SyntaxKind::Literal
            || self.types.node_types.get(&limit) != Some(&ResolvedType::Scalar(Scalar::Int))
        {
            return Err(self.fail(limit, "loop needs typed literal limit"));
        }
        if usize::from(maximum).saturating_mul(effect.then_effects.len()) > 200 {
            return Err(self.fail(effect.node, "loop Set execution bound"));
        }
        let item = effect
            .item
            .clone()
            .ok_or_else(|| self.fail(effect.node, "missing loop item binding"))?;
        self.loop_node = Some(effect.node);
        let mut env = flow.env.clone();
        env.insert(
            Local::For(effect.node),
            ValuePath {
                record: Some(model),
                ..ValuePath::default()
            },
        );
        let mut body = ValuePath::default();
        for child in &effect.then_effects {
            let node = self
                .nodes
                .get(&child.node)
                .ok_or_else(|| self.fail(child.node, "missing loop Set"))?;
            let receiver = node
                .children
                .iter()
                .find(|node| node.kind == SyntaxKind::Path)
                .ok_or_else(|| self.fail(child.node, "missing loop Set receiver"))?;
            let receiver_binding = self
                .resolve
                .node_binding
                .get(&NodeKey::of(receiver))
                .or_else(|| {
                    receiver
                        .children
                        .iter()
                        .find_map(|node| self.resolve.node_binding.get(&NodeKey::of(node)))
                });
            if !matches!(receiver_binding, Some(Binding::ForItem {node}) if *node == effect.node) {
                return Err(self.fail(child.node, "loop Set must target its exact item"));
            }
            let mut pending = vec![*node];
            let mut visits = 0usize;
            while let Some(part) = pending.pop() {
                visits += 1;
                if visits > 4096 || matches!(part.kind, SyntaxKind::Call | SyntaxKind::Query) {
                    return Err(self.fail(child.node, "unsupported per-element expression"));
                }
                if part.kind == SyntaxKind::Member {
                    let mut base = part
                        .children
                        .iter()
                        .find(|child| expression(child.kind))
                        .ok_or_else(|| self.fail(child.node, "missing loop field receiver"))?;
                    for _ in 0..65 {
                        if base.kind != SyntaxKind::Group {
                            break;
                        }
                        base = base
                            .children
                            .iter()
                            .find(|child| expression(child.kind))
                            .ok_or_else(|| {
                                self.fail(child.node, "missing grouped loop receiver")
                            })?;
                    }
                    let binding = self
                        .resolve
                        .node_binding
                        .get(&NodeKey::of(base))
                        .or_else(|| {
                            base.children.iter().find_map(|child| {
                                self.resolve.node_binding.get(&NodeKey::of(child))
                            })
                        });
                    if base.kind != SyntaxKind::NameRef
                        || !matches!(binding, Some(Binding::ForItem {node}) if *node == effect.node)
                    {
                        return Err(self.fail(child.node, "loop field must read its exact item"));
                    }
                }
                pending.extend(part.children.iter());
            }
            let mut alternatives = self.set(child, module, &env, calls)?;
            if alternatives.len() != 1 {
                return Err(self.fail(child.node, "per-element loop alternatives unsupported"));
            }
            let value = alternatives
                .pop()
                .ok_or_else(|| self.fail(child.node, "missing loop body alternative"))?;
            if !value.decisions.is_empty() || !value.intrinsics.is_empty() {
                return Err(self.fail(
                    child.node,
                    "per-element loop decisions or intrinsics unsupported",
                ));
            }
            body.join(&value);
        }
        let repeated = (usize::from(maximum) - 1).saturating_mul(body.reads.len());
        if body.reads.len().saturating_add(repeated) > 200 {
            return Err(self.fail(effect.node, "loop observation bound"));
        }
        self.proof(
            effect,
            module,
            DisclosureEffectKind::For {
                domain,
                limit,
                maximum,
                item,
                parameter,
                model,
                body: effect.then_effects.iter().map(|child| child.node).collect(),
            },
        )?;
        let mut empty = flow.clone();
        empty.writes.join(&empty.controls);
        empty.evaluated.push(DisclosureDecision {
            node: effect.node,
            calls: Vec::new(),
            choice: DisclosureChoice::Else,
        });
        let mut populated = flow;
        populated.evaluated.push(DisclosureDecision {
            node: effect.node,
            calls: Vec::new(),
            choice: DisclosureChoice::Then,
        });
        populated.executed_effect = true;
        populated.writes.join(&populated.controls);
        populated.writes.join(&populated.effect_guards);
        populated.writes.join(&body);
        populated.repeated_observations = populated.repeated_observations.saturating_add(repeated);
        for read in body.observed {
            if !populated.observed.contains(&read) {
                populated.observed.push(read);
            }
        }
        if populated
            .writes
            .reads
            .len()
            .saturating_add(populated.writes.intrinsics.len())
            .saturating_add(populated.repeated_observations)
            > 200
        {
            return Err(self.fail(effect.node, "loop total observation bound"));
        }
        self.effect_visits += 1;
        Ok(vec![empty, populated])
    }

    fn statements(
        &mut self,
        effects: &[Effect],
        module: ModuleId,
        flows: Vec<Flow>,
        calls: &[NodeKey],
    ) -> Result<(Vec<Flow>, Vec<DisclosureReturn>), DisclosureDecline> {
        let Some(anchor) = effects.first().map(|effect| effect.node) else {
            return Ok((flows, Vec::new()));
        };
        if self.statement_depth >= 64 {
            return Err(self.fail(anchor, "statement closure depth bound"));
        }
        self.statement_depth += 1;
        let result = self.statements_inner(effects, module, flows, calls);
        self.statement_depth -= 1;
        result
    }

    fn statements_inner(
        &mut self,
        effects: &[Effect],
        module: ModuleId,
        mut flows: Vec<Flow>,
        calls: &[NodeKey],
    ) -> Result<(Vec<Flow>, Vec<DisclosureReturn>), DisclosureDecline> {
        if let Some(created) = effects
            .iter()
            .find(|effect| effect.verb == EffectVerb::Create)
        {
            let direct_model_return = self.result_model.is_some_and(|model| {
                effects.len() >= 2
                    && effects.get(effects.len() - 2).map(|effect| effect.node) == Some(created.node)
                    && effects[..effects.len() - 2].iter().all(|effect| matches!(effect.verb, EffectVerb::Let | EffectVerb::Require))
                    && matches!(created.target, Some(EffectTarget::Model(actual)) if actual == model)
                    && effects.last().is_some_and(|returned| {
                        returned.verb == EffectVerb::Return
                            && returned.value.is_some_and(|key| {
                                matches!(self.query_binding(key), Some(Binding::CreateAs {node}) if *node == created.node)
                                    && self.query_group(key).is_some_and(|key| {
                                        self.types.node_types.get(&key) == Some(&ResolvedType::Record {symbol: model, stored: true})
                                    })
                            })
                    })
                    && effects.iter().all(|effect| effect.then_effects.is_empty()
                        && effect.else_effects.is_empty() && effect.match_arms.is_empty())
            });
            if !direct_model_return {
                // Keep this admission tied to the original straight-line created
                // row workflow. Existing late requirements may reject both stages.
                let fail = || {
                    self.fail(
                        created.node,
                        "create then set/current-field return profile required",
                    )
                };
                let Some(set) = effects.get(1) else {
                    return Err(fail());
                };
                let Some(returned) = effects.last() else {
                    return Err(fail());
                };
                if effects.first().map(|effect| effect.node) != Some(created.node)
                    || effects.len() < 3
                    || set.verb != EffectVerb::Set
                    || returned.verb != EffectVerb::Return
                    || effects[2..effects.len() - 1]
                        .iter()
                        .any(|effect| effect.verb != EffectVerb::Require)
                    || effects.iter().any(|effect| {
                        !effect.then_effects.is_empty()
                            || !effect.else_effects.is_empty()
                            || !effect.match_arms.is_empty()
                    })
                {
                    return Err(fail());
                }
                let receiver = self
                    .nodes
                    .get(&set.node)
                    .and_then(|node| {
                        node.children
                            .iter()
                            .find(|child| child.kind == SyntaxKind::Path)
                    })
                    .ok_or_else(fail)?;
                let value = returned
                    .value
                    .and_then(|key| self.nodes.get(&key))
                    .ok_or_else(fail)?;
                let base = value
                    .children
                    .iter()
                    .find(|child| expression(child.kind))
                    .ok_or_else(fail)?;
                if value.kind != SyntaxKind::Member
                    || !matches!(self.query_binding(NodeKey::of(receiver)), Some(Binding::CreateAs {node}) if *node == created.node)
                    || !matches!(self.query_binding(NodeKey::of(base)), Some(Binding::CreateAs {node}) if *node == created.node)
                    || self.types.node_types.get(&NodeKey::of(value))
                        != Some(&ResolvedType::Scalar(Scalar::Int))
                {
                    return Err(fail());
                }
            }
        }
        let mut returns = Vec::new();
        for effect in effects {
            self.steps += 1;
            if self.steps > 16384 {
                return Err(self.fail(effect.node, "statement closure item bound"));
            }
            let mut next = Vec::new();
            for flow in flows {
                match effect.verb {
                    EffectVerb::Create => {
                        let (model, inputs) = self.create(effect, module, &flow.env, calls)?;
                        self.effect_visits += 1;
                        for input in inputs {
                            let mut path = flow.clone();
                            path.executed_effect = true;
                            path.writes.join(&path.effect_guards);
                            path.writes.join(&path.controls);
                            path.writes.join(&input);
                            path.env.insert(
                                Local::Create(effect.node),
                                ValuePath {
                                    record: Some(model),
                                    model_result: Some(DisclosureModelResult::Create {
                                        model,
                                        node: effect.node,
                                    }),
                                    ..ValuePath::default()
                                },
                            );
                            if path.env.len() > 256 {
                                return Err(self.fail(effect.node, "binding closure bound"));
                            }
                            next.push(path);
                        }
                    }
                    EffectVerb::Delete => {
                        // Only the original terminal archive with implicit void;
                        // no post-delete read or scalar disclosure is introduced.
                        if effects.len() != 1 || !returns.is_empty() {
                            return Err(self.fail(
                                effect.node,
                                "terminal implicit-void archive profile required",
                            ));
                        }
                        self.delete(effect, module, &flow.env, calls)?;
                        self.effect_visits += 1;
                        let mut path = flow;
                        path.executed_effect = true;
                        path.writes.join(&path.effect_guards);
                        path.writes.join(&path.controls);
                        next.push(path);
                    }
                    EffectVerb::Let => {
                        let value = effect.value.ok_or_else(|| {
                            self.fail(effect.node, "missing immutable initializer")
                        })?;
                        for evaluated in self.expr(value, module, &flow.env, calls)? {
                            if matches!(
                                evaluated.reference_origin,
                                Some(
                                    ReferenceOrigin::Parent { .. } | ReferenceOrigin::Field { .. }
                                )
                            ) {
                                return Err(
                                    self.fail(value, "stored reference operand cannot be copied")
                                );
                            }
                            if !compatible(&flow.evaluated, &evaluated.decisions) {
                                continue;
                            }
                            let mut path = flow.clone();
                            for read in &evaluated.observed {
                                if !path.observed.contains(read) {
                                    path.observed.push(read.clone());
                                }
                            }
                            for decision in &evaluated.decisions {
                                if !path.evaluated.contains(decision) {
                                    path.evaluated.push(decision.clone());
                                }
                            }
                            path.env.insert(Local::Let(effect.node), evaluated);
                            if path.env.len() > 256 {
                                return Err(self.fail(effect.node, "binding closure bound"));
                            }
                            next.push(path);
                            if next.len() > 1024 {
                                return Err(self.fail(effect.node, "statement path bound"));
                            }
                        }
                    }
                    EffectVerb::Require => {
                        let cond = effect
                            .cond
                            .ok_or_else(|| self.fail(effect.node, "missing checked requirement"))?;
                        let alternatives =
                            self.authorization_expr(cond, module, &flow.env, calls)?;
                        // Preserve independent-return authorization pruning. Required
                        // supported intrinsic guard values control successful effects,
                        // while stored guard reads retain their existing policy.
                        for value in alternatives {
                            if !compatible(&flow.evaluated, &value.decisions) {
                                continue;
                            }
                            let mut path = flow.clone();
                            // The new finite reference operand retains whole
                            // source-field authority even on a scalar return.
                            // Ordinary scalar/Contract guard pruning is unchanged.
                            path.controls.join(
                                &self.control(ValuePath {
                                    reads: value
                                        .reads
                                        .iter()
                                        .filter(|dependency| {
                                            self.reference_operand_type_id(&dependency.ty).is_some()
                                        })
                                        .cloned()
                                        .collect(),
                                    ..ValuePath::default()
                                })?,
                            );
                            let admitted_guard = self.control(ValuePath {
                                intrinsics: value.intrinsics.clone(),
                                // Whole canonical Contract/reference-field
                                // authority belongs to the successful guard,
                                // including void/effect returns. Keep existing
                                // ordinary scalar authorization pruning.
                                reads: value.reads.iter().filter(|dependency| {
                                    matches!(&dependency.ty, ResolvedType::Record {symbol,..}
                                        if self.resolve.symbols.get(symbol.0 as usize)
                                            .is_some_and(|symbol| matches!(symbol.kind, SymbolKind::Contract { .. })))
                                        || self.reference_operand_type_id(&dependency.ty).is_some()
                                }).cloned().collect(),
                                ..ValuePath::default()
                            })?;
                            path.effect_guards.join(&admitted_guard);
                            if path.executed_effect {
                                path.writes.join(&admitted_guard);
                            }
                            for read in &value.observed {
                                if !path.observed.contains(read) {
                                    path.observed.push(read.clone());
                                }
                            }
                            for decision in value.decisions {
                                if !path.evaluated.contains(&decision) {
                                    path.evaluated.push(decision);
                                }
                            }
                            next.push(path);
                            if next.len() > 1024 {
                                return Err(self.fail(effect.node, "statement path bound"));
                            }
                        }
                    }
                    EffectVerb::Set | EffectVerb::Send | EffectVerb::Call => {
                        let (alternatives, delivery) = if effect.verb == EffectVerb::Set {
                            (self.set(effect, module, &flow.env, calls)?, None)
                        } else if effect.verb == EffectVerb::Send {
                            self.send(effect, module, &flow.env, calls)?
                        } else {
                            (self.static_call(effect, module, &flow.env, calls)?, None)
                        };
                        self.effect_visits += 1;
                        for evaluated in alternatives {
                            if !compatible(&flow.evaluated, &evaluated.decisions) {
                                continue;
                            }
                            let mut path = flow.clone();
                            path.executed_effect = true;
                            path.writes.join(&flow.effect_guards);
                            path.writes.join(&flow.controls);
                            path.writes.join(&evaluated);
                            if path.writes.reads.len() + path.writes.intrinsics.len() > 200 {
                                return Err(self.fail(effect.node, "effect write dependency bound"));
                            }
                            for read in &evaluated.observed {
                                if !path.observed.contains(read) {
                                    path.observed.push(read.clone());
                                }
                            }
                            for decision in &evaluated.decisions {
                                if !path.evaluated.contains(decision) {
                                    path.evaluated.push(decision.clone());
                                }
                            }
                            if let Some(delivery) = &delivery {
                                path.env.insert(
                                    Local::Send(effect.node),
                                    ValuePath {
                                        delivery: Some(delivery.clone()),
                                        ..ValuePath::default()
                                    },
                                );
                                if path.env.len() > 256 {
                                    return Err(self.fail(effect.node, "binding closure bound"));
                                }
                            }
                            if effect.verb == EffectVerb::Call
                                && effect.binding.is_some()
                                && (evaluated.query_child.is_some()
                                    || evaluated.model_result.is_some())
                            {
                                path.env.insert(Local::Call(effect.node), evaluated.clone());
                                if path.env.len() > 256 {
                                    return Err(self.fail(effect.node, "binding closure bound"));
                                }
                            }
                            next.push(path);
                            if next.len() > 1024 {
                                return Err(self.fail(effect.node, "effect evaluation path bound"));
                            }
                        }
                    }
                    EffectVerb::Transition => {
                        self.effect_visits += 1;
                        for write in self.transition(effect, module, &flow.env, calls)? {
                            if !compatible(&flow.evaluated, &write.decisions) {
                                continue;
                            }
                            let mut path = flow.clone();
                            path.executed_effect = true;
                            path.writes.join(&flow.effect_guards);
                            path.writes.join(&flow.controls);
                            path.writes.join(&write);
                            if path.writes.reads.len() + path.writes.intrinsics.len() > 200 {
                                return Err(
                                    self.fail(effect.node, "transition write dependency bound")
                                );
                            }
                            for observed in &write.observed {
                                if !path.observed.contains(observed) {
                                    path.observed.push(observed.clone());
                                }
                            }
                            for decision in &write.decisions {
                                if !path.evaluated.contains(decision) {
                                    path.evaluated.push(decision.clone());
                                }
                            }
                            next.push(path);
                            if next.len() > 1024 {
                                return Err(self.fail(effect.node, "transition path bound"));
                            }
                        }
                    }
                    EffectVerb::Return => {
                        let values = match effect.value {
                            Some(key)
                                if matches!(
                                    self.query_binding(key),
                                    Some(Binding::CallAs { .. })
                                ) && self.result_model.is_some() =>
                            {
                                let Some(Binding::CallAs { node }) = self.query_binding(key) else {
                                    unreachable!();
                                };
                                let value = flow
                                    .env
                                    .get(&Local::Call(*node))
                                    .filter(|value| {
                                        value.model_result.is_some_and(|origin| {
                                            Some(origin.model()) == self.result_model
                                        })
                                    })
                                    .cloned()
                                    .ok_or_else(|| {
                                        self.fail(
                                            key,
                                            "direct child model result provenance required",
                                        )
                                    })?;
                                if self.types.node_types.get(&self.query_group(key).ok_or_else(
                                    || self.fail(key, "missing direct result operand"),
                                )?) != Some(&ResolvedType::Record {
                                    symbol: self.result_model.unwrap(),
                                    stored: true,
                                }) {
                                    return Err(
                                        self.fail(key, "direct child model result type mismatch")
                                    );
                                }
                                vec![value]
                            }
                            Some(key) => self.expr(key, module, &flow.env, calls)?,
                            None => vec![ValuePath::default()],
                        };
                        for value in values {
                            if let Some(model) = self.result_model {
                                let direct = effect.value.and_then(|key| self.query_binding(key));
                                let matches = match (direct, value.model_result) {
                                    (
                                        Some(Binding::CreateAs { node }),
                                        Some(DisclosureModelResult::Create {
                                            model: actual,
                                            node: producer,
                                        }),
                                    )
                                    | (
                                        Some(Binding::CallAs { node }),
                                        Some(DisclosureModelResult::Call {
                                            model: actual,
                                            node: producer,
                                            ..
                                        }),
                                    ) => *node == producer && model == actual,
                                    _ => false,
                                };
                                if !matches {
                                    return Err(self.fail(
                                        effect.node,
                                        "direct newly-created model result required",
                                    ));
                                }
                            }
                            if !compatible(&flow.evaluated, &value.decisions) {
                                continue;
                            }
                            returns.push(self.return_path(
                                effect.node,
                                module,
                                flow.clone(),
                                value,
                            )?);
                            if returns.len() > 1024 {
                                return Err(self.fail(effect.node, "return path bound"));
                            }
                        }
                    }
                    EffectVerb::If | EffectVerb::Match => {
                        let subject = if effect.verb == EffectVerb::If {
                            effect.cond
                        } else {
                            effect.value
                        }
                        .ok_or_else(|| self.fail(effect.node, "missing branch subject"))?;
                        if effect.verb == EffectVerb::Match
                            && !self.types.exhaustive_matches.contains(&effect.node)
                        {
                            return Err(self.fail(effect.node, "unproven exhaustive match"));
                        }
                        let alternatives = self.expr(subject, module, &flow.env, calls)?;
                        let branches: Vec<_> = if effect.verb == EffectVerb::If {
                            vec![
                                (DisclosureChoice::Then, &effect.then_effects),
                                (DisclosureChoice::Else, &effect.else_effects),
                            ]
                        } else {
                            effect
                                .match_arms
                                .iter()
                                .map(|arm| {
                                    arm.case
                                        .clone()
                                        .map(|case| (DisclosureChoice::Match(case), &arm.effects))
                                        .ok_or_else(|| {
                                            self.fail(arm.node, "missing checked match case")
                                        })
                                })
                                .collect::<Result<_, _>>()?
                        };
                        for condition in alternatives {
                            if !compatible(&flow.evaluated, &condition.decisions) {
                                continue;
                            }
                            let control = self.control(condition)?;
                            let mut continuing = Vec::new();
                            let mut all_continue = true;
                            let prior_effect_visits = self.effect_visits;
                            for (choice, body) in &branches {
                                let mut branch = flow.clone();
                                for read in &control.observed {
                                    if !branch.observed.contains(read) {
                                        branch.observed.push(read.clone());
                                    }
                                }
                                branch.controls.join(&control);
                                branch.controls.decisions.push(DisclosureDecision {
                                    node: effect.node,
                                    calls: calls.to_vec(),
                                    choice: choice.clone(),
                                });
                                for decision in &branch.controls.decisions {
                                    if !branch.evaluated.contains(decision) {
                                        branch.evaluated.push(decision.clone());
                                    }
                                }
                                let (live, emitted) =
                                    self.statements(body, module, vec![branch], calls)?;
                                all_continue &= !live.is_empty() && emitted.is_empty();
                                continuing.extend(live);
                                returns.extend(emitted);
                                if continuing.len().saturating_add(returns.len()) > 1024 {
                                    return Err(self.fail(effect.node, "branch path bound"));
                                }
                            }
                            // A branch can select whether a changed record
                            // exists, even on its no-transition outcome. Keep
                            // that selector for every continuing outcome when
                            // any sibling accumulated new write dependencies.
                            let selects_writes = self.effect_visits != prior_effect_visits
                                || continuing.iter().any(|path| {
                                    path.writes.reads.iter().any(|read| {
                                        !flow.writes.reads.iter().any(|prior| prior.id == read.id)
                                    })
                                });
                            for mut path in continuing {
                                // Only an entirely read-only branch loses its
                                // local controls at the common postdominator.
                                path.env = flow.env.clone();
                                if selects_writes {
                                    path.writes.join(&path.controls);
                                    if path.writes.reads.len() + path.writes.intrinsics.len() > 200
                                    {
                                        return Err(self.fail(
                                            effect.node,
                                            "transition write dependency bound",
                                        ));
                                    }
                                } else if all_continue {
                                    path.controls = flow.controls.clone();
                                }
                                next.push(path);
                                if next.len() > 1024 {
                                    return Err(self.fail(effect.node, "statement path bound"));
                                }
                            }
                        }
                    }
                    EffectVerb::For => {
                        next.extend(self.bounded_input_loop(effect, module, flow, calls)?);
                    }
                    _ => return Err(self.fail(effect.node, "mutation or external effect closure")),
                }
            }
            if next.len().saturating_add(returns.len()) > 1024 {
                return Err(self.fail(effect.node, "statement path bound"));
            }
            flows = next;
        }
        Ok((flows, returns))
    }
}

fn compatible(left: &[DisclosureDecision], right: &[DisclosureDecision]) -> bool {
    let default_selection = |choice: &DisclosureChoice| {
        matches!(
            choice,
            DisclosureChoice::DefaultEvaluated | DisclosureChoice::DefaultProvided
        )
    };
    !left.iter().any(|a| {
        right.iter().any(|b| {
            a.node == b.node
                && a.calls == b.calls
                && default_selection(&a.choice) == default_selection(&b.choice)
                && a.choice != b.choice
        })
    })
}

fn primitive_type(ty: &ResolvedType) -> bool {
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
}

fn result_type(ty: &ResolvedType) -> bool {
    let base = match ty {
        ResolvedType::Nullable(inner) => inner.as_ref(),
        ty => ty,
    };
    primitive_type(base)
        || matches!(base, ResolvedType::Enum { cases, .. } if !cases.is_empty())
        || matches!(base, ResolvedType::Array { element, .. } if primitive_type(element))
}

/// The owning imported constructor supplies the carried schema identity.
/// Retain anonymous objects without deriving a nominal identity from shape.
fn checked_text_schema_fields<'a>(
    ty: &'a ResolvedType,
    schema: Option<&str>,
) -> Option<&'a [(String, ResolvedType)]> {
    match ty {
        ResolvedType::Object(fields) => Some(fields),
        ResolvedType::StdNominal { fields, .. }
            if schema.is_some_and(|name| {
                matches!(
                    name,
                    "TextRequest"
                        | "TextMessage"
                        | "WorkflowInput"
                        | "WorkflowDefinition"
                        | "ImageRequest"
                ) && checked_standard_nominal_name(ty) == Some(name)
            }) =>
        {
            Some(fields)
        }
        _ => None,
    }
}

fn stored_result_model(ty: &ResolvedType, resolve: &ResolveTables) -> Option<SymbolId> {
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = ty
    else {
        return None;
    };
    let declaration = resolve.symbols.get(symbol.0 as usize)?;
    (declaration.id == *symbol && matches!(declaration.kind, SymbolKind::Model { .. }))
        .then_some(*symbol)
}

fn checked_stored_contract_type_id(
    ty: &ResolvedType,
    alias: Option<SymbolId>,
    resolve: &ResolveTables,
    depth: usize,
) -> Option<String> {
    if depth > 64 {
        return None;
    }
    match ty {
        ResolvedType::Nullable(inner) => Some(format!(
            "{}?",
            checked_stored_contract_type_id(inner, alias, resolve, depth + 1)?
        )),
        ResolvedType::Array { element, .. } => Some(format!(
            "{}[]",
            checked_stored_contract_type_id(element, alias, resolve, depth + 1)?
        )),
        _ if alias.is_some() => Some(resolve.symbols.get(alias?.0 as usize)?.canonical.clone()),
        ResolvedType::Scalar(scalar) => Some(scalar.as_str().into()),
        ResolvedType::Record { symbol, .. } => {
            Some(resolve.symbols.get(symbol.0 as usize)?.canonical.clone())
        }
        ResolvedType::Enum {
            owner: Some(owner), ..
        } => Some(resolve.symbols.get(owner.0 as usize)?.canonical.clone()),
        ResolvedType::Enum { owner: None, cases } => Some(format!("enum({})", cases.join(","))),
        _ => None,
    }
}

fn exact_type_id(ty: &ResolvedType, resolve: &ResolveTables) -> Option<String> {
    if !result_type(ty) {
        return None;
    }
    let mut ty = ty;
    let mut suffix = String::new();
    for _ in 0..64 {
        if let ResolvedType::Nullable(inner) = ty {
            ty = inner;
            suffix.push('?');
        } else {
            break;
        }
    }
    if let ResolvedType::Array { element, .. } = ty {
        ty = element;
        suffix.insert_str(0, "[]");
    }
    let base = match ty {
        ResolvedType::Scalar(scalar) => Some(scalar.as_str().to_string()),
        ResolvedType::Enum {
            owner: Some(owner), ..
        } => Some(resolve.symbols.get(owner.0 as usize)?.canonical.clone()),
        ResolvedType::Enum { owner: None, cases } if !cases.is_empty() => {
            Some(format!("enum({})", cases.join(",")))
        }
        _ => None,
    }?;
    Some(format!("{base}{suffix}"))
}

fn expression(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Literal
            | SyntaxKind::NameRef
            | SyntaxKind::Group
            | SyntaxKind::Array
            | SyntaxKind::Object
            | SyntaxKind::Construct
            | SyntaxKind::Member
            | SyntaxKind::Call
            | SyntaxKind::Unary
            | SyntaxKind::Binary
            | SyntaxKind::Query
            | SyntaxKind::Path
            | SyntaxKind::MessageValue
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checked(source: &str) -> ScenarioDisclosure {
        checked_named(source, "Bounds.probe")
    }

    fn checked_named(source: &str, canonical: &str) -> ScenarioDisclosure {
        let mut db = SourceDb::new();
        let file = db.add("bounds.can".into(), source.into());
        let (program, diagnostics) = super::super::check_program(&db, &[file], None);
        assert!(diagnostics.is_empty(), "source admission: {diagnostics:?}");
        let scenario = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == canonical)
            .unwrap();
        program
            .scenario_disclosures()
            .get(&scenario.id)
            .unwrap()
            .clone()
    }

    fn checked_query_source(source: &str) -> ScenarioDisclosure {
        let mut db = SourceDb::new();
        let file = db.add("query-source.can".into(), source.into());
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) =
            super::super::catalog::load_catalog(&super::super::catalog::CatalogRequest {
                flag: Some(&path),
                env: None,
                cwd: path.parent().unwrap(),
                primary: crate::source::Span::new(file, 0, 0),
            });
        assert!(diagnostics.is_empty(), "catalog: {diagnostics:?}");
        let (program, diagnostics) = super::super::check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "source admission: {diagnostics:?}");
        let scenario = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "Bounds.probe")
            .unwrap();
        program
            .scenario_disclosures()
            .get(&scenario.id)
            .unwrap()
            .clone()
    }

    fn query_source_fixture() -> String {
        // A finite collector fixture, not an accepted replacement for the
        // original Workbench authorization/composition workflow.
        let original = include_str!("../../../draft/CanWorkbench.can");
        let body = original
            .lines()
            .skip_while(|line| !line.trim_start().starts_with("let visible="))
            .take(3)
            .map(|line| format!("{}\n", line.trim_start()))
            .collect::<String>();
        let body = body
            .lines()
            .map(|line| format!("   {line}\n"))
            .collect::<String>();
        format!(
            "app Bounds\nGiven\n Location {{name:text}}\n Task {{location:Location?,title:text,description:text?,due:datetime?,priority:enum(low,normal,high)=normal,done:bool=false}}\n contract Scope {{targets:Task[]! min=1 max=10}}\n contract Fact {{task:Task,version:int min=1,title:Task.title max=2000,description:Task.description max=8000,due:Task.due,priority:Task.priority,done:bool}}\n policy Task read=members\n policy Location read=members\nWhen\n scenario probe(location:Location,targets:Scope.targets) read=true -> Fact[] by=members\n  do\n{body}Then\n"
        )
    }

    #[test]
    fn finite_query_closure_retains_original_body_without_native_publication() {
        let disclosure = checked_query_source(&query_source_fixture());
        let ScenarioDisclosure::Complete(plan) = &disclosure else {
            panic!("finite checked query closure declined: {disclosure:?}");
        };
        let source = disclosure.source_facts().expect("checked source");
        let queries = source.queries.as_ref().expect("closed original body");
        assert_eq!(queries.len(), 1);
        let query = &queries[0];
        assert_eq!(plan.returns.len(), 1);
        assert_eq!(plan.returns[0].id, query.return_id());
        assert_eq!(plan.returns[0].node, query.return_node);
        assert_eq!(plan.returns[0].influences, query.influences);
        assert!(plan.returns[0].dependencies.is_empty());
        assert!(plan.returns[0].intrinsics.is_empty());
        assert_eq!(query.model_name, "Bounds.Task");
        assert_eq!(query.dependencies.len(), 6);
        assert_eq!(query.dependencies[0].field_name, "location");
        assert_eq!(query.dependencies[0].type_id, "Bounds.Location?");
        assert_eq!(query.dependencies[0].role, DependencyRole::Control);
        assert_eq!(query.dependencies[4].field_name, "priority");
        assert_eq!(query.dependencies[4].type_id, "Bounds.Task.priority");
        assert!(
            query.dependencies[1..]
                .iter()
                .all(|dep| dep.role == DependencyRole::Data)
        );
        assert_eq!(query.inputs.len(), 3);
        assert_eq!(query.inputs[0].1, query.inputs[2].1);
        assert_eq!(query.projection.fields.len(), 7);
        assert!(matches!(
            query.projection.fields[0].mapping,
            CheckedQueryProjectionMapping::StoredReference
        ));
        assert!(matches!(
            query.projection.fields[1].mapping,
            CheckedQueryProjectionMapping::Version
        ));
        assert_eq!(query.influences.len(), 4);
        assert!(
            query
                .influences
                .iter()
                .all(|fact| fact.query_id.as_ref() == Some(&query.id))
        );
        assert!(query.order.is_empty());
        assert_eq!(query.limit, None);
        assert!(!query.archived);
        let again = checked_query_source(&query_source_fixture());
        assert_eq!(
            again.source_facts().unwrap().queries.as_ref().unwrap(),
            queries
        );
    }

    #[test]
    fn finite_query_header_proves_original_frozen_array_and_refuses_other_controls() {
        let original = query_source_fixture();
        for guard in [
            "count(targets)>0",
            "0<count(targets)",
            "count(targets)>=1",
            "count(targets)==2",
        ] {
            let source = original.replace("  do\n", &format!("  require {guard}\n  do\n"));
            assert!(
                matches!(
                    checked_query_source(&source),
                    ScenarioDisclosure::Complete(_)
                ),
                "{guard}"
            );
        }
        for guard in [
            "count(Task)>0",
            "count(targets)>count(targets)",
            "location.name!=\"\"",
            "any(Task as task,task.done)",
        ] {
            let source = original.replace("  do\n", &format!("  require {guard}\n  do\n"));
            assert!(
                matches!(
                    checked_query_source(&source),
                    ScenarioDisclosure::Declined(_)
                ),
                "{guard}"
            );
        }
        for source in [
            original.replace("min=1 max=10", "max=10"),
            original.replace("min=1 max=10", "min=1 max=201"),
            original.replace(
                "targets:Scope.targets",
                "targets:Scope.targets,unused:int=0",
            ),
            original.replace("targets:Scope.targets", "targets:Task[]"),
            original.replace("  do\n", "  do\n   require true\n"),
        ] {
            assert!(
                matches!(
                    checked_query_source(&source),
                    ScenarioDisclosure::Declined(_)
                ),
                "{source}"
            );
        }
    }

    #[test]
    fn finite_query_uses_owning_reused_array_bounds_without_required_presence() {
        let original = query_source_fixture();
        let source = original.replace(
            "contract Scope {targets:Task[]! min=1 max=10}",
            "contract Base {targets:Task[]! min=0 max=20}\n contract Scope {targets:Base.targets min=1 max=10}",
        );
        let disclosure = checked_query_source(&source);
        assert!(
            matches!(disclosure, ScenarioDisclosure::Complete(_)),
            "{disclosure:?}"
        );
        let parameters = &disclosure.source_facts().unwrap().parameters;
        assert!(matches!(
            parameters[1].ty,
            ResolvedType::Array {
                nonempty: false,
                ..
            }
        ));
        for changed in [
            source.replace(" min=1 max=10", ""),
            source.replace("min=1 max=10", "min=1 max=201"),
            source.replace("  do\n", "  require count(targets)>201\n  do\n"),
        ] {
            assert!(matches!(
                checked_query_source(&changed),
                ScenarioDisclosure::Declined(_)
            ));
        }
    }

    #[test]
    fn query_source_refuses_incomplete_domain_cardinality_and_projection_lineage() {
        let original = query_source_fixture();
        for changed in [
            original.replace("task in targets and ", ""),
            original.replace(
                "count(visible)==count(targets)",
                "count(visible)>=count(targets)",
            ),
            original.replace("Task as task where", "Task archived=include as task where"),
            original.replace("visible as task select", "targets as task select"),
            original.replace("version=task.version", "version=1"),
            original.replace("title=task.title", "title=\"copied\""),
            original.replace("task.location==location", "task.location!=location"),
        ] {
            let disclosure = checked_query_source(&changed);
            assert!(
                disclosure.source_facts().unwrap().queries.is_none(),
                "incomplete producer accepted: {changed}"
            );
        }
    }

    #[test]
    fn admitted_intrinsics_keep_original_parameter_through_groups_aliases_and_derives() {
        let source = "app Bounds\nGiven\n Item {value:int}\n policy Item read=members\n derive original(record:Item):int=(record).version\n derive nested(record:Item):int=original(record)\nWhen\n scenario probe(item:Item) -> int by=members\n  do\n   let alias=(item)\n   return nested(alias)+item.version\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("checked original reference alias")
        };
        let path = &plan.returns[0];
        assert!(path.dependencies.is_empty());
        assert_eq!(path.intrinsics.len(), 2);
        assert_eq!(path.intrinsics[0].calls.len(), 2);
        assert!(path.intrinsics[1].calls.is_empty());
        assert_ne!(path.intrinsics[0].id, path.intrinsics[1].id);
        for intrinsic in &path.intrinsics {
            assert_eq!(intrinsic.type_id, "int");
            assert_eq!(intrinsic.ty, ResolvedType::Scalar(Scalar::Int));
            assert_eq!(intrinsic.role, DependencyRole::Data);
            assert!(
                matches!(&intrinsic.kind,DisclosureIntrinsicKind::AdmittedReferenceVersion {parameter_name,model_name,..}
                if parameter_name=="item" && model_name=="Bounds.Item")
            );
        }
    }

    #[test]
    fn operation_intrinsic_is_checked_text_and_alias_data_is_return_specific() {
        let source = "app Bounds\nGiven\n derive identity():text=(operation).id\nWhen\n scenario probe() -> text by=members\n  do\n   let ignored=operation.id\n   let saved=identity()\n   return saved\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("checked operation identity")
        };
        assert_eq!(plan.returns[0].intrinsics.len(), 1);
        let intrinsic = &plan.returns[0].intrinsics[0];
        assert_eq!(intrinsic.type_id, "text");
        assert_eq!(intrinsic.calls.len(), 1);
        assert!(matches!(
            intrinsic.kind,
            DisclosureIntrinsicKind::OperationId
        ));
    }

    #[test]
    fn intrinsic_control_and_default_selection_preserve_evaluation_roles() {
        let source = "app Bounds\nGiven\n Item {value:int}\n policy Item read=members\nWhen\n scenario probe(item:Item,selected:int=item.version) -> int by=members\n  do\n   if selected>0\n    return 1\n   else\n    return 0\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("versioned reference default scalar")
        };
        assert_eq!(plan.returns.len(), 4);
        for path in &plan.returns {
            let provided = path
                .decisions
                .iter()
                .any(|decision| decision.choice == DisclosureChoice::DefaultProvided);
            assert_eq!(path.intrinsics.len(), usize::from(!provided));
            if !provided {
                assert_eq!(path.intrinsics[0].role, DependencyRole::Control);
            }
        }
        let op = "app Bounds\nGiven\nWhen\n scenario probe(selected:text=operation.id) -> text by=members\n  do return selected\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(op) else {
            panic!("operation default identity")
        };
        assert_eq!(plan.returns.len(), 2);
        assert!(plan.returns.iter().any(|path| path.intrinsics.is_empty()
            && path.decisions[0].choice == DisclosureChoice::DefaultProvided));
        assert!(plan.returns.iter().any(|path| path.intrinsics.len() == 1
            && path.decisions[0].choice == DisclosureChoice::DefaultEvaluated));
    }

    #[test]
    fn nonoriginal_optional_default_and_versionless_metadata_decline() {
        let prefix = "app Bounds\nGiven\n Other {value:int}\n Item {value:int,other:Other?}\n policy Other read=members\n policy Item read=members\nWhen\n";
        for scenario in [
            " scenario probe(item:Item?) -> int by=members\n  do\n   require item!=null\n   return item.version\n",
            " scenario probe(original:Item,item:Item=original) -> int by=members\n  do return item.version\n",
            " scenario probe(item:Item) read=true -> int by=members\n  do return item.version\n",
            " scenario probe(item:Item) -> int by=members\n  do\n   require item.other!=null\n   return item.other.version\n",
            " scenario probe() -> text by=members\n  do return operation.source\n",
        ] {
            assert!(matches!(
                checked(&format!("{prefix}{scenario}Then\n")),
                ScenarioDisclosure::Declined(_)
            ));
        }
    }

    #[test]
    fn admitted_primitive_inputs_observe_only_actual_once_bound_evaluations() {
        let source = "app Bounds\nGiven\n derive doubled(value:int):int=value+value\nWhen\n scenario probe(value:int,unused:text) -> int by=members\n  do\n   let alias=value\n   return doubled(alias)\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("required builtin input")
        };
        assert_eq!(plan.returns[0].intrinsics.len(), 1);
        let input = &plan.returns[0].intrinsics[0];
        assert!(input.calls.is_empty());
        assert_eq!(input.type_id, "int");
        assert!(
            matches!(&input.kind,DisclosureIntrinsicKind::AdmittedInput {parameter_name,..} if parameter_name=="value")
        );
        for ty in [
            "text", "bool", "int", "date", "datetime", "decimal", "money", "duration", "user",
        ] {
            let source = format!(
                "app Bounds\nGiven\nWhen\n scenario probe(value:{ty}) -> {ty} by=members\n  do return value\nThen\n"
            );
            let ScenarioDisclosure::Complete(plan) = checked(&source) else {
                panic!("required primitive {ty}")
            };
            assert_eq!(plan.returns[0].intrinsics.len(), 1);
            assert_eq!(plan.returns[0].intrinsics[0].type_id, ty);
        }
    }

    #[test]
    fn primitive_success_require_controls_effects_but_not_independent_returns() {
        let base = "app Bounds\nGiven\n Item {value:int}\n policy Item read=members\nWhen\n scenario probe(item:Item,accept:bool) -> int by=members\n  do\n";
        for body in [
            "   require accept\n   set item {value=1}\n   return 9\n",
            "   set item {value=1}\n   require accept\n   return 9\n",
        ] {
            let ScenarioDisclosure::Complete(plan) = checked(&format!("{base}{body}Then\n")) else {
                panic!("successful primitive effect guard")
            };
            assert_eq!(plan.returns[0].intrinsics.len(), 1);
            assert_eq!(plan.returns[0].intrinsics[0].role, DependencyRole::Control);
            assert!(matches!(&plan.returns[0].intrinsics[0].kind,
                DisclosureIntrinsicKind::AdmittedInput {parameter_name,..} if parameter_name=="accept"));
        }
        let ScenarioDisclosure::Complete(plan) =
            checked(&format!("{base}   require accept\n   return 9\nThen\n"))
        else {
            panic!("independent guard policy")
        };
        assert!(plan.returns[0].intrinsics.is_empty());
    }

    #[test]
    fn operation_and_original_version_require_controls_survive_before_and_after_effects() {
        let base = "app Bounds\nGiven\n Item {value:int}\n policy Item read=members\nWhen\n scenario probe(item:Item) -> int by=members\n  do\n";
        for (guard, operation) in [("operation.id!=\"\"", true), ("item.version>1", false)] {
            for body in [
                format!("   require {guard}\n   set item {{value=1}}\n   return 9\n"),
                format!("   set item {{value=1}}\n   require {guard}\n   return 9\n"),
            ] {
                let ScenarioDisclosure::Complete(plan) = checked(&format!("{base}{body}Then\n"))
                else {
                    panic!("supported intrinsic effect guard: {guard}")
                };
                let path = &plan.returns[0];
                assert!(path.dependencies.is_empty());
                assert_eq!(path.intrinsics.len(), 1, "guard: {guard}, body: {body}");
                assert_eq!(path.intrinsics[0].role, DependencyRole::Control);
                if operation {
                    assert!(matches!(
                        path.intrinsics[0].kind,
                        DisclosureIntrinsicKind::OperationId
                    ));
                } else {
                    assert!(
                        matches!(&path.intrinsics[0].kind,DisclosureIntrinsicKind::AdmittedReferenceVersion {parameter_name,model_name,..}
                        if parameter_name=="item" && model_name=="Bounds.Item")
                    );
                }
            }
            let ScenarioDisclosure::Complete(plan) =
                checked(&format!("{base}   require {guard}\n   return 9\nThen\n"))
            else {
                panic!("independent return intrinsic guard: {guard}")
            };
            assert!(plan.returns[0].dependencies.is_empty());
            assert!(plan.returns[0].intrinsics.is_empty());
        }
    }

    #[test]
    fn optional_default_alias_enum_and_array_inputs_preserve_separate_frozen_profile() {
        for signature in [
            "value:int?",
            "value:int=1",
            "value:int[]",
            "value:Choice.kind",
        ] {
            let source = format!(
                "app Bounds\nGiven\n Choice {{kind:text min=1 max=80}}\n policy Choice read=members\nWhen\n scenario probe({signature}) -> bool by=members\n  do return value==value\nThen\n"
            );
            let ScenarioDisclosure::Complete(plan) = checked(&source) else {
                panic!("existing frozen profile {signature}")
            };
            assert!(
                plan.returns[0].intrinsics.is_empty(),
                "unexpected admitted-input for {signature}"
            );
        }
        let source = "app Bounds\nGiven\n Choice {kind:enum(a,b)}\n policy Choice read=members\nWhen\n scenario probe(value:Choice.kind) -> bool by=members\n  do return value==a\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("existing enum input profile")
        };
        assert!(plan.returns[0].intrinsics.is_empty());
    }

    #[test]
    fn scalar_sets_retain_read_data_and_literal_effect_selectors() {
        let source = "app Bounds\nGiven\n Item {available:bool,value:int,note:text?}\n policy Item read=members\nWhen\n scenario probe(item:Item) by=members\n  do\n   if item.available\n    set item {value=7}\n   set item {value=item.value+1,note=null}\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("direct checked scalar sets should close")
        };
        assert_eq!(plan.effects.len(), 2);
        assert!(plan.effects.iter().all(|effect| matches!(&effect.kind,
            DisclosureEffectKind::Set {fields,..} if !fields.is_empty())));
        assert_eq!(plan.returns.len(), 2);
        for path in &plan.returns {
            assert!(
                path.dependencies
                    .iter()
                    .any(|read| read.field_name == "available"
                        && read.role == DependencyRole::Control)
            );
            assert!(
                path.dependencies
                    .iter()
                    .any(|read| read.field_name == "value" && read.role == DependencyRole::Data)
            );
            assert_eq!(path.decisions.len(), 1);
        }
    }

    #[test]
    fn literal_set_no_effect_branch_retains_selector_with_void_result() {
        let source = "app Bounds\nGiven\n Item {available:bool,value:int}\n policy Item read=members\nWhen\n scenario probe(item:Item) by=members\n  do\n   if item.available\n    set item {value=7}\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("literal set closure")
        };
        assert_eq!(plan.effects.len(), 1);
        assert_eq!(plan.returns.len(), 2);
        for path in &plan.returns {
            assert_eq!(path.dependencies.len(), 1);
            assert_eq!(path.dependencies[0].field_name, "available");
            assert_eq!(path.dependencies[0].role, DependencyRole::Control);
        }
    }

    #[test]
    fn read_free_send_keeps_effect_and_no_effect_selector_controls() {
        let source = "app Bounds\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\n Item {available:bool}\n policy Item read=members\nWhen\n scenario probe(item:Item) by=members\n  do\n   if item.available\n    send LLM.cancel {revision=1,source=\"fixed\"} as stop\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("read-free send closure")
        };
        assert_eq!(plan.effects.len(), 1);
        assert_eq!(plan.returns.len(), 2);
        for path in &plan.returns {
            assert_eq!(path.dependencies.len(), 1);
            assert_eq!(path.dependencies[0].field_name, "available");
            assert_eq!(path.dependencies[0].role, DependencyRole::Control);
        }
    }

    #[test]
    fn original_generation_cancel_reconcile_close_exact_send_and_carrier_sets() {
        let source = include_str!(
            "../../../packages/cloudflare/test/fixtures/typed-generation-progress.can"
        );
        for (scenario, operation, field) in [
            ("cancel", "cancel", "stop"),
            ("reconcile", "reconcile", "probe"),
        ] {
            let ScenarioDisclosure::Complete(plan) =
                checked_named(source, &format!("TypedGenerationProgress.{scenario}"))
            else {
                panic!("original {scenario} should close without frozen operation metadata")
            };
            assert_eq!(plan.effects.len(), 2);
            assert!(
                matches!(&plan.effects[0].kind,DisclosureEffectKind::Send {operation:actual,deployment_binding:Some(binding),when:None}
                if actual==&format!("std.TextGenerationV1.{operation}") && binding=="TypedGenerationProgress.LLM")
            );
            assert!(
                matches!(&plan.effects[1].kind,DisclosureEffectKind::Set {fields,..} if fields.len()==1)
            );
            for path in &plan.returns {
                let names: HashSet<_> = path
                    .dependencies
                    .iter()
                    .map(|read| read.field_name.as_str())
                    .collect();
                assert_eq!(names, HashSet::from(["request_source", "request_revision"]));
            }
            assert_eq!(plan.effects[1].source.module, "TypedGenerationProgress");
            assert!(source.contains(&format!("set job {{{field}}}")));
        }
        let ScenarioDisclosure::Complete(generate) =
            checked_named(source, "TypedGenerationProgress.generate")
        else {
            panic!("released operation/reference intrinsics close original generate source")
        };
        assert_eq!(generate.effects.len(), 2);
        assert_eq!(generate.returns.len(), 1);
        assert_eq!(generate.returns[0].intrinsics.len(), 4);
        assert!(matches!(
            generate.returns[0].intrinsics[0].kind,
            DisclosureIntrinsicKind::OperationId
        ));
        assert!(matches!(&generate.returns[0].intrinsics[1].kind,
            DisclosureIntrinsicKind::AdmittedReferenceVersion {parameter_name,model_name,..}
                if parameter_name == "job" && model_name == "TypedGenerationProgress.Job"));
        assert!(matches!(&generate.returns[0].intrinsics[2].kind,
            DisclosureIntrinsicKind::AdmittedInput {parameter_name,..} if parameter_name=="prompt"));
        assert_eq!(generate.returns[0].intrinsics[2].role, DependencyRole::Data);
        assert!(matches!(&generate.returns[0].intrinsics[3].kind,
            DisclosureIntrinsicKind::AdmittedInput {parameter_name,..} if parameter_name=="accept"));
        assert_eq!(
            generate.returns[0].intrinsics[3].role,
            DependencyRole::Control
        );
    }

    #[test]
    fn sealed_standard_text_source_traversal_refuses_foreign_owner_and_type_mutants() {
        let source = include_str!(
            "../../../packages/cloudflare/test/fixtures/typed-generation-progress.can"
        );
        let mut db = SourceDb::new();
        let file = db.add("typed-generation-progress.can".into(), source.into());
        let (tree, mut diagnostics) = crate::syntax::parse(&db, file);
        let trees = vec![(file, tree)];
        let resolve =
            super::super::resolve::try_resolve_program(&db, &trees, None, &mut diagnostics)
                .unwrap();
        let types = super::super::types::check_types(&db, &trees, None, &resolve, &mut diagnostics);
        let effects = super::super::effects::check_effects(
            &db,
            &trees,
            &resolve,
            &types,
            None,
            &mut diagnostics,
        );
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let owner = resolve
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "TypedGenerationProgress.generate")
            .unwrap();
        let plans = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
        let ScenarioDisclosure::Complete(plan) = &plans[&owner.id] else {
            panic!("original sealed generation producer");
        };
        assert_eq!(plan.returns[0].intrinsics.len(), 4);
        for position in [
            "request-construct",
            "message-construct",
            "message-array",
            "request-member",
        ] {
            let key = *types.node_types.iter().find(|(key, ty)| match position {
                "request-construct" => key.kind == SyntaxKind::Construct as u8 && checked_standard_nominal_name(ty) == Some("TextRequest"),
                "message-construct" => key.kind == SyntaxKind::Construct as u8 && checked_standard_nominal_name(ty) == Some("TextMessage"),
                "message-array" => key.kind == SyntaxKind::Array as u8 && matches!(ty, ResolvedType::Array {element, ..} if checked_standard_nominal_name(element) == Some("TextMessage")),
                "request-member" => key.kind == SyntaxKind::NameRef as u8 && checked_standard_nominal_name(ty) == Some("TextRequest")
                    && source.get(key.start as usize..key.end as usize) == Some("value"),
                _ => unreachable!(),
            }).unwrap().0;
            for mutation in ["shape", "identity"] {
                let mut changed = types.clone();
                let mut ty = changed.node_types.get_mut(&key).unwrap();
                if let ResolvedType::Array { element, .. } = ty {
                    ty = element;
                }
                let ResolvedType::StdNominal { name, fields } = ty else {
                    panic!("original nominal leaf");
                };
                if mutation == "shape" {
                    fields[0].1 = ResolvedType::Scalar(Scalar::File);
                } else {
                    *name = "UnreleasedTextSchema";
                }
                let plans = analyze_scenario_disclosure(&db, &trees, &resolve, &changed, &effects);
                assert!(
                    matches!(plans[&owner.id], ScenarioDisclosure::Declined(_)),
                    "{position}/{mutation}"
                );
            }
        }
        let mut foreign = resolve.clone();
        foreign.module_scopes[owner.module.0 as usize].prod.insert(
            "TextRequest".into(),
            ScopedName::External {
                provider: "foreign".into(),
                name: "TextRequest".into(),
            },
        );
        let plans = analyze_scenario_disclosure(&db, &trees, &foreign, &types, &effects);
        assert!(matches!(plans[&owner.id], ScenarioDisclosure::Declined(_)));
        let anonymous =
            ResolvedType::Object(vec![("source".into(), ResolvedType::Scalar(Scalar::Text))]);
        assert!(checked_text_schema_fields(&anonymous, None).is_some());
        assert!(checked_standard_nominal_name(&anonymous).is_none());
    }

    #[test]
    fn closed_std_composite_send_and_scalar_projection_keep_authored_read_order() {
        let source = "app Bounds\nuse std {TextRequest,TextMessage}\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\n Item {source:text,revision:int,prompt:text,request:delivery(LLM.generate)?,saved:text}\n policy Item read=members fields=source,revision,prompt,saved\nWhen\n scenario probe(item:Item) by=members\n  do\n   let request=TextRequest {source=item.source,revision=item.revision,profile=\"local-chat\",policy_revision=\"policy-1\",messages=[TextMessage {role=user,content=item.prompt,attachments=[]}],max_input_tokens=1024,max_output_tokens=128,max_duration=30s}\n   send LLM.generate {value=request} as attempt\n   set item {request=attempt,saved=request.source}\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("closed std request intermediate")
        };
        assert_eq!(plan.effects.len(), 2);
        assert_eq!(plan.returns.len(), 1);
        assert_eq!(
            plan.returns[0]
                .dependencies
                .iter()
                .map(|read| read.field_name.as_str())
                .collect::<Vec<_>>(),
            vec!["source", "revision", "prompt"]
        );
        assert!(
            matches!(&plan.effects[1].kind,DisclosureEffectKind::Set {fields,..} if fields.len()==2)
        );
        let projected=source.replace("   send LLM.generate {value=request} as attempt\n   set item {request=attempt,saved=request.source}","   set item {saved=request.source}");
        let ScenarioDisclosure::Complete(plan) = checked(&projected) else {
            panic!("scalar schema selection")
        };
        assert_eq!(plan.returns[0].dependencies.len(), 1);
        assert_eq!(plan.returns[0].dependencies[0].field_name, "source");
    }

    #[test]
    fn delivery_inspection_and_unreleased_metadata_remain_whole_declined() {
        let base = "app Bounds\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\n Item {source:text,revision:int,stop:delivery(LLM.cancel)?,saved:text}\n policy Item read=members fields=source,revision,saved\nWhen\n scenario probe(item:Item) by=members\n  do\n   send LLM.cancel {source=item.source,revision=item.revision} as stop\n   set item {stop}\n";
        for tail in [
            "   require stop.status==pending\nThen\n",
            "   set item {saved=operation.source}\nThen\n",
        ] {
            assert!(matches!(
                checked(&format!("{base}{tail}")),
                ScenarioDisclosure::Declined(_)
            ));
        }
    }

    #[test]
    fn guarded_send_retains_dispatch_source_and_reference_writes_still_decline() {
        let send = "app Bounds\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\n Item {source:text,revision:int}\n policy Item read=members\nWhen\n scenario probe(item:Item) by=members\n  do\n   send LLM.cancel {source=item.source,revision=item.revision} when=false as stop\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(send) else {
            panic!("original checked dispatch source must qualify")
        };
        let DisclosureEffectKind::Send {
            when: Some(when), ..
        } = plan.effects[0].kind
        else {
            panic!("durable predicate source must survive")
        };
        assert_eq!(&send[when.start as usize..when.end as usize], "false");
        let source = plan.source_facts.as_ref().unwrap();
        let sites = source.decision_sites.as_ref().unwrap();
        assert_eq!(sites.len(), 1);
        assert_eq!(sites[0].stage, CheckedDecisionStage::SendDispatch);
        assert_eq!(sites[0].owner, plan.scenario);
        assert_eq!(sites[0].statement, plan.effects[0].node);
        assert_eq!(sites[0].node, when);
        assert_eq!(sites[0].source, plan.source);
        assert!(sites[0].calls.is_empty());
        assert_eq!(plan.returns.len(), 1, "false dispatch must not prune SEND");
        assert!(plan.returns[0].decisions.is_empty());
        assert_eq!(plan.returns[0].dependencies.len(), 2);
        let reference = "app Bounds\nGiven\n Other {value:int}\n Item {other:Other?}\n policy Other read=members\n policy Item read=members\nWhen\n scenario probe(item:Item,other:Other) by=members\n  do set item {other}\nThen\n";
        assert!(matches!(
            checked(reference),
            ScenarioDisclosure::Declined(_)
        ));
        let foreign = "package Other\n Given\n  export Item {value:int}\n  policy Item read=members\n When\n Then\napp Bounds\nuse Other {Item}\nGiven\nWhen\n scenario probe(item:Item) by=members\n  do set item {value=1}\nThen\n";
        let mut db = SourceDb::new();
        let file = db.add("foreign.can".into(), foreign.into());
        let (_, diagnostics) = super::super::check_program(&db, &[file], None);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E4001"),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn effect_inventory_declines_before_unbounded_literal_write_profile() {
        let mut source = String::from(
            "app Bounds\nGiven\n Item {value:int}\n policy Item read=members\nWhen\n scenario probe(item:Item) by=members\n  do\n",
        );
        for _ in 0..201 {
            source.push_str("   set item {value=1}\n");
        }
        source.push_str("Then\n");
        let ScenarioDisclosure::Declined(decline) = checked(&source) else {
            panic!("effect bound")
        };
        assert_eq!(decline.reason, "effect proof bound");
    }

    #[test]
    fn immutable_coalesce_alias_retains_one_already_selected_path() {
        let source = "app Bounds\nGiven\nWhen\n scenario probe(a:int?) -> int by=members\n  do\n   let v=a??0\n   return v+v\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("legal pure alias must qualify")
        };
        assert_eq!(plan.returns.len(), 2);
        for returned in plan.returns {
            assert_eq!(
                returned.decisions.len(),
                1,
                "referencing v cannot reevaluate its coalesce"
            );
            assert!(returned.dependencies.is_empty());
        }
    }

    #[test]
    fn stored_defaults_bind_prior_declarations_and_supplied_overrides_cut_reads() {
        let source = "app Bounds\nGiven\n Item {value:int}\n policy Item read=members\nWhen\n scenario probe(item:Item,first:int=item.value,second:int=first) -> int by=members\n  do return second\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("checked stored defaults must establish omitted and supplied paths")
        };
        assert_eq!(plan.returns.len(), 4);
        for returned in &plan.returns {
            assert_eq!(returned.decisions.len(), 2);
            assert_eq!(
                returned
                    .decisions
                    .iter()
                    .map(|d| source[d.node.start as usize..d.node.end as usize].trim())
                    .collect::<Vec<_>>(),
                ["item.value", "first"]
            );
            let both_evaluated = returned
                .decisions
                .iter()
                .all(|d| d.choice == DisclosureChoice::DefaultEvaluated);
            assert_eq!(returned.dependencies.len(), usize::from(both_evaluated));
            if both_evaluated {
                assert_eq!(returned.dependencies[0].field_name, "value");
                assert_eq!(returned.dependencies[0].role, DependencyRole::Data);
            }
        }
        assert_eq!(
            plan.returns
                .iter()
                .map(|p| &p.id)
                .collect::<HashSet<_>>()
                .len(),
            4
        );
    }

    #[test]
    fn stored_default_selector_becomes_control_but_unused_default_data_is_pruned() {
        let source = "app Bounds\nGiven\n Item {available:bool}\n policy Item read=members\nWhen\n scenario probe(item:Item,selected:bool=item.available) -> int by=members\n  do\n   if selected\n    return 1\n   else\n    return 2\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("default selector closure must qualify")
        };
        assert_eq!(plan.returns.len(), 4);
        for returned in plan.returns {
            assert_eq!(returned.decisions.len(), 2);
            assert_eq!(
                source[returned.decisions[0].node.start as usize
                    ..returned.decisions[0].node.end as usize]
                    .trim(),
                "item.available"
            );
            let evaluated = returned.decisions[0].choice == DisclosureChoice::DefaultEvaluated;
            assert_eq!(returned.dependencies.len(), usize::from(evaluated));
            assert!(
                returned
                    .dependencies
                    .iter()
                    .all(|d| d.role == DependencyRole::Control)
            );
        }
        let unused = source.replace(
            "   if selected\n    return 1\n   else\n    return 2",
            "   return 1",
        );
        let ScenarioDisclosure::Complete(plan) = checked(&unused) else {
            panic!("independent return must keep only actual default choice")
        };
        assert_eq!(plan.returns.len(), 2);
        assert!(
            plan.returns
                .iter()
                .all(|p| p.dependencies.is_empty() && p.decisions.len() == 1)
        );
    }

    #[test]
    fn stored_default_path_expansion_retains_finite_bound() {
        let defaults = (0..11)
            .map(|i| format!("v{i}:int=item.value"))
            .collect::<Vec<_>>()
            .join(",");
        let source = format!(
            "app Bounds\nGiven\n Item {{value:int}}\n policy Item read=members\nWhen\n scenario probe(item:Item,{defaults}) -> int by=members\n  do return 1\nThen\n"
        );
        let ScenarioDisclosure::Declined(reason) = checked(&source) else {
            panic!("default omission choices must obey the path limit")
        };
        assert_eq!(reason.reason, "parameter default evaluation path bound");
    }

    #[test]
    fn default_selection_and_inner_coalesce_share_anchor_without_conflicting() {
        let source = "app Bounds\nGiven\n Item {available:bool?}\n policy Item read=members\nWhen\n scenario probe(item:Item,selected:bool=item.available ?? false) -> bool by=members\n  do return selected\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("default omission and its own coalesce are independent decisions")
        };
        assert_eq!(plan.returns.len(), 3);
        let supplied = plan
            .returns
            .iter()
            .find(|p| p.decisions[0].choice == DisclosureChoice::DefaultProvided)
            .unwrap();
        assert!(supplied.dependencies.is_empty());
        assert_eq!(supplied.decisions.len(), 1);
        for omitted in plan
            .returns
            .iter()
            .filter(|p| p.decisions[0].choice == DisclosureChoice::DefaultEvaluated)
        {
            assert_eq!(omitted.decisions.len(), 2);
            assert_eq!(omitted.decisions[0].node, omitted.decisions[1].node);
            assert!(matches!(
                omitted.decisions[1].choice,
                DisclosureChoice::RhsEvaluated | DisclosureChoice::RhsSkipped
            ));
            assert!(!omitted.dependencies.is_empty());
            assert!(compatible(&omitted.decisions, &omitted.decisions));
        }
    }

    #[test]
    fn ignored_initializer_decisions_precede_return_expression_decisions() {
        let source = "app Bounds\nGiven\nWhen\n scenario probe(a:int?,b:int?) -> int by=members\n  do\n   let ignored=a??1\n   return b??2\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("legal pure initializers must qualify")
        };
        assert_eq!(plan.returns.len(), 4);
        for returned in plan.returns {
            let decisions = returned
                .decisions
                .iter()
                .map(|decision| {
                    source[decision.node.start as usize..decision.node.end as usize].trim()
                })
                .collect::<Vec<_>>();
            assert_eq!(decisions, ["a??1", "b??2"]);
        }
    }

    #[test]
    fn many_independent_evaluation_paths_decline_before_cartesian_growth() {
        let params = (0..11)
            .map(|index| format!("a{index}:int?"))
            .collect::<Vec<_>>()
            .join(",");
        let expression = (0..11)
            .map(|index| format!("(a{index}??0)"))
            .collect::<Vec<_>>()
            .join("+");
        let source = format!(
            "app Bounds\nGiven\nWhen\n scenario probe({params}) -> int by=members\n  do\n   return {expression}\nThen\n"
        );
        let ScenarioDisclosure::Declined(reason) = checked(&source) else {
            panic!("path limit must decline additive facts")
        };
        assert!(reason.reason.contains("path bound"), "{reason:?}");
    }

    #[test]
    fn deep_expression_declines_without_changing_source_admission() {
        // Flat left-associative source admits a deep binary tree without
        // consuming the parser's separate nested-expression budget.
        let expression = format!("{}1", "1+".repeat(80));
        let source = format!(
            "app Bounds\nGiven\nWhen\n scenario probe() -> int by=members\n  do\n   return {expression}\nThen\n"
        );
        let ScenarioDisclosure::Declined(reason) = checked(&source) else {
            panic!("depth limit must decline additive facts")
        };
        assert_eq!(reason.reason, "expression closure depth bound");
    }

    #[test]
    fn finite_reference_loop_has_exact_empty_and_populated_write_paths() {
        let source = "app Bounds\nGiven\n Item {value:int=0}\n policy Item read=members\nWhen\n scenario probe(items:Item[]) by=members\n  do\n   for item in (items) limit=3\n    set item {value=item.value+1}\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("finite original reference array loop must qualify")
        };
        assert_eq!(plan.returns.len(), 2);
        let empty = plan
            .returns
            .iter()
            .find(|path| {
                path.decisions
                    .iter()
                    .any(|decision| decision.choice == DisclosureChoice::Else)
            })
            .unwrap();
        let populated = plan
            .returns
            .iter()
            .find(|path| {
                path.decisions
                    .iter()
                    .any(|decision| decision.choice == DisclosureChoice::Then)
            })
            .unwrap();
        assert!(empty.dependencies.is_empty());
        assert!(empty.intrinsics.is_empty());
        assert_eq!(populated.dependencies.len(), 1);
        let read = &populated.dependencies[0];
        assert_eq!(
            (
                read.model_name.as_str(),
                read.field_name.as_str(),
                read.type_id.as_str()
            ),
            ("Bounds.Item", "value", "int")
        );
        assert_eq!(read.role, DependencyRole::Data);
        assert!(read.calls.is_empty());
        assert_eq!(
            source[read.node.start as usize..read.node.end as usize].trim(),
            "item.value"
        );
        let proof = plan
            .effects
            .iter()
            .find_map(|proof| match &proof.kind {
                DisclosureEffectKind::For {
                    domain,
                    limit,
                    maximum,
                    item,
                    parameter,
                    model,
                    body,
                } => Some((domain, limit, maximum, item, parameter, model, body)),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            source[proof.0.start as usize..proof.0.end as usize].trim(),
            "items"
        );
        assert_eq!(
            source[proof.1.start as usize..proof.1.end as usize].trim(),
            "3"
        );
        assert_eq!(*proof.2, 3);
        assert_eq!(proof.3, "item");
        assert_eq!(*proof.5, read.model);
        assert_eq!(proof.6.len(), 1);
        assert_eq!(
            plan.effects
                .iter()
                .filter(|proof| matches!(proof.kind, DisclosureEffectKind::Set { .. }))
                .count(),
            1
        );
        assert_ne!(empty.id, populated.id);
    }

    #[test]
    fn finite_loop_declines_dynamic_per_element_paths_and_excess_observations() {
        let prefix = "app Bounds\nGiven\n Item {value:int=0,other:int=0}\n policy Item read=members\nWhen\n scenario probe(items:Item[],maximum:int) by=members\n  do\n";
        for body in [
            "   for item in items limit=maximum\n    set item {value=item.value+1}\n",
            "   for item in items limit=3\n    if item.value>0\n     set item {value=1}\n",
            "   for item in items limit=3\n    set item {value=item.version}\n",
            "   for item in items limit=101\n    set item {value=item.value+1,other=item.other+1}\n",
            "   for item in items limit=101\n    set item {value=1}\n    set item {other=2}\n",
            "   for item in items limit=3\n    set item {value=1}\n   for item in items limit=3\n    set item {value=2}\n",
        ] {
            assert!(
                matches!(
                    checked(&format!("{prefix}{body}Then\n")),
                    ScenarioDisclosure::Declined(_)
                ),
                "unexpected loop closure: {body}"
            );
        }
        let allowed = format!(
            "{prefix}   for item in items limit=100\n    set item {{value=item.value+1,other=item.other+1}}\nThen\n"
        );
        assert!(matches!(checked(&allowed), ScenarioDisclosure::Complete(_)));
    }

    #[test]
    fn guarded_loop_retains_private_selector_even_on_empty_or_skipped_paths() {
        let source = "app Bounds\nGiven\n Item {value:int=0}\n policy Item read=members\nWhen\n scenario probe(owner:Item,items:Item[]) by=members\n  do\n   if owner.value>0\n    for item in items limit=3\n     set item {value=item.value+1}\nThen\n";
        let ScenarioDisclosure::Complete(plan) = checked(source) else {
            panic!("guarded bounded loop")
        };
        assert_eq!(plan.returns.len(), 3);
        for path in &plan.returns {
            let controls = path
                .dependencies
                .iter()
                .filter(|dependency| dependency.role == DependencyRole::Control)
                .collect::<Vec<_>>();
            assert_eq!(controls.len(), 1);
            assert_eq!(
                source[controls[0].node.start as usize..controls[0].node.end as usize].trim(),
                "owner.value"
            );
        }
        assert_eq!(
            plan.returns
                .iter()
                .filter(|path| path.dependencies.len() == 1)
                .count(),
            2
        );
        assert_eq!(
            plan.returns
                .iter()
                .filter(|path| path.dependencies.len() == 2)
                .count(),
            1
        );
    }
}
