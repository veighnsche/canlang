//! Checked return-specific provenance, before lowering erases lexical identities.
//!
//! These facts are not grants. Only `Complete` may become a disclosure plan.
//! A failed closure declines the whole scenario, including earlier returns.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::catalog::{Catalog, Effects, SigType, nominal_schema, std_capability, std_operation};
use super::effects::{DeleteMode, Effect, EffectTables, EffectTarget, EffectVerb, HandlerSource};
use super::resolve::{
    Binding, ContextVar, ModelOwner, ResolveTables, ScopedName, SymbolKind, TypeRef,
};
use super::types::{
    CheckedQuery, CheckedQueryClauseKind, CheckedQueryProjectionField,
    CheckedQueryProjectionMapping, SelectedCallTarget, checked_standard_nominal_name,
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
    /// Exact candidate-only ordinary occurrence of an existing checked query.
    /// Other reads, including query-local controls, keep their normal obligation.
    pub query_id: Option<String>,
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

#[derive(Debug, Clone, PartialEq)]
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
    pub alias: Option<NodeKey>,
    pub predicate: Option<NodeKey>,
    pub inputs: Vec<(NodeKey, SymbolId)>,
    pub dependencies: Vec<DisclosureDependency>,
    pub order: Vec<DisclosureQueryOrder>,
    pub limit: Option<u16>,
    pub archived: bool,
    pub cardinality_guard: Option<NodeKey>,
    pub return_node: NodeKey,
    pub projection: Option<DisclosureQueryProjection>,
    /// Exact original first invocation and its immutable selected-row binding.
    pub first: Option<DisclosureFirstQuery>,
    /// Original count invocation; this source inventory issues no query handle.
    pub count: Option<DisclosureCountQuery>,
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
    /// Reserved metadata order has no authored field declaration.
    pub field: Option<SymbolId>,
    pub field_name: String,
    pub descending: bool,
    pub node: NodeKey,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureFirstQuery {
    pub call: NodeKey,
    pub overload: usize,
    pub binding: NodeKey,
    pub operand: NodeKey,
    /// Later `and`-conjunct operands in source order; empty for a single
    /// predicate. The first conjunct stays in `operand` so single-predicate
    /// readers keep working unchanged.
    pub extra_operands: Vec<NodeKey>,
    /// DESIGN442 guard-consumed mark: the confined single-`Let(first)` plus
    /// single-`Require` hook slice consumes this occurrence only as a
    /// decision (hook_first_event + checked_first_query_source +
    /// first_query_stored_require_read). The `Require` grants nothing, so
    /// the native host may evaluate its declared control reads as a
    /// recorded owner decision instead of a viewer grant. False preserves
    /// ordinary viewer behavior everywhere else.
    pub guard_consumed: bool,
    /// DESIGN442 presence-consumed mark: the same confined slice whose
    /// `Require` consumes only the first binding's presence
    /// (`require budget != null`, no stored-field read). Still a
    /// source-consuming decision with no stored-field require dependency,
    /// so viewer projection must not silently turn present into null.
    /// Unused bindings and `require true` reference nothing and stay
    /// unmarked; body/value copies stay viewer.
    pub presence_consumed: bool,
    /// A true contained Member scans this original required parent parameter.
    /// An unscoped model scan has no contained parent selector. Mirrors the
    /// count contained-parent correspondence; the predicate operand keeps its
    /// own separate input entry.
    pub contained_parent: Option<(NodeKey, SymbolId)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureCountQuery {
    pub call: NodeKey,
    pub overload: usize,
    pub slots: Vec<Option<usize>>,
    pub statement: NodeKey,
    /// A true contained Member scans this original required parent parameter.
    /// An unscoped model scan has no contained parent selector.
    pub contained_parent: Option<(NodeKey, SymbolId)>,
    /// Actual metadata occurrences in the original predicate, in operand order.
    /// These are ownership facts, never fabricated authored field identities.
    pub parent_edges: Vec<DisclosureQueryParentEdge>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureQueryParentEdge {
    pub node: NodeKey,
    pub receiver: NodeKey,
    pub child: SymbolId,
    pub parent: SymbolId,
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
    /// Checked lexical producer of a singular stored result.
    /// This is source provenance; the native owner must bind its current row.
    pub(crate) model_result: Option<DisclosureModelResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DisclosureModelResult {
    Reference {
        model: SymbolId,
        node: NodeKey,
        source_model: SymbolId,
        field: SymbolId,
    },
    Parameter {
        model: SymbolId,
        parameter: SymbolId,
        node: NodeKey,
    },
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
            Self::Reference { model, .. }
            | Self::Parameter { model, .. }
            | Self::Create { model, .. }
            | Self::Call { model, .. } => model,
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
    /// Checked model-trait leaves retain their attachment identity, never
    /// fabricated authored Field nodes.
    pub(crate) contributed: Vec<CheckedScenarioContributedField>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CheckedScenarioContributedField {
    pub field: SymbolId,
    pub canonical: String,
    pub source: DisclosureSource,
    pub span: crate::source::Span,
    pub ty: ResolvedType,
    pub value: super::types::GivenContributedField,
    pub constraints: Option<super::resolve::CheckedValueConstraints>,
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
    /// Receiving-to-source declaration chain for exact field-trait normalization.
    /// Defaults remain receiving-owned; inherited entries supply only constraints.
    pub(crate) modifier_sources: Vec<(
        super::effects::FieldData,
        DisclosureSource,
        ResolvedType,
        Option<SymbolId>,
        Vec<super::types::GivenContributedField>,
    )>,
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
    ForMember {
        domain: NodeKey,
        limit: NodeKey,
        maximum: u16,
        item: String,
        parameter: SymbolId,
        model: SymbolId,
        body: Vec<NodeKey>,
    },
    Emit {
        event: SymbolId,
    },
    Schedule {
        event: SymbolId,
    },
    Cancel {},
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
    /// Exact resolved declared role at the original bare by= occurrence.
    pub(crate) by_role: Option<(NodeKey, SymbolId, String)>,
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
    /// Original supported query occurrences; this inventory grants no closure.
    /// Unhandled query uses still decline the executable scenario independently.
    pub queries: Option<Vec<DisclosureQuery>>,
    /// Original transcript invocations and eager row projections, source only.
    pub(crate) transcripts: Option<Vec<CheckedTranscriptSource>>,
    /// Exact original WHERE-bound inline TextMessage selection; no query/File grant.
    pub(crate) inline_selections: Option<Vec<CheckedInlineSelectionSource>>,
    /// Private owning stored-field/Contract snapshots and two-parent Model
    /// source operands. File declarations here grant no receipt admission.
    pub(crate) stored_contracts: Option<Vec<CheckedStoredContractSchema>>,
}

/// This catalog projection is not a local Contract and issues no row/File grant.
/// Retained source anchors await the defining native projection consumer.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CheckedTranscriptSource {
    pub id: String,
    pub source: DisclosureSource,
    pub derive: SymbolId,
    pub declaration: NodeKey,
    pub body: NodeKey,
    pub call: NodeKey,
    pub statement: NodeKey,
    pub slots: Vec<Option<usize>>,
    pub argument: NodeKey,
    pub parameter: SymbolId,
    pub formal: SymbolId,
    pub branch: SymbolId,
    pub prefix: SymbolId,
    pub prefix_node: NodeKey,
    pub prefix_max: NodeKey,
    pub query: CheckedQuery,
    pub model: SymbolId,
    pub alias: NodeKey,
    pub order: SymbolId,
    pub order_node: NodeKey,
    /// Original query ordering is separate from eager selected DATA fields.
    pub order_dependency: DisclosureDependency,
    pub select: NodeKey,
    pub ty: ResolvedType,
    pub fields: Vec<CheckedTranscriptField>,
    /// Actual eager selection reads, in authored TextMessage field order.
    /// Each dependency retains the original owning helper invocation chain.
    pub dependencies: Vec<DisclosureDependency>,
    /// Query candidate attribution is distinct from the ordinary selected
    /// DATA observations carried by consuming Returns and selection metadata.
    pub query_dependencies: Vec<DisclosureDependency>,
    pub influences: Vec<DisclosureInfluence>,
}

/// The original regenerate prefix query is not the WHERE-free transcript helper.
/// All selected keys use the catalog identity; only real stored source fields have IDs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CheckedInlineSelectionSource {
    pub query: DisclosureQuery,
    pub checked: CheckedQuery,
    pub statement: NodeKey,
    pub value: NodeKey,
    pub parameter: SymbolId,
    pub argument: NodeKey,
    pub parent: DisclosureQueryParentEdge,
    pub prefix_parent: DisclosureQueryParentEdge,
    pub parent_dependency: DisclosureDependency,
    pub prefix: SymbolId,
    pub prefix_node: NodeKey,
    pub prefix_max: NodeKey,
    pub bound_node: NodeKey,
    pub bound_field: SymbolId,
    pub bound_dependency: DisclosureDependency,
    pub order_dependency: DisclosureDependency,
    pub predicate_dependency: DisclosureDependency,
    pub select: NodeKey,
    pub ty: ResolvedType,
    pub fields: Vec<CheckedTranscriptField>,
    pub dependencies: Vec<DisclosureDependency>,
    pub expression_types: Option<Vec<(NodeKey, ResolvedType)>>,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub(crate) struct CheckedTranscriptField {
    pub name: String,
    pub key_node: NodeKey,
    pub value_node: NodeKey,
    pub source_field: SymbolId,
    pub ty: ResolvedType,
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
    /// Original checked Given attachment, never a fabricated authored Field.
    pub contributed: Option<CheckedScenarioContributedField>,
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

/// Executed Require field reads remain separate from result disclosure.
/// Original occurrence identities are evidence, never runtime field grants.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CheckedRequireConsumption {
    pub statement: NodeKey,
    pub condition: NodeKey,
    pub dependencies: Vec<DisclosureDependency>,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioDisclosure {
    pub source_facts: Option<Box<CheckedScenarioSource>>,
    pub scenario: SymbolId,
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub returns: Vec<DisclosureReturn>,
    pub effects: Vec<DisclosureEffect>,
    pub(crate) require_consumptions: Vec<CheckedRequireConsumption>,
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
    analyze_scenario_disclosure_with_catalog(db, trees, resolve, types, effects, None)
}

pub(super) fn analyze_scenario_disclosure_with_catalog<'a>(
    db: &'a SourceDb,
    trees: &'a [(SourceId, SyntaxNode)],
    resolve: &'a ResolveTables,
    types: &'a TypeTable,
    effects: &'a EffectTables,
    catalog: Option<&'a Catalog>,
) -> HashMap<SymbolId, ScenarioDisclosure> {
    let mut nodes = HashMap::new();
    let mut pending: Vec<_> = trees.iter().map(|(_, tree)| tree).collect();
    while let Some(node) = pending.pop() {
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter());
    }
    let mut cx = Closure {
        catalog,
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
        require_consumptions: Vec::new(),
        effect_visits: 0,
        loop_node: None,
        complete_children: HashSet::new(),
        complete_model_children: HashMap::new(),
        result_model: None,
        statement_expressions: None,
        source_facts: RefCell::new(ImmutableSourceFacts::default()),
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
            cx.require_consumptions.clear();
            cx.loop_node = None;
            cx.effect_visits = 0;
            cx.result_model = None;
            let result = (|| {
                // C23 hook slice: a handler with an admitted first-query fact
                // may prove its closure below; every other trusted shape
                // keeps this refusal, and the finite-query fast path never
                // applies to handlers.
                if scenario.on.is_some() && cx.hook_first_complete(scenario).is_none() {
                    return Err(cx.fail(scenario.node, "trusted handler"));
                }
                if scenario.on.is_none()
                    && let Some(plan) = cx.complete_query(scenario)?
                {
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
                    if let Some(model) = cx.nullable_model_input(scenario, param) {
                        supplied.record = Some(model);
                        supplied.reference_origin =
                            Some(ReferenceOrigin::NullableParameter(param.param));
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
                // Finite first-query slice D (CAN18-v1): allow exactly one
                // whole-row replay (`return <first-let>`, proven narrow at
                // its return arm) alongside a same-model create. All other
                // provenance gaps (including bare direct returns) stay refused.
                if let Some(model) = cx.result_model
                    && returns.iter().any(|returned| match returned.model_result
                    {
                        Some(origin) => origin.model() != model,
                        None => {
                            !(returns.len() == 2
                                && returns
                                    .iter()
                                    .filter(|returned| {
                                        returned.model_result.is_none()
                                    })
                                    .count()
                                    == 1)
                        }
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
                    require_consumptions: cx.require_consumptions.clone(),
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
        let mut facts = cx.checked_source_facts(scenario).map(Box::new);
        // DESIGN442 guard/presence-consumed marks: the confined
        // single-`Let(first)` plus single-`Require` hook slice
        // (hook_first_event) consumes its first-query occurrence only as a
        // decision. Mark the skeleton's own `Let` occurrence exactly when
        // the admitted first query exists (checked_first_query_source) and
        // the `Require` consumes either a stored read derived from it
        // (first_query_stored_require_read, already the
        // execution-dependency filter) or its bare presence
        // (`require budget != null`, no stored-field read). Anything else —
        // unused bindings, `require true`, unconfined shapes — keeps
        // ordinary viewer behavior.
        if let (Some(facts), Some(ScenarioDisclosure::Complete(checked))) =
            (facts.as_mut(), out.get(&scenario.scenario))
        {
            if cx.hook_first_event(scenario).is_some() {
                // The skeleton above already proved the 2-effect shape; the
                // re-match only recovers the nodes without re-proving it.
                if let [binding, guard] = scenario.effects.as_slice() {
                    let stored = checked
                        .require_consumptions
                        .iter()
                        .flat_map(|consumption| consumption.dependencies.iter())
                        .any(|dependency| {
                            cx.first_query_stored_require_read(dependency, scenario.module)
                        });
                    let presence = guard.cond.is_some_and(|cond| {
                        cx.first_binding_presence_consumed(binding, cond)
                    });
                    if stored || presence {
                        for query in facts
                            .queries
                            .iter_mut()
                            .flatten()
                            .filter(|query| query.first.is_some())
                        {
                            if let Some(first) = query.first.as_mut() {
                                if first.binding != binding.node {
                                    continue;
                                }
                                if stored {
                                    first.guard_consumed = true;
                                } else {
                                    first.presence_consumed = true;
                                }
                            }
                        }
                    }
                }
            }
            // Ordinary-scenario guard slice (CAN18-v1 first-query absence
            // conjunctions): the confined let-first + require-conjunction +
            // create + scalar-return skeleton consumes the first binding
            // plus stored control reads as its Require decision. Mark
            // guard-consumed only when a stored read is present; bare
            // presence stays unmarked under the pure-control profile.
            // Anything else keeps ordinary viewer behavior.
            if let Some((binding, guard)) = cx.ordinary_first_decision(scenario) {
                let stored = checked
                    .require_consumptions
                    .iter()
                    .flat_map(|consumption| consumption.dependencies.iter())
                    .any(|dependency| {
                        cx.first_query_stored_require_read(dependency, scenario.module)
                    });
                let presence = guard.cond.is_some_and(|cond| {
                    cx.first_binding_presence_consumed(binding, cond)
                });
                if stored && presence {
                    for query in facts
                        .queries
                        .iter_mut()
                        .flatten()
                        .filter(|query| query.first.is_some())
                    {
                        if let Some(first) = query.first.as_mut() {
                            if first.binding != binding.node {
                                continue;
                            }
                            first.guard_consumed = true;
                        }
                    }
                }
            }
        }
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
/// The selected helper closure: every derive body the checked decision walk
/// may descend into from a sealed read. Derive bodies are small one-step
/// helpers; the Given/When bulk around them stays unindexed.
fn helper_closure_keys(effects: &EffectTables) -> HashSet<NodeKey> {
    let mut required = HashSet::new();
    for data in effects.derives.values() {
        required.extend(data.expr);
        for param in &data.params {
            required.extend(param.default);
        }
    }
    required
}

/// Exact-consumed CST scope for one seal read: the required anchors plus the
/// selected helper closure. Unrelated bulk never spends the finite node
/// budget (same 200k entries/depth 256 bounds); a missing anchor refuses
/// exactly like the previous whole-tree map did.
fn pruned_closure_nodes<'t>(
    trees: &'t [(SourceId, SyntaxNode)],
    anchors: &HashSet<NodeKey>,
    effects: &EffectTables,
) -> Option<HashMap<NodeKey, &'t SyntaxNode>> {
    let mut required = anchors.clone();
    required.extend(helper_closure_keys(effects));
    let contains = |node: &SyntaxNode, key: &NodeKey| {
        node.span.file == key.file && node.span.start <= key.start && node.span.end >= key.end
    };
    fn index_subtree<'t>(
        node: &'t SyntaxNode,
        depth: usize,
        nodes: &mut HashMap<NodeKey, &'t SyntaxNode>,
    ) -> Option<()> {
        let mut pending = vec![(node, depth)];
        while let Some((node, depth)) = pending.pop() {
            if nodes.len() >= 200000 || depth > 256 {
                return None;
            }
            nodes.insert(NodeKey::of(node), node);
            pending.extend(node.children.iter().map(|child| (child, depth + 1)));
        }
        Some(())
    }
    let mut nodes = HashMap::new();
    for (_, tree) in trees {
        if !required.iter().any(|key| contains(tree, key)) {
            continue;
        }
        let mut pending = vec![(tree, 0usize)];
        while let Some((node, depth)) = pending.pop() {
            if nodes.len() >= 200000 || depth > 256 {
                return None;
            }
            if required.contains(&NodeKey::of(node)) {
                index_subtree(node, depth, &mut nodes)?;
                continue;
            }
            pending.extend(
                node.children
                    .iter()
                    .filter(|child| required.iter().any(|key| contains(child, key)))
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    Some(nodes)
}

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
    // Only this policy plus the selected helper closure spend the finite
    // node budget. Unrelated bulk remains in the checked cohort unindexed.
    let mut anchors = HashSet::from([policy.node]);
    anchors.extend(policy.read);
    anchors.extend(policy.where_predicate);
    let nodes = pruned_closure_nodes(trees, &anchors, effects)?;
    let node = nodes.get(&policy.node)?;
    let text = &db.get(policy.node.file)?.text;
    if node.kind != SyntaxKind::Policy
        || super::attribute_value(node, "read", text).map(NodeKey::of) != policy.read
        || super::attribute_value(node, "where", text).map(NodeKey::of) != policy.where_predicate
    {
        return None;
    }
    let cx = Closure {
        catalog: None,
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
        require_consumptions: Vec::new(),
        effect_visits: 0,
        loop_node: None,
        complete_children: HashSet::new(),
        complete_model_children: HashMap::new(),
        result_model: None,
        statement_expressions: None,
        source_facts: RefCell::new(ImmutableSourceFacts::default()),
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
    // Only this page, query and predicate plus the selected helper closure
    // spend the finite node budget. Unrelated bulk remains unindexed.
    let anchors = HashSet::from([page, query, *predicate]);
    let nodes = pruned_closure_nodes(trees, &anchors, effects)?;
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
        catalog: None,
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
        require_consumptions: Vec::new(),
        effect_visits: 0,
        loop_node: None,
        complete_children: HashSet::new(),
        complete_model_children: HashMap::new(),
        result_model: None,
        statement_expressions: None,
        source_facts: RefCell::new(ImmutableSourceFacts::default()),
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

/// Complete original callable census for a checked Boolean page requirement or
/// derived field. The codegen consumer independently authenticates its owner.
#[allow(clippy::too_many_arguments)]
pub fn checked_read_boolean_site(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    resolve: &ResolveTables,
    types: &TypeTable,
    effects: &EffectTables,
    module: ModuleId,
    owner: SymbolId,
    predicate: NodeKey,
    statement: NodeKey,
) -> Option<CheckedDecisionSite> {
    // A Boolean result never defines permission to read (DESIGN §3): the
    // caller admits every valid derived/page consumer shape, including
    // non-Boolean derived fields reusing this same observer join. The
    // predicate type still travels in each serialized call argument.
    let collected = collect_read_calls(db, trees, resolve, types, effects, module, predicate)?;
    Some(CheckedDecisionSite {
        owner,
        source: collected.source,
        node: predicate,
        statement,
        stage: CheckedDecisionStage::ReadPredicate,
        position: Vec::new(),
        calls: collected.calls,
    })
}

/// Owning call set behind a checked read observer: the verified source origin
/// plus every checked decision call under the predicate, in source order.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectedReadCalls {
    pub source: DisclosureSource,
    pub calls: Vec<CheckedDecisionCall>,
}

/// Model- or page-scoped callers wrap this with their own owner/stage; a
/// page without a record owner serializes the same set without inventing one.
#[allow(clippy::too_many_arguments)]
pub fn collect_read_calls(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    resolve: &ResolveTables,
    types: &TypeTable,
    effects: &EffectTables,
    module: ModuleId,
    predicate: NodeKey,
) -> Option<CollectedReadCalls> {
    // Only this predicate plus the selected helper closure spend the finite
    // node budget. Unrelated bulk remains in the checked cohort unindexed.
    let nodes = pruned_closure_nodes(trees, &HashSet::from([predicate]), effects)?;
    let cx = Closure {
        catalog: None,
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
        require_consumptions: Vec::new(),
        effect_visits: 0,
        loop_node: None,
        complete_children: HashSet::new(),
        complete_model_children: HashMap::new(),
        result_model: None,
        statement_expressions: None,
        source_facts: RefCell::new(ImmutableSourceFacts::default()),
    };
    let mut calls = Vec::new();
    cx.checked_decision_expression(
        predicate,
        module,
        &[],
        &mut HashSet::new(),
        &mut calls,
        &mut 0,
        &mut 0,
        0,
    )?;
    Some(CollectedReadCalls {
        source: cx.source(module, predicate).ok()?,
        calls,
    })
}

/// Finite membership dependency through the selected derive calls, including
/// calls in argument defaults. This grants no execution authority.
pub fn expression_reads_membership(
    types: &TypeTable,
    effects: &EffectTables,
    root: NodeKey,
) -> bool {
    let mut pending = vec![root];
    let mut seen = HashSet::new();
    while let Some(key) = pending.pop() {
        if !seen.insert(key) {
            continue;
        }
        if seen.len() > 4096 {
            return false;
        }
        for (node, selected) in &types.selected_calls {
            if node.file != key.file || node.start < key.start || node.end > key.end {
                continue;
            }
            match &selected.target {
                SelectedCallTarget::Builtin { id, .. } if id == "active_member" => return true,
                SelectedCallTarget::DeriveFn(id) => {
                    if let Some(data) = effects.derives.get(id) {
                        pending.extend(data.expr);
                        for (param, slot) in data.params.iter().zip(&selected.slots) {
                            if slot.is_none() {
                                pending.extend(param.default);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    false
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

#[derive(Debug, Clone, Default, PartialEq)]
struct ValuePath {
    reads: Vec<DisclosureDependency>,
    intrinsics: Vec<DisclosureIntrinsic>,
    observed: Vec<(NodeKey, Vec<NodeKey>)>,
    decisions: Vec<DisclosureDecision>,
    influences: Vec<DisclosureInfluence>,
    /// Original first call and Let; never a copied/foreign record receiver.
    first_query: Option<(NodeKey, NodeKey)>,
    /// Only the original guarded current Let can own this stored Revision.
    current_revision: Option<NodeKey>,
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
    /// Only exact transcript-origin TextMessage concat/count consumers use these.
    transcript_messages: Option<NodeKey>,
    transcript_count: bool,
    contract_value: Option<ContractValue>,
    /// Original input and at most two checked implicit containment edges.
    reference_origin: Option<ReferenceOrigin>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReferenceOrigin {
    Parameter(SymbolId),
    /// Required Model slot reached through the original Contract parameter.
    ParameterMember {
        parameter: SymbolId,
        node: NodeKey,
    },
    /// Canonical optional input slot; no row/version intrinsic or field promotion.
    NullableParameter(SymbolId),
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

/// Original successful Template.current guard and its one lexical Revision.
/// This is source lineage, never a nullable row facade or runtime admission.
#[derive(Debug, Clone)]
struct CurrentRevisionSource {
    parameter: SymbolId,
    template: SymbolId,
    field: SymbolId,
    revision: SymbolId,
    active: Option<(NodeKey, SymbolId)>,
    presence: NodeKey,
    presence_read: NodeKey,
    published: NodeKey,
    published_read: NodeKey,
    binding: NodeKey,
    value: NodeKey,
    digest_presence: NodeKey,
    digest_read: NodeKey,
}

impl ValuePath {
    fn join(&mut self, other: &Self) {
        for influence in &other.influences {
            if !self.influences.iter().any(|prior| prior.id == influence.id) {
                self.influences.push(influence.clone());
            }
        }
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

/// Reuse completed compiler analysis, never an evaluated application value.
/// Every lexical value and its ordered provenance participate in equality.
struct CompletedStatementExpression {
    node: NodeKey,
    module: ModuleId,
    calls: Vec<NodeKey>,
    authorization: bool,
    result_model: Option<SymbolId>,
    env: Env,
    values: Vec<ValuePath>,
}

/// Completed source checks against this Closure's immutable analysis tables.
/// No lexical environment, traversal state, or recursive prerequisite is cached.
#[derive(Default)]
struct ImmutableSourceFacts {
    models: HashMap<(SymbolId, ModuleId), Option<Rc<CheckedScenarioCreatedModel>>>,
    revisions: HashMap<(SymbolId, ModuleId, NodeKey), Option<CurrentRevisionSource>>,
    revision_owners: HashMap<(NodeKey, ModuleId), Option<CurrentRevisionSource>>,
}

struct Closure<'a> {
    complete_children: HashSet<SymbolId>,
    complete_model_children: HashMap<SymbolId, SymbolId>,
    result_model: Option<SymbolId>,
    catalog: Option<&'a Catalog>,
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
    require_consumptions: Vec<CheckedRequireConsumption>,
    effect_visits: usize,
    loop_node: Option<NodeKey>,
    statement_expressions: Option<Vec<CompletedStatementExpression>>,
    source_facts: RefCell<ImmutableSourceFacts>,
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
    /// Presence here is the original admitted input slot, not a stored field
    /// or a fabricated observation. Runtime input/hash/ref admission owns it.
    fn nullable_model_input(
        &self,
        scenario: &super::effects::ScenarioData,
        parameter: &super::effects::ParamData,
    ) -> Option<SymbolId> {
        let symbol = self.resolve.symbols.get(parameter.param.0 as usize)?;
        let SymbolKind::Param {
            owner,
            index,
            type_node,
        } = symbol.kind
        else {
            return None;
        };
        let ResolvedType::Nullable(inner) = self.types.symbol_types.get(&parameter.param)? else {
            return None;
        };
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = inner.as_ref()
        else {
            return None;
        };
        let default = parameter.default?;
        let node = self.nodes.get(&default)?;
        if owner != scenario.scenario
            || symbol.module != scenario.module
            || scenario.params.get(index)?.param != parameter.param
            || type_node != parameter.type_node
            || scenario.read
            || scenario.on.is_some()
            || default.file != scenario.node.file
            || node.kind != SyntaxKind::Literal
            || self.word(node) != Some("null")
            || self.types.node_types.get(&default) != Some(&ResolvedType::Null)
            || !matches!(
                self.resolve.symbols.get(model.0 as usize)?.kind,
                SymbolKind::Model { .. }
            )
        {
            return None;
        }
        Some(*model)
    }

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

    /// The original successful presence/published guard narrows exactly one
    /// required Template.current into its original lexical Revision binding.
    fn checked_current_revision_source(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<CurrentRevisionSource> {
        // Only the immutable table's own declaration can use its identity key.
        // A copied or altered declaration still receives the full source check.
        if !self
            .effects
            .scenarios
            .get(&scenario.scenario)
            .is_some_and(|original| std::ptr::eq(original, scenario))
        {
            return self.check_current_revision_source(scenario);
        }
        let key = (scenario.scenario, scenario.module, scenario.node);
        if let Some(result) = self.source_facts.borrow().revisions.get(&key) {
            return result.clone();
        }
        let result = self.check_current_revision_source(scenario);
        self.source_facts
            .borrow_mut()
            .revisions
            .insert(key, result.clone());
        result
    }

    fn check_current_revision_source(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<CurrentRevisionSource> {
        if scenario.read
            || scenario.on.is_some()
            || scenario.module.0 as usize >= self.resolve.modules.len()
        {
            return None;
        }
        let mut candidates = scenario
            .effects
            .iter()
            .enumerate()
            .filter_map(|(index, binding)| {
                if binding.verb != EffectVerb::Let || binding.binding.is_none() {
                    return None;
                }
                let value = self.query_group(binding.value?)?;
                let (receiver, name) = self.count_member(value)?;
                if name != "current" {
                    return None;
                }
                let parameter = self.query_parameter(scenario, receiver)?;
                let ResolvedType::Record {
                    symbol: template,
                    stored: true,
                } = self.types.symbol_types.get(&parameter)?
                else {
                    return None;
                };
                Some((index, binding, value, parameter, *template))
            });
        let (index, binding, value, parameter, template) = candidates.next()?;
        if candidates.next().is_some()
            || scenario.effects[..index]
                .iter()
                .any(|effect| !matches!(effect.verb, EffectVerb::Let | EffectVerb::Require))
        {
            return None;
        }
        let template_definition = self.checked_created_model(template, scenario.module)?;
        let field = template_definition
            .fields
            .iter()
            .find(|field| field.name == "current")?;
        let current_data = template_definition
            .declaration
            .fields
            .iter()
            .find(|data| data.field == field.field)?;
        let ResolvedType::Nullable(inner) = &field.ty else {
            return None;
        };
        let ResolvedType::Record {
            symbol: revision,
            stored: true,
        } = inner.as_ref()
        else {
            return None;
        };
        let revision = *revision;
        let revision_definition = self.checked_created_model(revision, scenario.module)?;
        let revision_symbol = self.resolve.symbols.get(revision.0 as usize)?;
        let parameter_data = scenario
            .params
            .iter()
            .find(|data| data.param == parameter)?;
        let parameter_symbol = self.resolve.symbols.get(parameter.0 as usize)?;
        let text = &self.db.get(scenario.node.file)?.text;
        if !matches!(revision_symbol.kind,SymbolKind::Model {owner:ModelOwner::ChildOf(parent),..} if parent==template)
            || revision_definition.declaration.owner != ModelOwner::ChildOf(template)
            || current_data.default.is_some()
            || current_data.server.is_some()
            || current_data.required_array
            || self.types.field_reuse_sources.contains_key(&field.field)
            || !matches!(parameter_symbol.kind,SymbolKind::Param {owner,type_node,..} if owner==scenario.scenario && type_node==parameter_data.type_node)
            || parameter_symbol.module != scenario.module
            || self.nodes.get(&binding.node)?.kind != SyntaxKind::Let
            || self.types.node_types.get(&value) != Some(inner.as_ref())
        {
            return None;
        }
        let is_current = |node: NodeKey, ty: &ResolvedType| {
            self.count_member(node).is_some_and(|(base,name)| {
                name=="current" && matches!(self.query_binding(base),Some(Binding::Symbol(id)) if *id==parameter)
                    && self.types.node_types.get(&base)==Some(&ResolvedType::Record {symbol:template,stored:true})
                    && self.types.node_types.get(&node)==Some(ty)
            })
        };
        if !is_current(value, inner) {
            return None;
        }
        let mut leading = None;
        for guard in &scenario.guards {
            if guard.verb != EffectVerb::Require {
                return None;
            }
            let cond = guard.cond?;
            let mut pending = vec![cond];
            let mut operands = Vec::new();
            while let Some(node) = pending.pop() {
                if operands.len() + pending.len() > 200 {
                    return None;
                }
                if let Some((left, right)) = self.query_binary(node, "and") {
                    pending.extend([right, left]);
                } else {
                    operands.push(self.query_group(node)?);
                }
            }
            for (position, pair) in operands.windows(2).enumerate() {
                let Some((read, null)) = self.query_binary(pair[0], "!=") else {
                    continue;
                };
                let Some((published_read, name)) = self.count_member(pair[1]) else {
                    continue;
                };
                if is_current(read, &field.ty)
                    && self.nodes.get(&null)?.kind == SyntaxKind::Literal
                    && self.word(self.nodes.get(&null)?) == Some("null")
                    && self.types.node_types.get(&null) == Some(&ResolvedType::Null)
                    && name == "published"
                    && is_current(published_read, inner)
                    && self.types.node_types.get(&pair[0])
                        == Some(&ResolvedType::Scalar(Scalar::Bool))
                    && self.types.node_types.get(&pair[1])
                        == Some(&ResolvedType::Scalar(Scalar::Bool))
                    && guard.node.end <= binding.node.start
                {
                    if leading.is_some() {
                        return None;
                    }
                    let active = operands.get(position.wrapping_sub(1)).and_then(|node| {
                        let (receiver, name) = self.count_member(*node)?;
                        if name != "active" {
                            return None;
                        }
                        let active = template_definition.fields.iter().find(|field| field.name == "active")?;
                        let declaration = template_definition.declaration.fields.iter().find(|field| field.field == active.field)?;
                        (matches!(self.query_binding(receiver), Some(Binding::Symbol(id)) if *id == parameter)
                            && self.types.node_types.get(&receiver) == Some(&ResolvedType::Record { symbol: template, stored: true })
                            && self.types.node_types.get(node) == Some(&ResolvedType::Scalar(Scalar::Bool))
                            && active.ty == ResolvedType::Scalar(Scalar::Bool)
                            && declaration.server.is_none()
                            && !self.types.field_reuse_sources.contains_key(&active.field)
                            && text.get(declaration.type_node.start as usize..declaration.type_node.end as usize)?.trim() == "bool")
                            .then_some((*node, active.field))
                    });
                    leading = Some((active, pair[0], read, pair[1], published_read));
                }
            }
        }
        let (active, presence, presence_read, published, published_read) = leading?;
        let published_field = revision_definition
            .fields
            .iter()
            .find(|field| field.name == "published")?;
        if published_field.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        let digest_field = revision_definition
            .fields
            .iter()
            .find(|field| field.name == "digest")?;
        if digest_field.ty != ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text))) {
            return None;
        }
        let mut digest_presence = None;
        for effect in &scenario.effects[index + 1..] {
            if !matches!(effect.verb, EffectVerb::Let | EffectVerb::Require) {
                break;
            }
            if effect.verb != EffectVerb::Require {
                continue;
            }
            let Some((read, null)) = effect.cond.and_then(|cond| self.query_binary(cond, "!="))
            else {
                continue;
            };
            let Some((base, name)) = self.count_member(read) else {
                continue;
            };
            if name == "digest"
                && matches!(self.query_binding(base),Some(Binding::Let {node}) if *node==binding.node)
                && self.types.node_types.get(&base) == Some(inner.as_ref())
                && self.types.node_types.get(&read) == Some(&digest_field.ty)
                && self.types.node_types.get(&null) == Some(&ResolvedType::Null)
                && self.nodes.get(&null)?.kind == SyntaxKind::Literal
                && self.word(self.nodes.get(&null)?) == Some("null")
                && self.types.node_types.get(&effect.cond?)
                    == Some(&ResolvedType::Scalar(Scalar::Bool))
            {
                digest_presence = Some((self.query_group(effect.cond?)?, read));
                break;
            }
        }
        let (digest_presence, digest_read) = digest_presence?;
        Some(CurrentRevisionSource {
            parameter,
            template,
            field: field.field,
            revision,
            active,
            presence,
            presence_read,
            published,
            published_read,
            binding: binding.node,
            value,
            digest_presence,
            digest_read,
        })
    }

    fn current_revision_at(
        &self,
        node: NodeKey,
        module: ModuleId,
    ) -> Option<CurrentRevisionSource> {
        let key = (node, module);
        if let Some(result) = self.source_facts.borrow().revision_owners.get(&key) {
            return result.clone();
        }
        let result = self.check_current_revision_at(node, module);
        self.source_facts
            .borrow_mut()
            .revision_owners
            .insert(key, result.clone());
        result
    }

    fn check_current_revision_at(
        &self,
        node: NodeKey,
        module: ModuleId,
    ) -> Option<CurrentRevisionSource> {
        let mut owners = self.effects.scenarios.values().filter(|scenario| {
            scenario.module == module
                && scenario.node.file == node.file
                && scenario.node.start <= node.start
                && node.end <= scenario.node.end
        });
        let owner = owners.next()?;
        if owners.next().is_some() {
            return None;
        }
        self.checked_current_revision_source(owner)
    }

    fn checked_current_revision_leaf(
        &self,
        node: NodeKey,
        module: ModuleId,
    ) -> Option<(CurrentRevisionSource, SymbolId)> {
        let fact = self.current_revision_at(node, module)?;
        let (receiver, name) = self.count_member(node)?;
        if node != fact.published
            && !matches!(self.query_binding(receiver),Some(Binding::Let {node}) if *node==fact.binding)
        {
            return None;
        }
        if node == fact.published && receiver != fact.published_read {
            return None;
        }
        if self.types.node_types.get(&receiver)
            != Some(&ResolvedType::Record {
                symbol: fact.revision,
                stored: true,
            })
        {
            return None;
        }
        let definition = self.checked_created_model(fact.revision, module)?;
        let field = definition.fields.iter().find(|field| field.name == name)?;
        let declared = match name {
            "definition"
                if checked_standard_nominal_name(&field.ty) == Some("WorkflowDefinition") =>
            {
                field.ty.clone()
            }
            "published" => ResolvedType::Scalar(Scalar::Bool),
            "digest" => ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text))),
            "outputs" => ResolvedType::Scalar(Scalar::Int),
            "duration" => ResolvedType::Scalar(Scalar::Duration),
            _ => return None,
        };
        let data = definition
            .declaration
            .fields
            .iter()
            .find(|data| data.field == field.field)?;
        if field.ty != declared
            || name == "definition" && (data.default.is_some() || data.required_array)
            || data.server.is_some()
            || self.types.field_reuse_sources.contains_key(&field.field)
            || !matches!(self.resolve.symbols.get(field.field.0 as usize)?.kind,SymbolKind::Field {owner,..} if owner==fact.revision)
        {
            return None;
        }
        let actual = self.types.node_types.get(&node)?;
        if actual != &declared
            && !(name == "digest"
                && actual == &ResolvedType::Scalar(Scalar::Text)
                && fact.digest_presence.end <= node.start)
        {
            return None;
        }
        Some((fact, field.field))
    }

    fn current_revision_control(
        &self,
        dependency: &DisclosureDependency,
        module: ModuleId,
    ) -> bool {
        if !dependency.calls.is_empty() || dependency.query_id.is_some() {
            return false;
        }
        self.current_revision_at(dependency.node, module)
            .is_some_and(|fact| {
                dependency.model == fact.template
                    && dependency.field == fact.field
                    && [fact.presence_read, fact.published_read, fact.value]
                        .contains(&dependency.node)
                    || fact.active.is_some_and(|(node, field)| {
                        dependency.node == node
                            && dependency.model == fact.template
                            && dependency.field == field
                            && dependency.field_name == "active"
                            && dependency.ty == ResolvedType::Scalar(Scalar::Bool)
                    })
                    || self
                        .checked_current_revision_leaf(dependency.node, module)
                        .is_some_and(|(fact, field)| {
                            dependency.model == fact.revision
                                && dependency.field == field
                                && [fact.published, fact.digest_read].contains(&dependency.node)
                        })
            })
    }

    fn current_revision_member(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Option<Vec<ValuePath>>, DisclosureDecline> {
        if !calls.is_empty() || self.statement_depth != 1 || self.loop_node.is_some() {
            return Ok(None);
        }
        let Some(fact) = self.current_revision_at(key, module) else {
            return Ok(None);
        };
        if [fact.presence_read, fact.published_read, fact.value].contains(&key) {
            if !env.get(&Local::Symbol(fact.parameter)).is_some_and(|value| {
                value.record==Some(fact.template) && matches!(value.reference_origin,Some(ReferenceOrigin::Parameter(parameter)) if parameter==fact.parameter)
            }) {return Err(self.fail(key,"current Revision needs its original required Template"));}
            let ty = self
                .types
                .node_types
                .get(&key)
                .ok_or_else(|| self.fail(key, "missing checked current Revision occurrence"))?
                .clone();
            let owner = self
                .resolve
                .symbols
                .get(fact.template.0 as usize)
                .ok_or_else(|| self.fail(key, "missing current Revision source owner"))?;
            let target = self
                .resolve
                .symbols
                .get(fact.revision.0 as usize)
                .ok_or_else(|| self.fail(key, "missing current Revision target"))?;
            let nullable = matches!(ty, ResolvedType::Nullable(_));
            return Ok(Some(vec![ValuePath {
                reads: vec![DisclosureDependency {
                    id: self.opaque("read-data", key, &self.call_stamp(calls)?)?,
                    source: self.source(module, key)?,
                    node: key,
                    calls: Vec::new(),
                    role: DependencyRole::Data,
                    model: fact.template,
                    field: fact.field,
                    model_name: owner.canonical.clone(),
                    field_name: "current".into(),
                    ty,
                    type_id: format!("{}{}", target.canonical, if nullable { "?" } else { "" }),
                    query_id: None,
                }],
                observed: vec![(key, Vec::new())],
                record: Some(fact.revision),
                current_revision: Some(fact.binding),
                reference_origin: Some(ReferenceOrigin::Field {
                    parameter: fact.parameter,
                    model: fact.template,
                    field: fact.field,
                }),
                ..ValuePath::default()
            }]));
        }
        let Some((fact, field)) = self.checked_current_revision_leaf(key, module) else {
            return Ok(None);
        };
        let (base, _) = self
            .count_member(key)
            .ok_or_else(|| self.fail(key, "missing current Revision member"))?;
        let mut values = self.expr(base, module, env, calls)?;
        let declaration = self
            .resolve
            .symbols
            .get(field.0 as usize)
            .ok_or_else(|| self.fail(key, "missing current Revision field"))?;
        let model = self
            .resolve
            .symbols
            .get(fact.revision.0 as usize)
            .ok_or_else(|| self.fail(key, "missing current Revision model"))?;
        let ty = self
            .types
            .node_types
            .get(&key)
            .ok_or_else(|| self.fail(key, "missing current Revision leaf type"))?
            .clone();
        let type_id = if declaration.name == "definition"
            && checked_standard_nominal_name(&ty) == Some("WorkflowDefinition")
        {
            "WorkflowDefinition".into()
        } else {
            self.field_type_id(key, field, &ty)?
        };
        for value in &mut values {
            if value.current_revision != Some(fact.binding)
                || value.record != Some(fact.revision)
                || !matches!(value.reference_origin,Some(ReferenceOrigin::Field {parameter,model,field}) if parameter==fact.parameter && model==fact.template && field==fact.field)
            {
                return Err(self.fail(
                    key,
                    "current Revision leaf needs its exact original receiver",
                ));
            }
            value.reads.push(DisclosureDependency {
                id: self.opaque("read-data", key, &self.call_stamp(calls)?)?,
                source: self.source(module, key)?,
                node: key,
                calls: Vec::new(),
                role: DependencyRole::Data,
                model: fact.revision,
                field,
                model_name: model.canonical.clone(),
                field_name: declaration.name.clone(),
                ty: ty.clone(),
                type_id: type_id.clone(),
                query_id: None,
            });
            value.observed.push((key, Vec::new()));
            value.record = None;
            value.reference = None;
            value.reference_origin = None;
            value.current_revision = None;
        }
        Ok(Some(values))
    }

    /// The original required Branch.profile feeds only its owning scalars.
    fn checked_profile_reference(
        &self,
        node: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId, SymbolId, SymbolId)> {
        let (receiver, name) = self.count_member(node)?;
        let Some(Binding::Symbol(parameter)) = self.query_binding(receiver) else {
            return None;
        };
        let parameter = *parameter;
        let (branch, depth) = self.checked_call_parent_path(receiver, parameter, 0)?;
        let declaration = self.resolve.symbols.get(branch.0 as usize)?;
        let SymbolKind::Model { fields, .. } = &declaration.kind else {
            return None;
        };
        let parameter_symbol = self.resolve.symbols.get(parameter.0 as usize)?;
        let SymbolKind::Param {
            owner: scenario, ..
        } = parameter_symbol.kind
        else {
            return None;
        };
        let scenario = self.effects.scenarios.get(&scenario)?;
        let parameter_data = scenario
            .params
            .iter()
            .find(|param| param.param == parameter)?;
        let field = fields
            .iter()
            .filter_map(|field| self.resolve.symbols.get(field.0 as usize))
            .find(|field| field.name == name)?;
        let ResolvedType::Record {
            symbol: profile,
            stored: true,
        } = self.types.symbol_types.get(&field.id)?
        else {
            return None;
        };
        let profile = *profile;
        let target = self.resolve.symbols.get(profile.0 as usize)?;
        let data = self
            .effects
            .models
            .get(&branch)?
            .fields
            .iter()
            .find(|data| data.field == field.id)?;
        let text = &self.db.get(node.file)?.text;
        if name != "profile"
            || depth != 0
            || declaration.module != module
            || target.module != module
            || parameter_symbol.module != module
            || scenario.module != module
            || scenario.read
            || scenario.on.is_some()
            || node.file != scenario.node.file
            || node.start < scenario.node.start
            || node.end > scenario.node.end
            || !matches!(field.kind,SymbolKind::Field {owner,..} if owner == branch)
            || field.module != module
            || data.default.is_some()
            || data.server.is_some()
            || data.required_array
            || self.types.field_reuse_sources.contains_key(&field.id)
            || self.types.node_types.get(&node) != self.types.symbol_types.get(&field.id)
            || text
                .get(data.type_node.start as usize..data.type_node.end as usize)?
                .trim()
                != target.name
            || text
                .get(
                    parameter_data.type_node.start as usize..parameter_data.type_node.end as usize,
                )?
                .trim()
                != declaration.name
            || self.checked_created_model(branch, module).is_none()
            || self.checked_created_model(profile, module).is_none()
        {
            return None;
        }
        Some((parameter, branch, field.id, profile))
    }

    fn checked_profile_scalar(
        &self,
        node: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId, SymbolId, SymbolId, SymbolId)> {
        let (reference, name) = self.count_member(node)?;
        let (parameter, branch, reference_field, profile) =
            self.checked_profile_reference(reference, module)?;
        let expected = match name {
            "active" => Scalar::Bool,
            "system_prompt" | "provider_key" | "policy_revision" => Scalar::Text,
            "input_tokens" | "output_tokens" => Scalar::Int,
            "duration" => Scalar::Duration,
            _ => return None,
        };
        let declaration = self.resolve.symbols.get(profile.0 as usize)?;
        let SymbolKind::Model { fields, .. } = &declaration.kind else {
            return None;
        };
        let field = fields
            .iter()
            .filter_map(|field| self.resolve.symbols.get(field.0 as usize))
            .find(|field| field.name == name)?;
        let SymbolKind::Field {
            owner: field_owner,
            type_node,
        } = field.kind
        else {
            return None;
        };
        let data = self
            .effects
            .models
            .get(&profile)?
            .fields
            .iter()
            .find(|data| data.field == field.id)?;
        let authored = self.nodes.get(&data.node)?;
        let source = self.db.get(data.type_node.file)?;
        let ty = ResolvedType::Scalar(expected);
        if field_owner != profile
            || type_node != data.type_node
            || authored.kind != SyntaxKind::Field
            || !authored
                .children
                .iter()
                .any(|child| NodeKey::of(child) == data.type_node)
            || source
                .text
                .get(data.type_node.start as usize..data.type_node.end as usize)?
                .trim()
                != expected.as_str()
            || field.module != module
            || self.types.symbol_types.get(&field.id) != Some(&ty)
            || self.types.node_types.get(&node) != Some(&ty)
            || self.types.field_reuse_sources.contains_key(&field.id)
        {
            return None;
        }
        Some((parameter, branch, reference_field, profile, field.id))
    }

    /// The original leading unfinished guard consumes one required Turn.run
    /// and the genuine owning Run Bool. This is not Contract or generic row
    /// traversal, and it never admits a copied/defaulted/nullable receiver.
    fn checked_run_reference(
        &self,
        node: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId, SymbolId, SymbolId)> {
        let (receiver, name) = self.count_member(node)?;
        let Some(Binding::Symbol(parameter)) = self.query_binding(receiver) else {
            return None;
        };
        let parameter = *parameter;
        let (turn, depth) = self.checked_call_parent_path(receiver, parameter, 0)?;
        let declaration = self.resolve.symbols.get(turn.0 as usize)?;
        let SymbolKind::Model {
            fields,
            owner: turn_parent,
            ..
        } = &declaration.kind
        else {
            return None;
        };
        let parameter_symbol = self.resolve.symbols.get(parameter.0 as usize)?;
        let SymbolKind::Param {
            owner: scenario, ..
        } = parameter_symbol.kind
        else {
            return None;
        };
        let scenario = self.effects.scenarios.get(&scenario)?;
        let parameter_data = scenario
            .params
            .iter()
            .find(|param| param.param == parameter)?;
        let mut fields = fields
            .iter()
            .filter_map(|field| self.resolve.symbols.get(field.0 as usize))
            .filter(|field| field.name == name);
        let field = fields.next()?;
        let ResolvedType::Record {
            symbol: run,
            stored: true,
        } = self.types.symbol_types.get(&field.id)?
        else {
            return None;
        };
        let run = *run;
        let target = self.resolve.symbols.get(run.0 as usize)?;
        let SymbolKind::Model {
            owner: run_parent, ..
        } = &target.kind
        else {
            return None;
        };
        let data = self
            .effects
            .models
            .get(&turn)?
            .fields
            .iter()
            .find(|data| data.field == field.id)?;
        let by = scenario.by?;
        let text = &self.db.get(node.file)?.text;
        if name != "run"
            || depth != 0
            || fields.next().is_some()
            || !matches!((turn_parent, run_parent), (ModelOwner::ChildOf(left), ModelOwner::ChildOf(right)) if left == right)
            || declaration.module != module
            || target.module != module
            || parameter_symbol.module != module
            || scenario.module != module
            || scenario.read
            || scenario.on.is_some()
            || scenario.cohort.is_some()
            || !matches!(self.query_binding(by), Some(Binding::Predicate))
            || self
                .db
                .get(by.file)?
                .text
                .get(by.start as usize..by.end as usize)?
                .trim()
                != "members"
            || node.file != scenario.node.file
            || node.start < scenario.node.start
            || node.end > scenario.node.end
            || !matches!(field.kind, SymbolKind::Field {owner,..} if owner == turn)
            || field.module != module
            || data.default.is_some()
            || data.server.is_some()
            || data.required_array
            || self.types.field_reuse_sources.contains_key(&field.id)
            || self.types.node_types.get(&node) != self.types.symbol_types.get(&field.id)
            || text
                .get(data.type_node.start as usize..data.type_node.end as usize)?
                .trim()
                != target.name
            || text
                .get(
                    parameter_data.type_node.start as usize..parameter_data.type_node.end as usize,
                )?
                .trim()
                != declaration.name
            || self.checked_created_model(turn, module).is_none()
            || self.checked_created_model(run, module).is_none()
        {
            return None;
        }
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        // Find the real leading Require operand, not an arbitrary occurrence
        // with a matching span inside a default, helper, or do statement.
        let mut matched = false;
        let mut visited = 0usize;
        for guard in &scenario.guards {
            let condition = guard.cond?;
            if guard.verb != EffectVerb::Require
                || self.nodes.get(&guard.node)?.kind != SyntaxKind::Require
                || self.types.node_types.get(&condition) != Some(&boolean)
            {
                return None;
            }
            let mut pending = vec![*self.nodes.get(&condition)?];
            while let Some(candidate) = pending.pop() {
                visited += 1;
                if visited > 16384 {
                    return None;
                }
                if candidate.kind == SyntaxKind::Unary {
                    let operands: Vec<_> = candidate
                        .children
                        .iter()
                        .filter(|child| expression(child.kind))
                        .collect();
                    let words: Vec<_> = candidate
                        .children
                        .iter()
                        .filter(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))
                        .map(|child| self.word(child))
                        .collect::<Option<Vec<_>>>()?;
                    if let [leaf] = operands.as_slice()
                        && self.count_member(NodeKey::of(leaf)) == Some((node, "unfinished"))
                    {
                        if matched
                            || words != ["not"]
                            || self.types.node_types.get(&NodeKey::of(candidate)) != Some(&boolean)
                            || self.types.node_types.get(&NodeKey::of(leaf)) != Some(&boolean)
                        {
                            return None;
                        }
                        matched = true;
                    }
                }
                pending.extend(candidate.children.iter());
            }
        }
        matched.then_some((parameter, turn, field.id, run))
    }

    fn checked_run_unfinished(
        &self,
        node: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId, SymbolId, SymbolId, SymbolId)> {
        let (reference, name) = self.count_member(node)?;
        let (parameter, turn, reference_field, run) =
            self.checked_run_reference(reference, module)?;
        let SymbolKind::Model { fields, .. } = &self.resolve.symbols.get(run.0 as usize)?.kind
        else {
            return None;
        };
        let mut fields = fields
            .iter()
            .filter_map(|field| self.resolve.symbols.get(field.0 as usize))
            .filter(|field| field.name == name);
        let field = fields.next()?;
        let SymbolKind::Field { owner, type_node } = field.kind else {
            return None;
        };
        let data = self
            .effects
            .models
            .get(&run)?
            .fields
            .iter()
            .find(|data| data.field == field.id)?;
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        if name != "unfinished"
            || fields.next().is_some()
            || owner != run
            || type_node != data.type_node
            || field.module != module
            || self.types.symbol_types.get(&field.id) != Some(&boolean)
            || self.types.node_types.get(&node) != Some(&boolean)
            || self.types.field_reuse_sources.contains_key(&field.id)
            || self
                .db
                .get(type_node.file)?
                .text
                .get(type_node.start as usize..type_node.end as usize)?
                .trim()
                != "bool"
        {
            return None;
        }
        Some((parameter, turn, reference_field, run, field.id))
    }

    fn run_unfinished_control(&self, read: &DisclosureDependency, module: ModuleId) -> bool {
        read.calls.is_empty()
            && read.query_id.is_none()
            && read.field_name == "unfinished"
            && read.ty == ResolvedType::Scalar(Scalar::Bool)
            && self
                .checked_run_unfinished(read.node, module)
                .is_some_and(|(_, _, _, run, field)| read.model == run && read.field == field)
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
        // A required Model leaf in the original Contract parameter owns the
        // same admitted containment lineage as a direct Model parameter. Its
        // Contract selectors do not consume the two authored parent hops.
        if node.kind == SyntaxKind::Member {
            let module = self.resolve.symbols.get(parameter.0 as usize)?.module;
            if let Some((root, model, _)) = self.checked_contract_input_reference(key, module) {
                return (root == parameter).then_some((model, 0));
            }
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
        if self.types.given_fields.contains_key(&field) {
            let module = self
                .resolve
                .symbols
                .get(owner.0 as usize)
                .ok_or_else(|| self.fail(key, "missing contributed field owner"))?
                .module;
            let definition = self
                .checked_created_model(owner, module)
                .ok_or_else(|| self.fail(key, "unestablished contributed field schema"))?;
            let original = definition
                .contributed
                .iter()
                .find(|candidate| candidate.field == field)
                .ok_or_else(|| self.fail(key, "missing checked contributed field"))?;
            if &original.ty != ty {
                return Err(self.fail(key, "contributed field type mismatch"));
            }
            return exact_type_id(ty, self.resolve)
                .ok_or_else(|| self.fail(key, "unsupported contributed stored field type"));
        }
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
        let by_role = scenario.by.and_then(|node| {
            let authored = self.nodes.get(&node)?;
            if authored.kind != SyntaxKind::NameRef {
                return None;
            }
            let spelling = super::name_text(
                super::kids(authored).first()?,
                &self.db.get(node.file)?.text,
            )?;
            let id = match self
                .resolve
                .module_scopes
                .get(scenario.module.0 as usize)?
                .prod
                .get(spelling)?
            {
                ScopedName::Local(id)
                | ScopedName::Imported {
                    target: id,
                    bound: false,
                } => *id,
                _ => return None,
            };
            let role = self.resolve.symbols.get(id.0 as usize)?;
            matches!(role.kind, SymbolKind::Role).then(|| (node, id, role.canonical.clone()))
        });
        Some(CheckedScenarioSource {
            by_role,
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
            transcripts: self.checked_transcript_sources(scenario),
            inline_selections: self.checked_inline_selection_sources(scenario),
            stored_contracts: self.checked_stored_contracts(scenario),
        })
    }

    /// Retain only the original direct prefix+WHERE/ORDER/SELECT Let. This
    /// source inventory survives unrelated closure declines without granting execution.
    fn checked_inline_selection_sources(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<CheckedInlineSelectionSource>> {
        let mut out = Vec::new();
        for statement in &scenario.effects {
            if statement.verb != EffectVerb::Let {
                continue;
            }
            let Some(value) = statement.value else {
                continue;
            };
            let Some((_, selected)) = self.query_binary(value, "+") else {
                continue;
            };
            let Some(query) = self.query_group(selected) else {
                continue;
            };
            if self.nodes.get(&query)?.kind != SyntaxKind::Query
                || !self
                    .types
                    .node_types
                    .get(&query)
                    .is_some_and(transcript_message_array)
            {
                continue;
            }
            if out.len() >= 200 {
                return None;
            }
            out.push(self.checked_inline_selection_source(scenario, statement)?);
        }
        Some(out)
    }

    fn checked_inline_selection_source(
        &self,
        scenario: &super::effects::ScenarioData,
        statement: &Effect,
    ) -> Option<CheckedInlineSelectionSource> {
        if scenario.read
            || scenario.on.is_some()
            || statement.verb != EffectVerb::Let
            || !statement.then_effects.is_empty()
            || !statement.else_effects.is_empty()
            || !statement.match_arms.is_empty()
            || statement.when.is_some()
        {
            return None;
        }
        let value = statement.value?;
        let let_node = self.nodes.get(&statement.node)?;
        let values: Vec<_> = let_node
            .children
            .iter()
            .filter(|part| expression(part.kind))
            .map(NodeKey::of)
            .collect();
        let names: Vec<_> = let_node
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::Name)
            .map(|part| self.word(part))
            .collect::<Option<Vec<_>>>()?;
        if let_node.kind != SyntaxKind::Let
            || values != [value]
            || names.len() != 2
            || names[0] != "let"
            || statement.binding.as_deref() != Some(names[1])
        {
            return None;
        }
        let (prefix_node, selected) = self.query_binary(value, "+")?;
        let query_node = self.query_group(selected)?;
        let checked = self.types.checked_queries.get(&query_node)?;
        let [alias, predicate, order, select] = checked.clauses.as_slice() else {
            return None;
        };
        let CheckedQueryClauseKind::As { name } = &alias.kind else {
            return None;
        };
        let [predicate_node] = predicate.expressions.as_slice() else {
            return None;
        };
        let [order_node] = order.expressions.as_slice() else {
            return None;
        };
        let [select_node] = select.expressions.as_slice() else {
            return None;
        };
        let ty = self.types.node_types.get(&value)?;
        let query_syntax = self.nodes.get(&query_node)?;
        let clauses: Vec<_> = query_syntax
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::QueryClause)
            .map(NodeKey::of)
            .collect();
        let domains: Vec<_> = query_syntax
            .children
            .iter()
            .filter(|part| expression(part.kind))
            .map(NodeKey::of)
            .collect();
        if query_syntax.kind != SyntaxKind::Query
            || checked.node != query_node
            || checked.projection.is_some()
            || !alias.expressions.is_empty()
            || predicate.kind != CheckedQueryClauseKind::Where
            || order.kind != CheckedQueryClauseKind::Order
            || select.kind != CheckedQueryClauseKind::Select
            || clauses != [alias.node, predicate.node, order.node, select.node]
            || domains != [checked.domain]
            || checked.result != *ty
            || self.types.node_types.get(&query_node) != Some(ty)
            || self.types.node_types.get(&selected) != Some(ty)
            || self.types.node_types.get(&prefix_node) != Some(ty)
            || !matches!(ty, ResolvedType::Array {element,ordered:true,nonempty:false}
                if checked_standard_nominal_name(element)==Some("TextMessage"))
        {
            return None;
        }
        // Clauses retain their actual original expression anchors and spelling.
        for (clause, keyword, expressions) in [
            (alias, "as", vec![]),
            (predicate, "where", vec![*predicate_node]),
            (order, "order", vec![*order_node]),
            (select, "select", vec![*select_node]),
        ] {
            let node = self.nodes.get(&clause.node)?;
            if node.kind != SyntaxKind::QueryClause
                || node
                    .children
                    .iter()
                    .find(|part| part.kind == SyntaxKind::Name)
                    .and_then(|part| self.word(part))
                    != Some(keyword)
                || node
                    .children
                    .iter()
                    .filter(|part| expression(part.kind))
                    .map(NodeKey::of)
                    .collect::<Vec<_>>()
                    != expressions
                || (keyword == "as"
                    && node
                        .children
                        .iter()
                        .filter(|part| part.kind == SyntaxKind::Name)
                        .map(|part| self.word(part))
                        .collect::<Option<Vec<_>>>()?
                        != ["as", name.as_str()])
            {
                return None;
            }
        }
        let (domain_parent, child_name) = self.count_member(checked.domain)?;
        let (argument, parent_name) = self.count_member(domain_parent)?;
        let parameter = self.query_parameter(scenario, argument)?;
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = self.types.symbol_types.get(&parameter)?
        else {
            return None;
        };
        let model = *model;
        let turn = self.checked_created_model(model, scenario.module)?;
        let owner = self.resolve.symbols.get(model.0 as usize)?;
        let parent =
            self.checked_count_parent_edge(domain_parent, argument, model, scenario.module)?;
        let branch = self.checked_created_model(parent.parent, scenario.module)?;
        let array = ResolvedType::Array {
            element: Box::new(ResolvedType::Record {
                symbol: model,
                stored: true,
            }),
            ordered: true,
            nonempty: false,
        };
        if child_name != owner.name
            || parent_name != "parent"
            || checked.domain_type != array
            || self.types.node_types.get(&checked.domain) != Some(&array)
            || self.checked_call_parent_path(domain_parent, parameter, 0)
                != Some((parent.parent, 1))
            || branch.fields.iter().any(|field| field.name == child_name)
        {
            return None;
        }
        let actual = scenario
            .params
            .iter()
            .find(|actual| actual.param == parameter)?;
        let actual_symbol = self.resolve.symbols.get(parameter.0 as usize)?;
        if !matches!(actual_symbol.kind,SymbolKind::Param {owner,type_node,..}
            if owner==scenario.scenario && type_node==actual.type_node)
            || actual_symbol.module != scenario.module
            || !self.checked_created_field_type(
                actual.type_node,
                scenario.module,
                &ResolvedType::Record {
                    symbol: model,
                    stored: true,
                },
                0,
            )
        {
            return None;
        }
        let (prefix_receiver, prefix_name) = self.count_member(prefix_node)?;
        let (prefix_argument, prefix_parent_name) = self.count_member(prefix_receiver)?;
        let prefix_parent = self.checked_count_parent_edge(
            prefix_receiver,
            prefix_argument,
            model,
            scenario.module,
        )?;
        let prefix = branch
            .fields
            .iter()
            .find(|field| field.name == prefix_name)?;
        let prefix_data = branch
            .declaration
            .fields
            .iter()
            .find(|field| field.field == prefix.field)?;
        let prefix_max = prefix_data
            .modifiers
            .iter()
            .find(|modifier| modifier.name == "max")?
            .value?;
        if prefix_parent_name != "parent"
            || self.query_parameter(scenario, prefix_argument) != Some(parameter)
            || prefix_parent.parent != parent.parent
            || prefix.ty != *ty
            || prefix_data.required_array
            || prefix_data.default.is_some()
            || prefix_data.server.is_some()
            || self.declared_message_bound(prefix_max).is_none()
        {
            return None;
        }
        let (candidate_node, bound_node) = self.query_binary(*predicate_node, "<")?;
        let candidate = self.query_member(candidate_node, alias.node, model)?;
        let position = self.query_member(*order_node, alias.node, model)?;
        let (bound_receiver, bound_name) = self.count_member(bound_node)?;
        if candidate != position
            || self.resolve.symbols.get(position.0 as usize)?.name != bound_name
            || self.query_parameter(scenario, bound_receiver) != Some(parameter)
            || self.types.node_types.get(&bound_receiver) != self.types.symbol_types.get(&parameter)
            || self.types.symbol_types.get(&position) != Some(&ResolvedType::Scalar(Scalar::Int))
            || [candidate_node, bound_node, *order_node]
                .iter()
                .any(|node| {
                    self.types.node_types.get(node) != Some(&ResolvedType::Scalar(Scalar::Int))
                })
            || self.types.node_types.get(predicate_node)
                != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
        let constructor = self.nodes.get(select_node)?;
        let head = constructor
            .children
            .iter()
            .find(|part| expression(part.kind))?;
        let imported = self.word(head)?;
        let ResolvedType::Array { element, .. } = ty else {
            return None;
        };
        if constructor.kind != SyntaxKind::Construct
            || checked_standard_nominal_name(element) != Some("TextMessage")
            || self.types.node_types.get(select_node) != Some(element.as_ref())
            || !matches!(
                self.resolve.node_typeref.get(&NodeKey::of(head)),
                Some(TypeRef::External)
            )
            || !matches!(self.resolve.module_scopes.get(scenario.module.0 as usize)?.prod.get(imported),
                Some(ScopedName::External {provider,name}) if provider=="std" && name=="TextMessage")
        {
            return None;
        }
        let object = constructor
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Object)?;
        let entries: Vec<_> = object
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::ObjectEntry)
            .collect();
        let schema = checked_text_schema_fields(element, Some("TextMessage"))?;
        if entries.len() != 3 || schema.len() != 3 {
            return None;
        }
        let mut fields = Vec::new();
        for (entry, (expected, expected_ty)) in entries.iter().zip(schema) {
            let key = entry.children.first()?;
            let mut values = entry.children.iter().filter(|part| expression(part.kind));
            let value_node = NodeKey::of(values.next()?);
            let source_field = self.query_member(value_node, alias.node, model)?;
            let field = turn
                .fields
                .iter()
                .find(|field| field.field == source_field)?;
            let declaration = turn
                .declaration
                .fields
                .iter()
                .find(|field| field.field == source_field)?;
            if key.kind != SyntaxKind::Name
                || self.word(key)? != expected
                || values.next().is_some()
                || self.query_member_name(value_node, alias.node, model)
                    != Some(field.name.as_str())
                || field.ty != *expected_ty
                || self.types.node_types.get(&value_node) != Some(expected_ty)
                || declaration.default.is_some()
                || declaration.server.is_some()
                || declaration.required_array
            {
                return None;
            }
            if expected == "attachments" {
                let maximum = declaration
                    .modifiers
                    .iter()
                    .find(|modifier| modifier.name == "max")?
                    .value?;
                if self.word(self.nodes.get(&maximum)?) != Some("8")
                    || self.types.node_types.get(&maximum)
                        != Some(&ResolvedType::Scalar(Scalar::Int))
                {
                    return None;
                }
            }
            fields.push(CheckedTranscriptField {
                name: expected.clone(),
                key_node: NodeKey::of(key),
                value_node,
                source_field,
                ty: expected_ty.clone(),
            });
        }
        let returned = scenario.effects.last()?;
        if returned.verb != EffectVerb::Return {
            return None;
        }
        let source = self.source(scenario.module, query_node).ok()?;
        let id = self.opaque("inline-selection-query", query_node, "").ok()?;
        let ordinary = |node: NodeKey, field: SymbolId, role: DependencyRole| {
            let declaration = self.resolve.symbols.get(field.0 as usize)?;
            let ty = self.types.symbol_types.get(&field)?;
            Some(DisclosureDependency {
                id: self
                    .opaque(
                        if role == DependencyRole::Data {
                            "read-data"
                        } else {
                            "read-control"
                        },
                        node,
                        "",
                    )
                    .ok()?,
                source: self.source(scenario.module, node).ok()?,
                node,
                calls: Vec::new(),
                role,
                model,
                field,
                model_name: owner.canonical.clone(),
                field_name: declaration.name.clone(),
                ty: ty.clone(),
                type_id: checked_stored_contract_type_id(ty, None, self.resolve, 0)?,
                query_id: Some(id.clone()),
            })
        };
        let predicate_dependency = ordinary(candidate_node, position, DependencyRole::Control)?;
        let bound_dependency = ordinary(bound_node, position, DependencyRole::Control)?;
        let order_dependency = ordinary(*order_node, position, DependencyRole::Control)?;
        let dependencies = fields
            .iter()
            .map(|field| ordinary(field.value_node, field.source_field, DependencyRole::Data))
            .collect::<Option<Vec<_>>>()?;
        let query_dependencies = std::iter::once(&predicate_dependency)
            .chain(std::iter::once(&order_dependency))
            .chain(&dependencies)
            .map(|dependency| {
                let mut query = dependency.clone();
                query.id = self
                    .opaque(
                        if query.role == DependencyRole::Data {
                            "query-data"
                        } else {
                            "query-control"
                        },
                        query.node,
                        &id,
                    )
                    .ok()?;
                query.query_id = None;
                Some(query)
            })
            .collect::<Option<Vec<_>>>()?;
        let parent_dependency = DisclosureDependency {
            id: self.opaque("read-data", parent.node, "").ok()?,
            source: source.clone(),
            node: parent.node,
            calls: Vec::new(),
            role: DependencyRole::Data,
            model,
            field: model,
            model_name: owner.canonical.clone(),
            field_name: "parent".into(),
            ty: ResolvedType::Record {
                symbol: parent.parent,
                stored: true,
            },
            type_id: self
                .resolve
                .symbols
                .get(parent.parent.0 as usize)?
                .canonical
                .clone(),
            query_id: None,
        };
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
                    .opaque("query-influence", query_node, &format!("{id}:{kind:?}"))
                    .ok()?,
                source: source.clone(),
                node: query_node,
                kind,
                query_id: Some(id.clone()),
            })
        })
        .collect::<Option<Vec<_>>>()?;
        Some(CheckedInlineSelectionSource {
            query: DisclosureQuery {
                id,
                source,
                node: query_node,
                domain: checked.domain,
                model,
                model_name: owner.canonical.clone(),
                alias: Some(alias.node),
                predicate: Some(*predicate_node),
                inputs: vec![(argument, parameter)],
                dependencies: query_dependencies,
                order: vec![DisclosureQueryOrder {
                    field: Some(position),
                    field_name: "position".into(),
                    descending: false,
                    node: *order_node,
                }],
                limit: None,
                archived: false,
                cardinality_guard: None,
                return_node: returned.node,
                projection: None,
                first: None,
                count: None,
                influences,
            },
            checked: checked.clone(),
            statement: statement.node,
            value,
            parameter,
            argument,
            parent,
            prefix_parent,
            parent_dependency,
            prefix: prefix.field,
            prefix_node,
            prefix_max,
            bound_node,
            bound_field: position,
            bound_dependency,
            order_dependency,
            predicate_dependency,
            select: *select_node,
            ty: ty.clone(),
            fields,
            dependencies,
            expression_types: Some(
                self.checked_create_expression_types(statement.node, scenario.module)?,
            ),
        })
    }

    fn inline_selection_at(
        &self,
        key: NodeKey,
        module: ModuleId,
    ) -> Option<CheckedInlineSelectionSource> {
        let node = self.nodes.get(&key)?;
        if node.kind != SyntaxKind::Query && node.kind != SyntaxKind::Member {
            return None;
        }
        self.effects
            .scenarios
            .values()
            .filter(|scenario| {
                scenario.module == module
                    && scenario.node.file == key.file
                    && scenario.node.start <= key.start
                    && key.end <= scenario.node.end
            })
            .find_map(|scenario| {
                self.checked_inline_selection_sources(scenario)?
                    .into_iter()
                    .find(|fact| fact.query.node == key || fact.prefix_node == key)
            })
    }

    /// Abstract source evaluation only. Bound reads stay at their original
    /// per-candidate WHERE site; this does not hoist runtime reads or select rows.
    fn inline_selection_value(
        &mut self,
        key: NodeKey,
        module: ModuleId,
        env: &Env,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let fact = self
            .inline_selection_at(key, module)
            .ok_or_else(|| self.fail(key, "inline selection needs exact original source"))?;
        if !calls.is_empty()
            || self.statement_depth != 1
            || self.loop_node.is_some()
            || !env
                .get(&Local::Symbol(fact.parameter))
                .is_some_and(|input| {
                    input.record == Some(fact.parent.child)
                        && input.reference_origin
                            == Some(ReferenceOrigin::Parameter(fact.parameter))
                })
        {
            return Err(self.fail(key, "inline selection needs original required Turn input"));
        }
        let edge = if key == fact.prefix_node {
            &fact.prefix_parent
        } else {
            &fact.parent
        };
        let mut values = self.expr(edge.node, module, env, calls)?;
        if values.len() != 1
            || !values.iter().all(|value| {
                value.record == Some(edge.parent)
                    && value.reference_origin
                        == Some(ReferenceOrigin::Parent {
                            parameter: fact.parameter,
                            model: edge.parent,
                            depth: 1,
                        })
            })
        {
            return Err(self.fail(key, "inline selection parent source lineage"));
        }
        let value = &mut values[0];
        value.record = None;
        value.reference = None;
        value.reference_origin = None;
        if key == fact.prefix_node {
            value.reads.push(DisclosureDependency {
                id: self.opaque("read-data", key, "")?,
                source: fact.query.source.clone(),
                node: key,
                calls: Vec::new(),
                role: DependencyRole::Data,
                model: edge.parent,
                field: fact.prefix,
                model_name: self.resolve.symbols[edge.parent.0 as usize]
                    .canonical
                    .clone(),
                field_name: self.resolve.symbols[fact.prefix.0 as usize].name.clone(),
                ty: fact.ty,
                type_id: "TextMessage[]".into(),
                query_id: None,
            });
            value.observed.push((key, Vec::new()));
        } else {
            if !value.reads.contains(&fact.parent_dependency) {
                return Err(self.fail(key, "inline selection exact domain parent read"));
            }
            // Candidate WHERE and engine ORDER controls remain in the query.
            // Ordinary observations preserve the real bound, then eager SELECT.
            for dependency in std::iter::once(fact.bound_dependency).chain(fact.dependencies) {
                value.observed.push((dependency.node, Vec::new()));
                value.reads.push(dependency);
            }
            value.influences = fact.query.influences;
        }
        Ok(values)
    }

    /// Read the owning field's checked literal maximum; authored spellings
    /// and a particular draft's chosen maximum are not source authority.
    fn declared_message_bound(&self, key: NodeKey) -> Option<u64> {
        let node = self.nodes.get(&key)?;
        if node.kind != SyntaxKind::Literal
            || self.types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Int))
        {
            return None;
        }
        let bound = self.word(node)?.parse::<u64>().ok()?;
        (bound > 0).then_some(bound)
    }

    fn transcript_bound_matches(&self, key: NodeKey, paths: &[ValuePath]) -> bool {
        let Some(bound) = self.declared_message_bound(key) else {
            return false;
        };
        !paths.is_empty()
            && paths.iter().all(|path| {
                path.reads.iter().any(|read| {
                    transcript_message_array(&read.ty)
                        && self
                            .effects
                            .models
                            .get(&read.model)
                            .and_then(|model| {
                                model.fields.iter().find(|field| field.field == read.field)
                            })
                            .and_then(|field| {
                                field
                                    .modifiers
                                    .iter()
                                    .find(|modifier| modifier.name == "max")
                            })
                            .and_then(|modifier| modifier.value)
                            .and_then(|maximum| self.declared_message_bound(maximum))
                            == Some(bound)
                })
            })
    }

    fn checked_transcript_sources(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<CheckedTranscriptSource>> {
        let mut out = Vec::new();
        let mut visits = 0;
        for statement in scenario.guards.iter().chain(&scenario.effects) {
            let mut pending = vec![*self.nodes.get(&statement.node)?];
            while let Some(node) = pending.pop() {
                visits += 1;
                if visits > 16384 || out.len() > 200 {
                    return None;
                }
                let key = NodeKey::of(node);
                if matches!(
                    self.types.selected_calls.get(&key).map(|call| &call.target),
                    Some(SelectedCallTarget::DeriveFn(_))
                ) && self
                    .types
                    .node_types
                    .get(&key)
                    .is_some_and(transcript_message_array)
                    && let Some(fact) =
                        self.checked_transcript_source(scenario, statement.node, key)
                {
                    out.push(fact);
                }
                // Source order, including nested operands; no derive invocation
                // is hoisted, reused or replaced with a cardinality shortcut.
                pending.extend(node.children.iter().rev());
            }
        }
        out.sort_by_key(|fact| (fact.call.start, fact.call.end));
        Some(out)
    }

    fn checked_transcript_source(
        &self,
        scenario: &super::effects::ScenarioData,
        statement: NodeKey,
        call: NodeKey,
    ) -> Option<CheckedTranscriptSource> {
        if scenario.read
            || scenario.on.is_some()
            || !scenario
                .guards
                .iter()
                .chain(&scenario.effects)
                .any(|effect| effect.node == statement)
            || call.file != statement.file
            || call.start < statement.start
            || call.end > statement.end
        {
            return None;
        }
        let selected = self.types.selected_calls.get(&call)?;
        let SelectedCallTarget::DeriveFn(derive) = &selected.target else {
            return None;
        };
        let derive = *derive;
        let data = self.effects.derives.get(&derive)?;
        let declaration = self.resolve.symbols.get(derive.0 as usize)?;
        let SymbolKind::DeriveFn {
            params,
            result_node,
        } = &declaration.kind
        else {
            return None;
        };
        let [formal] = data.params.as_slice() else {
            return None;
        };
        let [argument] = selected.arguments.as_slice() else {
            return None;
        };
        let parameter = self.query_parameter(scenario, *argument)?;
        let actual = scenario
            .params
            .iter()
            .find(|param| param.param == parameter)?;
        let formal_symbol = self.resolve.symbols.get(formal.param.0 as usize)?;
        let actual_symbol = self.resolve.symbols.get(parameter.0 as usize)?;
        let ResolvedType::Record {
            symbol: branch,
            stored: true,
        } = self.types.symbol_types.get(&parameter)?
        else {
            return None;
        };
        let branch = *branch;
        let branch_ty = ResolvedType::Record {
            symbol: branch,
            stored: true,
        };
        let body = data.expr?;
        let result = data.result?;
        let text = &self.db.get(data.node.file)?.text;
        let call_node = self.nodes.get(&call)?;
        let mut syntax_arguments = call_node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument);
        let syntax_argument = syntax_arguments.next()?;
        let syntax_values: Vec<_> = syntax_argument
            .children
            .iter()
            .filter(|child| expression(child.kind))
            .map(NodeKey::of)
            .collect();
        let head = call_node
            .children
            .iter()
            .find(|child| expression(child.kind))?;
        let result_ty = self.types.symbol_results.get(&derive)?.as_ref()?;
        let parameter_name = |parameter: &super::effects::ParamData,
                              symbol: &super::resolve::Symbol| {
            self.nodes
                .get(&parameter.node)
                .and_then(|node| {
                    node.children
                        .iter()
                        .find(|child| child.kind == SyntaxKind::Name)
                })
                .is_some_and(|name| {
                    self.word(name) == Some(symbol.name.as_str()) && name.span == symbol.span
                })
        };
        if declaration.module != scenario.module
            || declaration.canonical
                != format!(
                    "{}.{}",
                    self.resolve.modules.get(scenario.module.0 as usize)?.name,
                    declaration.name
                )
            || data.module != scenario.module
            || data.derive != derive
            || data.model.is_some()
            || params.as_slice() != [formal.param]
            || *result_node != data.node
            || selected.slots.as_slice() != [Some(0)]
            || formal.default.is_some()
            || actual.default.is_some()
            || formal_symbol.module != scenario.module
            || actual_symbol.module != scenario.module
            || !parameter_name(formal, formal_symbol)
            || !parameter_name(actual, actual_symbol)
            || formal_symbol.canonical
                != format!("{}.{}", declaration.canonical, formal_symbol.name)
            || !matches!(formal_symbol.kind,SymbolKind::Param {owner,type_node,..} if owner==derive && type_node==formal.type_node)
            || !matches!(actual_symbol.kind,SymbolKind::Param {owner,type_node,..} if owner==scenario.scenario && type_node==actual.type_node)
            || self.types.symbol_types.get(&formal.param) != Some(&branch_ty)
            || self.types.node_types.get(argument) != Some(&branch_ty)
            || !self.checked_created_field_type(formal.type_node, scenario.module, &branch_ty, 0)
            || !self.checked_created_field_type(actual.type_node, scenario.module, &branch_ty, 0)
            || text.get(result.start as usize..result.end as usize)?.trim() != "TextMessage[]"
            || !self
                .nodes
                .get(&data.node)?
                .children
                .iter()
                .any(|child| NodeKey::of(child) == result)
            || !transcript_message_array(result_ty)
            || self.types.node_types.get(&call) != Some(result_ty)
            || self.types.node_types.get(&body) != Some(result_ty)
            || call_node.kind != SyntaxKind::Call
            || syntax_arguments.next().is_some()
            || syntax_values.as_slice() != [*argument]
            || !matches!(self.query_binding(NodeKey::of(head)),Some(Binding::Symbol(id)) if *id==derive)
        {
            return None;
        }
        let branch_definition = self.checked_created_model(branch, scenario.module)?;
        let (prefix_node, query_group) = self.query_binary(body, "+")?;
        let (prefix_receiver, prefix_name) = self.count_member(prefix_node)?;
        if !matches!(self.query_binding(prefix_receiver),Some(Binding::Symbol(id)) if *id==formal.param)
            || self.types.node_types.get(&prefix_receiver) != Some(&branch_ty)
            || self.types.node_types.get(&prefix_node) != Some(result_ty)
        {
            return None;
        }
        let prefix_field = branch_definition
            .fields
            .iter()
            .find(|field| field.name == prefix_name)?;
        let prefix_data = branch_definition
            .declaration
            .fields
            .iter()
            .find(|field| field.field == prefix_field.field)?;
        let prefix_max = prefix_data
            .modifiers
            .iter()
            .find(|modifier| modifier.name == "max")?
            .value?;
        if prefix_field.ty != *result_ty
            || prefix_data.required_array
            || prefix_data.default.is_some()
            || prefix_data.server.is_some()
            || self.declared_message_bound(prefix_max).is_none()
        {
            return None;
        }
        let query_node = self.query_group(query_group)?;
        let query = self.types.checked_queries.get(&query_node)?;
        let [alias, order, select] = query.clauses.as_slice() else {
            return None;
        };
        let CheckedQueryClauseKind::As { name: alias_name } = &alias.kind else {
            return None;
        };
        if query.node != query_node
            || self.nodes.get(&query_node)?.kind != SyntaxKind::Query
            || query.projection.is_some()
            || order.kind != CheckedQueryClauseKind::Order
            || select.kind != CheckedQueryClauseKind::Select
            || self
                .nodes
                .get(&alias.node)?
                .children
                .iter()
                .filter(|child| child.kind == SyntaxKind::Name)
                .map(|child| self.word(child))
                .collect::<Option<Vec<_>>>()?
                != ["as", alias_name.as_str()]
            || query.result != *result_ty
            || self.types.node_types.get(&query_node) != Some(result_ty)
        {
            return None;
        }
        let [order_node] = order.expressions.as_slice() else {
            return None;
        };
        let [select_node] = select.expressions.as_slice() else {
            return None;
        };
        let (domain_receiver, child_name) = self.count_member(query.domain)?;
        let ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        } = &query.domain_type
        else {
            return None;
        };
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = element.as_ref()
        else {
            return None;
        };
        let model = *model;
        let model_definition = self.checked_created_model(model, scenario.module)?;
        let model_symbol = self.resolve.symbols.get(model.0 as usize)?;
        if model_symbol.name != child_name
            || !matches!(model_symbol.kind,SymbolKind::Model {owner:ModelOwner::ChildOf(parent),..} if parent==branch)
            || branch_definition
                .fields
                .iter()
                .any(|field| field.name == child_name)
            || !matches!(self.query_binding(domain_receiver),Some(Binding::Symbol(id)) if *id==formal.param)
            || self.types.node_types.get(&domain_receiver) != Some(&branch_ty)
            || self.types.node_types.get(&query.domain) != Some(&query.domain_type)
        {
            return None;
        }
        let position = self.query_member(*order_node, alias.node, model)?;
        if self.types.symbol_types.get(&position) != Some(&ResolvedType::Scalar(Scalar::Int))
            || self.types.node_types.get(order_node) != Some(&ResolvedType::Scalar(Scalar::Int))
        {
            return None;
        }
        let constructor = self.nodes.get(select_node)?;
        let constructor_head = constructor
            .children
            .iter()
            .find(|child| expression(child.kind))?;
        let imported = self.word(constructor_head)?;
        let element_ty = match result_ty {
            ResolvedType::Array { element, .. } => element.as_ref(),
            _ => return None,
        };
        if constructor.kind != SyntaxKind::Construct
            || checked_standard_nominal_name(element_ty) != Some("TextMessage")
            || self.types.node_types.get(select_node) != Some(element_ty)
            || !matches!(
                self.resolve
                    .node_typeref
                    .get(&NodeKey::of(constructor_head)),
                Some(TypeRef::External)
            )
            || !matches!(self.resolve.module_scopes.get(scenario.module.0 as usize)?.prod.get(imported),Some(ScopedName::External {provider,name}) if provider=="std" && name=="TextMessage")
        {
            return None;
        }
        let object = constructor
            .children
            .iter()
            .find(|child| child.kind == SyntaxKind::Object)?;
        let entries: Vec<_> = object
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::ObjectEntry)
            .collect();
        let schema = checked_text_schema_fields(element_ty, Some("TextMessage"))?;
        if entries.len() != 3 || schema.len() != 3 {
            return None;
        }
        let mut fields = Vec::new();
        for (entry, (expected, expected_ty)) in entries.iter().zip(schema) {
            let key_node = entry.children.first()?;
            let mut values = entry.children.iter().filter(|child| expression(child.kind));
            let value_node = NodeKey::of(values.next()?);
            let source_field = self.query_member(value_node, alias.node, model)?;
            let field = model_definition
                .fields
                .iter()
                .find(|field| field.field == source_field)?;
            let source_data = model_definition
                .declaration
                .fields
                .iter()
                .find(|field| field.field == source_field)?;
            if key_node.kind != SyntaxKind::Name
                || self.word(key_node)? != expected
                || values.next().is_some()
                || self.query_member_name(value_node, alias.node, model)
                    != Some(field.name.as_str())
                || field.ty != *expected_ty
                || self.types.node_types.get(&value_node) != Some(expected_ty)
                || source_data.default.is_some()
                || source_data.server.is_some()
                || source_data.required_array
            {
                return None;
            }
            if expected == "attachments" {
                let maximum = source_data
                    .modifiers
                    .iter()
                    .find(|modifier| modifier.name == "max")?
                    .value?;
                if text
                    .get(maximum.start as usize..maximum.end as usize)?
                    .trim()
                    != "8"
                    || self.types.node_types.get(&maximum)
                        != Some(&ResolvedType::Scalar(Scalar::Int))
                {
                    return None;
                }
            }
            fields.push(CheckedTranscriptField {
                name: expected.clone(),
                key_node: NodeKey::of(key_node),
                value_node,
                source_field,
                ty: expected_ty.clone(),
            });
        }
        let source = self.source(scenario.module, call).ok()?;
        if source.sha256 != sha256_hex(self.db.get(call.file)?.text.as_bytes()) {
            return None;
        }
        let calls = vec![call];
        let call_stamp = self.call_stamp(&calls).ok()?;
        let id = self
            .opaque("transcript-query", query_node, &call_stamp)
            .ok()?;
        let order_dependency = DisclosureDependency {
            id: self.opaque("read-control", *order_node, &call_stamp).ok()?,
            source: self.source(scenario.module, *order_node).ok()?,
            node: *order_node,
            calls: calls.clone(),
            role: DependencyRole::Control,
            model,
            field: position,
            model_name: model_symbol.canonical.clone(),
            field_name: self.resolve.symbols.get(position.0 as usize)?.name.clone(),
            ty: ResolvedType::Scalar(Scalar::Int),
            type_id: "int".into(),
            query_id: None,
        };
        let dependencies = fields
            .iter()
            .map(|field| {
                Some(DisclosureDependency {
                    id: self
                        .opaque("read-data", field.value_node, &call_stamp)
                        .ok()?,
                    source: self.source(scenario.module, field.value_node).ok()?,
                    node: field.value_node,
                    calls: calls.clone(),
                    role: DependencyRole::Data,
                    model,
                    field: field.source_field,
                    model_name: model_symbol.canonical.clone(),
                    field_name: self
                        .resolve
                        .symbols
                        .get(field.source_field.0 as usize)?
                        .name
                        .clone(),
                    ty: field.ty.clone(),
                    type_id: checked_stored_contract_type_id(&field.ty, None, self.resolve, 0)?,
                    query_id: Some(id.clone()),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let query_dependencies = dependencies
            .iter()
            .map(|dependency| {
                let mut query = dependency.clone();
                query.id = self.opaque("query-data", query.node, &id).ok()?;
                query.query_id = None;
                Some(query)
            })
            .collect::<Option<Vec<_>>>()?;
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
                    .opaque("query-influence", query_node, &format!("{id}:{kind:?}"))
                    .ok()?,
                source: source.clone(),
                node: query_node,
                kind,
                query_id: Some(id.clone()),
            })
        })
        .collect::<Option<Vec<_>>>()?;
        Some(CheckedTranscriptSource {
            id,
            source,
            derive,
            declaration: data.node,
            body,
            call,
            statement,
            slots: selected.slots.clone(),
            argument: *argument,
            parameter,
            formal: formal.param,
            branch,
            prefix: prefix_field.field,
            prefix_node,
            prefix_max,
            query: query.clone(),
            model,
            alias: alias.node,
            order: position,
            order_node: *order_node,
            order_dependency,
            select: *select_node,
            ty: result_ty.clone(),
            fields,
            dependencies,
            query_dependencies,
            influences,
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
                // Checked Given field-trait defaults make omission legal in
                // the owning type checker and lower to the existing default.
                && !self.types.given_constraints.get(&field.field).is_some_and(|constraints|
                    constraints.iter().any(|constraint| constraint.default.is_some()))
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
            definition: definition.as_ref().clone(),
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
        let mut anchors = vec![owner.node];
        for transcript in self.checked_transcript_sources(owner).unwrap_or_default() {
            if !anchors.contains(&transcript.declaration) {
                anchors.push(transcript.declaration);
            }
        }
        for site in self.checked_decision_sites(owner)? {
            if !matches!(
                site.stage,
                CheckedDecisionStage::LeadingRequire | CheckedDecisionStage::BodyRequire
            ) {
                continue;
            }
            for call in site.calls {
                if let CheckedDecisionCallTarget::DeriveFn(derive) = call.target {
                    let data = self.effects.derives.get(&derive)?;
                    let declaration = self.resolve.symbols.get(derive.0 as usize)?;
                    let body = data.expr?;
                    if data.derive != derive
                        || declaration.id != derive
                        || declaration.module != data.module
                        || !matches!(declaration.kind, SymbolKind::DeriveFn { .. })
                        || self.source(data.module, data.node).ok()?
                            != self.source(data.module, body).ok()?
                        || body.file != data.node.file
                        || body.start < data.node.start
                        || body.end > data.node.end
                    {
                        return None;
                    }
                    if !anchors.contains(&data.node) {
                        anchors.push(data.node);
                    }
                }
            }
        }
        // Include shorthand Name nodes as well as expressions: their checked
        // binding type belongs to the authored key occurrence. Unknown/error
        // entries are retained faithfully and cannot become an admitted value.
        let mut retained: Vec<_> = self
            .types
            .node_types
            .iter()
            .filter(|(node, _)| {
                anchors.iter().any(|anchor| {
                    node.file == anchor.file && anchor.start <= node.start && node.end <= anchor.end
                }) && self.nodes.contains_key(node)
            })
            .map(|(node, ty)| (*node, ty.clone()))
            .collect();
        if retained.len() > 16384 {
            return None;
        }
        retained.sort_by_key(|(node, _)| (node.file, node.start, node.end, node.kind));
        Some(retained)
    }

    fn checked_created_model(
        &self,
        model: SymbolId,
        module: ModuleId,
    ) -> Option<Rc<CheckedScenarioCreatedModel>> {
        let key = (model, module);
        if let Some(result) = self.source_facts.borrow().models.get(&key) {
            return result.clone();
        }
        // Insert only a finished check, including refusal. Never mark an
        // in-progress model as admitted or suppress recursive validation.
        let result = self.check_created_model(model, module).map(Rc::new);
        self.source_facts
            .borrow_mut()
            .models
            .insert(key, result.clone());
        result
    }

    fn check_created_model(
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
        let mut contributed = Vec::new();
        for id in order {
            let member = self.resolve.symbols.get(id.0 as usize)?;
            if member.id != *id || member.module != module {
                return None;
            }
            match member.kind {
                SymbolKind::Field { owner, .. } if owner == model => {
                    if let Some(value) = self.types.given_fields.get(id) {
                        let ty = self.types.symbol_types.get(id)?;
                        if member.canonical != format!("{}.{}", symbol.canonical, value.name)
                            || member.name != value.name
                            || value.default.is_none()
                            || !checked_source_type(ty)
                        {
                            return None;
                        }
                        contributed.push(CheckedScenarioContributedField {
                            field: *id,
                            canonical: member.canonical.clone(),
                            source: self
                                .source(
                                    module,
                                    NodeKey {
                                        file: member.span.file,
                                        start: member.span.start,
                                        end: member.span.end,
                                        kind: SyntaxKind::Field as u8,
                                    },
                                )
                                .ok()?,
                            span: member.span,
                            ty: ty.clone(),
                            value: value.clone(),
                            constraints: self.types.value_constraints.get(id).cloned(),
                        });
                    } else {
                        stored_order.push(*id);
                    }
                }
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
            let mut modifier_sources = Vec::new();
            let mut current = data.field;
            let mut seen = HashSet::new();
            loop {
                if !seen.insert(current) || seen.len() > 128 {
                    return None;
                }
                let member = self.resolve.symbols.get(current.0 as usize)?;
                let SymbolKind::Field { owner, .. } = member.kind else {
                    return None;
                };
                let Some(original) = self
                    .effects
                    .models
                    .get(&owner)
                    .and_then(|value| value.fields.iter().find(|field| field.field == current))
                    .or_else(|| {
                        self.effects.records.get(&owner).and_then(|value| {
                            value.fields.iter().find(|field| field.field == current)
                        })
                    })
                else {
                    break;
                };
                let reuse = self.types.field_reuse_sources.get(&current).copied();
                modifier_sources.push((
                    original.clone(),
                    self.source(member.module, original.node).ok()?,
                    self.types.symbol_types.get(&current)?.clone(),
                    reuse,
                    self.types
                        .given_constraints
                        .get(&current)
                        .cloned()
                        .unwrap_or_default(),
                ));
                let Some(parent) = reuse else {
                    break;
                };
                current = parent;
            }
            fields.push(CheckedScenarioCreatedField {
                field: data.field,
                name: field.name.clone(),
                canonical: field.canonical.clone(),
                source: self.source(module, data.node).ok()?,
                ty: ty.clone(),
                constraints: self.types.value_constraints.get(&data.field).cloned(),
                reuse: self.types.field_reuse_sources.get(&data.field).copied(),
                modifier_sources,
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
            contributed,
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

    /// Resolve only required Contract fields rooted at the original parameter.
    /// The slot is the existing admission path, never a stored-field read.
    fn checked_contract_input_reference(
        &self,
        key: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId, String)> {
        let (parameter, ty, path) = self.checked_contract_input_path(key, module, 0)?;
        let ResolvedType::Record { symbol: target, .. } = ty else {
            return None;
        };
        (!path.is_empty()
            && matches!(
                self.resolve.symbols.get(target.0 as usize)?.kind,
                SymbolKind::Model { .. }
            ))
        .then(|| {
            let name = &self.resolve.symbols[parameter.0 as usize].name;
            (parameter, target, format!("{name}/{}", path.join("/")))
        })
    }

    fn checked_contract_input_path(
        &self,
        key: NodeKey,
        module: ModuleId,
        depth: usize,
    ) -> Option<(SymbolId, ResolvedType, Vec<String>)> {
        if depth >= 16 {
            return None;
        }
        let key = self.query_group(key)?;
        let node = self.nodes.get(&key)?;
        if node.kind == SyntaxKind::NameRef {
            let Binding::Symbol(parameter) = self.query_binding(key)? else {
                return None;
            };
            let symbol = self.resolve.symbols.get(parameter.0 as usize)?;
            let SymbolKind::Param { owner, index, .. } = symbol.kind else {
                return None;
            };
            let scenario = self.effects.scenarios.get(&owner)?;
            let param = scenario.params.get(index)?;
            let ResolvedType::Record {
                symbol: contract, ..
            } = self.types.symbol_types.get(parameter)?
            else {
                return None;
            };
            if symbol.module != module
                || scenario.module != module
                || scenario.read
                || scenario.on.is_some()
                || param.param != *parameter
                || param.default.is_some()
                || key.file != scenario.node.file
                || key.start < scenario.node.start
                || key.end > scenario.node.end
                || self.types.node_types.get(&key) != self.types.symbol_types.get(parameter)
                || !matches!(
                    self.resolve.symbols.get(contract.0 as usize)?.kind,
                    SymbolKind::Contract { .. }
                )
            {
                return None;
            }
            return Some((
                *parameter,
                self.types.symbol_types.get(parameter)?.clone(),
                Vec::new(),
            ));
        }
        if node.kind != SyntaxKind::Member {
            return None;
        }
        let mut operands = node.children.iter().filter(|child| expression(child.kind));
        let base = NodeKey::of(operands.next()?);
        if operands.next().is_some() {
            return None;
        }
        let (parameter, receiver, mut path) =
            self.checked_contract_input_path(base, module, depth + 1)?;
        let ResolvedType::Record {
            symbol: contract, ..
        } = receiver
        else {
            return None;
        };
        let name = self.word(
            node.children
                .iter()
                .rev()
                .find(|child| child.kind == SyntaxKind::Name)?,
        )?;
        let ty = self.types.node_types.get(&key)?;
        let field = self.contract_member(contract, name, ty)?;
        let declaration = self
            .effects
            .records
            .get(&contract)?
            .fields
            .iter()
            .find(|data| data.field == field)?;
        if declaration.required_array
            || !primitive_type(ty)
                && !matches!(ty, ResolvedType::Record {symbol, ..}
                if self.resolve.symbols.get(symbol.0 as usize).is_some_and(|owner|
                    matches!(owner.kind, SymbolKind::Contract { .. } | SymbolKind::Model { .. })))
        {
            return None;
        }
        path.push(name.into());
        Some((parameter, ty.clone(), path))
    }

    fn contract_input_stored_read(&self, read: &DisclosureDependency, module: ModuleId) -> bool {
        let Some(node) = self.nodes.get(&read.node) else {
            return false;
        };
        let Some(base) = node.children.iter().find(|node| expression(node.kind)) else {
            return false;
        };
        read.calls.is_empty()
            && read.query_id.is_none()
            && self
                .checked_contract_input_reference(NodeKey::of(base), module)
                .is_some_and(|(_, model, _)| model == read.model)
    }

    /// Executed operands retain field authority even when the helper result
    /// does not consume their data. `observed` is the original evaluation lane.
    fn require_observed_stored_read(
        &self,
        node: NodeKey,
        calls: &[NodeKey],
        caller: ModuleId,
    ) -> Option<DisclosureDependency> {
        let (base, name) = self.count_member(node)?;
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = self.types.node_types.get(&self.query_group(base)?)?
        else {
            return None;
        };
        let model = *model;
        let owner = self.resolve.symbols.get(model.0 as usize)?;
        if !matches!(owner.kind, SymbolKind::Model { .. }) {
            return None;
        }
        let ty = self.types.node_types.get(&node)?.clone();
        let field = self
            .effects
            .models
            .get(&model)?
            .fields
            .iter()
            .find_map(|declaration| {
                let field = self.resolve.symbols.get(declaration.field.0 as usize)?;
                (field.name == name
                    && matches!(field.kind,SymbolKind::Field {owner,..} if owner==model)
                    && self.types.symbol_types.get(&field.id) == Some(&ty))
                .then_some(field)
            })?;
        let module = match calls.last() {
            Some(call) => {
                let SelectedCallTarget::DeriveFn(id) = self.types.selected_calls.get(call)?.target
                else {
                    return None;
                };
                self.effects.derives.get(&id)?.module
            }
            None => caller,
        };
        let type_id = match &ty {
            ResolvedType::Record { symbol, .. }
                if self
                    .resolve
                    .symbols
                    .get(symbol.0 as usize)
                    .is_some_and(|declaration| {
                        matches!(declaration.kind, SymbolKind::Contract { .. })
                    }) =>
            {
                self.resolve
                    .symbols
                    .get(symbol.0 as usize)?
                    .canonical
                    .clone()
            }
            _ => self
                .reference_operand_type_id(&ty)
                .or_else(|| self.field_type_id(node, field.id, &ty).ok())?,
        };
        Some(DisclosureDependency {
            query_id: None,
            id: self
                .opaque("read-data", node, &self.call_stamp(calls).ok()?)
                .ok()?,
            source: self.source(module, node).ok()?,
            node,
            calls: calls.to_vec(),
            role: DependencyRole::Data,
            model,
            field: field.id,
            model_name: owner.canonical.clone(),
            field_name: field.name.clone(),
            ty,
            type_id,
        })
    }

    /// Census unsupported helper shapes too: an unproved execution read must
    /// refuse at the existing original-call join, never disappear with pruning.
    fn first_query_stored_require_read(
        &self,
        read: &DisclosureDependency,
        module: ModuleId,
    ) -> bool {
        if read.query_id.is_some() || self.reference_operand_type_id(&read.ty).is_some() {
            return false;
        }
        let Some((mut receiver, field)) = self.count_member(read.node) else {
            return false;
        };
        if field != read.field_name {
            return false;
        }
        for call in read.calls.iter().rev() {
            let Some(selected) = self.types.selected_calls.get(call) else {
                return false;
            };
            let SelectedCallTarget::DeriveFn(id) = selected.target else {
                return false;
            };
            let Some(derive) = self.effects.derives.get(&id) else {
                return false;
            };
            let mut supplied = None;
            for _ in 0..64 {
                let Some(Binding::Symbol(parameter)) = self.query_binding(receiver) else {
                    return false;
                };
                let Some((index, formal)) = derive
                    .params
                    .iter()
                    .enumerate()
                    .find(|(_, formal)| formal.param == *parameter)
                else {
                    return false;
                };
                match selected.slots.get(index) {
                    Some(Some(index)) => {
                        supplied = selected.arguments.get(*index).copied();
                        break;
                    }
                    Some(None) => {
                        let Some(default) = formal.default else {
                            return false;
                        };
                        receiver = default;
                    }
                    None => return false,
                }
            }
            let Some(actual) = supplied else {
                return false;
            };
            receiver = actual;
        }
        let mut pending = vec![receiver];
        let mut steps = 0;
        while let Some(key) = pending.pop() {
            steps += 1;
            if steps > 16384 {
                return false;
            }
            if let Some(Binding::Let { node }) = self.query_binding(key) {
                for scenario in self
                    .effects
                    .scenarios
                    .values()
                    .filter(|scenario| scenario.module == module)
                {
                    let mut statements: Vec<_> = scenario.effects.iter().collect();
                    while let Some(binding) = statements.pop() {
                        statements.extend(binding.then_effects.iter());
                        statements.extend(binding.else_effects.iter());
                        if binding.node == *node {
                            if self
                                .checked_first_query_source(scenario, binding)
                                .is_some_and(|query| query.model == read.model)
                            {
                                return true;
                            }
                            if let Some(value) = binding.value {
                                if value != key {
                                    pending.push(value);
                                }
                            }
                        }
                    }
                }
            }
            if let Some(node) = self.nodes.get(&key) {
                pending.extend(
                    node.children
                        .iter()
                        .filter(|child| expression(child.kind))
                        .map(NodeKey::of),
                );
            }
        }
        false
    }

    /// Original required Model-valued field, used by expression provenance and
    /// the owning schema census. This prepares source facts, never a row view.
    fn checked_required_model_reference(
        &self,
        key: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId, SymbolId)> {
        self.checked_required_model_reference_inner(key, module, 0)
    }

    fn checked_required_model_reference_inner(
        &self,
        key: NodeKey,
        module: ModuleId,
        depth: usize,
    ) -> Option<(SymbolId, SymbolId, SymbolId)> {
        if depth >= 16 {
            return None;
        }
        let key = self.query_group(key)?;
        let node = self.nodes.get(&key)?;
        if node.kind != SyntaxKind::Member {
            return None;
        }
        let mut operands = node.children.iter().filter(|child| expression(child.kind));
        let base = self.query_group(NodeKey::of(operands.next()?))?;
        if operands.next().is_some() {
            return None;
        }
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = self.types.node_types.get(&base)?
        else {
            return None;
        };
        let scenario = self.effects.scenarios.values().find(|scenario| {
            scenario.module == module
                && scenario.node.file == key.file
                && scenario.node.start <= key.start
                && key.end <= scenario.node.end
        })?;
        if scenario.read || scenario.on.is_some() {
            return None;
        }
        let original = match self.query_binding(base) {
            Some(Binding::Symbol(parameter)) => {
                self.checked_call_parent_path(base, *parameter, 0) == Some((*model, 0))
            }
            Some(Binding::Let { node }) => scenario
                .effects
                .iter()
                .find(|binding| binding.node == *node)
                .and_then(|binding| self.checked_first_query_source(scenario, binding))
                .is_some_and(|query| {
                    query.model == *model && query.first.is_some_and(|first| first.binding == *node)
                }),
            _ => self
                .checked_required_model_reference_inner(base, module, depth + 1)
                .is_some_and(|(_, _, target)| target == *model),
        };
        if !original
            && !self
                .checked_contract_input_reference(base, module)
                .is_some_and(|(_, target, _)| target == *model)
        {
            return None;
        }
        let owner = self.resolve.symbols.get(model.0 as usize)?;
        let SymbolKind::Model { fields, .. } = &owner.kind else {
            return None;
        };
        let name = self.word(
            node.children
                .iter()
                .rev()
                .find(|child| child.kind == SyntaxKind::Name)?,
        )?;
        let field = fields
            .iter()
            .filter_map(|id| self.resolve.symbols.get(id.0 as usize))
            .find(|field| {
                field.name == name
                    && field.module == owner.module
                    && matches!(field.kind, SymbolKind::Field {owner, ..} if owner == *model)
            })?;
        let ResolvedType::Record {
            symbol: target,
            stored: true,
        } = self.types.symbol_types.get(&field.id)?
        else {
            return None;
        };
        if self.types.node_types.get(&key) != self.types.symbol_types.get(&field.id)
            || !matches!(
                self.resolve.symbols.get(target.0 as usize)?.kind,
                SymbolKind::Model { .. }
            )
            || self
                .effects
                .models
                .get(model)?
                .fields
                .iter()
                .find(|declaration| declaration.field == field.id)?
                .required_array
        {
            return None;
        }
        Some((*model, field.id, *target))
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
        let current_revision = self.checked_current_revision_source(scenario);
        let inline_selections = self.checked_inline_selection_sources(scenario)?;
        if let Some(fact) = &current_revision {
            pending.push((fact.revision, true));
        }
        for parameter in &scenario.params {
            // The sealed optional input still owns its actual model schema;
            // null/default paths create no row view or reference observation.
            if let Some(model) = self.nullable_model_input(scenario, parameter) {
                pending.push((model, true));
                continue;
            }
            let Some(ResolvedType::Record { symbol, .. }) =
                self.types.symbol_types.get(&parameter.param)
            else {
                continue;
            };
            if is_contract(*symbol) {
                pending.push((*symbol, false));
            } else if matches!(
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
        for binding in &scenario.effects {
            if binding.verb == EffectVerb::Let
                && let Some(query) = self.checked_first_query_source(scenario, binding)
            {
                pending.push((query.model, true));
            }
        }
        // Only an actual original stored reference adds its target census.
        // No runtime view is issued.
        let mut expressions: Vec<_> = scenario
            .guards
            .iter()
            .chain(&scenario.effects)
            .filter_map(|statement| self.nodes.get(&statement.node).copied())
            .collect();
        let mut visited = 0usize;
        while let Some(node) = expressions.pop() {
            visited += 1;
            if visited > 16384 {
                return None;
            }
            if node.kind == SyntaxKind::Examples {
                continue;
            }
            if node.kind == SyntaxKind::Member
                && let Some((_, target, _)) =
                    self.checked_contract_input_reference(NodeKey::of(node), scenario.module)
            {
                pending.push((target, true));
            }
            // Capture only actually authored implicit-parent targets. Required
            // Contract Model leaves are discovered above; the parent proof
            // retains the same original parameter and checked containment.
            if node.kind == SyntaxKind::Member
                && self
                    .count_member(NodeKey::of(node))
                    .is_some_and(|(_, field)| field == "parent")
            {
                for parameter in &scenario.params {
                    if let Some((parent, hops)) =
                        self.checked_call_parent_path(NodeKey::of(node), parameter.param, 0)
                        && hops > 0
                    {
                        pending.push((parent, true));
                    }
                }
            }
            if node.kind == SyntaxKind::Member
                && let Some((_, _, target)) =
                    self.checked_required_model_reference(NodeKey::of(node), scenario.module)
            {
                pending.push((target, true));
            }
            if node.kind == SyntaxKind::Member
                && let Some((_, _, _, profile)) = self
                    .checked_profile_reference(NodeKey::of(node), scenario.module)
                    .or_else(|| self.checked_run_reference(NodeKey::of(node), scenario.module))
            {
                pending.push((profile, true));
            }
            expressions.extend(node.children.iter());
        }
        // Retain the owning Model census of actual helper query calls. These
        // original source facts supply no query execution or reference grant.
        // The call chain keeps caller Require occurrences separate from the
        // query and predicate in their defining helper source.
        for site in self.checked_decision_sites(scenario)? {
            if !matches!(
                site.stage,
                CheckedDecisionStage::LeadingRequire | CheckedDecisionStage::BodyRequire
            ) {
                continue;
            }
            for call in site.calls {
                if call.chain.is_empty() {
                    continue;
                }
                let CheckedDecisionCallTarget::Builtin { ref id, overload } = call.target else {
                    continue;
                };
                if !matches!(id.as_str(), "any" | "all" | "count" | "first") {
                    continue;
                }
                let (domain, domain_type) = call.arguments.get(call.slots.first().copied()??)?;
                if self.nodes.get(domain)?.kind != SyntaxKind::Query {
                    continue;
                }
                let query = self.types.checked_queries.get(domain)?;
                let stored = matches!(&query.domain_type, ResolvedType::Array { element, .. }
                    if matches!(element.as_ref(), ResolvedType::Record { stored: true, .. }));
                let collection = self.types.checked_collection_calls.get(&call.node);
                if !stored && collection.is_none() {
                    continue;
                }
                let collection = collection?;
                let model = collection.model;
                let row = ResolvedType::Record {
                    symbol: model,
                    stored: true,
                };
                let array = ResolvedType::Array {
                    element: Box::new(row),
                    ordered: true,
                    nonempty: false,
                };
                let alias = query
                    .clauses
                    .iter()
                    .find(|clause| clause.node == collection.alias)?;
                let CheckedQueryClauseKind::As { name } = &alias.kind else {
                    return None;
                };
                let owner = self.resolve.symbols.get(model.0 as usize)?;
                let source = self.source(call.module, call.node).ok()?;
                let query_node = self.nodes.get(domain)?;
                let clauses: Vec<_> = query_node
                    .children
                    .iter()
                    .filter(|child| child.kind == SyntaxKind::QueryClause)
                    .map(NodeKey::of)
                    .collect();
                let domains: Vec<_> = query_node
                    .children
                    .iter()
                    .filter(|child| expression(child.kind))
                    .map(NodeKey::of)
                    .collect();
                if collection.node != call.node
                    || collection.builtin != *id
                    || collection.overload != overload
                    || collection.query != *domain
                    || query.node != *domain
                    || query.domain_type != array
                    || query.result != array
                    || *domain_type != array
                    || self.types.node_types.get(domain) != Some(&array)
                    || self.types.node_types.get(&query.domain) != Some(&array)
                    || !alias.expressions.is_empty()
                    || name.is_empty()
                    || clauses
                        != query
                            .clauses
                            .iter()
                            .map(|clause| clause.node)
                            .collect::<Vec<_>>()
                    || domains != [query.domain]
                    || call.source != source
                    || self.source(call.module, *domain).ok()? != source
                    || !matches!(owner.kind, SymbolKind::Model { .. })
                    || owner.id != model
                    || self.checked_created_model(model, owner.module).is_none()
                    || !call.defaults.is_empty()
                    || collection
                        .predicate
                        .as_ref()
                        .map(|predicate| (predicate.node, predicate.ty.clone()))
                        != call
                            .slots
                            .get(1)
                            .copied()
                            .flatten()
                            .and_then(|slot| call.arguments.get(slot))
                            .cloned()
                {
                    return None;
                }
                pending.push((model, true));
            }
        }
        for query in self.checked_count_query_sources(scenario)? {
            pending.push((query.model, true));
            if let Some((_, parameter)) = query.count.as_ref()?.contained_parent
                && let Some(ResolvedType::Record {
                    symbol,
                    stored: true,
                }) = self.types.symbol_types.get(&parameter)
            {
                pending.push((*symbol, true));
            }
            for edge in &query.count.as_ref()?.parent_edges {
                pending.push((edge.child, true));
                pending.push((edge.parent, true));
            }
        }
        for query in self.checked_any_query_sources(scenario)? {
            pending.push((query.model, true));
        }
        for transcript in self
            .checked_transcript_sources(scenario)
            .unwrap_or_default()
        {
            pending.push((transcript.model, true));
        }
        // A helper's lazy CONTROL census needs the exact declared reference
        // array even when it is not a reusable bounded Create operand. This
        // inventory is source evidence; it grants no array read or write.
        let helper_query_fields: HashSet<_> = self
            .checked_helper_any_query_sources(scenario)
            .into_iter()
            .flatten()
            .flat_map(|query| query.dependencies)
            .filter(|read| read.role == DependencyRole::Control)
            .map(|read| (read.model, read.field))
            .collect();
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
                    && !inline_selections
                        .iter()
                        .any(|fact| id == fact.parent.parent && *field == fact.prefix)
                    && !current_revision
                        .as_ref()
                        .is_some_and(|fact| id == fact.template && *field == fact.field)
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
                if model && self.types.given_fields.contains_key(field) {
                    let definition = self.checked_created_model(id, declaration.module)?;
                    let contributed = definition
                        .contributed
                        .iter()
                        .find(|candidate| candidate.field == *field)?
                        .clone();
                    if contributed.ty != *ty || !result_type(ty) {
                        return None;
                    }
                    let declared = exact_type_id(ty, self.resolve)?;
                    fields.push(CheckedStoredContractField {
                        id: *field,
                        canonical: member.canonical.clone(),
                        name: member.name.clone(),
                        owner: id,
                        span: member.span,
                        source: contributed.source.clone(),
                        ty: ty.clone(),
                        required_array: false,
                        declared,
                        constraints: contributed.constraints.clone(),
                        trim: contributed.value.trim,
                        contributed: Some(contributed),
                        reuse: None,
                        min: None,
                        max: None,
                    });
                    continue;
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
                    && !helper_query_fields.contains(&(id, *field))
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
                let mut declared = if inline_selections
                    .iter()
                    .any(|fact| id == fact.parent.parent && *field == fact.prefix && *ty == fact.ty)
                {
                    "TextMessage[]".into()
                } else {
                    checked_stored_contract_type_id(
                        ty,
                        if self.reference_operand_type_id(ty).is_some() {
                            None
                        } else {
                            constraints.as_ref().and_then(|value| value.alias)
                        },
                        self.resolve,
                        0,
                    )?
                };
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
                    contributed: None,
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
        let Some(projection) = query.projection.as_ref() else {
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
                if matches!(element.as_ref(), ResolvedType::Record {symbol, ..} if *symbol == projection.contract)
                    && matches!(self.resolve.symbols.get(projection.contract.0 as usize).map(|s| &s.kind), Some(SymbolKind::Contract {..})))
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
            require_consumptions: Vec::new(),
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
        if !scenario.read {
            let mut first = self.checked_count_query_sources(scenario)?;
            first.extend(self.checked_any_query_sources(scenario)?);
            first.extend(self.checked_helper_any_query_sources(scenario)?);
            first.extend(
                self.checked_inline_selection_sources(scenario)?
                    .into_iter()
                    .map(|fact| fact.query),
            );
            for binding in &scenario.effects {
                let Some(value) = binding.value.and_then(|key| self.query_group(key)) else {
                    continue;
                };
                if binding.verb == EffectVerb::Let
                    && matches!(self.types.selected_calls.get(&value).map(|call| &call.target),
                        Some(SelectedCallTarget::Builtin {id,..}) if id == "first")
                {
                    first.push(self.checked_first_query_source(scenario, binding)?);
                    if first.len() > 200 {
                        return None;
                    }
                }
            }
            if !first.is_empty() {
                first.sort_by_key(|query| {
                    let call = query
                        .first
                        .as_ref()
                        .map(|fact| fact.call)
                        .or_else(|| query.count.as_ref().map(|fact| fact.call))
                        .unwrap_or(query.node);
                    (call.start, call.end)
                });
                return Some(first);
            }
        }
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
            alias: Some(scan_alias.node),
            predicate: Some(predicate),
            inputs: vec![
                (membership.1, targets),
                (equality.1, location),
                (targets_argument, targets),
            ],
            dependencies,
            order: Vec::new(),
            limit: None,
            archived: false,
            cardinality_guard: Some(guard.node),
            return_node: returned.node,
            projection: Some(DisclosureQueryProjection {
                node: select_key,
                source: self.source(scenario.module, select_key).ok()?,
                contract: projection.contract,
                model,
                alias: projection.alias,
                fields: projection.fields.clone(),
            }),
            first: None,
            count: None,
            influences,
        }])
    }

    /// Preserve a helper Require's exact root ANY source census.
    /// This records its lazy candidate reads; it admits no query execution.
    fn checked_helper_any_query_sources(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<DisclosureQuery>> {
        if scenario.read || scenario.on.is_some() || self.catalog.is_none() {
            return Some(Vec::new());
        }
        let mut queries = Vec::new();
        for site in self.checked_decision_sites(scenario)? {
            if !matches!(
                site.stage,
                CheckedDecisionStage::LeadingRequire | CheckedDecisionStage::BodyRequire
            ) {
                continue;
            }
            for call in site.calls.iter().filter(|call| call.chain.is_empty()) {
                let CheckedDecisionCallTarget::DeriveFn(derive) = call.target else {
                    continue;
                };
                let data = self.effects.derives.get(&derive)?;
                let body = self.query_group(data.expr?)?;
                let Some(selected) = self.types.selected_calls.get(&body) else {
                    continue;
                };
                if !matches!(&selected.target, SelectedCallTarget::Builtin { id, .. } if id == "any")
                    || data.params.len() != 2
                    || self.types.symbol_types.get(&data.params[0].param)
                        != Some(&ResolvedType::Scalar(Scalar::User))
                {
                    continue;
                }
                if call
                    .slots
                    .get(1)
                    .copied()
                    .flatten()
                    .and_then(|slot| call.arguments.get(slot))
                    .and_then(|(argument, _)| {
                        self.checked_contract_input_reference(*argument, scenario.module)
                            .map(|(_, model, _)| model)
                            .or_else(|| {
                                (site.stage == CheckedDecisionStage::BodyRequire)
                                    .then(|| {
                                        self.checked_required_model_reference(
                                            *argument,
                                            scenario.module,
                                        )
                                    })
                                    .flatten()
                                    .map(|(_, _, model)| model)
                            })
                    })
                    .is_none()
                {
                    continue;
                }
                queries.push(
                    self.checked_helper_any_query_source(scenario, &site, call, derive, body)?,
                );
                if queries.len() > 200 {
                    return None;
                }
            }
        }
        Some(queries)
    }

    fn checked_helper_any_query_source(
        &self,
        scenario: &super::effects::ScenarioData,
        site: &CheckedDecisionSite,
        outer: &CheckedDecisionCall,
        derive: SymbolId,
        body: NodeKey,
    ) -> Option<DisclosureQuery> {
        let data = self.effects.derives.get(&derive)?;
        let declaration = self.resolve.symbols.get(derive.0 as usize)?;
        let [person, location] = data.params.as_slice() else {
            return None;
        };
        let ResolvedType::Record {
            symbol: location_model,
            stored: true,
        } = self.types.symbol_types.get(&location.param)?
        else {
            return None;
        };
        let [Some(actor_slot), Some(location_slot)] = outer.slots.as_slice() else {
            return None;
        };
        if outer.arguments.len() != 2 || actor_slot == location_slot {
            return None;
        }
        let actor = outer.arguments.get(*actor_slot)?;
        let argument = outer.arguments.get(*location_slot)?;
        let (parameter, actual_model) = if let Some((parameter, model, _)) =
            self.checked_contract_input_reference(argument.0, scenario.module)
        {
            (Some(parameter), model)
        } else {
            if site.stage != CheckedDecisionStage::BodyRequire {
                return None;
            }
            let (_, _, model) =
                self.checked_required_model_reference(argument.0, scenario.module)?;
            (None, model)
        };
        let location_path = self
            .nodes
            .get(&location.type_node)?
            .children
            .iter()
            .find(|child| child.kind == SyntaxKind::Path)?;
        let selected = self.types.selected_calls.get(&body)?;
        let [domain, predicate] = selected.arguments.as_slice() else {
            return None;
        };
        let checked = self.types.checked_queries.get(domain)?;
        let collection = self.types.checked_collection_calls.get(&body)?;
        let [alias] = checked.clauses.as_slice() else {
            return None;
        };
        let CheckedQueryClauseKind::As { name } = &alias.kind else {
            return None;
        };
        let model = self.resolve.symbols.get(collection.model.0 as usize)?;
        let array = ResolvedType::Array {
            element: Box::new(ResolvedType::Record {
                symbol: model.id,
                stored: true,
            }),
            ordered: true,
            nonempty: false,
        };
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        let source = self.source(data.module, body).ok()?;
        let frame = CheckedDecisionCallFrame {
            node: outer.node,
            module: scenario.module,
            source: outer.source.clone(),
            derive,
        };
        let nested = site.calls.iter().find(|call| {
            call.node == body && call.chain.as_slice() == std::slice::from_ref(&frame)
        })?;
        let call_node = self.nodes.get(&outer.node)?;
        let head = call_node
            .children
            .iter()
            .find(|child| expression(child.kind))?;
        let binding = self
            .resolve
            .module_scopes
            .get(scenario.module.0 as usize)?
            .prod
            .get(self.word(head)?)?;
        let matches_owner = match binding {
            ScopedName::Local(target) => *target == derive && declaration.module == scenario.module,
            ScopedName::Imported {
                target,
                bound: false,
            } => *target == derive && declaration.exported && declaration.module != scenario.module,
            _ => false,
        };
        let query_node = self.nodes.get(domain)?;
        let source_domains: Vec<_> = query_node
            .children
            .iter()
            .filter(|child| expression(child.kind))
            .map(NodeKey::of)
            .collect();
        let source_clauses: Vec<_> = query_node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::QueryClause)
            .map(NodeKey::of)
            .collect();
        let alias_words: Vec<_> = self
            .nodes
            .get(&alias.node)?
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Name)
            .map(|child| self.word(child))
            .collect::<Option<Vec<_>>>()?;
        if !matches_owner
            || declaration.module != data.module
            || data.derive != derive
            || !matches!(&declaration.kind, SymbolKind::DeriveFn { params, .. } if params.as_slice() == [person.param, location.param])
            || data.params.iter().any(|formal| formal.default.is_some())
            || self
                .db
                .get(person.type_node.file)?
                .text
                .get(person.type_node.start as usize..person.type_node.end as usize)?
                .trim()
                != "user"
            || !matches!(self.resolve.node_typeref.get(&NodeKey::of(location_path)), Some(TypeRef::Symbol(target)) if target == location_model)
            || actual_model != *location_model
            || argument.1
                != (ResolvedType::Record {
                    symbol: *location_model,
                    stored: true,
                })
            || actor.1 != ResolvedType::Scalar(Scalar::User)
            || !matches!(
                self.query_binding(actor.0),
                Some(Binding::Context(ContextVar::Actor(_)))
            )
            || outer.module != scenario.module
            || outer.source != site.source
            || !outer.defaults.is_empty()
            || selected.slots.as_slice() != [Some(0), Some(1)]
            || collection.node != body
            || collection.builtin != "any"
            || collection.query != *domain
            || collection.model != model.id
            || nested.target
                != (CheckedDecisionCallTarget::Builtin {
                    id: "any".into(),
                    overload: collection.overload,
                })
            || nested.arguments != vec![(*domain, array.clone()), (*predicate, boolean.clone())]
            || nested.source != source
            || nested.module != data.module
            || !nested.defaults.is_empty()
            || nested.slots.as_slice() != [Some(0), Some(1)]
            || query_node.kind != SyntaxKind::Query
            || source_domains != [checked.domain]
            || source_clauses != [alias.node]
            || alias_words != ["as", name.as_str()]
            || self.types.symbol_results.get(&derive) != Some(&Some(boolean.clone()))
            || checked.node != *domain
            || checked.domain_type != array
            || checked.result != array
            || checked.projection.is_some()
            || alias.node != collection.alias
            || !alias.expressions.is_empty()
            || name.is_empty()
            || collection
                .predicate
                .as_ref()
                .is_none_or(|value| value.node != *predicate || value.ty != boolean)
            || !matches!(self.query_binding(checked.domain), Some(Binding::Symbol(target)) if *target == model.id)
            || !matches!(
                model.kind,
                SymbolKind::Model {
                    owner: ModelOwner::Team | ModelOwner::App,
                    ..
                }
            )
            || self.types.node_types.get(&body) != Some(&boolean)
            || self.types.node_types.get(predicate) != Some(&boolean)
        {
            return None;
        }
        self.checked_created_model(model.id, model.module)?;
        self.checked_created_model(
            *location_model,
            self.resolve.symbols.get(location_model.0 as usize)?.module,
        )?;
        for (index, formal) in data.params.iter().enumerate() {
            if !matches!(self.resolve.symbols.get(formal.param.0 as usize)?.kind,
                SymbolKind::Param { owner, index: position, type_node } if owner == derive && position == index && type_node == formal.type_node)
            {
                return None;
            }
        }
        let mut eager = self.query_group(*predicate)?;
        for _ in 0..64 {
            let next = self
                .query_binary(eager, "and")
                .or_else(|| self.query_binary(eager, "or"));
            match next {
                Some((left, _)) => eager = self.query_group(left)?,
                None => break,
            }
        }
        let (left, right) = self.query_binary(eager, "==")?;
        let (first_read, compared) = if self.query_member(left, alias.node, model.id).is_some() {
            (left, right)
        } else {
            (right, left)
        };
        let first_field = self.query_member(first_read, alias.node, model.id)?;
        if self.types.symbol_types.get(&first_field) != Some(&ResolvedType::Scalar(Scalar::User))
            || !matches!(self.query_binding(self.query_group(compared)?), Some(Binding::Symbol(target)) if *target == person.param)
        {
            return None;
        }
        let id = self
            .opaque("query", *domain, &self.key_stamp(outer.node).ok()?)
            .ok()?;
        let mut dependencies = Vec::new();
        let mut pending = vec![*self.nodes.get(predicate)?];
        let mut visits = 0;
        while let Some(node) = pending.pop() {
            visits += 1;
            if visits > 16384 {
                return None;
            }
            if node.kind == SyntaxKind::Member {
                let key = NodeKey::of(node);
                let field = self.query_member(key, alias.node, model.id)?;
                if self.types.node_types.get(&key) != self.types.symbol_types.get(&field) {
                    return None;
                }
                let mut read = self.query_dependency(
                    key,
                    data.module,
                    model.id,
                    field,
                    DependencyRole::Control,
                    &id,
                )?;
                read.calls.push(outer.node);
                dependencies.push(read);
            }
            pending.extend(node.children.iter().rev());
        }
        let first_read = self.query_group(first_read)?;
        if dependencies
            .first()
            .is_none_or(|read| read.node != first_read || read.field != first_field)
        {
            return None;
        }
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
                    .opaque("query-influence", *domain, &format!("{id}:{kind:?}"))
                    .ok()?,
                source: source.clone(),
                node: *domain,
                kind,
                query_id: Some(id.clone()),
            })
        })
        .collect::<Option<Vec<_>>>()?;
        Some(DisclosureQuery {
            id,
            source,
            node: *domain,
            domain: checked.domain,
            model: model.id,
            model_name: model.canonical.clone(),
            alias: Some(alias.node),
            predicate: Some(*predicate),
            inputs: parameter
                .map(|parameter| vec![(argument.0, parameter)])
                .unwrap_or_default(),
            dependencies,
            order: Vec::new(),
            limit: None,
            archived: false,
            cardinality_guard: None,
            return_node: scenario.effects.last()?.node,
            projection: None,
            first: None,
            count: None,
            influences,
        })
    }

    /// The original leading unfinished-Run check has an external predicate.
    /// Its candidate reads stay query-owned, never a fabricated where clause
    /// or one parent decision shared across repeated candidate evaluations.
    fn checked_any_query_sources(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<DisclosureQuery>> {
        if scenario.read || scenario.on.is_some() || self.catalog.is_none() {
            return Some(Vec::new());
        }
        let mut queries = Vec::new();
        let mut visits = 0usize;
        for guard in &scenario.guards {
            let mut pending = vec![*self.nodes.get(&guard.node)?];
            while let Some(node) = pending.pop() {
                visits += 1;
                if visits > 16384 {
                    return None;
                }
                pending.extend(node.children.iter().rev());
                if node.kind != SyntaxKind::Call {
                    continue;
                }
                let call = NodeKey::of(node);
                let Some(selected) = self.types.selected_calls.get(&call) else {
                    continue;
                };
                if !matches!(&selected.target,SelectedCallTarget::Builtin {id,..} if id=="any") {
                    continue;
                }
                let domain = *selected.arguments.get(selected.slots.first().copied()??)?;
                let domain = self.query_group(domain)?;
                // Supplied value arrays retain their existing pure closure.
                // This finite inventory is solely a true stored model query.
                if self.nodes.get(&domain)?.kind != SyntaxKind::Query
                    || !matches!(self.types.node_types.get(&domain),
                        Some(ResolvedType::Array {element,..})
                        if matches!(element.as_ref(),ResolvedType::Record {stored:true,..}))
                {
                    continue;
                }
                queries.push(self.checked_any_query_source(scenario, guard, call)?);
                if queries.len() > 1 {
                    return None;
                }
            }
        }
        Some(queries)
    }

    fn checked_any_query_source(
        &self,
        scenario: &super::effects::ScenarioData,
        guard: &Effect,
        call: NodeKey,
    ) -> Option<DisclosureQuery> {
        let selected = self.types.selected_calls.get(&call)?;
        let SelectedCallTarget::Builtin {
            id: builtin,
            overload,
        } = &selected.target
        else {
            return None;
        };
        let [supplied, predicate] = selected.arguments.as_slice() else {
            return None;
        };
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        let catalog = self.catalog?;
        let signature = catalog.overloads(builtin)?.get(*overload)?;
        let [domain_input, predicate_input] = signature.params.as_slice() else {
            return None;
        };
        let condition = guard.cond?;
        let unary = self.nodes.get(&self.query_group(condition)?)?;
        let unary_values: Vec<_> = unary
            .children
            .iter()
            .filter(|part| expression(part.kind))
            .map(NodeKey::of)
            .collect();
        let unary_words: Vec<_> = unary
            .children
            .iter()
            .filter(|part| matches!(part.kind, SyntaxKind::Name | SyntaxKind::Punct))
            .map(|part| self.word(part))
            .collect::<Option<Vec<_>>>()?;
        let call_node = self.nodes.get(&call)?;
        let target = call_node
            .children
            .iter()
            .find(|part| expression(part.kind))?;
        let arguments: Vec<_> = call_node
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::Argument)
            .map(|part| {
                let mut values = part.children.iter().filter(|value| expression(value.kind));
                let value = NodeKey::of(values.next()?);
                values.next().is_none().then_some(value)
            })
            .collect::<Option<Vec<_>>>()?;
        let by = scenario.by?;
        if builtin != "any"
            || catalog.effects(builtin) != Some(Effects::Pure)
            || domain_input.name != "domain"
            || domain_input.ty != SigType::Collection(Box::new(SigType::Any))
            || domain_input.alias.is_none()
            || domain_input.in_scope.is_some()
            || predicate_input.name != "predicate"
            || predicate_input.ty != SigType::Named("bool".into())
            || predicate_input.alias.is_some()
            || predicate_input.in_scope != domain_input.alias
            || signature.result != SigType::Named("bool".into())
            || selected.slots.as_slice() != [Some(0), Some(1)]
            || self.types.node_types.get(&call) != Some(&boolean)
            || self.types.node_types.get(predicate) != Some(&boolean)
            || self.types.node_types.get(&condition) != Some(&boolean)
            || guard.verb != EffectVerb::Require
            || self.nodes.get(&guard.node)?.kind != SyntaxKind::Require
            || unary.kind != SyntaxKind::Unary
            || unary_words != ["not"]
            || unary_values.len() != 1
            || self.query_group(unary_values[0])? != call
            || call_node.kind != SyntaxKind::Call
            || arguments != selected.arguments
            || target.kind != SyntaxKind::NameRef
            || self.word(target)? != "any"
            || !matches!(self.query_binding(NodeKey::of(target)),Some(Binding::Builtin {id}) if id=="any")
            || scenario.read
            || scenario.on.is_some()
            || scenario.cohort.is_some()
            || !matches!(self.query_binding(by), Some(Binding::Predicate))
            || self
                .db
                .get(by.file)?
                .text
                .get(by.start as usize..by.end as usize)?
                .trim()
                != "members"
            || guard.node.file != scenario.node.file
            || call.file != guard.node.file
            || guard.node.start < scenario.node.start
            || guard.node.end > scenario.node.end
            || call.start < guard.node.start
            || call.end > guard.node.end
        {
            return None;
        }
        let node = self.query_group(*supplied)?;
        let query = self.types.checked_queries.get(&node)?;
        let fact = self.types.checked_collection_calls.get(&call)?;
        let [alias] = query.clauses.as_slice() else {
            return None;
        };
        let CheckedQueryClauseKind::As { name } = &alias.kind else {
            return None;
        };
        let model = fact.model;
        let owner = self.checked_count_model(model, scenario.module)?;
        let (receiver, collection) = self.count_member(query.domain)?;
        let parameter = self.query_parameter(scenario, receiver)?;
        let (parent, hops) = self.checked_call_parent_path(receiver, parameter, 0)?;
        self.checked_count_model(parent, scenario.module)?;
        let parameter_symbol = self.resolve.symbols.get(parameter.0 as usize)?;
        let SymbolKind::Param {
            owner: parameter_owner,
            index,
            type_node,
        } = parameter_symbol.kind
        else {
            return None;
        };
        let parameter_data = scenario.params.get(index)?;
        let array = ResolvedType::Array {
            element: Box::new(ResolvedType::Record {
                symbol: model,
                stored: true,
            }),
            ordered: true,
            nonempty: false,
        };
        let authored = self.nodes.get(&node)?;
        let domains: Vec<_> = authored
            .children
            .iter()
            .filter(|part| expression(part.kind))
            .map(NodeKey::of)
            .collect();
        let clauses: Vec<_> = authored
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::QueryClause)
            .map(NodeKey::of)
            .collect();
        let alias_words: Vec<_> = self
            .nodes
            .get(&alias.node)?
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::Name)
            .map(|part| self.word(part))
            .collect::<Option<Vec<_>>>()?;
        let predicate_node = self.query_group(*predicate)?;
        let field = self.query_member(predicate_node, alias.node, model)?;
        if fact.node != call
            || fact.builtin != "any"
            || fact.overload != *overload
            || fact.query != node
            || fact.alias != alias.node
            || fact
                .predicate
                .as_ref()
                .is_none_or(|actual| actual.node != *predicate || actual.ty != boolean)
            || authored.kind != SyntaxKind::Query
            || query.node != node
            || query.projection.is_some()
            || query.domain_type != array
            || query.result != array
            || self.types.node_types.get(&node) != Some(&array)
            || self.types.node_types.get(supplied) != Some(&array)
            || self.types.node_types.get(&query.domain) != Some(&array)
            || domains != [query.domain]
            || clauses != [alias.node]
            || !alias.expressions.is_empty()
            || alias_words != ["as", name.as_str()]
            || collection != owner.name
            || hops != 0
            || !self.original_reference_parameter(receiver, parameter)
            || self.model_has_field(parent, collection)
            || !matches!(owner.kind,SymbolKind::Model {owner:ModelOwner::ChildOf(actual),..} if actual==parent)
            || self.effects.models.get(&model)?.owner != ModelOwner::ChildOf(parent)
            || parameter_owner != scenario.scenario
            || parameter_symbol.module != scenario.module
            || parameter_symbol.id != parameter
            || parameter_data.param != parameter
            || parameter_data.type_node != type_node
            || parameter_data.default.is_some()
            || self.word(self.nodes.get(&receiver)?)? != parameter_symbol.name
            || self.query_member_name(predicate_node, alias.node, model) != Some("unfinished")
            || self.types.node_types.get(&predicate_node) != Some(&boolean)
            || self.types.symbol_types.get(&field) != Some(&boolean)
        {
            return None;
        }
        let source = self.source(scenario.module, node).ok()?;
        let sites = self.checked_decision_sites(scenario)?;
        let mut matching = sites.iter().filter(|site| {
            site.owner == scenario.scenario
                && site.statement == guard.node
                && site.node == condition
                && site.stage == CheckedDecisionStage::LeadingRequire
                && site.source == source
        });
        let site = matching.next()?;
        let mut original_calls = site.calls.iter().filter(|original| original.node == call);
        let original = original_calls.next()?;
        if matching.next().is_some()
            || original_calls.next().is_some()
            || original.module != scenario.module
            || original.source != source
            || original.target
                != (CheckedDecisionCallTarget::Builtin {
                    id: "any".into(),
                    overload: *overload,
                })
            || original.arguments != vec![(*supplied, array), (*predicate, boolean)]
            || original.slots != selected.slots
            || !original.defaults.is_empty()
            || !original.chain.is_empty()
        {
            return None;
        }
        let returned = scenario.effects.last()?;
        if returned.verb != EffectVerb::Return {
            return None;
        }
        let id = self.opaque("query", node, "").ok()?;
        let dependencies = vec![self.query_dependency(
            predicate_node,
            scenario.module,
            model,
            field,
            DependencyRole::Control,
            &id,
        )?];
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
                    .opaque("query-influence", node, &format!("{id}:{kind:?}"))
                    .ok()?,
                source: source.clone(),
                node,
                kind,
                query_id: Some(id.clone()),
            })
        })
        .collect::<Option<Vec<_>>>()?;
        Some(DisclosureQuery {
            id,
            source,
            node,
            domain: query.domain,
            model,
            model_name: owner.canonical.clone(),
            alias: Some(alias.node),
            predicate: Some(*predicate),
            inputs: vec![(receiver, parameter)],
            dependencies,
            order: Vec::new(),
            limit: None,
            archived: false,
            cardinality_guard: None,
            return_node: returned.node,
            projection: None,
            first: None,
            count: None,
            influences,
        })
    }

    /// Retain original model counts independently from executable disclosure.
    /// Supplied arrays and derived value arrays remain ordinary pure count.
    fn checked_count_query_sources(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<Vec<DisclosureQuery>> {
        if scenario.read || scenario.on.is_some() {
            return Some(Vec::new());
        }
        let mut queries = Vec::new();
        let mut visited = 0usize;
        for statement in scenario.guards.iter().chain(&scenario.effects) {
            let mut pending = vec![*self.nodes.get(&statement.node)?];
            while let Some(node) = pending.pop() {
                visited += 1;
                if visited > 16384 {
                    return None;
                }
                if node.kind == SyntaxKind::Examples {
                    continue;
                }
                pending.extend(node.children.iter().rev());
                if node.kind != SyntaxKind::Call {
                    continue;
                }
                let call = NodeKey::of(node);
                let callee = node.children.iter().find(|part| expression(part.kind))?;
                let is_count = matches!(self.query_binding(NodeKey::of(callee)),
                    Some(Binding::Builtin {id}) if id == "count");
                if !is_count {
                    continue;
                }
                let mut arguments = node
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Argument);
                let argument = arguments.next()?;
                let mut values = argument
                    .children
                    .iter()
                    .filter(|part| expression(part.kind));
                let supplied = NodeKey::of(values.next()?);
                if arguments.next().is_some() || values.next().is_some() {
                    return None;
                }
                let domain = self.query_group(supplied)?;
                let Some(ResolvedType::Array { element, .. }) = self.types.node_types.get(&domain)
                else {
                    continue;
                };
                let ResolvedType::Record {
                    symbol: model,
                    stored: true,
                } = element.as_ref()
                else {
                    continue;
                };
                // Parameter arrays and other local arrays are pure values.
                // A model-query inventory requires its actual Query or Member.
                if !matches!(
                    self.nodes.get(&domain)?.kind,
                    SyntaxKind::Query | SyntaxKind::Member
                ) {
                    continue;
                }
                if self.nodes.get(&domain)?.kind == SyntaxKind::Member {
                    let (receiver, name) = self.count_member(domain)?;
                    if let Some(ResolvedType::Record { symbol, .. }) =
                        self.types.node_types.get(&receiver)
                        && self
                            .resolve
                            .symbols
                            .get(symbol.0 as usize)?
                            .fields_of()
                            .iter()
                            .any(|field| {
                                self.resolve
                                    .symbols
                                    .get(field.0 as usize)
                                    .is_some_and(|field| field.name == name)
                            })
                    {
                        // An authored field array is a supplied value. It must
                        // never borrow implicit child-collection provenance.
                        continue;
                    }
                }
                queries.push(self.checked_count_query_source(
                    scenario,
                    statement.node,
                    call,
                    supplied,
                    *model,
                )?);
                if queries.len() > 200 {
                    return None;
                }
            }
        }
        queries.sort_by_key(|query| (query.count.as_ref().unwrap().call.start, query.node.end));
        Some(queries)
    }

    fn checked_count_query_source(
        &self,
        scenario: &super::effects::ScenarioData,
        statement: NodeKey,
        call: NodeKey,
        supplied: NodeKey,
        model: SymbolId,
    ) -> Option<DisclosureQuery> {
        let selected = self.types.selected_calls.get(&call)?;
        let SelectedCallTarget::Builtin {
            id: builtin,
            overload,
        } = &selected.target
        else {
            return None;
        };
        let node = self.query_group(supplied)?;
        let record = ResolvedType::Record {
            symbol: model,
            stored: true,
        };
        let array = ResolvedType::Array {
            element: Box::new(record.clone()),
            ordered: true,
            nonempty: false,
        };
        let owner = self.checked_count_model(model, scenario.module)?;
        if builtin != "count"
            || selected.arguments.as_slice() != [supplied]
            || selected.slots.as_slice() != [Some(0)]
            || self.types.node_types.get(&call) != Some(&ResolvedType::Scalar(Scalar::Int))
            || self.types.node_types.get(&node) != Some(&array)
            || self.types.node_types.get(&supplied) != Some(&array)
            || statement.file != call.file
            || statement.start > call.start
            || statement.end < call.end
            || scenario.node.file != statement.file
            || scenario.node.start > statement.start
            || scenario.node.end < statement.end
        {
            return None;
        }
        let source = self.source(scenario.module, node).ok()?;
        let id = self.opaque("query", node, "").ok()?;
        let mut dependencies = Vec::new();
        let mut inputs = Vec::new();
        let mut parent_edges = Vec::new();
        let (domain, alias, predicate, contained_parent) = match self.nodes.get(&node)?.kind {
            SyntaxKind::Member => {
                if self.types.checked_queries.contains_key(&node)
                    || self.types.checked_collection_calls.contains_key(&call)
                {
                    return None;
                }
                let (receiver, name) = self.count_member(node)?;
                let parameter = self.query_parameter(scenario, receiver)?;
                let (parent, hops) = self.checked_call_parent_path(receiver, parameter, 0)?;
                let SymbolKind::Model {
                    owner: ModelOwner::ChildOf(actual_parent),
                    ..
                } = &owner.kind
                else {
                    return None;
                };
                let parent_owner = self.checked_count_model(parent, scenario.module)?;
                if hops != 0
                    || *actual_parent != parent
                    || owner.name != name
                    || !self.original_reference_parameter(receiver, parameter)
                    || self.model_has_field(parent, name)
                    || self.effects.models.get(&model)?.owner != ModelOwner::ChildOf(parent)
                    || parent_owner.id != parent
                {
                    return None;
                }
                inputs.push((receiver, parameter));
                (node, None, None, Some((receiver, parameter)))
            }
            SyntaxKind::Query => {
                // This original ancestor scan is a real owning Require, not
                // a copied count tree or a selected-call annotation alone.
                let mut statements = scenario
                    .guards
                    .iter()
                    .chain(&scenario.effects)
                    .filter(|effect| effect.node == statement);
                let required = statements.next()?;
                let authored_statement = self.nodes.get(&statement)?;
                let authored_condition = authored_statement
                    .children
                    .iter()
                    .find(|part| expression(part.kind))
                    .map(NodeKey::of)?;
                let authored_call = self.nodes.get(&call)?;
                let callee = authored_call
                    .children
                    .iter()
                    .find(|part| expression(part.kind))?;
                if statements.next().is_some()
                    || required.verb != EffectVerb::Require
                    || authored_statement.kind != SyntaxKind::Require
                    || required.cond != Some(authored_condition)
                    || self.types.node_types.get(&authored_condition)
                        != Some(&ResolvedType::Scalar(Scalar::Bool))
                    || authored_call.kind != SyntaxKind::Call
                    || callee.kind != SyntaxKind::NameRef
                    || self.word(callee)? != "count"
                    || !matches!(self.query_binding(NodeKey::of(callee)),
                        Some(Binding::Builtin {id}) if id == "count")
                {
                    return None;
                }
                let fact = self.types.checked_collection_calls.get(&call)?;
                let query = self.types.checked_queries.get(&node)?;
                let [alias, predicate] = query.clauses.as_slice() else {
                    return None;
                };
                let authored = self.nodes.get(&node)?;
                let clauses: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::QueryClause)
                    .map(NodeKey::of)
                    .collect();
                let domains: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|part| expression(part.kind))
                    .map(NodeKey::of)
                    .collect();
                let alias_names: Vec<_> = self
                    .nodes
                    .get(&alias.node)?
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Name)
                    .map(|part| self.word(part))
                    .collect::<Option<Vec<_>>>()?;
                let where_names: Vec<_> = self
                    .nodes
                    .get(&predicate.node)?
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Name)
                    .map(|part| self.word(part))
                    .collect::<Option<Vec<_>>>()?;
                if fact.node != call
                    || fact.builtin != "count"
                    || fact.overload != *overload
                    || fact.query != node
                    || fact.model != model
                    || fact.alias != alias.node
                    || fact.predicate.is_some()
                    || query.node != node
                    || query.projection.is_some()
                    || query.domain_type != array
                    || query.result != array
                    || self.types.node_types.get(&query.domain) != Some(&array)
                    || !matches!(self.query_binding(query.domain), Some(Binding::Symbol(id)) if *id == model)
                    || self.nodes.get(&query.domain)?.kind != SyntaxKind::NameRef
                    || self.word(self.nodes.get(&query.domain)?)? != owner.name
                    || !matches!(&alias.kind, CheckedQueryClauseKind::As { name }
                        if alias_names == ["as", name.as_str()])
                    || !alias.expressions.is_empty()
                    || predicate.kind != CheckedQueryClauseKind::Where
                    || predicate.expressions.len() != 1
                    || clauses != [alias.node, predicate.node]
                    || domains != [query.domain]
                    || where_names != ["where"]
                {
                    return None;
                }
                let predicate_node = predicate.expressions[0];
                let actual_predicates: Vec<_> = self
                    .nodes
                    .get(&predicate.node)?
                    .children
                    .iter()
                    .filter(|part| expression(part.kind))
                    .map(NodeKey::of)
                    .collect();
                if actual_predicates != [predicate_node]
                    || self.types.node_types.get(&predicate_node)
                        != Some(&ResolvedType::Scalar(Scalar::Bool))
                {
                    return None;
                }
                let (equality, unfinished) = self.query_binary(predicate_node, "and")?;
                let (candidate_parent, supplied_parent) = self.query_binary(equality, "==")?;
                let (outer_receiver, outer_name) = self.count_member(candidate_parent)?;
                let (candidate, inner_name) = self.count_member(outer_receiver)?;
                if outer_name != "parent"
                    || inner_name != "parent"
                    || !self.query_row(candidate, alias.node, model)
                {
                    return None;
                }
                let first_edge = self.checked_count_parent_edge(
                    outer_receiver,
                    candidate,
                    model,
                    scenario.module,
                )?;
                let second_edge = self.checked_count_parent_edge(
                    candidate_parent,
                    outer_receiver,
                    first_edge.parent,
                    scenario.module,
                )?;
                let (parameter_node, parameter_name) = self.count_member(supplied_parent)?;
                let parameter = self.query_parameter(scenario, parameter_node)?;
                let (parameter_model, hops) =
                    self.checked_call_parent_path(parameter_node, parameter, 0)?;
                let supplied_edge = self.checked_count_parent_edge(
                    supplied_parent,
                    parameter_node,
                    parameter_model,
                    scenario.module,
                )?;
                if parameter_name != "parent"
                    || hops != 0
                    || parameter_model != first_edge.parent
                    || supplied_edge.parent != second_edge.parent
                    || self.types.node_types.get(&equality)
                        != Some(&ResolvedType::Scalar(Scalar::Bool))
                {
                    return None;
                }
                let field = self.query_member(unfinished, alias.node, model)?;
                if self.resolve.symbols.get(field.0 as usize)?.name != "unfinished"
                    || self.types.symbol_types.get(&field)
                        != Some(&ResolvedType::Scalar(Scalar::Bool))
                    || self.types.node_types.get(&unfinished)
                        != Some(&ResolvedType::Scalar(Scalar::Bool))
                {
                    return None;
                }
                // This is original containment metadata, not an authored
                // field. Its owning query captures the candidate's first hop.
                dependencies.push(DisclosureDependency {
                    id: self.opaque("query-control", first_edge.node, &id).ok()?,
                    source: self.source(scenario.module, first_edge.node).ok()?,
                    node: first_edge.node,
                    calls: Vec::new(),
                    role: DependencyRole::Control,
                    model,
                    field: model,
                    model_name: owner.canonical.clone(),
                    field_name: "parent".into(),
                    ty: ResolvedType::Record {
                        symbol: first_edge.parent,
                        stored: true,
                    },
                    type_id: self
                        .resolve
                        .symbols
                        .get(first_edge.parent.0 as usize)?
                        .canonical
                        .clone(),
                    query_id: None,
                });
                dependencies.push(self.query_dependency(
                    unfinished,
                    scenario.module,
                    model,
                    field,
                    DependencyRole::Control,
                    &id,
                )?);
                inputs.push((parameter_node, parameter));
                parent_edges.extend([first_edge, second_edge, supplied_edge]);
                (query.domain, Some(alias.node), Some(predicate_node), None)
            }
            _ => return None,
        };
        let returned = scenario.effects.last()?;
        if returned.verb != EffectVerb::Return {
            return None;
        }
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
                    .opaque("query-influence", node, &format!("{id}:{kind:?}"))
                    .ok()?,
                source: source.clone(),
                node,
                kind,
                query_id: Some(id.clone()),
            })
        })
        .collect::<Option<Vec<_>>>()?;
        Some(DisclosureQuery {
            id,
            source,
            node,
            domain,
            model,
            model_name: owner.canonical.clone(),
            alias,
            predicate,
            inputs,
            dependencies,
            order: Vec::new(),
            limit: None,
            archived: false,
            cardinality_guard: None,
            return_node: returned.node,
            projection: None,
            first: None,
            count: Some(DisclosureCountQuery {
                call,
                overload: *overload,
                slots: selected.slots.clone(),
                statement,
                contained_parent,
                parent_edges,
            }),
            influences,
        })
    }

    fn count_member(&self, key: NodeKey) -> Option<(NodeKey, &str)> {
        let node = self.nodes.get(&key)?;
        if node.kind != SyntaxKind::Member {
            return None;
        }
        let mut receivers = node.children.iter().filter(|part| expression(part.kind));
        let receiver = NodeKey::of(receivers.next()?);
        if receivers.next().is_some() {
            return None;
        }
        let name = node
            .children
            .iter()
            .rev()
            .find(|part| part.kind == SyntaxKind::Name)?;
        Some((receiver, self.word(name)?))
    }

    fn model_has_field(&self, model: SymbolId, name: &str) -> bool {
        let Some(owner) = self.resolve.symbols.get(model.0 as usize) else {
            return true;
        };
        let SymbolKind::Model { fields, .. } = &owner.kind else {
            return true;
        };
        fields.iter().any(|field| {
            self.resolve
                .symbols
                .get(field.0 as usize)
                .is_none_or(|member| member.name == name)
        })
    }

    fn checked_count_model(
        &self,
        model: SymbolId,
        module: ModuleId,
    ) -> Option<&super::resolve::Symbol> {
        let owner = self.resolve.symbols.get(model.0 as usize)?;
        let data = self.effects.models.get(&model)?;
        let definition = self.checked_created_model(model, module)?;
        if owner.id != model
            || owner.module != module
            || data.module != module
            || definition.declaration.model != model
            || definition.declaration.node != data.node
        {
            return None;
        }
        Some(owner)
    }

    fn checked_count_parent_edge(
        &self,
        node: NodeKey,
        receiver: NodeKey,
        child: SymbolId,
        module: ModuleId,
    ) -> Option<DisclosureQueryParentEdge> {
        let (actual_receiver, name) = self.count_member(node)?;
        let owner = self.checked_count_model(child, module)?;
        let SymbolKind::Model {
            owner: ModelOwner::ChildOf(parent),
            ..
        } = owner.kind
        else {
            return None;
        };
        self.checked_count_model(parent, module)?;
        if actual_receiver != receiver
            || name != "parent"
            || self.model_has_field(child, "parent")
            || self.effects.models.get(&child)?.owner != ModelOwner::ChildOf(parent)
            || self.types.node_types.get(&receiver)
                != Some(&ResolvedType::Record {
                    symbol: child,
                    stored: true,
                })
            || self.types.node_types.get(&node)
                != Some(&ResolvedType::Record {
                    symbol: parent,
                    stored: true,
                })
        {
            return None;
        }
        Some(DisclosureQueryParentEdge {
            node,
            receiver,
            child,
            parent,
        })
    }

    /// C23 hook slice completeness: the skeleton below plus an actual
    /// admitted first-query fact for the leading `let`. Hooks without an
    /// admittable first query keep the trusted-handler refusal exactly.
    fn hook_first_complete(&self, scenario: &super::effects::ScenarioData) -> Option<()> {
        self.hook_first_event(scenario)?;
        let [binding, _] = scenario.effects.as_slice() else {
            return None;
        };
        self.checked_first_query_source(scenario, binding)?;
        Some(())
    }

    /// C23 hook slice skeleton: a declared-event handler (`on=Event`) with no
    /// caller parameters, no result, no cohort, no header guards and exactly
    /// one `let` plus one `require`. The returned event symbol authorizes the
    /// operand arm below; anything else keeps the trusted-handler refusal.
    fn hook_first_event(
        &self,
        scenario: &super::effects::ScenarioData,
    ) -> Option<SymbolId> {
        let Some(HandlerSource::Event(event)) = &scenario.on else {
            return None;
        };
        let event = *event;
        if scenario.read
            || scenario.by.is_some()
            || scenario.result.is_some()
            || scenario.cohort.is_some()
            || !scenario.params.is_empty()
            || !scenario.guards.is_empty()
        {
            return None;
        }
        let [binding, guard] = scenario.effects.as_slice() else {
            return None;
        };
        if binding.verb != EffectVerb::Let
            || guard.verb != EffectVerb::Require
            || guard.cond.is_none()
        {
            return None;
        }
        Some(event)
    }

    /// Ordinary-scenario guard skeleton (CAN18-v1 first-query absence
    /// conjunctions): an ordinary (event-less) scenario whose effects are
    /// exactly let-first, require-with-condition, create and return. Only
    /// this confined shape may gain the guard-consumed mark below; any
    /// other tail, extra effect or branch keeps ordinary viewer behavior.
    /// Parameters are allowed (checked inputs, not authority); guards,
    /// cohorts, reads and result-less shapes are out of scope.
    fn ordinary_first_decision<'b>(
        &self,
        scenario: &'b super::effects::ScenarioData,
    ) -> Option<(&'b super::effects::Effect, &'b super::effects::Effect)> {
        if scenario.on.is_some() {
            return None;
        }
        if scenario.read
            || scenario.by.is_none()
            || scenario.result.is_none()
            || scenario.cohort.is_some()
            || !scenario.guards.is_empty()
        {
            return None;
        }
        let [binding, guard, create, ret] = scenario.effects.as_slice() else {
            return None;
        };
        if binding.verb != EffectVerb::Let
            || guard.verb != EffectVerb::Require
            || guard.cond.is_none()
            || create.verb != EffectVerb::Create
            || ret.verb != EffectVerb::Return
        {
            return None;
        }
        Some((binding, guard))
    }

    /// DESIGN442 presence consumption: the confined hook `Require` consumes
    /// the first binding's presence when its condition references the `Let`
    /// occurrence (a null check or a stored-read base). Reuses the
    /// structural 2-effect skeleton above: only the skeleton's own `Let`
    /// counts, so an unused binding or `require true` references nothing
    /// and gains no decision authority. Body/value copies are out of scope:
    /// only the decision reads ride the mark.
    fn first_binding_presence_consumed(
        &self,
        binding: &Effect,
        cond: NodeKey,
    ) -> bool {
        let mut pending = vec![cond];
        let mut steps = 0;
        while let Some(key) = pending.pop() {
            steps += 1;
            if steps > 16384 {
                return false;
            }
            let Some(key) = self.query_group(key) else {
                continue;
            };
            if matches!(self.query_binding(key), Some(Binding::Let { node }) if *node == binding.node) {
                return true;
            }
            if let Some(node) = self.nodes.get(&key) {
                pending.extend(
                    node.children
                        .iter()
                        .filter(|child| expression(child.kind))
                        .map(NodeKey::of),
                );
            }
        }
        false
    }

    /// C23 hook event operand: the predicate compares the row field against
    /// one declared text field read off the handler's `event` binding
    /// (`event.source`, never a longer chain). The event declaration owns
    /// the field and its type equals the predicate field type, so the value
    /// is handler context like `actor` and carries no transported input.
    fn query_hook_event_operand(
        &self,
        event: SymbolId,
        operand: NodeKey,
        field_ty: &ResolvedType,
    ) -> Option<()> {
        if *field_ty != ResolvedType::Scalar(Scalar::Text) {
            return None;
        }
        let operand = self.query_group(operand)?;
        let node = self.nodes.get(&operand)?;
        if node.kind != SyntaxKind::Member {
            return None;
        }
        let base = node
            .children
            .iter()
            .find(|child| expression(child.kind))?;
        if !matches!(
            self.query_binding(NodeKey::of(base)),
            Some(Binding::Context(ContextVar::Event))
        ) {
            return None;
        }
        let name = node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        let spelling = self.word(name)?;
        let SymbolKind::Event { fields } = &self.resolve.symbols.get(event.0 as usize)?.kind
        else {
            return None;
        };
        let field = fields.iter().copied().find(|field| {
            self.resolve
                .symbols
                .get(field.0 as usize)
                .is_some_and(|symbol| symbol.name == spelling)
        })?;
        (self.types.symbol_types.get(&field)? == field_ty
            && self.types.node_types.get(&operand) == Some(field_ty))
        .then_some(())
    }

    /// An original scalar-equality scan selects one owning mutable row. The
    /// whole candidate domain remains retained; first is never a query limit.
    /// This inventory is available even when another original source leaf
    /// declines. Native execution still needs the complete owner/source join.
    fn checked_first_query_source(
        &self,
        scenario: &super::effects::ScenarioData,
        binding: &Effect,
    ) -> Option<DisclosureQuery> {
        // C23 hook slice: a declared-event handler with the exact void
        // single-first skeleton may prove its query facts; every other
        // trusted shape keeps the closure refusal below.
        let hook_event = self.hook_first_event(scenario);
        if scenario.read
            || (scenario.on.is_some() && hook_event.is_none())
            || binding.verb != EffectVerb::Let
            || !binding.then_effects.is_empty()
            || !binding.else_effects.is_empty()
            || !binding.match_arms.is_empty()
        {
            return None;
        }
        let call = self.query_group(binding.value?)?;
        let fact = self.types.checked_collection_calls.get(&call)?;
        let selected = self.types.selected_calls.get(&call)?;
        if fact.node != call
            || fact.builtin != "first"
            || fact.predicate.is_some()
            || !matches!(&selected.target, SelectedCallTarget::Builtin {id,overload}
                if id == "first" && *overload == fact.overload)
            || selected.arguments.len() != 1
            || selected.slots.as_slice() != [Some(0)]
            || self.query_group(selected.arguments[0])? != fact.query
        {
            return None;
        }
        let query = self.types.checked_queries.get(&fact.query)?;
        let owner = self.resolve.symbols.get(fact.model.0 as usize)?;
        let SymbolKind::Model { fields, .. } = &owner.kind else {
            return None;
        };
        let record = ResolvedType::Record {
            symbol: fact.model,
            stored: true,
        };
        let array = ResolvedType::Array {
            element: Box::new(record.clone()),
            ordered: true,
            nonempty: false,
        };
        // The grammar orders clauses `archived/as/where/order`: an
        // `archived=include` clause leads when present (the parser admits
        // only the exact `include` spelling; absence keeps the default).
        // Anything else keeps the closure refusal below.
        // Guarded archived arms lead: the unguarded `[alias, predicate,
        // order]` arm below would otherwise swallow a 3-clause
        // `[archived, alias, predicate]` shape (binding archived as the
        // alias) and fail As/Where validation, leaving the archived-3 arm
        // unreachable. Length-4 archived shapes never reach the plain arms.
        let (alias, predicate, order, archived) = match query.clauses.as_slice() {
            [archived, alias, predicate]
                if matches!(archived.kind, CheckedQueryClauseKind::Archived) =>
            {
                (alias, predicate, None, Some(archived))
            }
            [archived, alias, predicate, order]
                if matches!(archived.kind, CheckedQueryClauseKind::Archived) =>
            {
                (alias, predicate, Some(order), Some(archived))
            }
            [alias, predicate] => (alias, predicate, None, None),
            [alias, predicate, order] => (alias, predicate, Some(order), None),
            _ => return None,
        };
        // The grammar admits only the exact `archived=include` spelling, so
        // a present Archived clause always selects archived rows and its
        // absence keeps the default. No value reading is needed or possible.
        let archived = archived.is_some();
        // The C23 hook slice admits only the unordered engine-default
        // selection; authored ordering stays a sequenced follow-up.
        if hook_event.is_some() && order.is_some() {
            return None;
        }
        // The domain names its model plainly, or selects a contained child
        // through the original required parent parameter (domain
        // correspondence below). Anything else keeps the closure refusal.
        let contained_parent =
            self.checked_first_query_domain(scenario, query, fact.model, owner)?;
        if query.node != fact.query
            || query.projection.is_some()
            || query.domain_type != array
            || query.result != array
            || self.types.node_types.get(&query.domain) != Some(&array)
            || self.types.node_types.get(&fact.query) != Some(&array)
            || self.types.node_types.get(&call)
                != Some(&ResolvedType::Nullable(Box::new(record.clone())))
            || alias.node != fact.alias
            || !matches!(alias.kind, CheckedQueryClauseKind::As { .. })
            || !alias.expressions.is_empty()
            || predicate.kind != CheckedQueryClauseKind::Where
            || predicate.expressions.len() != 1
            || order.is_some_and(|order| {
                order.kind != CheckedQueryClauseKind::Order || order.expressions.len() != 1
            })
            || (owner.module != scenario.module
                && !self.imported_query_source(scenario.module, &owner.canonical))
        {
            return None;
        }
        let predicate_node = predicate.expressions[0];
        // A where predicate is one `==` conjunct or an `and` chain of them,
        // flattened order-preserving. Any other shape (`or`, comparisons,
        // calls) keeps the closure refusal below.
        let mut pending = vec![predicate_node];
        let mut conjuncts = Vec::new();
        while let Some(node) = pending.pop() {
            if let Some((left, right)) = self.query_binary(node, "and") {
                pending.push(right);
                pending.push(left);
                continue;
            }
            conjuncts.push(node);
        }
        if conjuncts.is_empty() {
            return None;
        }
        if fields.iter().any(|field| {
            self.resolve
                .symbols
                .get(field.0 as usize)
                .is_none_or(|field| field.name == "id")
        }) {
            return None;
        }
        // Each conjunct admits exactly like the former single predicate: a
        // stored-row field compared against an actor/param/event operand.
        // Dependencies and transported inputs accumulate per conjunct.
        let mut members: Vec<(
            NodeKey,
            SymbolId,
            ResolvedType,
            NodeKey,
            Option<(NodeKey, SymbolId)>,
        )> = Vec::new();
        for conjunct in &conjuncts {
            let (member, operand) = self.query_binary(*conjunct, "==")?;
            let field = self.query_member(member, alias.node, fact.model)?;
            let field_ty = self.types.symbol_types.get(&field)?.clone();
            let operand = self.query_group(operand)?;
            // C23 hook slice: the row field compares against one declared text
            // field of the trusted event payload. The event value is handler
            // context, so the query carries no transported input.
            let event_operand = hook_event.is_some_and(|event| {
                self.query_hook_event_operand(event, operand, &field_ty)
                    .is_some()
            });
            // Closed enum cases compare like the former scalar operands; a
            // case literal carries no transported input.
            let case_operand =
                matches!(&field_ty, ResolvedType::Enum { cases, .. } if !cases.is_empty())
                    && self.types.resolved_cases.contains(&operand);
            if !fields.contains(&field)
                || !(primitive_type(&field_ty)
                    || matches!(&field_ty, ResolvedType::Enum { cases, .. } if !cases.is_empty()))
                || self.types.node_types.get(&self.query_group(member)?) != Some(&field_ty)
                || (!event_operand
                    && !case_operand
                    && self.nodes.get(&operand)?.kind != SyntaxKind::NameRef)
                || self.types.node_types.get(&operand) != Some(&field_ty)
                || self.types.node_types.get(conjunct) != Some(&ResolvedType::Scalar(Scalar::Bool))
            {
                return None;
            }
            let input = if event_operand || case_operand {
                None
            } else if matches!(
                self.query_binding(operand),
                Some(Binding::Context(ContextVar::Actor(_)))
            ) && field_ty == ResolvedType::Scalar(Scalar::User)
                && self.word(self.nodes.get(&operand)?)? == "actor"
            {
                None
            } else {
                let parameter = self.query_parameter(scenario, operand)?;
                if self.types.symbol_types.get(&parameter) != Some(&field_ty) {
                    return None;
                }
                Some((operand, parameter))
            };
            members.push((member, field, field_ty, operand, input));
        }
        // Bound before dependencies: the opaque query id anchors them.
        let id = self.opaque("query", fact.query, "").ok()?;
        let dependencies = members
            .iter()
            .map(|(member, field, _, _, _)| {
                self.query_dependency(
                    *member,
                    scenario.module,
                    fact.model,
                    *field,
                    DependencyRole::Control,
                    &id,
                )
            })
            .collect::<Option<Vec<_>>>()?;
        let inputs = members
            .iter()
            .filter_map(|(_, _, _, _, input)| *input)
            .collect::<Vec<_>>();
        let operand = members.first().map(|member| member.3)?;
        let extra_operands = members
            .iter()
            .skip(1)
            .map(|member| member.3)
            .collect::<Vec<_>>();
        // Only authored ordering has a source node. An empty list preserves
        // the canonical stored-query created/id default at the engine boundary.
        let order = if let Some(order) = order {
            let order_node = self.query_group(order.expressions[0])?;
            if self.query_member_name(order_node, alias.node, fact.model) != Some("id")
                || self.types.node_types.get(&order_node)
                    != Some(&ResolvedType::Scalar(Scalar::Text))
                || self.nodes.get(&order.node)?.children.iter().any(|node| {
                    matches!(
                        node.kind,
                        SyntaxKind::Selectors | SyntaxKind::Descending | SyntaxKind::Path
                    )
                })
            {
                return None;
            }
            vec![DisclosureQueryOrder {
                field: None,
                field_name: "id".into(),
                descending: false,
                node: order_node,
            }]
        } else {
            Vec::new()
        };
        // Query execution is independent from its eventual result. This is
        // the actual terminal source anchor; only the checked Return census
        // may publish return identities or disclosure associations.
        let returned = scenario.effects.last()?;
        let source = self.source(scenario.module, fact.query).ok()?;
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
                    .opaque("query-influence", fact.query, &format!("{id}:{kind:?}"))
                    .ok()?,
                source: source.clone(),
                node: fact.query,
                kind,
                query_id: Some(id.clone()),
            })
        })
        .collect::<Option<Vec<_>>>()?;
        Some(DisclosureQuery {
            dependencies,
            id,
            source,
            node: fact.query,
            domain: query.domain,
            model: fact.model,
            model_name: owner.canonical.clone(),
            alias: Some(alias.node),
            predicate: Some(predicate_node),
            inputs,
            order,
            limit: None,
            archived,
            cardinality_guard: None,
            return_node: returned.node,
            projection: None,
            first: Some(DisclosureFirstQuery {
                call,
                overload: fact.overload,
                binding: binding.node,
                operand,
                extra_operands,
                // DESIGN442: the guard/presence-consumed marks land in the
                // source-facts pass below, where the Require consumptions
                // for this scenario are known. Unmarked here so every
                // other shape keeps ordinary viewer behavior.
                guard_consumed: false,
                presence_consumed: false,
                contained_parent,
            }),
            count: None,
            influences,
        })
    }

    /// A first-query domain names its model plainly, or selects a contained
    /// child through the original required parent parameter. The qualified
    /// spelling carries no rename: the receiver names a default-free
    /// scenario Model parameter, the child stays ChildOf that parent, and
    /// the spelling names the child itself. Anything else refuses, keeping
    /// the closure fail-closed. Mirrors the count contained-Member
    /// correspondence; the predicate operand keeps its own input entry.
    fn checked_first_query_domain(
        &self,
        scenario: &super::effects::ScenarioData,
        query: &crate::analysis::types::CheckedQuery,
        model: SymbolId,
        owner: &super::resolve::Symbol,
    ) -> Option<Option<(NodeKey, SymbolId)>> {
        if matches!(self.query_binding(query.domain), Some(Binding::Symbol(actual)) if *actual == model) {
            return Some(None);
        }
        let (receiver, name) = self.count_member(query.domain)?;
        let parameter = self.query_parameter(scenario, receiver)?;
        let (parent, hops) = self.checked_call_parent_path(receiver, parameter, 0)?;
        let SymbolKind::Model {
            owner: ModelOwner::ChildOf(actual_parent),
            ..
        } = &owner.kind
        else {
            return None;
        };
        if hops != 0
            || *actual_parent != parent
            || owner.name != name
            || !self.original_reference_parameter(receiver, parameter)
            || self.model_has_field(parent, name)
            || self.effects.models.get(&model)?.owner != ModelOwner::ChildOf(parent)
        {
            return None;
        }
        Some(Some((receiver, parameter)))
    }

    /// A cross-package query domain must arrive through the consumer's
    /// checked `use`: the owner canonical matches one imported provider
    /// member exactly. Same-module domains keep their existing path;
    /// aliasing never renames the source, so only the provider-side
    /// spelling counts. Nothing else crosses modules here.
    fn imported_query_source(&self, consumer: ModuleId, canonical: &str) -> bool {
        let Some(module) = self.resolve.modules.get(consumer.0 as usize) else {
            return false;
        };
        module.imports.iter().any(|import| {
            import.members.iter().any(|member| {
                import.provider.len() + 1 + member.name.len() == canonical.len()
                    && canonical.starts_with(import.provider.as_str())
                    && canonical.as_bytes().get(import.provider.len()) == Some(&b'.')
                    && canonical[import.provider.len() + 1..] == member.name
            })
        })
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
            let projection = query.projection.as_ref()?;
            if projection.contract != fact.contract {
                return None;
            }
            (ValuePath::default(), Some(projection.clone()))
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
            ResolvedType::Array { .. } if self.reference_operand_type_id(ty).is_some() => {
                self.reference_operand_type_id(ty)?
            }
            // The State query owner recomputes an inline enum's identity
            // from the artifact field descriptor (`enum(a,b)`), so
            // first-query enum dependencies spell the cases rather than
            // the owner canonical. Sealed checks still run first; the exact
            // declaration binding stays with the schema owners.
            ResolvedType::Enum { cases, .. } if !cases.is_empty() => {
                self.field_type_id(node, field, ty).ok()?;
                format!("enum({})", cases.join(","))
            }
            _ => self.field_type_id(node, field, ty).ok()?,
        };
        Some(DisclosureDependency {
            query_id: None,
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
            // Constructing the original selected TextMessage eagerly consumes
            // its DATA fields even when count later uses only cardinality.
            // Query association alone never exempts another ordinary read.
            if self.transcript_selection_dependency(read) {
                continue;
            }
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

    fn transcript_selection_dependency(&self, read: &DisclosureDependency) -> bool {
        let [call] = read.calls.as_slice() else {
            return false;
        };
        let Some(query_id) = read.query_id.as_deref() else {
            return false;
        };
        if read.role != DependencyRole::Data {
            return false;
        }
        self.effects.scenarios.values().any(|scenario| {
            scenario
                .guards
                .iter()
                .chain(&scenario.effects)
                .any(|statement| {
                    statement.node.file == call.file
                        && statement.node.start <= call.start
                        && call.end <= statement.node.end
                        && self
                            .checked_transcript_source(scenario, statement.node, *call)
                            .is_some_and(|fact| {
                                fact.id == query_id
                                    && fact.call == *call
                                    && fact.source == read.source
                                    && fact.dependencies.iter().any(|original| original == read)
                            })
                })
        })
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
        // Only top-level straight-line expression analyses share a statement.
        // Nested statements, derive frames and input-loop scopes stay separate.
        let reuse = self.depth == 0
            && self.statement_depth == 1
            && self.loop_node.is_none()
            && self.stack.is_empty()
            && calls.is_empty();
        if reuse
            && let Some(completed) = self.statement_expressions.as_ref().and_then(|entries| {
                entries.iter().find(|entry| {
                    entry.node == key
                        && entry.module == module
                        && entry.calls == calls
                        && entry.authorization == self.authorization
                        && entry.result_model == self.result_model
                        && entry.env == *env
                })
            })
        {
            return Ok(completed.values.clone());
        }
        let bookkeeping = (
            self.effect_proofs.len(),
            self.effect_visits,
            self.loop_node,
            self.result_model,
            self.authorization,
        );
        self.depth += 1;
        let result = self.expr_inner(key, module, env, calls);
        self.depth -= 1;
        // Expression traversal normally restores these values. Never reuse an
        // analysis which published an effect or left a changed scope behind.
        if reuse
            && bookkeeping
                == (
                    self.effect_proofs.len(),
                    self.effect_visits,
                    self.loop_node,
                    self.result_model,
                    self.authorization,
                )
            && self.stack.is_empty()
            && let Ok(values) = &result
            && let Some(entries) = self.statement_expressions.as_mut()
            && entries.len() < 1024
        {
            entries.push(CompletedStatementExpression {
                node: key,
                module,
                calls: calls.to_vec(),
                authorization: self.authorization,
                result_model: self.result_model,
                env: env.clone(),
                values: values.clone(),
            });
        }
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
                    // Invocation facts carry no stored-read authority. Preserve
                    // their checked lexical binding and exact scalar identity;
                    // lowering is matched against the same source occurrence.
                    Some(Binding::Context(ContextVar::Actor(_)))
                        if ty == &ResolvedType::Scalar(Scalar::User) =>
                    {
                        Ok(vec![ValuePath::default()])
                    }
                    Some(Binding::Context(ContextVar::Now))
                        if ty == &ResolvedType::Scalar(Scalar::Datetime) =>
                    {
                        Ok(vec![ValuePath::default()])
                    }
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
                        .filter(|value| {
                            value.record.is_none()
                                || value
                                    .first_query
                                    .is_none_or(|(_, original)| original == *node)
                                    && value
                                        .current_revision
                                        .is_none_or(|original| original == *node)
                        })
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
            SyntaxKind::Query if self.inline_selection_at(key, module).is_some() => {
                self.inline_selection_value(key, module, env, calls)
            }
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
        if self
            .inline_selection_at(key, module)
            .is_some_and(|fact| fact.prefix_node == key)
        {
            return self.inline_selection_value(key, module, env, calls);
        }
        if let Some(values) = self.current_revision_member(key, module, env, calls)? {
            return Ok(values);
        }
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
        if calls.is_empty()
            && self.loop_node.is_none()
            && let Some((parameter, ResolvedType::Scalar(scalar), path)) =
                self.checked_contract_input_path(key, module, 0)
            && !path.is_empty()
            && env.contains_key(&Local::Symbol(parameter))
        {
            let name = &self.resolve.symbols[parameter.0 as usize].name;
            return self
                .input_value(
                    key,
                    module,
                    calls,
                    ValuePath {
                        input: Some((parameter, format!("{name}/{}", path.join("/")), scalar)),
                        ..ValuePath::default()
                    },
                )
                .map(|value| vec![value]);
        }
        if calls.is_empty()
            && self.loop_node.is_none()
            && let Some((parameter, model, slot)) =
                self.checked_contract_input_reference(key, module)
            && env.contains_key(&Local::Symbol(parameter))
        {
            let key = self
                .query_group(key)
                .ok_or_else(|| self.fail(key, "missing input member"))?;
            let owner = self
                .resolve
                .symbols
                .get(model.0 as usize)
                .ok_or_else(|| self.fail(key, "missing input member model"))?;
            return Ok(vec![ValuePath {
                record: Some(model),
                reference_origin: Some(ReferenceOrigin::ParameterMember {
                    parameter,
                    node: key,
                }),
                reference: Some(DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter,
                    parameter_name: slot,
                    model,
                    model_name: owner.canonical.clone(),
                }),
                ..ValuePath::default()
            }]);
        }
        let mut values = self.expr(base_key, module, env, calls)?;
        if self.types.node_types.get(&base_key) == Some(&ResolvedType::Scalar(Scalar::Money))
            && matches!(
                (field_name, ty),
                ("minor", ResolvedType::Scalar(Scalar::Int))
                    | ("currency", ResolvedType::Scalar(Scalar::Currency))
            )
            && values.iter().all(|value| {
                value.intrinsics.iter().any(|intrinsic| {
                    intrinsic.ty == ResolvedType::Scalar(Scalar::Money)
                        && matches!(
                            intrinsic.kind,
                            DisclosureIntrinsicKind::AdmittedInput { .. }
                        )
                })
            })
        {
            return Ok(values);
        }
        // Same-transaction send-result envelope reads (CAN18-v1 dispatch
        // fence persistence, e.g. cancel/retry_release): `delivery.id`
        // stores the sealed send fence. The base must be a flow-visible
        // send binding (effects disclose in order, so a later use sees
        // only already-executed sends); the leaf comes from the closed
        // `DeliveryResult` envelope with its checker-resolved scalar
        // type. Ordering is structural; source/owner/failure stay sealed
        // by the existing receipt checks. The clone drops only the
        // carrier flag — reads/observed/decisions are preserved.
        let send_visible = match self.resolve.node_binding.get(&base_key) {
            Some(Binding::SendAs { node }) => env.contains_key(&Local::Send(*node)),
            _ => false,
        };
        if result_type(ty)
            && send_visible
            && values.iter().all(|value| {
                matches!(
                    value.delivery,
                    Some(ResolvedType::Delivery { .. })
                        | Some(ResolvedType::StdDelivery { .. })
                )
            })
            && nominal_schema("DeliveryResult")
                .is_some_and(|schema| schema.fields.iter().any(|(name, _)| *name == field_name))
        {
            for value in &mut values {
                value.delivery = None;
            }
            return Ok(values);
        }
        for value in &mut values {
            if matches!(
                value.model_result,
                Some(DisclosureModelResult::Reference { .. })
            ) && !matches!(value.model_result,
                Some(DisclosureModelResult::Reference {model, node, ..})
                    if Some(node) == self.query_group(base_key)
                        && self.checked_required_model_reference(key, module)
                            .is_some_and(|(source, _, _)| source == model))
                && self
                    .checked_profile_scalar(key, module)
                    .or_else(|| self.checked_run_unfinished(key, module))
                    .is_none()
            {
                return Err(self.fail(
                    key,
                    "stored Model reference needs its direct result consumer",
                ));
            }
            if value.current_revision.is_some() {
                return Err(self.fail(
                    key,
                    "current Revision needs its exact original scalar member",
                ));
            }
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
                let (parameter, member) = match value.reference_origin {
                    Some(ReferenceOrigin::Parameter(parameter)) => (parameter, false),
                    Some(ReferenceOrigin::ParameterMember { parameter, node })
                        if Some(node) == self.query_group(base_key)
                            && self
                                .checked_contract_input_reference(node, module)
                                .is_some_and(|(root, target, _)| {
                                    root == parameter && target == model
                                }) =>
                    {
                        (parameter, true)
                    }
                    _ => {
                        return Err(self.fail(key, "id needs required original scenario parameter"));
                    }
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
                    || !member
                        && self.checked_call_parent_path(base_key, parameter, 0) != Some((model, 0))
                    || !member && owner.module != module
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
                    query_id: None,
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
                    Some(ReferenceOrigin::ParameterMember { parameter, node })
                        if Some(node) == self.query_group(base_key)
                            && self
                                .checked_contract_input_reference(node, module)
                                .is_some_and(|(root, target, _)| {
                                    root == parameter && target == model
                                }) =>
                    {
                        (parameter, 0)
                    }
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
                    query_id: None,
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
            let profile_reference = self
                .checked_profile_reference(key, module)
                .or_else(|| self.checked_run_reference(key, module));
            let profile_scalar = self
                .checked_profile_scalar(key, module)
                .or_else(|| self.checked_run_unfinished(key, module));
            // A required stored Model field is a reference to its actual row,
            // never a local Contract shell. Retain the exact original receiver;
            // lexical copies and further traversal are separate consumers.
            let required_reference = self.checked_required_model_reference(key, module)
                .filter(|(source, reference, _)| *source == model && *reference == field.id)
                .filter(|_| calls.is_empty() && self.loop_node.is_none()
                    && (matches!(value.reference_origin, Some(ReferenceOrigin::Parameter(parameter))
                        if matches!(self.query_binding(base_key), Some(Binding::Symbol(actual)) if *actual == parameter))
                        || value.first_query.is_some_and(|(_, binding)| {
                            matches!(self.query_binding(base_key), Some(Binding::Let {node}) if *node == binding)
                        })
                        || matches!(value.reference_origin,
                            Some(ReferenceOrigin::ParameterMember {parameter, node})
                                if Some(node) == self.query_group(base_key)
                                    && self.checked_contract_input_reference(node, module)
                                        .is_some_and(|(root, target, _)| root == parameter && target == model))
                        || matches!(value.model_result,
                            Some(DisclosureModelResult::Reference {model: target, node, source_model, field})
                                if target == model && Some(node) == self.query_group(base_key)
                                    && self.checked_required_model_reference(node, module)
                                        == Some((source_model, field, target))
                                    && value.reads.iter().any(|read| read.node == node
                                        && read.model == source_model && read.field == field
                                        && read.ty == ResolvedType::Record {symbol: target, stored: true}
                                        && read.calls.is_empty() && read.query_id.is_none()))))
                .map(|(_, _, target)| target);
            if matches!(value.reference_origin, Some(ReferenceOrigin::Field { .. }))
                && self
                    .checked_profile_reference(base_key, module)
                    .or_else(|| self.checked_run_reference(base_key, module))
                    .is_some()
                && profile_scalar.is_none()
            {
                return Err(self.fail(key, "Profile scalar declaration source correspondence"));
            }
            if let Some((parameter, branch, reference, profile, scalar)) = profile_scalar {
                if !calls.is_empty()
                    || self.loop_node.is_some()
                    || model != profile
                    || field.id != scalar
                    || !matches!(value.reference_origin,Some(ReferenceOrigin::Field {parameter:actual,model:source,field})
                        if actual == parameter && source == branch && field == reference)
                    || !value.reads.iter().any(|read| {
                        read.node == base_key
                            && read.model == branch
                            && read.field == reference
                            && read.ty
                                == (ResolvedType::Record {
                                    symbol: profile,
                                    stored: true,
                                })
                            && self
                                .resolve
                                .symbols
                                .get(reference.0 as usize)
                                .is_some_and(|field| read.field_name == field.name)
                            && read.calls.is_empty()
                            && read.query_id.is_none()
                    })
                {
                    return Err(self.fail(
                        key,
                        "Profile scalar needs its original stored reference receiver",
                    ));
                }
                // This scalar consumes exactly its original stored receiver.
                // The separate owning reference read remains in provenance.
                value.reference_origin = None;
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
            let type_id = if let Some((parameter, branch, reference, profile)) = profile_reference {
                if !calls.is_empty() || self.loop_node.is_some() || model != branch || field.id != reference
                    || !matches!(value.reference_origin,Some(ReferenceOrigin::Parameter(actual)) if actual == parameter)
                    || !env.get(&Local::Symbol(parameter)).is_some_and(|input| {
                        matches!(input.reference_origin,Some(ReferenceOrigin::Parameter(actual)) if actual == parameter)
                    })
                {
                    return Err(self.fail(key,"Profile reference needs its original required Branch input"));
                }
                value.reference_origin = Some(ReferenceOrigin::Field {
                    parameter,
                    model: branch,
                    field: reference,
                });
                self.reference_operand_type_id(&ResolvedType::Record {
                    symbol: profile,
                    stored: true,
                })
                .ok_or_else(|| {
                    self.fail(key, "Profile reference lacks its owning model declaration")
                })?
            } else if let Some(parameter) = parent_origin {
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
            } else if required_reference.is_some() {
                if self.effects.models.get(&model).is_none_or(|owner| {
                    !owner.fields.iter().any(|declaration| {
                        declaration.field == field.id && !declaration.required_array
                    })
                }) {
                    return Err(self.fail(key, "missing required stored Model field declaration"));
                }
                value.contract_value = None;
                value.first_query = None;
                value.reference_origin = None;
                self.reference_operand_type_id(field_ty).ok_or_else(|| {
                    self.fail(key, "missing required stored Model target declaration")
                })?
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
                query_id: None,
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
            value.record =
                required_reference.or_else(|| profile_reference.map(|(_, _, _, profile)| profile));
            value.model_result =
                required_reference.map(|target| DisclosureModelResult::Reference {
                    model: target,
                    node: key,
                    source_model: model,
                    field: field.id,
                });
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
        // An empty literal carries no element provenance; any element shape
        // is admitted here and the declaration gate stays at the parameter.
        if children.is_empty() {
            return Ok(vec![ValuePath::default()]);
        }
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
        let current_null_check = op == "!="
            && calls.is_empty()
            && self
                .current_revision_at(key, module)
                .is_some_and(|fact| fact.presence == key);
        // Absence primitive (CAN18-v1 first-query slice): a null test on the
        // first-query let binding in EITHER direction (`!=null` presence or
        // `==null` absence) consumes only that binding's presence, never a
        // stored field. Field reads off the possibly-null binding keep the
        // AbsentReference refusal below, as do require-or/if-branch shapes
        // (their own slices, still refused at the terminal tail rule).
        let first_null_check = current_null_check || matches!(op, "==" | "!=") && calls.is_empty()
            && [(children[0], children[1]), (children[1], children[0])].iter().any(|(value, null)| {
                let key = NodeKey::of(value);
                self.types.node_types.get(&NodeKey::of(null)) == Some(&ResolvedType::Null)
                    && matches!(self.query_binding(key), Some(Binding::Let {node})
                        if env.get(&Local::Let(*node)).is_some_and(|value| {
                            value.record.is_some() && value.first_query.is_some_and(|(_, original)| original == *node)
                        }))
            });
        let input_null_check = matches!(op, "==" | "!=") && calls.is_empty()
            && [(children[0], children[1]), (children[1], children[0])].iter().any(|(value, null)| {
                let input = NodeKey::of(value);
                self.types.node_types.get(&NodeKey::of(null)) == Some(&ResolvedType::Null)
                    && value.kind == SyntaxKind::NameRef
                    && matches!(self.query_binding(input), Some(Binding::Symbol(parameter))
                        if env.get(&Local::Symbol(*parameter)).is_some_and(|value| {
                            value.reference_origin == Some(ReferenceOrigin::NullableParameter(*parameter))
                                && value.record.is_some()
                        }))
            });
        if !first_null_check
            && !input_null_check
            && matches!(op, "??" | "==" | "!=")
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
        // Exact original required Model slots, direct or in Contracts, may
        // consume checked containment in equality. Both operands retain their
        // own admission provenance and must name the same model. Arbitrary
        // stored-reference fields keep their direct-child/count-only boundary.
        let admitted_parent_comparison =
            matches!(op, "==" | "!=") && calls.is_empty() && self.loop_node.is_none() && {
                let operand = |node: &SyntaxNode| -> Option<(SymbolId, bool)> {
                    let key = self.query_group(NodeKey::of(node))?;
                    if let Some((parameter, model, _)) =
                        self.checked_contract_input_reference(key, module)
                    {
                        return env
                            .contains_key(&Local::Symbol(parameter))
                            .then_some((model, false));
                    }
                    env.keys().find_map(|local| {
                        let Local::Symbol(parameter) = local else {
                            return None;
                        };
                        let (model, hops) = self.checked_call_parent_path(key, *parameter, 0)?;
                        Some((model, hops > 0))
                    })
                };
                matches!((operand(children[0]), operand(children[1])),
                    (Some((left_model, left_parent)), Some((right_model, right_parent)))
                    if left_model == right_model && (left_parent || right_parent))
            };
        let left = self.expr(NodeKey::of(children[0]), module, env, calls)?;
        if !current_null_check
            && !admitted_parent_comparison
            && left.iter().any(|value| {
                matches!(
                    value.reference_origin,
                    Some(ReferenceOrigin::Parent { .. } | ReferenceOrigin::Field { .. })
                )
            })
        {
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
            if !admitted_parent_comparison
                && right.iter().any(|value| {
                    matches!(
                        value.reference_origin,
                        Some(ReferenceOrigin::Parent { .. } | ReferenceOrigin::Field { .. })
                    )
                })
            {
                return Err(self.fail(
                    key,
                    "stored reference operand needs direct child or count consumer",
                ));
            }
            let mut values = self.product(key, &left, &right)?;
            if current_null_check || input_null_check || admitted_parent_comparison {
                for value in &mut values {
                    value.reference_origin = None;
                    value.reference = None;
                    value.record = None;
                    value.current_revision = None;
                }
            }
            if op == "+"
                && self
                    .types
                    .node_types
                    .get(&key)
                    .is_some_and(transcript_message_array)
            {
                let operand = |node: &SyntaxNode, paths: &[ValuePath]| {
                    let original = self
                        .query_group(NodeKey::of(node))
                        .unwrap_or(NodeKey::of(node));
                    self.types
                        .node_types
                        .get(&NodeKey::of(node))
                        .is_some_and(transcript_message_array)
                        && (self
                            .nodes
                            .get(&original)
                            .is_some_and(|node| node.kind == SyntaxKind::Array)
                            || paths
                                .iter()
                                .all(|value| value.transcript_messages == Some(original)))
                };
                if operand(children[0], &left)
                    && operand(children[1], &right)
                    && left
                        .iter()
                        .chain(&right)
                        .any(|value| value.transcript_messages.is_some())
                {
                    for value in &mut values {
                        value.transcript_messages = Some(key);
                    }
                }
            }
            // Only this original cardinality guard retains query/prefix
            // controls on a scalar Return; other authorization pruning stays.
            if op == "<"
                && left.iter().all(|value| value.transcript_count)
                && self.transcript_bound_matches(NodeKey::of(children[1]), &left)
            {
                for value in &mut values {
                    value.transcript_count = true;
                }
            }
            Ok(values)
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
                merged.transcript_messages = None;
                merged.transcript_count = false;
                merged.current_revision = None;
                out.push(merged);
            }
        }
        Ok(out)
    }

    fn checked_membership_signature(&self, key: NodeKey, module: ModuleId) -> Option<()> {
        let catalog = self.catalog?;
        let selected = self.types.selected_calls.get(&key)?;
        let signature = catalog.overloads("active_member")?.first()?;
        if !matches!(&selected.target,
            SelectedCallTarget::Builtin {id,overload:0} if id == "active_member")
            || catalog.effects("active_member") != Some(Effects::StateRead)
            || selected.arguments.len() != 2
            || selected.slots.as_slice() != [Some(0), Some(1)]
            || signature.params.len() != 2
            || signature.result != SigType::Named("bool".into())
            || self.types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
        for (parameter, (name, declared, ty)) in signature.params.iter().zip([
            ("person", "user", ResolvedType::Scalar(Scalar::User)),
            ("team", "Team", ResolvedType::Team),
        ]) {
            if parameter.name != name
                || parameter.ty != SigType::Named(declared.into())
                || parameter.alias.is_some()
                || parameter.in_scope.is_some()
            {
                return None;
            }
            let index = usize::from(name == "team");
            if self.types.node_types.get(&selected.arguments[index]) != Some(&ty) {
                return None;
            }
        }
        let node = self.nodes.get(&key)?;
        let arguments: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .map(|argument| {
                let mut values = argument
                    .children
                    .iter()
                    .filter(|child| expression(child.kind));
                let value = NodeKey::of(values.next()?);
                values.next().is_none().then_some(value)
            })
            .collect::<Option<Vec<_>>>()?;
        let head = node.children.iter().find(|child| expression(child.kind))?;
        (node.kind == SyntaxKind::Call
            && arguments == selected.arguments
            && matches!(self.query_binding(NodeKey::of(head)),
                Some(Binding::Builtin {id}) if id == "active_member")
            && self.source(module, key).is_ok())
        .then_some(())
    }

    /// Only the original leading authorization helper consumes this parent.
    /// The checked formal observes the same row; it is never a new admitted input.
    fn checked_authorization_derive(
        &self,
        key: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId, NodeKey, NodeKey)> {
        let selected = self.types.selected_calls.get(&key)?;
        let SelectedCallTarget::DeriveFn(id) = &selected.target else {
            return None;
        };
        let id = *id;
        let data = self.effects.derives.get(&id)?;
        let declaration = self.resolve.symbols.get(id.0 as usize)?;
        let defining_module = declaration.module;
        let imported = defining_module != module;
        let SymbolKind::DeriveFn {
            params,
            result_node,
        } = &declaration.kind
        else {
            return None;
        };
        let body = data.expr?;
        let result = data.result?;
        let text = &self.db.get(data.node.file)?.text;
        let formal = data.params.get(1)?;
        let person = data.params.first()?;
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = self.types.symbol_types.get(&formal.param)?
        else {
            return None;
        };
        let model = *model;
        let owner = self.resolve.symbols.get(model.0 as usize)?;
        let declaration_path = self
            .nodes
            .get(&data.node)?
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)?;
        let declaration_name = declaration_path
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        if declaration.id != id
            || self.word(declaration_name) != Some(declaration.name.as_str())
            || declaration_path.span != declaration.span
            || declaration.canonical
                != format!(
                    "{}.{}",
                    self.resolve.modules.get(defining_module.0 as usize)?.name,
                    declaration.name
                )
            || data.derive != id
            || data.module != defining_module
            || data.model.is_some()
            // Resolver retains this declaration sentinel; effects owns the
            // actual authored result type child, checked independently below.
            || *result_node != data.node
            || !self.nodes.get(&data.node)?.children.iter().any(|child| NodeKey::of(child) == result)
            || self.types.symbol_results.get(&id) != Some(&Some(ResolvedType::Scalar(Scalar::Bool)))
            || data.params.len() != 2
            || !params
                .iter()
                .copied()
                .eq(data.params.iter().map(|parameter| parameter.param))
            || data
                .params
                .iter()
                .any(|parameter| parameter.default.is_some())
            || selected.arguments.len() != 2
            || selected.slots.as_slice() != [Some(0), Some(1)]
            || self.types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Bool))
            || self.types.node_types.get(&body) != Some(&ResolvedType::Scalar(Scalar::Bool))
            || self.types.symbol_types.get(&person.param)
                != Some(&ResolvedType::Nullable(Box::new(ResolvedType::Scalar(
                    Scalar::User,
                ))))
            || text
                .get(person.type_node.start as usize..person.type_node.end as usize)?
                .trim()
                != "user?"
            || text
                .get(formal.type_node.start as usize..formal.type_node.end as usize)?
                .trim()
                != owner.name
            || text
                .get(result.start as usize..result.end as usize)?
                .trim()
                != "bool"
            || owner.module != defining_module
            || self.checked_created_model(model, defining_module).is_none()
            || self.source(defining_module, data.node).ok()? != self.source(defining_module, body).ok()?
        {
            return None;
        }
        for (index, parameter) in data.params.iter().enumerate() {
            let symbol = self.resolve.symbols.get(parameter.param.0 as usize)?;
            if !matches!(symbol.kind,SymbolKind::Param {owner,index:actual,type_node} if owner == id && actual == index && type_node == parameter.type_node)
                || symbol.module != defining_module
                || symbol.id != parameter.param
                || symbol.canonical != format!("{}.{}", declaration.canonical, symbol.name)
                || self
                    .nodes
                    .get(&parameter.node)?
                    .children
                    .iter()
                    .find(|node| node.kind == SyntaxKind::Name)
                    .is_none_or(|name| {
                        self.word(name) != Some(symbol.name.as_str()) || name.span != symbol.span
                    })
            {
                return None;
            }
        }
        let call = self.nodes.get(&key)?;
        let head = call.children.iter().find(|child| expression(child.kind))?;
        let arguments: Vec<_> = call
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .map(|argument| {
                let mut values = argument
                    .children
                    .iter()
                    .filter(|child| expression(child.kind));
                let value = NodeKey::of(values.next()?);
                values.next().is_none().then_some(value)
            })
            .collect::<Option<Vec<_>>>()?;
        // Imported authorization keeps the actual exported helper/Conversation
        // identities for optional inputs and required containment paths.
        // Local parent cases retain their original source checks.
        if imported
            && (head.kind != SyntaxKind::NameRef
                || !declaration.exported
                || !owner.exported
                || !matches!(self.resolve.module_scopes.get(module.0 as usize)?.prod.get(self.word(head)?),
                    Some(ScopedName::Imported {target, bound: false}) if *target == id)
                || !self.resolve.module_scopes.get(module.0 as usize)?.prod.values().any(|name|
                    matches!(name, ScopedName::Imported {target, bound: false} if *target == model)))
        {
            return None;
        }
        let actor = selected.arguments[0];
        let parent = selected.arguments[1];
        if call.kind != SyntaxKind::Call || arguments != selected.arguments
            || !matches!(self.query_binding(NodeKey::of(head)),Some(Binding::Symbol(actual)) if *actual == id)
            || self.nodes.get(&actor)?.kind != SyntaxKind::NameRef
            || self.word(self.nodes.get(&actor)?)? != "actor"
            || !matches!(self.query_binding(actor),Some(Binding::Context(ContextVar::Actor(_))))
            || !matches!(self.types.node_types.get(&actor),
                Some(ResolvedType::Scalar(Scalar::User)) | Some(ResolvedType::Nullable(_)))
            || self.types.node_types.get(&actor).is_some_and(|ty| {
                matches!(ty,ResolvedType::Nullable(inner) if inner.as_ref() != &ResolvedType::Scalar(Scalar::User))
            })
            || self.types.node_types.get(&parent) != self.types.symbol_types.get(&formal.param)
        { return None; }
        // Retain the original required parameter across exactly one or two
        // authored containment edges; neither an alias nor a declared field
        // named parent can stand in for the checked ChildOf lineage.
        let mut receiver = parent;
        let mut hops = 0;
        while let Some((base, field)) = self.count_member(receiver) {
            if field != "parent" || hops == 2 {
                return None;
            }
            receiver = base;
            hops += 1;
        }
        let Some(Binding::Symbol(parameter)) = self.query_binding(receiver) else {
            return None;
        };
        let imported_owner = if imported {
            // Only the original caller parameter can supply either the already
            // admitted optional input or one/two genuine imported parent edges.
            let parameter_symbol = self.resolve.symbols.get(parameter.0 as usize)?;
            let SymbolKind::Param {
                owner: caller,
                index,
                type_node,
            } = parameter_symbol.kind
            else {
                return None;
            };
            let scenario = self.effects.scenarios.get(&caller)?;
            let mut parameters = scenario
                .params
                .iter()
                .filter(|param| param.param == *parameter);
            let parameter_data = parameters.next()?;
            if self.nodes.get(&receiver)?.kind != SyntaxKind::NameRef
                || parameters.next().is_some()
                || scenario.params.get(index)?.param != *parameter
                || type_node != parameter_data.type_node
                || parameter_symbol.module != module
                || scenario.module != module
                || scenario.read
                || scenario.on.is_some()
                || scenario.cohort.is_some()
                || key.file != scenario.node.file
                || key.start < scenario.node.start
                || key.end > scenario.node.end
            {
                return None;
            }
            if hops == 0 {
                if parent != receiver
                    || self.nullable_model_input(scenario, parameter_data) != Some(model)
                {
                    return None;
                }
            } else {
                let ResolvedType::Record {
                    symbol: root,
                    stored: true,
                } = self.types.symbol_types.get(parameter)?
                else {
                    return None;
                };
                let root_declaration = self.resolve.symbols.get(root.0 as usize)?;
                let annotation = self.nodes.get(&parameter_data.type_node)?;
                if !matches!(hops, 1 | 2)
                    || parameter_data.default.is_some()
                    || self.checked_call_parent_path(parent, *parameter, 0) != Some((model, hops))
                    || root_declaration.module != defining_module
                    || !root_declaration.exported
                    || annotation.kind != SyntaxKind::NamedType
                    || !matches!(self.resolve.module_scopes.get(module.0 as usize)?.prod.get(self.word(annotation)?),
                        Some(ScopedName::Imported {target, bound: false}) if target == root)
                    || self.checked_created_model(*root, defining_module).is_none()
                {
                    return None;
                }
                // Seal both source declarations on the checked containment
                // path, rather than treating a carried type as an imported row.
                let mut edge = parent;
                for _ in 0..hops {
                    let (base, name) = self.count_member(edge)?;
                    let ResolvedType::Record {
                        symbol: child,
                        stored: true,
                    } = self.types.node_types.get(&base)?
                    else {
                        return None;
                    };
                    if name != "parent"
                        || self.resolve.symbols.get(child.0 as usize)?.module != defining_module
                        || self
                            .checked_created_model(*child, defining_module)
                            .is_none()
                    {
                        return None;
                    }
                    edge = base;
                }
                if edge != receiver {
                    return None;
                }
            }
            Some(caller)
        } else {
            if !matches!(hops, 1 | 2)
                || self.checked_call_parent_path(parent, *parameter, 0) != Some((model, hops))
            {
                return None;
            }
            None
        };
        let (first_three, active) = self.query_binary(body, "and")?;
        let (first_two, equality) = self.query_binary(first_three, "and")?;
        let (null_guard, membership) = self.query_binary(first_two, "and")?;
        let (subject, absent) = self.query_binary(null_guard, "!=")?;
        let (account, compared) = self.query_binary(equality, "==")?;
        let formal_name = |node, parameter, ty: &ResolvedType| {
            self.nodes
                .get(&node)
                .is_some_and(|node| node.kind == SyntaxKind::NameRef)
                && matches!(self.query_binding(node),Some(Binding::Symbol(actual)) if *actual == parameter)
                && self.types.node_types.get(&node) == Some(ty)
        };
        let formal_member = |node, name, ty: &ResolvedType| {
            self.count_member(node).is_some_and(|(base, field)| {
                field == name && formal_name(base,formal.param,&ResolvedType::Record {symbol:model,stored:true})
                    && self.types.node_types.get(&node) == Some(ty)
                    && matches!(&owner.kind,SymbolKind::Model {fields,..} if fields.iter().any(|field| {
                        self.resolve.symbols.get(field.0 as usize).is_some_and(|field| field.name == name
                            && matches!(field.kind,SymbolKind::Field {owner,..} if owner == model)
                            && self.types.symbol_types.get(&field.id) == Some(ty))
                    }))
            })
        };
        self.checked_membership_signature(membership, defining_module)?;
        let membership_call = self.types.selected_calls.get(&membership)?;
        if !formal_name(
            subject,
            person.param,
            self.types.symbol_types.get(&person.param)?,
        ) || self.nodes.get(&absent)?.kind != SyntaxKind::Literal
            || self.types.node_types.get(&absent) != Some(&ResolvedType::Null)
            || !formal_name(compared, person.param, &ResolvedType::Scalar(Scalar::User))
            || !formal_member(account, "account", &ResolvedType::Scalar(Scalar::User))
            || !formal_member(active, "active", &ResolvedType::Scalar(Scalar::Bool))
            || !formal_name(
                membership_call.arguments[0],
                person.param,
                &ResolvedType::Scalar(Scalar::User),
            )
            || self.nodes.get(&membership_call.arguments[1])?.kind != SyntaxKind::NameRef
            || self.word(self.nodes.get(&membership_call.arguments[1])?)? != "team"
            || !matches!(
                self.query_binding(membership_call.arguments[1]),
                Some(Binding::Context(ContextVar::Team))
            )
        {
            return None;
        }
        let mut sites = self
            .effects
            .scenarios
            .values()
            .filter(|scenario| scenario.module == module)
            .filter_map(|scenario| self.checked_decision_sites(scenario))
            .flatten()
            .filter(|site| {
                site.stage == CheckedDecisionStage::LeadingRequire
                    && site.calls.iter().any(|call| {
                        call.node == key
                            && call.chain.is_empty()
                            && call.target == CheckedDecisionCallTarget::DeriveFn(id)
                            && call
                                .arguments
                                .iter()
                                .map(|(node, _)| *node)
                                .eq(selected.arguments.iter().copied())
                            && call.slots == selected.slots
                            && call.defaults.is_empty()
                    })
            });
        let site = sites.next()?;
        let original_source = self.source(module, key).ok()?;
        let membership_source = self.source(defining_module, membership).ok()?;
        if sites.next().is_some()
            || site.source != original_source
            || imported_owner.is_some_and(|owner| site.owner != owner)
            || !site.calls.iter().any(|call| {
                call.node == membership
                    && call.module == defining_module
                    && call.source == membership_source
                    && call.target
                        == CheckedDecisionCallTarget::Builtin {
                            id: "active_member".into(),
                            overload: 0,
                        }
                    && call.defaults.is_empty()
                    && call.chain.len() == 1
                    && call.chain[0].node == key
                    && call.chain[0].derive == id
                    && call.chain[0].module == module
                    && call.chain[0].source == original_source
            })
        {
            return None;
        }
        Some((id, model, parent, membership))
    }

    /// These original leading guards consume an admitted value's text or
    /// cardinality only. They supply no stored-row or File authority.
    fn checked_pure_input_guard(&self, key: NodeKey, module: ModuleId) -> Option<NodeKey> {
        if !self.authorization || self.statement_depth != 1 || self.loop_node.is_some() {
            return None;
        }
        let selected = self.types.selected_calls.get(&key)?;
        let SelectedCallTarget::Builtin { id, overload: 0 } = &selected.target else {
            return None;
        };
        if !matches!(id.as_str(), "trim" | "count") || selected.slots.as_slice() != [Some(0)] {
            return None;
        }
        let [argument] = selected.arguments.as_slice() else {
            return None;
        };
        let catalog = self.catalog?;
        let signature = catalog.overloads(id)?.first()?;
        let [input] = signature.params.as_slice() else {
            return None;
        };
        let (name, input_type, result) = if id == "trim" {
            ("value", SigType::StringLike, Scalar::Text)
        } else {
            (
                "domain",
                SigType::Collection(Box::new(SigType::Any)),
                Scalar::Int,
            )
        };
        if catalog.effects(id) != Some(Effects::Pure)
            || input.name != name
            || input.ty != input_type
            || input.alias.is_some()
            || input.in_scope.is_some()
            || signature.result != SigType::Named(result.as_str().into())
            || self.types.node_types.get(&key) != Some(&ResolvedType::Scalar(result))
        {
            return None;
        }
        let node = self.nodes.get(&key)?;
        let head = node.children.iter().find(|child| expression(child.kind))?;
        let mut authored = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument);
        let source_argument = authored.next()?;
        let mut values = source_argument
            .children
            .iter()
            .filter(|child| expression(child.kind));
        if node.kind != SyntaxKind::Call
            || authored.next().is_some()
            || NodeKey::of(values.next()?) != *argument
            || values.next().is_some()
            || !matches!(self.query_binding(NodeKey::of(head)),Some(Binding::Builtin {id: actual}) if actual == id)
            || self.word(head)? != id
        {
            return None;
        }
        let operand = self.nodes.get(argument)?;
        let Some(Binding::Symbol(parameter)) = self.query_binding(*argument) else {
            return None;
        };
        let symbol = self.resolve.symbols.get(parameter.0 as usize)?;
        let SymbolKind::Param {
            owner,
            index,
            type_node,
        } = symbol.kind
        else {
            return None;
        };
        let scenario = self.effects.scenarios.get(&owner)?;
        let declaration = scenario.params.get(index)?;
        let by = scenario.by?;
        if operand.kind != SyntaxKind::NameRef
            || self.word(operand)? != symbol.name
            || symbol.id != *parameter
            || symbol.module != module
            || scenario.module != module
            || scenario.read
            || scenario.on.is_some()
            || scenario.cohort.is_some()
            || declaration.param != *parameter
            || declaration.type_node != type_node
            || !matches!(self.query_binding(by), Some(Binding::Predicate))
            || self
                .db
                .get(by.file)?
                .text
                .get(by.start as usize..by.end as usize)?
                .trim()
                != "members"
            || !scenario.guards.iter().any(|guard| {
                guard.verb == EffectVerb::Require
                    && guard.node.file == key.file
                    && guard.node.start <= key.start
                    && key.end <= guard.node.end
            })
            || self.types.node_types.get(argument) != self.types.symbol_types.get(parameter)
            || self.source(module, key).is_err()
        {
            return None;
        }
        if id == "trim" {
            if declaration.default.is_some()
                || self.types.node_types.get(argument) != Some(&ResolvedType::Scalar(Scalar::Text))
            {
                return None;
            }
        } else if !self.explicit_file_array_call_parameter(declaration) {
            return None;
        }
        Some(*argument)
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
        if calls.is_empty()
            && self.authorization
            && self.statement_depth >= 1
            && self.loop_node.is_none()
            && matches!(&selected.target, SelectedCallTarget::DeriveFn(_))
        {
            let query = self.effects.scenarios.values().find_map(|scenario| {
                if scenario.module != module
                    || key.file != scenario.node.file
                    || key.start < scenario.node.start
                    || key.end > scenario.node.end
                {
                    return None;
                }
                self.checked_helper_any_query_sources(scenario)?
                    .into_iter()
                    .find(|query| {
                        query
                            .dependencies
                            .first()
                            .is_some_and(|read| read.calls.as_slice() == [key])
                    })
            });
            if let Some(query) = query {
                let argument = selected
                    .slots
                    .get(1)
                    .copied()
                    .flatten()
                    .and_then(|slot| selected.arguments.get(slot))
                    .copied()
                    .ok_or_else(|| self.fail(key, "helper query selected reference argument"))?;
                let input = self.checked_contract_input_reference(argument, module);
                let required = self.checked_required_model_reference(argument, module);
                let model = match (&input, &required, query.inputs.as_slice()) {
                    (Some((parameter, model, _)), _, [(original, root)])
                        if *original == argument && root == parameter =>
                    {
                        *model
                    }
                    (None, Some((_, _, model)), []) => *model,
                    _ => {
                        return Err(
                            self.fail(key, "helper query original reference source mismatch")
                        );
                    }
                };
                let argument_node = self
                    .query_group(argument)
                    .ok_or_else(|| self.fail(argument, "helper query reference group"))?;
                let mut result = ValuePath::default();
                // Traverse explicit arguments in their authored order. The
                // callback's candidate reads and membership stay query-owned.
                for supplied in &selected.arguments {
                    let mut values = self.expr(*supplied, module, env, calls)?;
                    let [value] = values.as_mut_slice() else {
                        return Err(self.fail(
                            *supplied,
                            "helper query argument must have one original value",
                        ));
                    };
                    if *supplied == argument {
                        if value.record != Some(model) || !value.intrinsics.is_empty() {
                            return Err(self.fail(*supplied, "helper query original Model slot"));
                        }
                        if let Some((parameter, _, _)) = input.as_ref() {
                            if value.reference_origin
                                != Some(ReferenceOrigin::ParameterMember {
                                    parameter: *parameter,
                                    node: argument_node,
                                })
                                || !env.contains_key(&Local::Symbol(*parameter))
                                || !value.reads.is_empty()
                                || !value.influences.is_empty()
                            {
                                return Err(self
                                    .fail(*supplied, "helper query original admitted Model slot"));
                            }
                        } else {
                            let (source_model, field, target) =
                                required.expect("checked required reference");
                            if value.reference_origin.is_some()
                                || value.model_result
                                    != Some(DisclosureModelResult::Reference {
                                        model: target,
                                        node: argument_node,
                                        source_model,
                                        field,
                                    })
                                || value.reads.last().is_none_or(|read| {
                                    read.node != argument_node
                                        || read.model != source_model
                                        || read.field != field
                                        || read.ty
                                            != ResolvedType::Record {
                                                symbol: target,
                                                stored: true,
                                            }
                                })
                                || value.reads.iter().any(|read| {
                                    !read.calls.is_empty()
                                        || read.query_id.is_some()
                                        || read.role != DependencyRole::Data
                                })
                            {
                                return Err(self
                                    .fail(*supplied, "helper query original required Model edge"));
                            }
                        }
                        value.record = None;
                        value.reference_origin = None;
                        value.reference = None;
                        value.model_result = None;
                    } else if value.record.is_some()
                        || value.reference_origin.is_some()
                        || !value.reads.is_empty()
                        || !value.intrinsics.is_empty()
                        || !value.influences.is_empty()
                    {
                        return Err(self.fail(*supplied, "helper query actor source mismatch"));
                    }
                    result.join(value);
                }
                result.influences.extend(query.influences);
                return Ok(vec![result]);
            }
        }
        if calls.is_empty()
            && let Some(argument) = self.checked_pure_input_guard(key, module)
        {
            return Ok(self
                .expr(argument, module, env, calls)?
                .into_iter()
                .map(|value| ValuePath {
                    reads: value.reads,
                    intrinsics: value.intrinsics,
                    observed: value.observed,
                    decisions: value.decisions,
                    influences: value.influences,
                    ..ValuePath::default()
                })
                .collect());
        }
        if calls.is_empty()
            && self.authorization
            && self.statement_depth == 1
            && self.loop_node.is_none()
            && matches!(&selected.target,SelectedCallTarget::Builtin {id,..} if id=="any")
        {
            let original = self.effects.scenarios.values().find_map(|scenario| {
                (scenario.module == module).then_some(())?;
                let actual = self.types.checked_collection_calls.get(&key)?;
                self.checked_any_query_sources(scenario)?
                    .into_iter()
                    .find(|query| {
                        actual.node == key
                            && actual.builtin == "any"
                            && actual.query == query.node
                            && Some(actual.alias) == query.alias
                            && actual.predicate.as_ref().map(|predicate| predicate.node)
                                == query.predicate
                    })
            });
            if let Some(query) = original {
                let [(receiver, parameter)] = query.inputs.as_slice() else {
                    return Err(self.fail(key, "any needs its original required parent"));
                };
                let Some(ResolvedType::Record {
                    symbol: parent,
                    stored: true,
                }) = self.types.symbol_types.get(parameter)
                else {
                    return Err(self.fail(key, "any needs its original parent type"));
                };
                if !self.original_reference_parameter(*receiver, *parameter)
                    || !env.get(&Local::Symbol(*parameter)).is_some_and(|value| {
                        value.record == Some(*parent)
                            && matches!(value.reference_origin,
                                Some(ReferenceOrigin::Parameter(original)) if original==*parameter)
                    })
                {
                    return Err(self.fail(key, "any needs its original required parent lineage"));
                }
                return Ok(vec![ValuePath {
                    // The external predicate is lazy and may run zero or many
                    // times. Its real CONTROL read is retained by the query,
                    // rather than becoming a parent scalar/root decision.
                    influences: query.influences,
                    ..ValuePath::default()
                }]);
            }
        }
        if calls.is_empty()
            && self.statement_depth == 1
            && self.loop_node.is_none()
            && matches!(&selected.target, SelectedCallTarget::DeriveFn(_))
            && self
                .types
                .node_types
                .get(&key)
                .is_some_and(transcript_message_array)
            && let Some(fact) = self.effects.scenarios.values().find_map(|scenario| {
                (scenario.module == module).then_some(())?;
                self.checked_transcript_sources(scenario)?
                    .into_iter()
                    .find(|fact| fact.call == key)
            })
        {
            if !env.get(&Local::Symbol(fact.parameter)).is_some_and(|value| {
                value.record==Some(fact.branch)
                    && matches!(value.reference_origin,Some(ReferenceOrigin::Parameter(parameter)) if parameter==fact.parameter)
            }) {
                return Err(self.fail(key,"transcript needs its original required Branch parameter"));
            }
            let model = self
                .resolve
                .symbols
                .get(fact.branch.0 as usize)
                .ok_or_else(|| self.fail(key, "missing transcript owning Branch"))?;
            let nested = vec![key];
            let mut observed = vec![(fact.prefix_node, nested.clone())];
            observed.extend(
                fact.dependencies
                    .iter()
                    .map(|dependency| (dependency.node, dependency.calls.clone())),
            );
            let mut reads = vec![DisclosureDependency {
                id: self.opaque("read-data", fact.prefix_node, &self.call_stamp(&nested)?)?,
                source: fact.source.clone(),
                node: fact.prefix_node,
                calls: nested.clone(),
                role: DependencyRole::Data,
                model: fact.branch,
                field: fact.prefix,
                model_name: model.canonical.clone(),
                field_name: self.resolve.symbols[fact.prefix.0 as usize].name.clone(),
                ty: fact.ty.clone(),
                type_id: "TextMessage[]".into(),
                query_id: None,
            }];
            reads.extend(fact.dependencies);
            return Ok(vec![ValuePath {
                // Retain each real eager selection in every consuming Return;
                // its exact query association still owns candidate capture.
                reads,
                observed,
                influences: fact.influences,
                transcript_messages: Some(key),
                ..ValuePath::default()
            }]);
        }
        if calls.is_empty()
            && self.statement_depth == 1
            && self.loop_node.is_none()
            && matches!(&selected.target,SelectedCallTarget::Builtin {id,overload:0} if id=="count")
            && selected.slots.as_slice() == [Some(0)]
            && selected.arguments.len() == 1
            && self.types.node_types.get(&key) == Some(&ResolvedType::Scalar(Scalar::Int))
            && self
                .types
                .node_types
                .get(&selected.arguments[0])
                .is_some_and(transcript_message_array)
        {
            let argument = selected.arguments[0];
            let original = self
                .query_group(argument)
                .ok_or_else(|| self.fail(key, "missing transcript count operand"))?;
            let operand = match self.query_binding(original) {
                Some(Binding::Let { node }) => self
                    .effects
                    .scenarios
                    .values()
                    .filter(|scenario| scenario.module == module)
                    .flat_map(|scenario| &scenario.effects)
                    .find(|effect| effect.node == *node && effect.verb == EffectVerb::Let)
                    .and_then(|effect| self.query_group(effect.value?)),
                _ => Some(original),
            }
            .ok_or_else(|| {
                self.fail(key, "transcript count needs its original immutable concat")
            })?;
            let count_node = self
                .nodes
                .get(&key)
                .ok_or_else(|| self.fail(key, "missing transcript count"))?;
            let head = count_node
                .children
                .iter()
                .find(|child| expression(child.kind))
                .ok_or_else(|| self.fail(key, "missing transcript count target"))?;
            let syntax_args: Vec<_> = count_node
                .children
                .iter()
                .filter(|child| child.kind == SyntaxKind::Argument)
                .filter_map(|child| {
                    child
                        .children
                        .iter()
                        .find(|child| expression(child.kind))
                        .map(NodeKey::of)
                })
                .collect();
            if count_node.kind != SyntaxKind::Call
                || syntax_args.as_slice() != [argument]
                || !matches!(self.query_binding(NodeKey::of(head)),Some(Binding::Builtin {id}) if id=="count")
            {
                return Err(self.fail(key, "transcript count source selection mismatch"));
            }
            let mut values = self.expr(argument, module, env, calls)?;
            if values.is_empty()
                || values
                    .iter()
                    .any(|value| value.transcript_messages != Some(operand))
            {
                return Err(self.fail(key, "count needs exact transcript-origin messages"));
            }
            for value in &mut values {
                value.transcript_messages = None;
                value.transcript_count = true;
            }
            return Ok(values);
        }
        if self.authorization
            && calls.len() == 1
            && self
                .effects
                .scenarios
                .values()
                .find_map(|scenario| {
                    (scenario.node.file == calls[0].file
                        && scenario.node.start <= calls[0].start
                        && scenario.node.end >= calls[0].end)
                        .then(|| self.checked_authorization_derive(calls[0], scenario.module))
                        .flatten()
                })
                .is_some_and(|(_, _, _, membership)| membership == key)
        {
            self.checked_membership_signature(key, module)
                .ok_or_else(|| self.fail(key, "original StateRead membership evidence required"))?;
            return Ok(vec![ValuePath {
                observed: vec![(key, calls.to_vec())],
                ..ValuePath::default()
            }]);
        }
        if calls.is_empty()
            && self.statement_depth == 1
            && matches!(&selected.target, SelectedCallTarget::Builtin {id,..} if id == "first")
        {
            let original = self.effects.scenarios.values().find_map(|scenario| {
                if scenario.module != module {
                    return None;
                }
                scenario
                    .effects
                    .iter()
                    .filter(|binding| binding.verb == EffectVerb::Let)
                    .find_map(|binding| {
                        let query = self.checked_first_query_source(scenario, binding)?;
                        (query.first.as_ref()?.call == key).then_some(query)
                    })
            });
            if let Some(query) = original {
                let first = query.first.as_ref().expect("checked first source");
                return Ok(vec![ValuePath {
                    record: Some(query.model),
                    first_query: Some((first.call, first.binding)),
                    influences: query.influences,
                    ..ValuePath::default()
                }]);
            }
        }
        if calls.is_empty()
            && self.statement_depth == 1
            && self.loop_node.is_none()
            && matches!(&selected.target, SelectedCallTarget::Builtin {id,..} if id == "count")
        {
            let original = self.effects.scenarios.values().find_map(|scenario| {
                if scenario.module != module {
                    return None;
                }
                self.checked_count_query_sources(scenario)?.into_iter().find(|query| {
                    let Some(count) = query.count.as_ref() else { return false; };
                    count.call == key
                        && scenario.guards.iter().chain(&scenario.effects)
                            .any(|statement| statement.node == count.statement)
                        && query.inputs.iter().all(|(_, parameter)| {
                            let Some(ResolvedType::Record { symbol, stored: true }) =
                                self.types.symbol_types.get(parameter)
                            else { return false; };
                            env.get(&Local::Symbol(*parameter)).is_some_and(|value| {
                                value.record == Some(*symbol)
                                    && matches!(value.reference_origin,
                                        Some(ReferenceOrigin::Parameter(original)) if original == *parameter)
                            })
                        })
                })
            });
            if let Some(query) = original {
                let mut value = ValuePath::default();
                let count = query.count.as_ref().expect("checked count source");
                if !count.parent_edges.is_empty() {
                    let [first, candidate, supplied] = count.parent_edges.as_slice() else {
                        return Err(
                            self.fail(key, "count needs its original three parent occurrences")
                        );
                    };
                    if count.contained_parent.is_some()
                        || candidate.receiver != first.node
                        || candidate.child != first.parent
                        || supplied.child != candidate.child
                        || supplied.parent != candidate.parent
                        || self
                            .checked_count_parent_edge(
                                candidate.node,
                                candidate.receiver,
                                candidate.child,
                                module,
                            )
                            .as_ref()
                            != Some(candidate)
                        || self.source(module, candidate.node)? != query.source
                        || self.source(module, supplied.node)? != query.source
                    {
                        return Err(self.fail(key, "count parent occurrence/source mismatch"));
                    }
                    let owner = self
                        .checked_count_model(candidate.child, module)
                        .ok_or_else(|| self.fail(key, "missing owning query parent model"))?;
                    let parent = self
                        .checked_count_model(candidate.parent, module)
                        .ok_or_else(|| self.fail(key, "missing owning query ancestor model"))?;
                    value.reads.push(DisclosureDependency {
                        id: self.opaque(
                            "read-control",
                            candidate.node,
                            &self.call_stamp(calls)?,
                        )?,
                        source: query.source.clone(),
                        node: candidate.node,
                        calls: Vec::new(),
                        role: DependencyRole::Control,
                        model: candidate.child,
                        field: candidate.child,
                        model_name: owner.canonical.clone(),
                        field_name: "parent".into(),
                        ty: ResolvedType::Record {
                            symbol: candidate.parent,
                            stored: true,
                        },
                        type_id: parent.canonical.clone(),
                        query_id: Some(query.id.clone()),
                    });
                    value.observed.push((candidate.node, Vec::new()));
                    // Retain the original supplied edge at its predicate
                    // occurrence. Native execution must never hoist this read.
                    let mut supplied_values = self.expr(supplied.node, module, env, calls)?;
                    if supplied_values.len() != 1 {
                        return Err(self.fail(key, "count supplied parent path"));
                    }
                    let mut supplied_value = self.control(supplied_values.remove(0))?;
                    let [read] = supplied_value.reads.as_mut_slice() else {
                        return Err(self.fail(key, "count supplied parent read closure"));
                    };
                    if read.node != supplied.node
                        || read.model != supplied.child
                        || read.field != supplied.child
                        || read.field_name != "parent"
                        || read.ty
                            != (ResolvedType::Record {
                                symbol: supplied.parent,
                                stored: true,
                            })
                        || read.source != query.source
                        || !read.calls.is_empty()
                        || read.query_id.is_some()
                        || !supplied_value.intrinsics.is_empty()
                        || !supplied_value.decisions.is_empty()
                    {
                        return Err(self.fail(key, "count supplied parent occurrence mismatch"));
                    }
                    read.query_id = Some(query.id.clone());
                    value.join(&supplied_value);
                }
                value.influences = query.influences;
                return Ok(vec![value]);
            }
        }
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
        let authorization = (self.authorization && calls.is_empty() && self.loop_node.is_none())
            .then(|| self.checked_authorization_derive(key, module))
            .flatten();
        let mut argument_paths = vec![(ValuePath::default(), Vec::<ValuePath>::new())];
        for argument in &selected.arguments {
            let mut alternatives = if (authorization.is_some()
                && selected.arguments.first() == Some(argument))
                || matches!(
                    self.query_binding(*argument),
                    Some(Binding::Context(ContextVar::Actor(_)))
                ) {
                // Only this original authorization call passes Actor into its
                // checked nullable User formal. It is not ordinary context data.
                vec![ValuePath::default()]
            } else {
                self.expr(*argument, module, env, calls)?
            };
            if let Some((_, model, parent, _)) = authorization
                && *argument == parent
            {
                for value in &mut alternatives {
                    if let Some(ReferenceOrigin::NullableParameter(parameter)) =
                        value.reference_origin
                    {
                        let (scenario, param) = self
                            .effects
                            .scenarios
                            .values()
                            .find_map(|scenario| {
                                scenario
                                    .params
                                    .iter()
                                    .find(|param| param.param == parameter)
                                    .map(|param| (scenario, param))
                            })
                            .ok_or_else(|| self.fail(parent, "missing original optional input"))?;
                        if scenario.module != module
                            || self.nullable_model_input(scenario, param) != Some(model)
                            || value.record != Some(model)
                            || !value.reads.is_empty()
                            || !value.intrinsics.is_empty()
                            || !value.decisions.is_empty()
                            || !matches!(self.query_binding(parent), Some(Binding::Symbol(actual)) if *actual == parameter)
                            || env.get(&Local::Symbol(parameter)).is_none_or(|input| {
                                input.reference_origin != value.reference_origin
                            })
                        {
                            return Err(self.fail(parent, "authorization optional input mismatch"));
                        }
                        value.reference_origin = None;
                        continue;
                    }
                    let Some(ReferenceOrigin::Parent {
                        parameter,
                        model: actual,
                        depth,
                    }) = value.reference_origin
                    else {
                        return Err(self.fail(
                            parent,
                            "authorization needs its original required parent reference",
                        ));
                    };
                    if !matches!(depth, 1 | 2) || actual != model || value.record != Some(model)
                        || self.checked_call_parent_path(parent,parameter,0) != Some((model,depth))
                        || !env.get(&Local::Symbol(parameter)).is_some_and(|input| {
                            matches!(input.reference_origin,Some(ReferenceOrigin::Parameter(original)) if original == parameter)
                        }) || value.reads.len()!=usize::from(depth)
                        || !value.intrinsics.is_empty() || !value.decisions.is_empty()
                    { return Err(self.fail(parent,"authorization parent observation mismatch")); }
                    let mut edges = Vec::new();
                    let mut edge = parent;
                    for _ in 0..depth {
                        let (base, field) = self.count_member(edge).ok_or_else(|| {
                            self.fail(parent, "authorization parent edge missing")
                        })?;
                        if field != "parent" {
                            return Err(self.fail(parent, "authorization parent edge mismatch"));
                        }
                        edges.push((edge, base));
                        edge = base;
                    }
                    edges.reverse();
                    for (read, (node, base)) in value.reads.iter().zip(edges) {
                        let Some(ResolvedType::Record {
                            symbol: child,
                            stored: true,
                        }) = self.types.node_types.get(&base)
                        else {
                            return Err(self.fail(parent, "authorization parent receiver mismatch"));
                        };
                        if read.node != node
                            || read.field != *child
                            || read.model != *child
                            || read.field_name != "parent"
                            || self.types.node_types.get(&node) != Some(&read.ty)
                            || read.role != DependencyRole::Data
                            || !read.calls.is_empty()
                            || read.query_id.is_some()
                            || read.source != self.source(module, node)?
                        {
                            return Err(
                                self.fail(parent, "authorization parent observation mismatch")
                            );
                        }
                    }
                    // Consumption into this exact formal retains the source
                    // parent read. It neither admits a new parameter nor leaves
                    // a general parent/field operand permission in the callee.
                    value.reference_origin = None;
                }
            }
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
                                if let Some((_, _, parent, _)) = authorization {
                                    // This checked authorization call eagerly
                                    // read its required parent before the lazy
                                    // derive body. Every resulting alternative
                                    // retains that same reference authority.
                                    value.join(&ValuePath {
                                        reads: evaluated
                                            .reads
                                            .iter()
                                            .filter(|read| {
                                                read.node == parent
                                                    && read.field_name == "parent"
                                                    && read.calls.is_empty()
                                            })
                                            .cloned()
                                            .collect(),
                                        ..ValuePath::default()
                                    });
                                }
                                // Other argument reads matter only when the derive's
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
                    "date"
                        | "datetime"
                        | "money"
                        | "abs"
                        | "round"
                        | "min"
                        | "max"
                        | "trim"
                        | "starts_with"
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
        child: &super::effects::ScenarioData,
        scalar: Scalar,
    ) -> bool {
        if let Some(default) = parameter.default {
            let literal = self
                .nodes
                .get(&default)
                .is_some_and(|node| node.kind == SyntaxKind::Literal)
                && self.types.node_types.get(&default)
                    == Some(&ResolvedType::Scalar(scalar));
            if !literal && !self.explicit_param_reference_default(parameter, child, default) {
                return false;
            }
        }
        let module = child.module;
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

    /// Singular model slots retain their actual named declaration. Only the
    /// original nullable slot's literal null is a default; CALL supplies it.
    fn explicit_model_call_parameter(
        &self,
        parameter: &super::effects::ParamData,
    ) -> Option<(SymbolId, bool)> {
        let ty = self.types.symbol_types.get(&parameter.param)?;
        let (base, nullable) = match ty {
            ResolvedType::Nullable(inner) => (inner.as_ref(), true),
            ty => (ty, false),
        };
        let ResolvedType::Record {
            symbol,
            stored: true,
        } = base
        else {
            return None;
        };
        let model = self.resolve.symbols.get(symbol.0 as usize)?;
        if !matches!(model.kind, SymbolKind::Model { .. })
            || self.types.value_constraints.contains_key(&parameter.param)
            || self
                .types
                .field_reuse_sources
                .contains_key(&parameter.param)
        {
            return None;
        }
        let declared = *self.nodes.get(&parameter.type_node)?;
        let named = if nullable {
            if declared.kind != SyntaxKind::NullableType {
                return None;
            }
            declared
                .children
                .iter()
                .find(|node| node.kind == SyntaxKind::NamedType)?
        } else {
            declared
        };
        if named.kind != SyntaxKind::NamedType {
            return None;
        }
        let path = named
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)?;
        if !matches!(self.resolve.node_typeref.get(&NodeKey::of(path)),
            Some(TypeRef::Symbol(actual)) if actual == symbol)
            || super::path_segments(path, &self.db.get(path.span.file)?.text)
                != [model.name.as_str()]
        {
            return None;
        }
        match (nullable, parameter.default) {
            (false, None) => {}
            (true, Some(default))
                if self.nodes.get(&default)?.kind == SyntaxKind::Literal
                    && self.types.node_types.get(&default) == Some(&ResolvedType::Null)
                    && self
                        .db
                        .get(default.file)?
                        .text
                        .get(default.start as usize..default.end as usize)?
                        == "null" => {}
            _ => return None,
        }
        Some((*symbol, nullable))
    }

    /// The ordinary File[] child slot keeps its original empty literal default.
    /// That literal is declaration evidence and is not a supplied CALL operand.
    fn explicit_file_array_call_parameter(&self, parameter: &super::effects::ParamData) -> bool {
        let Some(ty) = self.types.symbol_types.get(&parameter.param) else {
            return false;
        };
        if !ordinary_file_array(ty)
            || self.types.value_constraints.contains_key(&parameter.param)
            || self
                .types
                .field_reuse_sources
                .contains_key(&parameter.param)
        {
            return false;
        }
        let Some(node) = self.nodes.get(&parameter.type_node) else {
            return false;
        };
        let Some(element) = node
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::NamedType)
        else {
            return false;
        };
        let Some(default) = parameter.default else {
            return false;
        };
        let Some(value) = self.nodes.get(&default) else {
            return false;
        };
        node.kind == SyntaxKind::ArrayType
            && self.direct_builtin_parameter_type(NodeKey::of(element), Scalar::File)
            && value.kind == SyntaxKind::Array
            && !value.children.iter().any(|node| expression(node.kind))
            && self.types.node_types.get(&default) == Some(ty)
    }

    /// A genuine `=name` scalar default names an earlier required same-type
    /// parameter. Static CALL supplies every slot, so the default never
    /// evaluates there; this keeps the declaration's own genuine default
    /// rather than admitting arbitrary default expressions.
    fn explicit_param_reference_default(
        &self,
        parameter: &super::effects::ParamData,
        child: &super::effects::ScenarioData,
        default: NodeKey,
    ) -> bool {
        let Some(node) = self.nodes.get(&default) else {
            return false;
        };
        if node.kind != SyntaxKind::NameRef {
            return false;
        }
        let Some(Binding::Symbol(target)) = self.resolve.node_binding.get(&default) else {
            return false;
        };
        let target = *target;
        let Some(position) = child.params.iter().position(|param| param.param == parameter.param)
        else {
            return false;
        };
        let Some(earlier) = child.params.iter().position(|param| param.param == target) else {
            return false;
        };
        if earlier >= position {
            return false;
        }
        let referenced = &child.params[earlier];
        if referenced.default.is_some() {
            return false;
        }
        let Some(expected) = self.types.symbol_types.get(&parameter.param) else {
            return false;
        };
        if self.types.symbol_types.get(&target) != Some(expected) {
            return false;
        }
        let Some(declaration) = self.resolve.symbols.get(target.0 as usize) else {
            return false;
        };
        if declaration.module != child.module {
            return false;
        }
        matches!(declaration.kind, super::resolve::SymbolKind::Param { owner, .. } if owner == child.scenario)
            && self.types.node_types.get(&default) == Some(expected)
    }

    /// Implicit `T?` absence is null; only an explicit literal null may also
    /// appear. Server-owned or constrained slots stay ineligible.
    fn nullable_value_default_ok(&self, parameter: &super::effects::ParamData) -> bool {
        match parameter.default {
            None => true,
            Some(default) => {
                self.nodes.get(&default).is_some_and(|node| {
                    node.kind == SyntaxKind::Literal
                        && self.types.node_types.get(&default) == Some(&ResolvedType::Null)
                        && self
                            .db
                            .get(default.file)
                            .and_then(|file| {
                                file.text.get(default.start as usize..default.end as usize)
                            })
                            == Some("null")
                })
            }
        }
    }

    /// Nullable scalar/enum/file slots (`text?`, `file?`, …) widen from their
    /// exact supplied inner value. Stored-model nullables keep the existing
    /// model rule; only value nullables land here.
    fn explicit_nullable_value_call_parameter(
        &self,
        parameter: &super::effects::ParamData,
    ) -> bool {
        let Some(ty) = self.types.symbol_types.get(&parameter.param) else {
            return false;
        };
        let ResolvedType::Nullable(inner) = ty else {
            return false;
        };
        match inner.as_ref() {
            ResolvedType::Scalar(scalar) => {
                if !(primitive_type(inner.as_ref()) || *scalar == Scalar::File) {
                    return false;
                }
            }
            ResolvedType::Enum { cases, .. } => {
                if cases.is_empty() {
                    return false;
                }
            }
            _ => return false,
        }
        if self.types.value_constraints.contains_key(&parameter.param)
            || self
                .types
                .field_reuse_sources
                .contains_key(&parameter.param)
        {
            return false;
        }
        let Some(node) = self.nodes.get(&parameter.type_node) else {
            return false;
        };
        if node.kind != SyntaxKind::NullableType {
            return false;
        }
        let named = node
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::NamedType);
        let Some(named) = named else {
            return false;
        };
        let Some(path) = named
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)
        else {
            return false;
        };
        let direct = match inner.as_ref() {
            ResolvedType::Scalar(scalar) => self.direct_builtin_parameter_type(
                NodeKey::of(named),
                *scalar,
            ) && matches!(
                self.resolve.node_typeref.get(&NodeKey::of(path)),
                Some(TypeRef::Scalar(name)) if name == scalar.as_str()
            ),
            ResolvedType::Enum { .. } => {
                self.resolve.node_typeref.get(&NodeKey::of(path)).is_some()
            }
            _ => false,
        };
        direct && self.nullable_value_default_ok(parameter)
    }

    /// Enum slots keep their exact checked domain through field reuse or a
    /// checked alias. Case spellings are never converted or widened here.
    fn explicit_enum_call_parameter(&self, parameter: &super::effects::ParamData) -> bool {
        let Some(ty) = self.types.symbol_types.get(&parameter.param) else {
            return false;
        };
        let ResolvedType::Enum { cases, .. } = ty else {
            return false;
        };
        if cases.is_empty() {
            return false;
        }
        if parameter.default.is_some_and(|default| {
            self.nodes
                .get(&default)
                .is_none_or(|node| node.kind != SyntaxKind::Literal)
                || self.types.node_types.get(&default) != Some(ty)
        }) {
            return false;
        }
        if self.types.value_constraints.contains_key(&parameter.param) {
            return false;
        }
        let Some(node) = self.nodes.get(&parameter.type_node) else {
            return false;
        };
        if node.kind != SyntaxKind::NamedType {
            return false;
        }
        let Some(path) = node
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)
        else {
            return false;
        };
        match self.resolve.node_typeref.get(&NodeKey::of(path)) {
            Some(TypeRef::FieldChain { fields, .. }) if fields.len() == 1 => {
                self.types.field_reuse_sources.get(&parameter.param) == fields.first()
                    && self.types.symbol_types.get(&fields[0]) == Some(ty)
            }
            Some(TypeRef::Symbol(alias)) => self
                .resolve
                .judgment_value_constraints
                .get(alias)
                .is_some_and(|constraints| {
                    constraints.alias == Some(*alias)
                        && self.types.value_constraints.get(&parameter.param) == Some(constraints)
                        && self.types.symbol_types.get(alias) == Some(ty)
                }),
            _ => false,
        }
    }

    /// Non-file array slots (`text[]`, `Slot[]`, …) keep their exact element
    /// shape. Only required slots or an empty-array literal default are
    /// eligible; stored-model element arrays stay declined.
    fn explicit_array_call_parameter(&self, parameter: &super::effects::ParamData) -> bool {
        let Some(ty) = self.types.symbol_types.get(&parameter.param) else {
            return false;
        };
        let ResolvedType::Array { element, ordered: true, .. } = ty else {
            return false;
        };
        if ordinary_file_array(ty) {
            return false;
        }
        match element.as_ref() {
            element if primitive_type(element) => {}
            ResolvedType::Scalar(Scalar::File) => {}
            ResolvedType::Enum { cases, .. } if !cases.is_empty() => {}
            ResolvedType::Record { stored: false, .. } => {}
            // Declared contracts/events are value types without row
            // authority, even though they resolve stored. Stored models
            // keep their row authority and stay declined as array slots.
            ResolvedType::Record { symbol, .. }
                if !matches!(
                    self.resolve.symbols.get(symbol.0 as usize).map(|symbol| &symbol.kind),
                    Some(super::resolve::SymbolKind::Model { .. }) | None
                ) => {}
            ResolvedType::Object(_) => {}
            _ => return false,
        }
        if self.types.value_constraints.contains_key(&parameter.param) {
            return false;
        }
        if let Some(default) = parameter.default {
            let Some(value) = self.nodes.get(&default) else {
                return false;
            };
            if value.kind != SyntaxKind::Array
                || value.children.iter().any(|node| expression(node.kind))
                || self.types.node_types.get(&default) != Some(ty)
            {
                return false;
            }
        }
        let Some(node) = self.nodes.get(&parameter.type_node) else {
            return false;
        };
        if node.kind == SyntaxKind::ArrayType {
            return true;
        }
        let Some(path) = node
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)
        else {
            return false;
        };
        match self.resolve.node_typeref.get(&NodeKey::of(path)) {
            Some(TypeRef::FieldChain { fields, .. }) if fields.len() == 1 => {
                self.types.field_reuse_sources.get(&parameter.param) == fields.first()
                    && self.types.symbol_types.get(&fields[0]) == Some(ty)
            }
            Some(TypeRef::Symbol(alias)) => self
                .resolve
                .judgment_value_constraints
                .get(alias)
                .is_some_and(|constraints| {
                    constraints.alias == Some(*alias)
                        && self.types.value_constraints.get(&parameter.param) == Some(constraints)
                        && self.types.symbol_types.get(alias) == Some(ty)
                }),
            _ => false,
        }
    }

    /// Original required caller parameters remain source operands, not copied
    /// lexical values which happen to carry the same resolved model type.
    fn original_call_model_parameter(
        &self,
        key: NodeKey,
        statement: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId)> {
        let node = self.nodes.get(&key)?;
        if !matches!(node.kind, SyntaxKind::Name | SyntaxKind::NameRef) {
            return None;
        }
        let Some(Binding::Symbol(parameter)) = self.query_binding(key) else {
            return None;
        };
        let SymbolKind::Param { owner, .. } = self.resolve.symbols.get(parameter.0 as usize)?.kind
        else {
            return None;
        };
        let scenario = self.effects.scenarios.get(&owner)?;
        let parameter_data = scenario
            .params
            .iter()
            .find(|param| param.param == *parameter)?;
        let (model, nullable) = self.explicit_model_call_parameter(parameter_data)?;
        (!nullable
            && !scenario.read
            && scenario.on.is_none()
            && scenario.module == module
            && statement.file == scenario.node.file
            && scenario.node.start <= statement.start
            && statement.end <= scenario.node.end
            && key.file == statement.file
            && statement.start <= key.start
            && key.end <= statement.end
            && self.types.node_types.get(&key) == self.types.symbol_types.get(parameter))
        .then_some((*parameter, model))
    }

    /// One checked `param.parent` hop into a required non-null model slot.
    /// The base remains the caller's original required model parameter and
    /// the hop is the checked containment edge, never a copied row.
    fn original_call_parent_parameter(
        &self,
        key: NodeKey,
        statement: NodeKey,
        module: ModuleId,
    ) -> Option<(SymbolId, SymbolId)> {
        let node = self.nodes.get(&key)?;
        if node.kind != SyntaxKind::Member {
            return None;
        }
        let mut operands = node.children.iter().filter(|child| expression(child.kind));
        let base = NodeKey::of(operands.next()?);
        if operands.next().is_some() {
            return None;
        }
        if node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)
            .and_then(|child| self.word(child))
            != Some("parent")
        {
            return None;
        }
        let (parameter, child) = self.original_call_model_parameter(base, statement, module)?;
        let declaration = self.resolve.symbols.get(child.0 as usize)?;
        let SymbolKind::Model {
            owner: ModelOwner::ChildOf(parent),
            ..
        } = &declaration.kind
        else {
            return None;
        };
        (self.checked_call_parent_path(key, parameter, 0) == Some((*parent, 1)))
            .then_some((parameter, *parent))
    }

    /// One contained-collection domain (`param.Child`) over the caller's
    /// original required model parameter. Returns the root parameter and
    /// the contained child model proven through the checked containment
    /// edge and the domain's own array type.
    fn original_loop_member_root(
        &self,
        domain: NodeKey,
        statement: NodeKey,
        module: ModuleId,
    ) -> Result<(SymbolId, SymbolId), DisclosureDecline> {
        let fail = || self.fail(domain, "loop needs original admitted member domain");
        let node = self.nodes.get(&domain).ok_or_else(fail)?;
        if node.kind != SyntaxKind::Member {
            return Err(fail());
        }
        let mut operands = node.children.iter().filter(|child| expression(child.kind));
        let base = NodeKey::of(operands.next().ok_or_else(fail)?);
        if operands.next().is_some() {
            return Err(fail());
        }
        let (parameter, root) = self
            .original_call_model_parameter(base, statement, module)
            .ok_or_else(fail)?;
        let expected_domain = self
            .types
            .node_types
            .get(&domain)
            .ok_or_else(fail)?;
        let ResolvedType::Array { element, ordered: true, .. } = expected_domain else {
            return Err(fail());
        };
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = element.as_ref()
        else {
            return Err(fail());
        };
        let model = *model;
        let declaration = self.resolve.symbols.get(model.0 as usize).ok_or_else(fail)?;
        let SymbolKind::Model {
            owner: ModelOwner::ChildOf(parent),
            ..
        } = &declaration.kind
        else {
            return Err(fail());
        };
        if *parent != root
            || declaration.module != module
            || self.effects.models.get(&model).ok_or_else(fail)?.owner != ModelOwner::ChildOf(root)
            || self.types.node_types.get(&base)
                != Some(&ResolvedType::Record {
                    symbol: root,
                    stored: true,
                })
        {
            return Err(fail());
        }
        Ok((parameter, model))
    }

    fn preceding_call_create(
        &self,
        effect: &Effect,
        module: ModuleId,
        key: NodeKey,
        model: SymbolId,
        created: NodeKey,
    ) -> bool {
        let Some(node) = self.nodes.get(&key) else {
            return false;
        };
        if !matches!(node.kind, SyntaxKind::Name | SyntaxKind::NameRef)
            || !matches!(self.query_binding(key), Some(Binding::CreateAs {node}) if *node == created)
        {
            return false;
        }
        let mut owners = self.effects.scenarios.values().filter(|scenario| {
            scenario.module == module
                && scenario.node.file == effect.node.file
                && scenario.node.start <= effect.node.start
                && effect.node.end <= scenario.node.end
        });
        let Some(owner) = owners.next() else {
            return false;
        };
        if owners.next().is_some() {
            return false;
        }
        let Some(position) = owner
            .effects
            .iter()
            .position(|statement| statement.node == effect.node)
        else {
            return false;
        };
        let Some(previous) = position
            .checked_sub(1)
            .and_then(|position| owner.effects.get(position))
        else {
            return false;
        };
        let Some(original) = self.checked_create_source(previous, module) else {
            return false;
        };
        previous.verb == EffectVerb::Create
            && previous.node == created
            && original.model == model
            && self.word(node) == Some(original.binding.as_str())
    }

    /// CALL-only stored File[] observation. No ordinary expression/result or
    /// File intrinsic gains admission from this source-backed input leaf.
    fn call_file_array_operand(
        &self,
        key: NodeKey,
        statement: NodeKey,
        module: ModuleId,
        calls: &[NodeKey],
    ) -> Result<Vec<ValuePath>, DisclosureDecline> {
        let fail = || {
            self.fail(
                key,
                "File[] call input needs original stored parameter member",
            )
        };
        let node = self.nodes.get(&key).ok_or_else(fail)?;
        if node.kind != SyntaxKind::Member || !calls.is_empty() || self.loop_node.is_some() {
            return Err(fail());
        }
        let mut operands = node.children.iter().filter(|node| expression(node.kind));
        let base = NodeKey::of(operands.next().ok_or_else(fail)?);
        let name = node
            .children
            .iter()
            .rev()
            .find(|node| node.kind == SyntaxKind::Name)
            .and_then(|node| self.word(node))
            .ok_or_else(fail)?;
        let (parameter, model) = self
            .original_call_model_parameter(base, statement, module)
            .ok_or_else(fail)?;
        if operands.next().is_some() {
            return Err(fail());
        }
        let owner = self
            .resolve
            .symbols
            .get(model.0 as usize)
            .ok_or_else(fail)?;
        let SymbolKind::Model { fields, .. } = &owner.kind else {
            return Err(fail());
        };
        let field = fields
            .iter()
            .filter_map(|id| self.resolve.symbols.get(id.0 as usize))
            .find(|field| field.name == name)
            .ok_or_else(fail)?;
        let SymbolKind::Param {
            owner: scenario, ..
        } = self
            .resolve
            .symbols
            .get(parameter.0 as usize)
            .ok_or_else(fail)?
            .kind
        else {
            return Err(fail());
        };
        let scenario = self.effects.scenarios.get(&scenario).ok_or_else(fail)?;
        let inventory = self.checked_stored_contracts(scenario).ok_or_else(fail)?;
        let mut originals = inventory
            .iter()
            .filter(|schema| schema.model && schema.id == model)
            .flat_map(|schema| schema.fields.iter())
            .filter(|original| original.id == field.id);
        let original = originals.next().ok_or_else(fail)?;
        if originals.next().is_some()
            || !matches!(field.kind, SymbolKind::Field {owner,..} if owner == model)
            || field.module != owner.module
            || original.owner != model
            || original.name != name
            || !ordinary_file_array(&original.ty)
            || original.required_array
            || original.reuse.is_some()
            || original.min.is_some()
            || original.max.as_ref().map(|(_, max, _)| *max) != Some(8)
            || self.types.node_types.get(&key) != Some(&original.ty)
            || self.types.symbol_types.get(&field.id) != Some(&original.ty)
        {
            return Err(fail());
        }
        let data = self
            .effects
            .models
            .get(&model)
            .and_then(|model| model.fields.iter().find(|data| data.field == field.id))
            .ok_or_else(fail)?;
        if data.default.is_some() || data.server.is_some() || data.required_array {
            return Err(fail());
        }
        Ok(vec![ValuePath {
            reads: vec![DisclosureDependency {
                query_id: None,
                id: self.opaque("read-data", key, &self.call_stamp(calls)?)?,
                source: self.source(module, key)?,
                node: key,
                calls: calls.to_vec(),
                role: DependencyRole::Data,
                model,
                field: field.id,
                model_name: owner.canonical.clone(),
                field_name: name.into(),
                ty: original.ty.clone(),
                type_id: "file[]".into(),
            }],
            observed: vec![(key, calls.to_vec())],
            ..ValuePath::default()
        }])
    }

    fn input_value(
        &self,
        key: NodeKey,
        module: ModuleId,
        calls: &[NodeKey],
        mut value: ValuePath,
    ) -> Result<ValuePath, DisclosureDecline> {
        if value.record.is_some()
            && matches!(value.reference_origin, Some(ReferenceOrigin::Field { .. }))
            && self
                .query_group(key)
                .and_then(|key| {
                    self.checked_profile_reference(key, module)
                        .or_else(|| self.checked_run_reference(key, module))
                })
                .is_some()
        {
            return Err(self.fail(
                key,
                "Profile reference needs its direct original scalar member",
            ));
        }
        if let Some(binding) = value.current_revision
            && (!calls.is_empty()
                || !matches!(self.query_binding(key),Some(Binding::Let {node}) if *node==binding)
                || !self.current_revision_at(key, module).is_some_and(|fact| {
                    fact.binding == binding && value.record == Some(fact.revision)
                }))
        {
            return Err(self.fail(key, "current Revision needs its original lexical binding"));
        }
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
        if value.record.is_some()
            && value
                .first_query
                .is_some_and(|(_, binding)| local != Local::Let(binding))
        {
            return Err(self.fail(key, "copied first query row binding"));
        }
        if value
            .current_revision
            .is_some_and(|binding| local != Local::Let(binding))
        {
            return Err(self.fail(key, "copied current Revision binding"));
        }
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
        let decline = self.fail(
            effect.node,
            "checked bound scenario create profile required",
        );
        let fail = || decline.clone();
        let checked = self
            .checked_create_source(effect, module)
            .ok_or_else(fail)?;
        let model = checked.model;
        // Branch-arm creates prove conditionally: only `statements` arm
        // recursion raises statement_depth past 1 (loops use loop_node, call
        // frames use calls), so If/Match-arm nesting is admitted here while
        // the receipt tail rule narrowly admits only captured conditional
        // shapes — every other nested tail keeps its loud refusal there.
        if self.loop_node.is_some() || !calls.is_empty() {
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
                    if let Some(binding) = value.current_revision {
                        let fact = self
                            .current_revision_at(input.value_node, module)
                            .ok_or_else(fail)?;
                        let owner = self
                            .resolve
                            .symbols
                            .get(model.0 as usize)
                            .ok_or_else(fail)?;
                        let field = input
                            .field
                            .and_then(|field| self.resolve.symbols.get(field.0 as usize))
                            .ok_or_else(fail)?;
                        if fact.binding != binding
                            || !matches!(owner.kind, SymbolKind::Model { .. })
                            || input.name != field.name
                            || !matches!(field.kind,SymbolKind::Field {owner,..} if owner==model)
                            || !matches!(self.query_binding(input.value_node),Some(Binding::Let {node}) if *node==binding)
                            || input.ty
                                != (ResolvedType::Record {
                                    symbol: fact.revision,
                                    stored: true,
                                })
                        {
                            return Err(self.fail(
                                input.value_node,
                                "current Revision needs its exact Run.revision Create input",
                            ));
                        }
                    }
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
        // A set may target a bound child result row: consume its owning
        // evaluated provenance in this flow, preserving caller, transaction
        // and order. Other CallAs uses keep their existing refusal.
        let receiver_key = NodeKey::of(receiver);
        let bound_call = self
            .resolve
            .node_binding
            .get(&receiver_key)
            .or_else(|| {
                receiver
                    .children
                    .iter()
                    .find_map(|child| self.resolve.node_binding.get(&NodeKey::of(child)))
            })
            .and_then(|binding| match binding {
                Binding::CallAs { node } => Some(*node),
                _ => None,
            });
        let mut paths = match bound_call {
            Some(node) => vec![env.get(&Local::Call(node)).cloned().ok_or_else(|| {
                self.fail(
                    receiver_key,
                    "bound child result consumption needs its owning provenance",
                )
            })?],
            None => self.expr(receiver_key, module, env, calls)?,
        };
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
        let sink = self
            .types
            .runtime_bindings
            .get(&module)
            .into_iter()
            .flatten()
            .find_map(|declaration| match (declaration, &effect.target) {
                (
                    super::types::CheckedRuntimeBinding::Queue { name, .. },
                    Some(EffectTarget::Queue { queue, op }),
                ) if name == &alias
                    && queue == name
                    && op == "publish"
                    && member == Some(op.as_str()) =>
                {
                    Some((op.as_str(), vec!["value".to_string()], Vec::new()))
                }
                (
                    super::types::CheckedRuntimeBinding::Analytics { name, fields },
                    Some(EffectTarget::Analytics { sink, op }),
                ) if name == &alias
                    && sink == name
                    && op == "write"
                    && member == Some(op.as_str()) =>
                {
                    Some((
                        op.as_str(),
                        fields.iter().map(|(name, _)| name.clone()).collect(),
                        fields
                            .iter()
                            .filter(|(_, ty)| matches!(ty, ResolvedType::Nullable(_)))
                            .map(|(name, _)| name.clone())
                            .collect::<Vec<_>>(),
                    ))
                }
                _ => None,
            });
        let optional_sink_inputs = sink
            .as_ref()
            .map(|(_, _, optional)| optional.clone())
            .unwrap_or_default();
        let (operation, deployment_binding, delivery, input_names) = match binding {
            None if sink.is_some() && imports.is_empty() => {
                let (op, inputs, _) = sink.unwrap();
                (
                    format!("{}.{}.{op}", host.name, alias),
                    Some(format!("{}.{}", host.name, alias)),
                    super::types::sink_delivery_type(),
                    inputs,
                )
            }
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
            _ => input_names
                .iter()
                .filter(|name| !optional_sink_inputs.contains(name))
                .map(String::as_str)
                .collect(),
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

    /// Durable owner effects (`emit`, `schedule`, `cancel`) evaluate their
    /// exact authored value operands once in source order and persist them
    /// in the owner transaction. Only pure value operands are admitted:
    /// record reads keep their own observation paths and never hide inside
    /// an event payload or schedule key.
    fn external_effect(
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
        let node = self
            .nodes
            .get(&effect.node)
            .ok_or_else(|| self.fail(effect.node, "missing external effect anchor"))?;
        let event = match effect.verb {
            EffectVerb::Emit | EffectVerb::Schedule => match &effect.target {
                Some(EffectTarget::Event(event)) => Some(*event),
                _ => {
                    return Err(self.fail(effect.node, "external effect needs its event target"));
                }
            },
            EffectVerb::Cancel => None,
            _ => return Err(self.fail(effect.node, "unsupported external effect")),
        };
        if let Some(event) = event {
            let declaration = self
                .resolve
                .symbols
                .get(event.0 as usize)
                .ok_or_else(|| self.fail(effect.node, "missing external event declaration"))?;
            if !matches!(declaration.kind, super::resolve::SymbolKind::Event { .. })
                || declaration.module != module
            {
                return Err(self.fail(effect.node, "external effect needs its event target"));
            }
        }
        let expected_kind = match effect.verb {
            EffectVerb::Emit => SyntaxKind::Emit,
            EffectVerb::Schedule => SyntaxKind::Schedule,
            EffectVerb::Cancel => SyntaxKind::Cancel,
            _ => return Err(self.fail(effect.node, "unsupported external effect")),
        };
        if node.kind != expected_kind {
            return Err(self.fail(effect.node, "checked external effect mismatch"));
        }
        let mut keys = vec![effect.key, effect.at, effect.value];
        let mut paths = vec![ValuePath::default()];
        for key in keys.drain(..).flatten() {
            let values = self.expr(key, module, env, calls)?;
            if values
                .iter()
                .any(|value| value.record.is_some() || value.delivery.is_some())
            {
                return Err(self.fail(key, "opaque external effect input"));
            }
            paths = self.product(effect.node, &paths, &values)?;
        }
        for argument in &effect.args {
            let key = argument.value.unwrap_or(argument.key_node);
            let values = match argument.value {
                Some(value) => self.expr(value, module, env, calls)?,
                None => self.lexical(argument.key_node, module, env, calls)?,
            };
            if values.iter().any(|value| {
                value.record.is_some() || value.delivery.is_some() || value.members.is_some()
            }) {
                return Err(self.fail(key, "opaque external effect input"));
            }
            paths = self.product(effect.node, &paths, &values)?;
        }
        let kind = match effect.verb {
            EffectVerb::Emit => DisclosureEffectKind::Emit { event: event.unwrap() },
            EffectVerb::Schedule => DisclosureEffectKind::Schedule { event: event.unwrap() },
            _ => DisclosureEffectKind::Cancel {},
        };
        self.proof(effect, module, kind)?;
        Ok(paths)
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
            return Err(self.fail(effect.node, "call requires complete authored inputs"));
        }
        let mut slots = HashMap::new();
        for parameter in &child.params {
            let ty = self
                .types
                .symbol_types
                .get(&parameter.param)
                .ok_or_else(|| self.fail(effect.node, "missing child input type"))?;
            let eligible = match ty {
                ResolvedType::Scalar(scalar) => {
                    primitive_type(ty)
                        && self.explicit_scalar_call_parameter(parameter, &child, *scalar)
                }
                ResolvedType::Record { .. } | ResolvedType::Nullable(_) => {
                    self.explicit_model_call_parameter(parameter).is_some()
                        || self.explicit_nullable_value_call_parameter(parameter)
                }
                ResolvedType::Enum { .. } => self.explicit_enum_call_parameter(parameter),
                ty if ordinary_file_array(ty) => self.explicit_file_array_call_parameter(parameter),
                ty if matches!(ty, ResolvedType::Array { .. }) => {
                    self.explicit_array_call_parameter(parameter)
                }
                _ => false,
            };
            if !eligible {
                return Err(self.fail(
                    effect.node,
                    "child input needs explicit checked declaration",
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
            let parameter = child
                .params
                .iter()
                .find(|parameter| {
                    self.resolve
                        .symbols
                        .get(parameter.param.0 as usize)
                        .is_some_and(|declaration| declaration.name == argument.key)
                })
                .ok_or_else(|| self.fail(key, "missing checked child slot"))?;
            let model_slot = self.explicit_model_call_parameter(parameter);
            // A supplied non-null value fills a nullable value slot exactly;
            // stored-model nullables keep their own provenance rule above.
            // Anything else (including null or a mismatched scalar) still
            // refuses at the exact-type gate below.
            let supplied_type = match (model_slot, expected) {
                (Some((_, true)), ResolvedType::Nullable(inner)) => inner.as_ref(),
                (None, ResolvedType::Nullable(inner))
                    if !matches!(
                        inner.as_ref(),
                        ResolvedType::Record { stored: true, .. }
                    ) && self.types.node_types.get(&key) == Some(inner.as_ref()) =>
                {
                    inner.as_ref()
                }
                _ => expected,
            };
            if self.types.node_types.get(&key) != Some(supplied_type) {
                return Err(self.fail(key, "child input lacks exact checked supplied type"));
            }
            let values = if ordinary_file_array(expected) {
                self.call_file_array_operand(key, effect.node, module, calls)?
            } else {
                match argument.value {
                    Some(value) => self.expr(value, module, env, calls)?,
                    None => self.lexical(argument.key_node, module, env, calls)?,
                }
            };
            if let Some((model, nullable)) = model_slot {
                // Branch-nested calls keep the caller's original parameter
                // value: shadowing still resolves through the lexical
                // binding check below, and derived/call/loop positions stay
                // refused. Only the top-level statement requirement is
                // relaxed; the provenance proof is unchanged.
                if !calls.is_empty() || self.loop_node.is_some() || self.statement_depth < 1 {
                    return Err(self.fail(key, "model call input needs original root occurrence"));
                }
                for value in &values {
                    let original = if nullable {
                        matches!(value.reference_origin,
                            Some(ReferenceOrigin::Parent { parameter, model: actual, depth: 2 })
                            if actual == model && self.checked_call_parent_path(key, parameter, 0) == Some((model, 2)))
                    } else {
                        matches!(value.reference_origin,
                            Some(ReferenceOrigin::Parameter(parameter))
                            if self.original_call_model_parameter(key, effect.node, module) == Some((parameter, model)))
                            || matches!(value.model_result,
                                Some(DisclosureModelResult::Create { model: actual, node })
                                if actual == model && self.preceding_call_create(effect, module, key, model, node))
                            // One `param.parent` hop into the required slot:
                            // the base stays the caller's original required
                            // model parameter and the hop is the checked
                            // containment edge, never a copied row.
                            || matches!(value.reference_origin,
                                Some(ReferenceOrigin::Parent { parameter, model: actual, depth: 1 })
                                if actual == model && self.original_call_parent_parameter(key, effect.node, module) == Some((parameter, model)))
                    };
                    if !original
                        || value.record != Some(model)
                        || value.delivery.is_some()
                        || value.members.is_some()
                    {
                        return Err(self.fail(key, "model child input lacks original provenance"));
                    }
                }
            } else if values.iter().any(|value| {
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
            query_id: None,
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
            influences: merged.influences,
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
        // A contained-collection domain (`param.Child`) scans the caller's
        // original required model parameter through its checked containment
        // edge. Query filters stay declined: only the whole contained
        // collection in source order is disclosed here.
        let member_root = if node.kind == SyntaxKind::Member {
            if effect.cond.is_some() {
                return Err(self.fail(domain, "loop needs unfiltered member domain"));
            }
            Some(self.original_loop_member_root(domain, effect.node, module)?)
        } else {
            None
        };
        if node.kind != SyntaxKind::NameRef && member_root.is_none() {
            return Err(self.fail(domain, "loop needs direct admitted array input"));
        }
        let (model, parameter) = match member_root {
            Some((root, model)) => (model, root),
            None => {
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
                let Some(ResolvedType::Array { element, .. }) =
                    self.types.symbol_types.get(&parameter)
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
                (model, parameter)
            }
        };
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
            // A constant admitted scalar input is the same value on every
            // element and is counted once in the total observation bound
            // below. Branch decisions and model-reference intrinsics keep
            // their per-element refusal: only the loop item is an admitted
            // row inside the body.
            if !value.decisions.is_empty()
                || value.intrinsics.iter().any(|intrinsic| {
                    !matches!(
                        intrinsic.kind,
                        DisclosureIntrinsicKind::AdmittedInput { .. }
                    )
                })
            {
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
        let body_nodes: Vec<NodeKey> = effect.then_effects.iter().map(|child| child.node).collect();
        // Member domains scan the caller's contained collection rather than
        // a supplied array parameter; the root parameter owns the domain.
        let kind = if member_root.is_some() {
            DisclosureEffectKind::ForMember {
                domain,
                limit,
                maximum,
                item,
                parameter,
                model,
                body: body_nodes,
            }
        } else {
            DisclosureEffectKind::For {
                domain,
                limit,
                maximum,
                item,
                parameter,
                model,
                body: body_nodes,
            }
        };
        self.proof(effect, module, kind)?;
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
        let previous_expressions = self.statement_expressions.replace(Vec::new());
        let result = self.statements_inner(effects, module, flows, calls);
        self.statement_expressions = previous_expressions;
        self.statement_depth -= 1;
        result
    }

    /// Two adjacent original creates may retain the first row as their result.
    /// Team roots store its exact CreateAs; the established contained pair also
    /// retains its same-parent and checked-count obligations.
    fn checked_created_pair(&self, effects: &[Effect], module: ModuleId, created: &Effect) -> bool {
        let Some(model) = self.result_model else {
            return false;
        };
        let mut creates = effects
            .iter()
            .enumerate()
            .filter(|(_, effect)| effect.verb == EffectVerb::Create);
        let Some((index, first)) = creates.next() else {
            return false;
        };
        let Some((second_index, second)) = creates.next() else {
            return false;
        };
        if creates.next().is_some() || first.node != created.node || second_index != index + 1 {
            return false;
        }
        let Some(first) = self.checked_create_source(first, module) else {
            return false;
        };
        let Some(second) = self.checked_create_source(second, module) else {
            return false;
        };
        if first.model != model || second.model == model || first.binding == second.binding {
            return false;
        }
        let result_type = ResolvedType::Record {
            symbol: model,
            stored: true,
        };
        let mut result_inputs = second.inputs.iter().filter(|input| input.ty == result_type);
        let Some(result_input) = result_inputs.next() else {
            return false;
        };
        if result_inputs.next().is_some()
            || result_input.field.is_none()
            || !matches!(self.query_binding(result_input.value_node),
                Some(Binding::CreateAs {node}) if *node == first.node)
        {
            return false;
        }
        if first.definition.declaration.owner == ModelOwner::Team
            && second.definition.declaration.owner == ModelOwner::Team
        {
            return effects[..index].iter().all(|effect| {
                matches!(effect.verb, EffectVerb::Let | EffectVerb::Require)
                    || effect.verb == EffectVerb::If
                        && effect.match_arms.is_empty()
                        && effect
                            .then_effects
                            .iter()
                            .chain(&effect.else_effects)
                            .all(|nested| {
                                matches!(nested.verb, EffectVerb::Require | EffectVerb::Return)
                                    && nested.then_effects.is_empty()
                                    && nested.else_effects.is_empty()
                                    && nested.match_arms.is_empty()
                            })
            });
        }
        let ModelOwner::ChildOf(parent) = first.definition.declaration.owner else {
            return false;
        };
        if first.model != model
            || second.model == model
            || first.binding == second.binding
            || second.definition.declaration.owner != ModelOwner::ChildOf(parent)
        {
            return false;
        }
        let Some(first_parent) = first.inputs.iter().find(|input| input.name == "parent") else {
            return false;
        };
        let Some(second_parent) = second.inputs.iter().find(|input| input.name == "parent") else {
            return false;
        };
        let Some(Binding::Symbol(parameter)) = self.query_binding(first_parent.value_node) else {
            return false;
        };
        if self.checked_call_parent_path(first_parent.value_node, *parameter, 0)
            != Some((parent, 0))
            || self.checked_call_parent_path(second_parent.value_node, *parameter, 0)
                != Some((parent, 0))
        {
            return false;
        }
        if effects[..index]
            .iter()
            .any(|effect| !matches!(effect.verb, EffectVerb::Let | EffectVerb::Require))
        {
            return false;
        }
        self.effects.scenarios.values().any(|scenario| {
            scenario.module == module
                && scenario
                    .effects
                    .iter()
                    .any(|effect| effect.node == first.node)
                && scenario
                    .effects
                    .iter()
                    .any(|effect| effect.node == second.node)
                && self
                    .checked_count_query_sources(scenario)
                    .is_some_and(|queries| {
                        queries.iter().any(|query| {
                            let Some(count) = &query.count else {
                                return false;
                            };
                            query.model == second.model
                                && count.statement == second.node
                                && count
                                    .contained_parent
                                    .is_some_and(|(_, actual)| actual == *parameter)
                                && second.inputs.iter().any(|input| {
                                    let Some((counted, increment)) =
                                        self.query_binary(input.value_node, "+")
                                    else {
                                        return false;
                                    };
                                    input.field.is_some()
                                        && input.ty == ResolvedType::Scalar(Scalar::Int)
                                        && self.query_group(counted) == Some(count.call)
                                        && self.query_group(increment).is_some_and(|increment| {
                                            self.nodes.get(&increment).is_some_and(|node| {
                                                node.kind == SyntaxKind::Literal
                                                    && self.types.node_types.get(&increment)
                                                        == Some(&ResolvedType::Scalar(Scalar::Int))
                                                    && self.db.get(increment.file).and_then(
                                                        |source| {
                                                            source.text.get(
                                                                increment.start as usize
                                                                    ..increment.end as usize,
                                                            )
                                                        },
                                                    ) == Some("1")
                                            })
                                        })
                                })
                        })
                    })
        })
    }

    fn statements_inner(
        &mut self,
        effects: &[Effect],
        module: ModuleId,
        mut flows: Vec<Flow>,
        calls: &[NodeKey],
    ) -> Result<(Vec<Flow>, Vec<DisclosureReturn>), DisclosureDecline> {
        // Void scenarios return no row, so no create/return profile applies;
        // their creates are still individually disclosed below, in order.
        if self.result_model.is_some()
            && let Some(created) = effects
                .iter()
                .find(|effect| effect.verb == EffectVerb::Create)
        {
            let created_pair = self.checked_created_pair(effects, module, created);
            // Branch contents still pass the ordinary ordered Flow proof:
            // only the actual surviving path reaches this final created row.
            let before_direct_create =
                |effect: &Effect| {
                    matches!(effect.verb, EffectVerb::Let | EffectVerb::Require)
                        || effect.verb == EffectVerb::If
                            && effect.match_arms.is_empty()
                            && effect.then_effects.iter().chain(&effect.else_effects).all(
                                |nested| {
                                    matches!(nested.verb, EffectVerb::Require | EffectVerb::Return)
                                        && nested.then_effects.is_empty()
                                        && nested.else_effects.is_empty()
                                        && nested.match_arms.is_empty()
                                },
                            )
                };
            let direct_model_return = self.result_model.is_some_and(|model| {
                effects.len() >= 2
                    && ((!created_pair && effects.iter().position(|effect| effect.node == created.node).is_some_and(|position| {
                            position + 1 < effects.len()
                                && effects[..position].iter().all(before_direct_create)
                                && effects[position + 1..effects.len() - 1].iter().all(|effect| effect.verb == EffectVerb::Require)
                        }))
                        || (created_pair && effects.len() >= 3
                            && (effects.get(effects.len() - 3).map(|effect| effect.node) == Some(created.node)
                                || effects.iter().position(|effect| effect.node == created.node).is_some_and(|position|
                                    position + 2 < effects.len()
                                        && effects[position + 2..effects.len() - 1].iter().all(|effect| effect.verb == EffectVerb::Require)))))
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
                    && effects.iter().all(|effect| effect.verb == EffectVerb::If
                        || effect.then_effects.is_empty()
                            && effect.else_effects.is_empty() && effect.match_arms.is_empty())
            });
            let created_child_return = self.result_model.is_some_and(|model| {
                if effects.len() < 3
                    || effects.get(effects.len() - 3).map(|effect| effect.node)
                        != Some(created.node)
                    || effects[..effects.len() - 3]
                        .iter()
                        .any(|effect| !matches!(effect.verb, EffectVerb::Let | EffectVerb::Require))
                    || effects.iter().any(|effect| {
                        !effect.then_effects.is_empty()
                            || !effect.else_effects.is_empty()
                            || !effect.match_arms.is_empty()
                    })
                {
                    return false;
                }
                let called = &effects[effects.len() - 2];
                let returned = &effects[effects.len() - 1];
                let Some(EffectTarget::Operation(operation)) = &called.target else {
                    return false;
                };
                let Some(EffectTarget::Model(created_model)) = created.target else {
                    return false;
                };
                called.verb == EffectVerb::Call
                    && called.binding.is_some()
                    && self.complete_model_children.get(operation) == Some(&model)
                    && called.args.iter().any(|argument| {
                        let key = argument.value.unwrap_or(argument.key_node);
                        matches!(self.query_binding(key), Some(Binding::CreateAs {node})
                            if *node == created.node)
                            && self.types.node_types.get(&key)
                                == Some(&ResolvedType::Record {
                                    symbol: created_model,
                                    stored: true,
                                })
                    })
                    && returned.verb == EffectVerb::Return
                    && returned.value.is_some_and(|key| {
                        matches!(self.query_binding(key), Some(Binding::CallAs {node})
                            if *node == called.node)
                            && self.query_group(key).is_some_and(|key| {
                                self.types.node_types.get(&key)
                                    == Some(&ResolvedType::Record {
                                        symbol: model,
                                        stored: true,
                                    })
                            })
                    })
            });
            let created_send_return = self.result_model.is_some_and(|model| {
                let Some(index) = effects
                    .iter()
                    .position(|effect| effect.node == created.node)
                else {
                    return false;
                };
                let tail = &effects[index + 1 + usize::from(created_pair)..];
                if tail.len() < 4
                    || effects[..index]
                        .iter()
                        .any(|effect| !matches!(effect.verb, EffectVerb::Let | EffectVerb::Require))
                    || !matches!(created.target, Some(EffectTarget::Model(actual)) if actual == model)
                    || created.binding.is_none()
                    || tail[0].verb != EffectVerb::Set
                    || tail[1].verb != EffectVerb::Send
                    || tail[1].when.is_none()
                    || tail[1].binding.is_none()
                    || tail[2].verb != EffectVerb::Set
                    || !matches!(tail[2].target, Some(EffectTarget::Record {model: Some(actual)}) if actual == model)
                    || tail[3..tail.len() - 1]
                        .iter()
                        .any(|effect| effect.verb != EffectVerb::Require)
                    || effects.iter().any(|effect| {
                        !effect.then_effects.is_empty()
                            || !effect.else_effects.is_empty()
                            || !effect.match_arms.is_empty()
                    })
                {
                    return false;
                }
                let sent = &tail[1];
                let assigned = &tail[2];
                let receiver = self.nodes.get(&assigned.node).and_then(|node| {
                    node.children
                        .iter()
                        .find(|child| child.kind == SyntaxKind::Path)
                });
                let returned = &tail[tail.len() - 1];
                receiver.is_some_and(|receiver| {
                    matches!(self.query_binding(NodeKey::of(receiver)),
                        Some(Binding::CreateAs {node}) if *node == created.node)
                })
                    && assigned.args.iter().any(|argument| {
                        let key = argument.value.unwrap_or(argument.key_node);
                        matches!(self.query_binding(key),
                            Some(Binding::SendAs {node}) if *node == sent.node)
                            && self.query_group(key).is_some_and(|key| {
                                matches!(self.types.node_types.get(&key),
                                    Some(ResolvedType::StdDelivery { .. }))
                            })
                    })
                    && returned.verb == EffectVerb::Return
                    && returned.value.is_some_and(|key| {
                        matches!(self.query_binding(key),
                            Some(Binding::CreateAs {node}) if *node == created.node)
                            && self.query_group(key).is_some_and(|key| {
                                self.types.node_types.get(&key)
                                    == Some(&ResolvedType::Record {
                                        symbol: model,
                                        stored: true,
                                    })
                            })
                    })
            });
            if !direct_model_return && !created_child_return && !created_send_return {
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
            if let Some(entries) = &mut self.statement_expressions {
                entries.clear();
            }
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
                                evaluated.model_result,
                                Some(DisclosureModelResult::Reference { .. })
                            ) {
                                return Err(self.fail(
                                    value,
                                    "stored Model reference result cannot be copied",
                                ));
                            }
                            if matches!(
                                evaluated.reference_origin,
                                Some(
                                    ReferenceOrigin::Parent { .. } | ReferenceOrigin::Field { .. }
                                )
                            ) && !evaluated.current_revision.is_some_and(|binding| {
                                binding == effect.node
                                    && self.current_revision_at(value, module).is_some_and(|fact| {
                                        fact.binding == effect.node
                                            && self.query_group(value) == Some(fact.value)
                                    })
                            }) {
                                return Err(
                                    self.fail(value, "stored reference operand cannot be copied")
                                );
                            }
                            if evaluated.record.is_some()
                                && matches!(
                                    evaluated.reference_origin,
                                    Some(ReferenceOrigin::ParameterMember { .. })
                                )
                            {
                                return Err(self
                                    .fail(value, "original input Model member cannot be copied"));
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
                            if value.transcript_count {
                                // The exact eager transcript cardinality guard
                                // controls this scalar sink as well as effects.
                                path.controls.join(&self.control(ValuePath {
                                    reads: value.reads.clone(),
                                    influences: value.influences.clone(),
                                    ..ValuePath::default()
                                })?);
                            }
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
                                                || self.current_revision_control(dependency, module)
                                                || self
                                                    .contract_input_stored_read(dependency, module)
                                                || self.run_unfinished_control(dependency, module)
                                                || dependency.field_name == "active"
                                                    && self
                                                        .checked_profile_scalar(
                                                            dependency.node,
                                                            module,
                                                        )
                                                        .is_some_and(|(_, _, _, profile, field)| {
                                                            dependency.model == profile
                                                                && dependency.field == field
                                                                && dependency.calls.is_empty()
                                                        })
                                        })
                                        .cloned()
                                        .collect(),
                                    ..ValuePath::default()
                                })?,
                            );
                            let admitted_guard = self.control(ValuePath {
                                intrinsics: value.intrinsics.clone(),
                                influences: value.influences.clone(),
                                // Whole canonical Contract/reference-field
                                // authority belongs to the successful guard,
                                // including void/effect returns. Keep existing
                                // ordinary scalar authorization pruning.
                                reads: value.reads.iter().filter(|dependency| {
                                    matches!(&dependency.ty, ResolvedType::Record {symbol,..}
                                        if self.resolve.symbols.get(symbol.0 as usize)
                                            .is_some_and(|symbol| matches!(symbol.kind, SymbolKind::Contract { .. })))
                                        || self.reference_operand_type_id(&dependency.ty).is_some()
                                        || self.current_revision_control(dependency,module)
                                        || self.contract_input_stored_read(dependency,module)
                                        || self.run_unfinished_control(dependency,module)
                                        || dependency.field_name == "active" && self.checked_profile_scalar(dependency.node,module).is_some_and(|(_,_,_,profile,field)| {
                                            dependency.model == profile && dependency.field == field && dependency.calls.is_empty()
                                        })
                                        || !value.influences.is_empty()
                                }).cloned().collect(),
                                ..ValuePath::default()
                            })?;
                            // Preserve the existing canonical whole-field read even
                            // when an independent return prunes the guard lane.
                            // Emission observes it only at this authored Member.
                            let mut execution_reads = value.reads.clone();
                            for (node, calls) in &value.observed {
                                if let Some(read) =
                                    self.require_observed_stored_read(*node, calls, module)
                                {
                                    if !execution_reads.iter().any(|prior| {
                                        prior.node == read.node
                                            && prior.calls == read.calls
                                            && prior.model == read.model
                                            && prior.field == read.field
                                    }) {
                                        execution_reads.push(read);
                                    }
                                }
                            }
                            let dependencies = self.control(ValuePath {
                                reads: execution_reads.iter().filter(|read| {
                                    matches!(&read.ty, ResolvedType::Record {symbol, ..}
                                        if self.resolve.symbols.get(symbol.0 as usize)
                                            .is_some_and(|symbol| matches!(symbol.kind, SymbolKind::Contract { .. })))
                                        || self.first_query_stored_require_read(read, module)
                                }).cloned().collect(),
                                ..ValuePath::default()
                            })?.reads;
                            if !dependencies.is_empty() {
                                let index =
                                    match self.require_consumptions.iter().position(|entry| {
                                        entry.statement == effect.node && entry.condition == cond
                                    }) {
                                        Some(index) => index,
                                        None => {
                                            if self.require_consumptions.len() >= 200 {
                                                return Err(self.fail(
                                                    effect.node,
                                                    "require consumption bound",
                                                ));
                                            }
                                            self.require_consumptions.push(
                                                CheckedRequireConsumption {
                                                    statement: effect.node,
                                                    condition: cond,
                                                    dependencies: Vec::new(),
                                                },
                                            );
                                            self.require_consumptions.len() - 1
                                        }
                                    };
                                for dependency in dependencies {
                                    let entry = &self.require_consumptions[index];
                                    if let Some(previous) = entry
                                        .dependencies
                                        .iter()
                                        .find(|read| read.id == dependency.id)
                                    {
                                        if previous != &dependency {
                                            return Err(self.fail(
                                                effect.node,
                                                "conflicting require consumption",
                                            ));
                                        }
                                    } else {
                                        if self
                                            .require_consumptions
                                            .iter()
                                            .map(|entry| entry.dependencies.len())
                                            .sum::<usize>()
                                            >= 200
                                        {
                                            return Err(self.fail(
                                                effect.node,
                                                "require consumption dependency bound",
                                            ));
                                        }
                                        self.require_consumptions[index]
                                            .dependencies
                                            .push(dependency);
                                    }
                                }
                            }
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
                        for mut value in values {
                            if let Some(model) = self.result_model {
                                let direct = effect.value.and_then(|key| self.query_binding(key));
                                if let Some(ReferenceOrigin::ParameterMember { parameter, node }) =
                                    value.reference_origin
                                    && value.record == Some(model)
                                    && calls.is_empty()
                                    && self.loop_node.is_none()
                                    && effect.value.and_then(|key| self.query_group(key))
                                        == Some(node)
                                    && self
                                        .checked_contract_input_reference(node, module)
                                        .is_some_and(|(root, target, _)| {
                                            root == parameter && target == model
                                        })
                                {
                                    let owner =
                                        self.resolve.symbols.get(model.0 as usize).ok_or_else(
                                            || self.fail(node, "missing input result model"),
                                        )?;
                                    let SymbolKind::Model { fields, .. } = &owner.kind else {
                                        return Err(
                                            self.fail(node, "input result needs stored Model")
                                        );
                                    };
                                    if fields.iter().any(|field| {
                                        self.resolve
                                            .symbols
                                            .get(field.0 as usize)
                                            .is_none_or(|field| field.name == "id")
                                    }) {
                                        return Err(
                                            self.fail(node, "input result identity is reserved")
                                        );
                                    }
                                    value.reads.push(DisclosureDependency {
                                        query_id: None,
                                        id: self.opaque(
                                            "read-data",
                                            node,
                                            &self.call_stamp(calls)?,
                                        )?,
                                        source: self.source(module, node)?,
                                        node,
                                        calls: calls.to_vec(),
                                        role: DependencyRole::Data,
                                        model,
                                        field: model,
                                        model_name: owner.canonical.clone(),
                                        field_name: "id".into(),
                                        ty: ResolvedType::Scalar(Scalar::Text),
                                        type_id: "text".into(),
                                    });
                                    value.observed.push((node, calls.to_vec()));
                                    value.model_result = Some(DisclosureModelResult::Parameter {
                                        model,
                                        parameter,
                                        node,
                                    });
                                }
                                if let (
                                    Some(Binding::Symbol(parameter)),
                                    Some(ReferenceOrigin::Parameter(origin)),
                                ) = (direct, value.reference_origin)
                                    && *parameter == origin
                                    && value.record == Some(model)
                                    && calls.is_empty()
                                    && self.loop_node.is_none()
                                {
                                    let operand = self
                                        .query_group(effect.value.unwrap())
                                        .ok_or_else(|| {
                                            self.fail(effect.node, "missing model return operand")
                                        })?;
                                    let scenario = self
                                        .effects
                                        .scenarios
                                        .values()
                                        .find(|scenario| {
                                            scenario.module == module
                                                && scenario.node.file == effect.node.file
                                                && scenario.node.start <= effect.node.start
                                                && effect.node.end <= scenario.node.end
                                        })
                                        .ok_or_else(|| {
                                            self.fail(effect.node, "missing model return owner")
                                        })?;
                                    let param = scenario
                                        .params
                                        .iter()
                                        .find(|param| param.param == origin)
                                        .ok_or_else(|| {
                                            self.fail(operand, "missing model return parameter")
                                        })?;
                                    let owner = self
                                        .resolve
                                        .symbols
                                        .get(model.0 as usize)
                                        .ok_or_else(|| {
                                            self.fail(operand, "missing model return declaration")
                                        })?;
                                    let SymbolKind::Model { fields, .. } = &owner.kind else {
                                        return Err(self.fail(
                                            operand,
                                            "model return needs a stored declaration",
                                        ));
                                    };
                                    if scenario.read
                                        || scenario.on.is_some()
                                        || owner.module != module
                                        || param.default.is_some()
                                        || self
                                            .nodes
                                            .get(&operand)
                                            .is_none_or(|node| node.kind != SyntaxKind::NameRef)
                                        || self.checked_call_parent_path(operand, origin, 0)
                                            != Some((model, 0))
                                        || fields.iter().any(|field| {
                                            self.resolve
                                                .symbols
                                                .get(field.0 as usize)
                                                .is_none_or(|field| field.name == "id")
                                        })
                                    {
                                        return Err(self.fail(
                                            operand,
                                            "model return parameter source correspondence",
                                        ));
                                    }
                                    value.reads.push(DisclosureDependency {
                                        query_id: None,
                                        id: self.opaque(
                                            "read-data",
                                            operand,
                                            &self.call_stamp(calls)?,
                                        )?,
                                        source: self.source(module, operand)?,
                                        node: operand,
                                        calls: calls.to_vec(),
                                        role: DependencyRole::Data,
                                        model,
                                        field: model,
                                        model_name: owner.canonical.clone(),
                                        field_name: "id".into(),
                                        ty: ResolvedType::Scalar(Scalar::Text),
                                        type_id: "text".into(),
                                    });
                                    value.observed.push((operand, calls.to_vec()));
                                    value.model_result = Some(DisclosureModelResult::Parameter {
                                        model,
                                        parameter: origin,
                                        node: operand,
                                    });
                                }
                                if let Some(DisclosureModelResult::Reference {
                                    model: target,
                                    node: operand,
                                    source_model,
                                    field,
                                }) = value.model_result
                                {
                                    let owner = self
                                        .resolve
                                        .symbols
                                        .get(target.0 as usize)
                                        .ok_or_else(|| {
                                            self.fail(operand, "missing reference result target")
                                        })?;
                                    if target != model
                                        || value.record != Some(target)
                                        || effect.value.and_then(|key| self.query_group(key))
                                            != Some(operand)
                                        || self
                                            .nodes
                                            .get(&operand)
                                            .is_none_or(|node| node.kind != SyntaxKind::Member)
                                        || self.types.node_types.get(&operand)
                                            != Some(&ResolvedType::Record {
                                                symbol: target,
                                                stored: true,
                                            })
                                        || !value.reads.iter().any(|read| {
                                            read.node == operand
                                                && read.role == DependencyRole::Data
                                                && read.model == source_model
                                                && read.field == field
                                                && read.ty
                                                    == (ResolvedType::Record {
                                                        symbol: target,
                                                        stored: true,
                                                    })
                                                && read.calls.is_empty()
                                                && read.query_id.is_none()
                                        })
                                        || !matches!(owner.kind, SymbolKind::Model { .. })
                                    {
                                        return Err(self.fail(operand, "direct required reference result source correspondence"));
                                    }
                                    value.reads.push(DisclosureDependency {
                                        query_id: None,
                                        id: self.opaque(
                                            "return-model-id",
                                            operand,
                                            &self.call_stamp(calls)?,
                                        )?,
                                        source: self.source(module, operand)?,
                                        node: operand,
                                        calls: calls.to_vec(),
                                        role: DependencyRole::Data,
                                        model: target,
                                        field: target,
                                        model_name: owner.canonical.clone(),
                                        field_name: "id".into(),
                                        ty: ResolvedType::Scalar(Scalar::Text),
                                        type_id: "text".into(),
                                    });
                                    value.observed.push((operand, calls.to_vec()));
                                }
                                let matches = match (direct, value.model_result) {
                                    (
                                        _,
                                        Some(DisclosureModelResult::Parameter {
                                            model: actual,
                                            parameter,
                                            node,
                                        }),
                                    ) if effect.value.and_then(|key| self.query_group(key))
                                        == Some(node)
                                        && self
                                            .checked_contract_input_reference(node, module)
                                            .is_some_and(|(root, target, _)| {
                                                root == parameter && target == model
                                            }) =>
                                    {
                                        actual == model
                                    }
                                    (
                                        Some(Binding::Symbol(parameter)),
                                        Some(DisclosureModelResult::Parameter {
                                            model: actual,
                                            parameter: original,
                                            ..
                                        }),
                                    ) => *parameter == original && model == actual,
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
                                    (
                                        _,
                                        Some(DisclosureModelResult::Reference {
                                            model: actual,
                                            node,
                                            ..
                                        }),
                                    ) => {
                                        model == actual
                                            && effect.value.and_then(|key| self.query_group(key))
                                                == Some(node)
                                    }
                                    // Finite first-query slice D (CAN18-v1):
                                    // whole-row idempotent replay
                                    // (`if previous!=null ... return previous`
                                    // alongside a same-model create) for one
                                    // unscoped single-Text-equality
                                    // id-ordered family. All other Let returns
                                    // (including bare absence and direct
                                    // returns) stay refused below.
                                    (
                                        Some(Binding::Let { node: let_node }),
                                        None,
                                    ) if value.record == Some(model)
                                        && value.first_query.is_some()
                                        && value.influences.len() == 4 =>
                                    {
                                        self.effects
                                            .scenarios
                                            .values()
                                            .find(|scenario| {
                                                scenario.module == module
                                                    && scenario.node.file
                                                        == effect.node.file
                                                    && scenario.node.start
                                                        <= effect.node.start
                                                    && effect.node.end
                                                        <= scenario.node.end
                                            })
                                            .is_some_and(|scenario| {
                                            let Some(let_effect) = scenario
                                                .effects
                                                .iter()
                                                .find(|binding| {
                                                    binding.verb
                                                        == EffectVerb::Let
                                                        && binding.node
                                                            == *let_node
                                                })
                                            else {
                                                return false;
                                            };
                                            let Some(query) = self
                                                .checked_first_query_source(
                                                    scenario,
                                                    let_effect,
                                                )
                                            else {
                                                return false;
                                            };
                                            let Some(first) = query.first.as_ref()
                                            else {
                                                return false;
                                            };
                                            query.model == model
                                                && first.contained_parent.is_none()
                                                && first.binding == *let_node
                                                && value.first_query.is_some_and(
                                                    |(call, binding)| {
                                                        call == first.call
                                                            && binding
                                                                == first.binding
                                                    },
                                                )
                                                && query.dependencies.len()
                                                    == 1
                                                && query.dependencies[0].role
                                                    == DependencyRole::Control
                                                && query.dependencies[0].model
                                                    == model
                                                && query.dependencies[0].type_id
                                                    == "text"
                                                && query.dependencies[0].ty
                                                    == ResolvedType::Scalar(
                                                        Scalar::Text,
                                                    )
                                                && query.inputs.len() == 1
                                                && !query.archived
                                                && query.limit.is_none()
                                                && query.projection.is_none()
                                                && query
                                                    .cardinality_guard
                                                    .is_none()
                                                && query.count.is_none()
                                                && query.order.len() == 1
                                                && query.order[0].field.is_none()
                                                && query.order[0].field_name
                                                    == "id"
                                                && !query.order[0].descending
                                        })
                                    }
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
                    EffectVerb::Emit | EffectVerb::Schedule | EffectVerb::Cancel => {
                        let alternatives = self.external_effect(effect, module, &flow.env, calls)?;
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
                            next.push(path);
                            if next.len() > 1024 {
                                return Err(self.fail(effect.node, "effect evaluation path bound"));
                            }
                        }
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

fn ordinary_file_array(ty: &ResolvedType) -> bool {
    matches!(ty, ResolvedType::Array { element, ordered: true, nonempty: false }
        if element.as_ref() == &ResolvedType::Scalar(Scalar::File))
}

/// Email joins the disclosed primitives: stored email fields are ordinary
/// checked scalars with a String MCP mapping and a Values wire codec, and
/// native dispatch (row 10) must seal record email inputs such as a mail
/// recipient. Other unlisted scalars keep failing closed; each needs its own
/// probe before admission.
fn primitive_type(ty: &ResolvedType) -> bool {
    matches!(
        ty,
        ResolvedType::Scalar(
            Scalar::Int
                | Scalar::Text
                | Scalar::Email
                | Scalar::Bool
                | Scalar::Decimal
                | Scalar::Money
                | Scalar::Date
                | Scalar::Datetime
                | Scalar::Duration
                | Scalar::Currency
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

fn transcript_message_array(ty: &ResolvedType) -> bool {
    matches!(ty,ResolvedType::Array {element,ordered:true,..}
        if checked_standard_nominal_name(element)==Some("TextMessage"))
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
        let original = include_str!("../../../draft/apps/CanWorkbench/CanWorkbench.can");
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
        let projection = query.projection.as_ref().unwrap();
        assert_eq!(projection.fields.len(), 7);
        assert!(matches!(
            projection.fields[0].mapping,
            CheckedQueryProjectionMapping::StoredReference
        ));
        assert!(matches!(
            projection.fields[1].mapping,
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
    #[test]
    fn original_regenerate_authorization_seals_both_parent_hops() {
        use super::super::catalog::{CatalogRequest, load_catalog};
        let source = include_str!("../../tests/fixtures/original-a850/CanChat.can");
        let mut db = SourceDb::new();
        let file = db.add("CanChat.can".into(), source.into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/cloudflare/dist/native-catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: crate::source::Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = super::super::check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (tree, diagnostics) = crate::syntax::parse(&db, file);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let trees = [(file, tree)];
        let mut diagnostics = Vec::new();
        let resolve =
            super::super::resolve::resolve_program(&db, &trees, Some(&catalog), &mut diagnostics);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert_eq!(
            resolve
                .symbols
                .iter()
                .map(|symbol| (symbol.id, &symbol.canonical, symbol.span))
                .collect::<Vec<_>>(),
            program
                .symbols
                .iter()
                .map(|symbol| (symbol.id, &symbol.canonical, symbol.span))
                .collect::<Vec<_>>()
        );
        let owner = resolve.by_canonical["chat.regenerate"];
        let derive = resolve.by_canonical["chat.can_use"];
        let scenario = &program.effects.scenarios[&owner];
        let (call, selected) = program
            .types
            .selected_calls
            .iter()
            .find(|(key, call)| {
                scenario.node.start <= key.start
                    && key.end <= scenario.node.end
                    && matches!(call.target, SelectedCallTarget::DeriveFn(id) if id == derive)
                    && call.arguments.len() == 2
                    && &source[call.arguments[1].start as usize..call.arguments[1].end as usize]
                        == "turn.parent.parent"
            })
            .unwrap();
        let call = *call;
        let actor = selected.arguments[0];
        let parent = selected.arguments[1];
        let intermediate = program
            .types
            .node_types
            .keys()
            .find(|key| {
                key.file == parent.file
                    && key.start == parent.start
                    && key.end < parent.end
                    && key.kind == SyntaxKind::Member as u8
                    && &source[key.start as usize..key.end as usize] == "turn.parent"
            })
            .copied()
            .unwrap();
        let body = program.effects.derives[&derive].expr.unwrap();
        let mut nodes = HashMap::new();
        let mut pending = vec![&trees[0].1];
        while let Some(node) = pending.pop() {
            nodes.insert(NodeKey::of(node), node);
            pending.extend(node.children.iter());
        }
        let check = |types: &TypeTable, resolved: &ResolveTables, effects: &EffectTables| {
            let cx = Closure {
                catalog: Some(&catalog),
                db: &db,
                resolve: resolved,
                types,
                effects,
                nodes: nodes.clone(),
                stack: HashSet::new(),
                steps: 0,
                depth: 0,
                statement_depth: 0,
                authorization: false,
                effect_proofs: Vec::new(),
                require_consumptions: Vec::new(),
                effect_visits: 0,
                loop_node: None,
                complete_children: HashSet::new(),
                complete_model_children: HashMap::new(),
                result_model: None,
                statement_expressions: None,
                source_facts: RefCell::new(ImmutableSourceFacts::default()),
            };
            cx.checked_authorization_derive(call, scenario.module)
        };
        let (actual_derive, model, actual_parent, _) =
            check(&program.types, &resolve, &program.effects)
                .expect("original two-hop authorization");
        assert_eq!(actual_derive, derive);
        assert_eq!(actual_parent, parent);
        assert_eq!(
            program.types.node_types[&parent],
            ResolvedType::Record {
                symbol: model,
                stored: true
            }
        );
        let proof = &program.scenario_disclosures()[&owner];
        let facts = proof.source_facts().unwrap();
        assert!(
            facts
                .expression_types
                .as_deref()
                .unwrap()
                .iter()
                .any(|(at, ty)| *at == body && *ty == ResolvedType::Scalar(Scalar::Bool))
        );
        if let ScenarioDisclosure::Declined(decline) = proof {
            assert_ne!(
                decline.node, actor,
                "this finite source unit must advance past actor; the inline prefix remains independent"
            );
        }
        // The next original guard must consume the genuine Run model,
        // rather than trying to reinterpret Turn.run as a Contract.
        let unfinished = program
            .types
            .node_types
            .keys()
            .find(|key| {
                key.file == scenario.node.file
                    && scenario.node.start <= key.start
                    && key.end <= scenario.node.end
                    && key.kind == SyntaxKind::Member as u8
                    && source[key.start as usize..key.end as usize].trim() == "turn.run.unfinished"
            })
            .copied()
            .unwrap();
        let reference = nodes[&unfinished]
            .children
            .iter()
            .find(|node| expression(node.kind))
            .map(NodeKey::of)
            .unwrap();
        let receiver = nodes[&reference]
            .children
            .iter()
            .find(|node| expression(node.kind))
            .map(NodeKey::of)
            .unwrap();
        let unary = nodes
            .values()
            .find(|node| {
                node.kind == SyntaxKind::Unary
                    && node
                        .children
                        .iter()
                        .any(|child| NodeKey::of(child) == unfinished)
            })
            .map(|node| NodeKey::of(node))
            .unwrap();
        let Some(Binding::Symbol(parameter)) = resolve.node_binding.get(&receiver) else {
            panic!("original Turn parameter");
        };
        let parameter = *parameter;
        let turn = resolve.by_canonical["chat.Turn"];
        let run = resolve.by_canonical["chat.Run"];
        let reference_field = resolve.by_canonical["chat.Turn.run"];
        let scalar_field = resolve.by_canonical["chat.Run.unfinished"];
        fn make_run_cx<'a>(
            catalog: &'a Catalog,
            db: &'a SourceDb,
            nodes: &HashMap<NodeKey, &'a SyntaxNode>,
            types: &'a TypeTable,
            resolved: &'a ResolveTables,
            effects: &'a EffectTables,
        ) -> Closure<'a> {
            Closure {
                catalog: Some(catalog),
                db,
                resolve: resolved,
                types,
                effects,
                nodes: nodes.clone(),
                stack: HashSet::new(),
                steps: 0,
                depth: 0,
                statement_depth: 0,
                authorization: false,
                effect_proofs: Vec::new(),
                require_consumptions: Vec::new(),
                effect_visits: 0,
                loop_node: None,
                complete_children: HashSet::new(),
                complete_model_children: HashMap::new(),
                result_model: None,
                statement_expressions: None,
                source_facts: RefCell::new(ImmutableSourceFacts::default()),
            }
        }
        let mut run_cx = make_run_cx(
            &catalog,
            &db,
            &nodes,
            &program.types,
            &resolve,
            &program.effects,
        );
        assert_eq!(
            run_cx.checked_run_reference(reference, scenario.module),
            Some((parameter, turn, reference_field, run))
        );
        assert_eq!(
            run_cx.checked_run_unfinished(unfinished, scenario.module),
            Some((parameter, turn, reference_field, run, scalar_field))
        );
        let mut env = Env::new();
        env.insert(
            Local::Symbol(parameter),
            ValuePath {
                record: Some(turn),
                reference_origin: Some(ReferenceOrigin::Parameter(parameter)),
                reference: Some(DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter,
                    parameter_name: "turn".into(),
                    model: turn,
                    model_name: "chat.Turn".into(),
                }),
                ..ValuePath::default()
            },
        );
        let values = run_cx
            .authorization_expr(unary, scenario.module, &env, &[])
            .unwrap();
        assert_eq!(values.len(), 1);
        let controlled = run_cx.control(values.into_iter().next().unwrap()).unwrap();
        assert_eq!(controlled.reads.len(), 2);
        let reference_read = &controlled.reads[0];
        let scalar_read = &controlled.reads[1];
        assert_eq!(
            (
                reference_read.node,
                reference_read.model,
                reference_read.field,
                reference_read.field_name.as_str()
            ),
            (reference, turn, reference_field, "run")
        );
        assert_eq!(
            (
                scalar_read.node,
                scalar_read.model,
                scalar_read.field,
                scalar_read.field_name.as_str()
            ),
            (unfinished, run, scalar_field, "unfinished")
        );
        assert_ne!(reference_read.id, scalar_read.id);
        assert_eq!(
            reference_read.ty,
            ResolvedType::Record {
                symbol: run,
                stored: true
            }
        );
        assert_eq!(scalar_read.ty, ResolvedType::Scalar(Scalar::Bool));
        assert!(
            controlled
                .reads
                .iter()
                .all(|read| read.role == DependencyRole::Control
                    && read.calls.is_empty()
                    && read.query_id.is_none()
                    && read.source == facts.source)
        );
        assert!(
            facts
                .stored_contracts
                .as_deref()
                .unwrap()
                .iter()
                .any(|schema| schema.id == run && schema.model)
        );
        if let ScenarioDisclosure::Declined(decline) = proof {
            assert_ne!(
                decline.node, reference,
                "the original unfinished guard must advance past Turn.run"
            );
            assert_ne!(
                decline.node, unfinished,
                "the original unfinished scalar must retain both controls"
            );
        }
        for mode in [
            "run-field-type",
            "leaf-type",
            "default-field",
            "server-field",
            "default-param",
            "foreign-binding",
            "foreign-parent",
            "field-name",
        ] {
            let mut types = program.types.clone();
            let mut resolved = resolve.clone();
            let mut effects = program.effects.clone();
            match mode {
                "run-field-type" => {
                    let ty = types.symbol_types[&reference_field].clone();
                    types
                        .symbol_types
                        .insert(reference_field, ResolvedType::Nullable(Box::new(ty)));
                }
                "leaf-type" => {
                    types
                        .symbol_types
                        .insert(scalar_field, ResolvedType::Scalar(Scalar::Text));
                }
                "default-field" => {
                    effects
                        .models
                        .get_mut(&turn)
                        .unwrap()
                        .fields
                        .iter_mut()
                        .find(|field| field.field == reference_field)
                        .unwrap()
                        .default = Some(receiver)
                }
                "server-field" => {
                    effects
                        .models
                        .get_mut(&turn)
                        .unwrap()
                        .fields
                        .iter_mut()
                        .find(|field| field.field == reference_field)
                        .unwrap()
                        .server = Some(receiver)
                }
                "default-param" => {
                    effects
                        .scenarios
                        .get_mut(&owner)
                        .unwrap()
                        .params
                        .iter_mut()
                        .find(|value| value.param == parameter)
                        .unwrap()
                        .default = Some(receiver)
                }
                "foreign-binding" => {
                    resolved.node_binding.insert(
                        receiver,
                        Binding::Symbol(
                            program.effects.scenarios[&resolve.by_canonical["chat.ask"]]
                                .params
                                .iter()
                                .find(|param| {
                                    resolve.symbols[param.param.0 as usize].name == "branch"
                                })
                                .unwrap()
                                .param,
                        ),
                    );
                }
                "foreign-parent" => {
                    effects.models.get_mut(&run).unwrap().owner = ModelOwner::Team;
                }
                "field-name" => {
                    resolved.symbols[scalar_field.0 as usize].name = "stop_requested".into();
                }
                _ => unreachable!(),
            }
            let cx = make_run_cx(&catalog, &db, &nodes, &types, &resolved, &effects);
            assert!(
                cx.checked_run_unfinished(unfinished, scenario.module)
                    .is_none(),
                "{mode} cannot borrow the original Run guard"
            );
        }
        for mode in [
            "actor",
            "intermediate-type",
            "slots",
            "default",
            "shadow-parent",
        ] {
            let mut types = program.types.clone();
            let mut resolved = resolve.clone();
            let mut effects = program.effects.clone();
            match mode {
                "actor" => {
                    types
                        .node_types
                        .insert(actor, ResolvedType::Scalar(Scalar::Text));
                }
                "intermediate-type" => {
                    types
                        .node_types
                        .insert(intermediate, types.node_types[&parent].clone());
                }
                "slots" => types
                    .selected_calls
                    .get_mut(&call)
                    .unwrap()
                    .slots
                    .swap(0, 1),
                "default" => {
                    effects
                        .scenarios
                        .get_mut(&owner)
                        .unwrap()
                        .params
                        .iter_mut()
                        .find(|parameter| {
                            resolved.symbols[parameter.param.0 as usize].name == "turn"
                        })
                        .unwrap()
                        .default = Some(actor);
                }
                "shadow-parent" => {
                    resolved
                        .symbols
                        .iter_mut()
                        .find(|symbol| symbol.canonical == "chat.Turn.run")
                        .unwrap()
                        .name = "parent".into();
                }
                _ => unreachable!(),
            }
            assert!(
                check(&types, &resolved, &effects).is_none(),
                "{mode} cannot borrow original containment authority"
            );
        }
    }
    #[test]
    fn checked_given_default_retains_complete_adjacent_root_creates() {
        use super::super::generation_intake::{AssociationKey, UnitKind};
        use super::super::types::{GivenSavedUnit, check_given_contract_tables};
        let source = r#"app RootPair
Given
 trait seats_default $"Supply the existing default of one and minimum of one."
 Customer {active:bool}
 Contact in Customer {name:text}
 Location {currency:currency}
 Deal {customer:Customer,contact:Contact,title:text trim min=1,location:Location,owner:user=actor,value:money,stage:enum(lead,qualified,proposal,won,lost)=lead,seats:int seats_default,desired_start:date?,duration:text?,workspace:text?,source:text?,next_action:datetime?,notes:text?,lost_reason:text?,outcome_reference:text?}
 contract ResearchLead {customer:Customer,contact:Contact,location:Location,title:Deal.title,value:money,notes:text}
 ResearchIntake {source:text unique,input:ResearchLead,deal:Deal}
When
 scenario promote(source:text,input:ResearchLead) -> Deal by=members
  require input.customer.active and input.value.minor>=0 and input.value.currency==input.location.currency
  do
   let existing=first(ResearchIntake as intake where intake.source==source)
   if existing!=null
    require existing.input==input
    return existing.deal
   create Deal {customer=input.customer,contact=input.contact,location=input.location,title=input.title,value=input.value,notes=input.notes,source} as deal
   create ResearchIntake {source,input,deal} as intake
   return deal
Then
"#;
        for renamed in [false, true] {
            let source = if renamed {
                source
                    .replace("Deal", "Opportunity")
                    .replace("ResearchIntake", "Evidence")
            } else {
                source.into()
            };
            let mut db = SourceDb::new();
            let file = db.add("root-pair-given.can".into(), source);
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let catalog_path = root
                .parent()
                .unwrap()
                .join("packages/cloudflare/dist/native-catalog.json");
            let (catalog, errors) =
                super::super::catalog::load_catalog(&super::super::catalog::CatalogRequest {
                    flag: Some(&catalog_path),
                    env: None,
                    cwd: root,
                    primary: crate::source::Span::new(file, 0, 0),
                });
            assert!(errors.is_empty(), "{errors:?}");
            let (initial, _) = super::super::check_program(&db, &[file], catalog.as_ref());
            let found = super::super::generation::discover_program(&db, initial.checked_files());
            let descriptor = found
                .descriptors
                .iter()
                .find(|value| value.kind == super::super::generation::GenerationKind::NamedTrait)
                .unwrap();
            let key = AssociationKey {
                owner: descriptor.owner.clone(),
                kind: UnitKind::NamedTrait,
                label: descriptor.label.clone(),
                anchor: descriptor.anchor.clone(),
            };
            let carrier = db.add(
                "saved/contributions.can".into(),
                "app RootPair\nGiven\n seats_default {value:int=1 min=1}\n".into(),
            );
            let saved = HashMap::from([(
                key,
                GivenSavedUnit {
                    unit_id: "checked-seats".into(),
                    contributions: Some(carrier),
                    implementation_js: None,
                    implementation_imports: Vec::new(),
                    declaration: None,
                },
            )]);
            let (tables, errors) = check_given_contract_tables(&db, &initial, &saved);
            assert!(errors.is_empty(), "{errors:?}");
            let (program, errors) = super::super::check_program_with_given(
                &db,
                &[file],
                catalog.as_ref(),
                Some(&tables),
            );
            assert!(errors.is_empty(), "{errors:?}");
            let owner = program
                .symbols
                .iter()
                .find(|value| value.canonical == "RootPair.promote")
                .unwrap();
            let ScenarioDisclosure::Complete(checked) = &program.scenario_disclosures()[&owner.id]
            else {
                panic!(
                    "complete checked first-row/create-pair workflow: {:?}",
                    program.scenario_disclosures()[&owner.id]
                );
            };
            let facts = checked.source_facts.as_deref().unwrap();
            let creates = facts.creates.as_deref().unwrap();
            assert_eq!(creates.len(), 2);
            assert_eq!(creates[0].inputs.len(), 7);
            assert_eq!(
                creates[1]
                    .inputs
                    .iter()
                    .map(|input| input.name.as_str())
                    .collect::<Vec<_>>(),
                ["source", "input", "deal"]
            );
            assert_eq!(
                creates[0].definition.fields.len(),
                16,
                "complete owning Deal field declaration"
            );
            let seats = creates[0]
                .definition
                .fields
                .iter()
                .find(|field| field.name == "seats")
                .unwrap();
            assert!(
                program.types.given_constraints[&seats.field]
                    .iter()
                    .any(|value| value.default.as_deref() == Some("1")
                        && value.min.as_deref() == Some("1"))
            );
            assert!(checked.returns.iter().any(|value| matches!(
                value.model_result,
                Some(DisclosureModelResult::Reference { .. })
            )));
            assert!(checked.returns.iter().any(|value| matches!(value.model_result, Some(DisclosureModelResult::Create {node, ..}) if node == creates[0].node)));
            let mut no_default = tables;
            no_default.traits[0].contributed_fields[0].default = None;
            let (rejected, errors) = super::super::check_program_with_given(
                &db,
                &[file],
                catalog.as_ref(),
                Some(&no_default),
            );
            assert!(
                !errors.is_empty(),
                "removing the checked default cannot make omission legal"
            );
            assert!(!matches!(
                rejected.scenario_disclosures().get(&owner.id),
                Some(ScenarioDisclosure::Complete(_))
            ));
        }
    }

    #[test]
    fn imported_query_helper_require_source_closure_retains_original_owners() {
        use super::super::catalog::{CatalogRequest, load_catalog};
        let caller = r#"app IntakeApp uses=[crm]
package crm
 use employee {can_work}
 use rent_catalog {Location}
 Given
  contract Input {location:Location}
  Deal {location:Location}
  Intake {source:text unique,input:Input,deal:Deal}
 When
  scenario promote(source:text,input:Input) -> Deal by=members
   require can_work(actor,input.location)
   do
    let existing=first(Intake as prior where prior.source==source)
    if existing!=null
     require existing.input==input and can_work(actor,existing.deal.location)
     return existing.deal
    create Deal {location=input.location} as deal
    create Intake {source,input,deal} as intake
    return deal
 Then
"#;
        let original_employee = include_str!("../../../draft/shared/Employees.can");
        for variant in 0..3 {
            let mut employee = original_employee.to_string();
            let mut caller = caller.to_string();
            if variant == 1 {
                employee = employee.replace("Location", "Site").replace(
                    "use rent_catalog {Site,test_site}",
                    "use rent_catalog {Location as Site,test_site}",
                );
                caller = caller
                    .replace(
                        "use employee {can_work}",
                        "use employee {can_work as allowed}",
                    )
                    .replace("can_work(", "allowed(");
            }
            if variant == 2 {
                let local = original_employee
                    .lines()
                    .find(|line| line.trim_start().starts_with("export derive can_work("))
                    .unwrap()
                    .trim_start()
                    .strip_prefix("export ")
                    .unwrap();
                caller = caller
                    .replace("use employee {can_work}", "use employee {Employee}")
                    .replace("  contract Input", &format!("  {local}\n  contract Input"))
                    .replace(
                        "can_work(actor,input.location)",
                        "can_work(location=input.location,person=actor)",
                    )
                    .replace(
                        "can_work(actor,existing.deal.location)",
                        "can_work(location=existing.deal.location,person=actor)",
                    );
            }
            let helper_module = if variant == 2 { "crm" } else { "employee" };
            let mut db = SourceDb::new();
            let files = [
                db.add("Employees.can".into(), employee),
                db.add("Locations.can".into(), "package rent_catalog\n Given\n  export Location {name:text}\n  export fixture test_site=Location {name=\"Main\"}\n When\n Then\n".into()),
                db.add("Intake.can".into(), caller),
            ];
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let catalog_path = root
                .parent()
                .unwrap()
                .join("packages/cloudflare/dist/native-catalog.json");
            let (catalog, errors) = load_catalog(&CatalogRequest {
                flag: Some(&catalog_path),
                env: None,
                cwd: root,
                primary: crate::source::Span::new(files[0], 0, 0),
            });
            assert!(errors.is_empty(), "{errors:?}");
            let catalog = catalog.unwrap();
            let trees: Vec<_> = files
                .into_iter()
                .map(|file| {
                    let (tree, errors) = crate::syntax::parse(&db, file);
                    assert!(errors.is_empty(), "{errors:?}");
                    (file, tree)
                })
                .collect();
            let mut errors = Vec::new();
            let resolve =
                super::super::resolve::resolve_program(&db, &trees, Some(&catalog), &mut errors);
            let types = super::super::types::check_types(
                &db,
                &trees,
                Some(&catalog),
                &resolve,
                &mut errors,
            );
            super::super::resolve::emit_unresolved(&db, &resolve, &types, &mut errors);
            let effects = super::super::effects::check_effects(
                &db,
                &trees,
                &resolve,
                &types,
                Some(&catalog),
                &mut errors,
            );
            assert!(errors.is_empty(), "{errors:?}");
            let scenario = &effects.scenarios[&resolve.by_canonical["crm.promote"]];
            let helper = resolve.by_canonical[&format!("{helper_module}.can_work")];
            let employee_model = resolve.by_canonical["employee.Employee"];
            let location = resolve.by_canonical["rent_catalog.Location"];
            let mut nodes = HashMap::new();
            let mut pending = trees.iter().map(|(_, tree)| tree).collect::<Vec<_>>();
            while let Some(node) = pending.pop() {
                nodes.insert(NodeKey::of(node), node);
                pending.extend(node.children.iter());
            }
            macro_rules! make {
                ($types:expr) => {
                    Closure {
                        catalog: Some(&catalog),
                        db: &db,
                        resolve: &resolve,
                        types: $types,
                        effects: &effects,
                        nodes: nodes.clone(),
                        stack: HashSet::new(),
                        steps: 0,
                        depth: 0,
                        statement_depth: 0,
                        authorization: false,
                        effect_proofs: Vec::new(),
                        require_consumptions: Vec::new(),
                        effect_visits: 0,
                        loop_node: None,
                        complete_children: HashSet::new(),
                        complete_model_children: HashMap::new(),
                        result_model: None,
                        statement_expressions: None,
                        source_facts: RefCell::new(ImmutableSourceFacts::default()),
                    }
                };
            }
            let mut cx = make!(&types);
            let sites = cx.checked_decision_sites(scenario).unwrap();
            let requires: Vec<_> = sites
                .iter()
                .filter(|site| {
                    matches!(
                        site.stage,
                        CheckedDecisionStage::LeadingRequire | CheckedDecisionStage::BodyRequire
                    )
                })
                .collect();
            assert_eq!(requires.len(), 2);
            let body = effects.derives[&helper].expr.unwrap();
            let expressions = cx
                .checked_create_expression_types(scenario.node, scenario.module)
                .unwrap();
            assert!(
                expressions
                    .iter()
                    .any(|(node, ty)| *node == body && *ty == ResolvedType::Scalar(Scalar::Bool))
            );
            let inventory = cx
                .checked_stored_contracts(scenario)
                .expect("helper stored query declaration census");
            let schema = inventory
                .iter()
                .find(|schema| schema.id == employee_model)
                .expect("Employee query owner retained");
            assert_eq!(schema.source.module, "employee");
            assert!(schema.fields.iter().any(|field| field.name == "home"
                && field.ty
                    == ResolvedType::Record {
                        symbol: location,
                        stored: true
                    }));
            let helper_queries = cx
                .checked_helper_any_query_sources(scenario)
                .expect("exact leading helper query census");
            let [helper_query, body_query] = helper_queries.as_slice() else {
                panic!("distinct leading and body helper query calls")
            };
            assert_ne!(helper_query.id, body_query.id);
            assert!(body_query.inputs.is_empty());
            assert_eq!(helper_query.model, employee_model);
            assert_eq!(helper_query.source.module, helper_module);
            assert_eq!(
                helper_query
                    .dependencies
                    .iter()
                    .map(|read| read.field_name.as_str())
                    .collect::<Vec<_>>(),
                ["user", "active", "operator_wide", "home", "locations"]
            );
            assert_eq!(
                helper_query.dependencies[0].ty,
                ResolvedType::Scalar(Scalar::User)
            );
            assert_eq!(
                helper_query.dependencies[4].type_id,
                "rent_catalog.Location[]"
            );
            assert!(helper_query.dependencies.iter().all(|read| read.role
                == DependencyRole::Control
                && read.source == helper_query.source
                && read.calls.len() == 1
                && read.query_id.is_none()));
            assert_eq!(helper_query.influences.len(), 4);
            assert!(
                helper_query
                    .influences
                    .iter()
                    .all(|influence| influence.source == helper_query.source
                        && influence.query_id.as_ref() == Some(&helper_query.id))
            );
            let mut query_call = None;
            for site in requires {
                let outer = site
                    .calls
                    .iter()
                    .find(|call| {
                        call.target == CheckedDecisionCallTarget::DeriveFn(helper)
                            && call.chain.is_empty()
                    })
                    .unwrap();
                let actor = &outer.arguments[outer.slots[0].unwrap()];
                let location_argument = &outer.arguments[outer.slots[1].unwrap()];
                assert_eq!(actor.1, ResolvedType::Scalar(Scalar::User));
                if variant == 2 {
                    assert_eq!(outer.slots, [Some(1), Some(0)]);
                    assert_eq!(
                        outer.arguments[0].0, location_argument.0,
                        "authored argument order is retained"
                    );
                }
                assert_eq!(
                    location_argument.1,
                    ResolvedType::Record {
                        symbol: location,
                        stored: true
                    }
                );
                let nested = site.calls.iter().find(|call| matches!(&call.target, CheckedDecisionCallTarget::Builtin { id, .. } if id == "any")).unwrap();
                assert_eq!(nested.source.module, helper_module);
                let [frame] = nested.chain.as_slice() else {
                    panic!("one original helper call frame")
                };
                assert_eq!(frame.node, outer.node);
                assert_eq!(frame.source.module, "crm");
                assert_eq!(frame.derive, helper);
                query_call = Some(nested.node);
                assert!(
                    cx.checked_authorization_derive(outer.node, scenario.module)
                        .is_none(),
                    "source inventory grants no query authorization"
                );
                let argument = location_argument.0;
                if site.stage == CheckedDecisionStage::LeadingRequire {
                    assert_eq!(
                        helper_query.inputs,
                        [(
                            argument,
                            scenario
                                .params
                                .iter()
                                .find(|parameter| resolve.symbols[parameter.param.0 as usize].name
                                    == "input")
                                .unwrap()
                                .param
                        )]
                    );
                    assert!(
                        helper_query
                            .dependencies
                            .iter()
                            .all(|read| read.calls == [outer.node])
                    );
                    let parameter = helper_query.inputs[0].1;
                    let mut env = Env::new();
                    env.insert(Local::Symbol(parameter), ValuePath::default());
                    cx.statement_depth = 1;
                    let closure = cx
                        .authorization_expr(outer.node, scenario.module, &env, &[])
                        .expect("exact leading helper source consumption");
                    let [value] = closure.as_slice() else {
                        panic!("one query verdict source")
                    };
                    assert_eq!(value.influences, helper_query.influences);
                    assert!(
                        value.reads.is_empty()
                            && value.intrinsics.is_empty()
                            && value.record.is_none()
                            && value.reference_origin.is_none()
                            && value.reference.is_none(),
                        "query control grants no candidate/record authority"
                    );
                    assert_eq!(
                        cx.checked_contract_input_reference(argument, scenario.module)
                            .map(|(_, model, _)| model),
                        Some(location)
                    );
                } else {
                    let binding = scenario
                        .effects
                        .iter()
                        .find(|binding| binding.verb == EffectVerb::Let)
                        .unwrap();
                    let first_query = cx.checked_first_query_source(scenario, binding).unwrap();
                    let first = first_query.first.as_ref().unwrap();
                    let mut env = Env::new();
                    env.insert(
                        Local::Let(first.binding),
                        ValuePath {
                            record: Some(first_query.model),
                            first_query: Some((first.call, first.binding)),
                            influences: first_query.influences.clone(),
                            ..ValuePath::default()
                        },
                    );
                    cx.statement_depth = 2;
                    let closure = cx.authorization_expr(outer.node, scenario.module, &env, &[])
                        .expect("exact body helper consumes the original first-query required reference");
                    let [value] = closure.as_slice() else {
                        panic!("one body verdict source");
                    };
                    assert_eq!(
                        value
                            .reads
                            .iter()
                            .map(|read| read.field_name.as_str())
                            .collect::<Vec<_>>(),
                        ["deal", "location"]
                    );
                    assert!(
                        value
                            .reads
                            .iter()
                            .all(|read| read.role == DependencyRole::Data
                                && read.calls.is_empty()
                                && read.query_id.is_none())
                    );
                    assert!(
                        value.record.is_none()
                            && value.model_result.is_none()
                            && value.reference_origin.is_none()
                    );
                    assert!(
                        first_query
                            .influences
                            .iter()
                            .chain(&body_query.influences)
                            .all(|influence| value.influences.contains(influence))
                    );
                    assert!(
                        body_query
                            .dependencies
                            .iter()
                            .all(|read| read.calls == [outer.node])
                    );
                    assert_eq!(
                        cx.checked_required_model_reference(argument, scenario.module)
                            .map(|(_, _, model)| model),
                        Some(location)
                    );
                }
            }
            let query_call = query_call.unwrap();
            for mutation in 0..4 {
                let mut changed = types.clone();
                match mutation {
                    0 => {
                        changed.checked_collection_calls.remove(&query_call);
                    }
                    1 => {
                        changed
                            .checked_collection_calls
                            .get_mut(&query_call)
                            .unwrap()
                            .model = location;
                    }
                    2 => {
                        changed
                            .checked_collection_calls
                            .get_mut(&query_call)
                            .unwrap()
                            .overload += 1;
                    }
                    _ => {
                        changed
                            .checked_collection_calls
                            .get_mut(&query_call)
                            .unwrap()
                            .alias
                            .start += 1;
                    }
                }
                assert!(
                    make!(&changed).checked_stored_contracts(scenario).is_none(),
                    "query metadata mutation {mutation} refuses census"
                );
                assert!(
                    make!(&changed)
                        .checked_helper_any_query_sources(scenario)
                        .is_none(),
                    "query metadata mutation {mutation} refuses the helper query producer"
                );
            }
            let mut changed = types.clone();
            changed.symbol_types.insert(
                helper_query.dependencies[0].field,
                ResolvedType::Scalar(Scalar::Text),
            );
            assert!(
                make!(&changed)
                    .checked_helper_any_query_sources(scenario)
                    .is_none(),
                "mandatory first User read must retain its original field type"
            );
            let mut changed = types.clone();
            let original_domain = changed.checked_queries[&helper_query.node].domain;
            changed
                .checked_queries
                .get_mut(&helper_query.node)
                .unwrap()
                .domain
                .start = original_domain.start + 1;
            assert!(
                make!(&changed)
                    .checked_helper_any_query_sources(scenario)
                    .is_none(),
                "source query domain occurrence cannot be substituted"
            );
        }
    }

    #[test]
    fn original_optional_model_input_seals_null_guard_and_imported_authorization() {
        use super::super::catalog::{CatalogRequest, load_catalog};
        let mut db = SourceDb::new();
        let files = [
            db.add(
                "CanChat.can".into(),
                include_str!("../../tests/fixtures/original-a850/CanChat.can").into(),
            ),
            db.add(
                "CanCreative.can".into(),
                include_str!("../../tests/fixtures/original-a850/CanCreative.can").into(),
            ),
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let catalog_path = root
            .parent()
            .unwrap()
            .join("packages/cloudflare/dist/native-catalog.json");
        let (catalog, errors) = load_catalog(&CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: root,
            primary: crate::source::Span::new(files[0], 0, 0),
        });
        assert!(errors.is_empty(), "{errors:?}");
        let catalog = catalog.unwrap();
        let trees = files
            .into_iter()
            .map(|file| {
                let (tree, errors) = crate::syntax::parse(&db, file);
                assert!(errors.is_empty(), "{errors:?}");
                (file, tree)
            })
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        let resolve =
            super::super::resolve::resolve_program(&db, &trees, Some(&catalog), &mut errors);
        assert!(errors.is_empty(), "{errors:?}");
        // This unit owns the original input and leading helper source seals.
        // Build real checked types/effects without reanalyzing the unrelated body.
        let types =
            super::super::types::check_types(&db, &trees, Some(&catalog), &resolve, &mut errors);
        super::super::resolve::emit_unresolved(&db, &resolve, &types, &mut errors);
        let effects = super::super::effects::check_effects(
            &db,
            &trees,
            &resolve,
            &types,
            Some(&catalog),
            &mut errors,
        );
        assert!(errors.is_empty(), "{errors:?}");
        let scenario = &effects.scenarios[&resolve.by_canonical["creative.generate"]];
        let parameter = scenario
            .params
            .iter()
            .find(|param| resolve.symbols[param.param.0 as usize].name == "conversation")
            .unwrap();
        let model = resolve.by_canonical["chat.Conversation"];
        let mut nodes = HashMap::new();
        let mut pending = trees.iter().map(|(_, tree)| tree).collect::<Vec<_>>();
        while let Some(node) = pending.pop() {
            nodes.insert(NodeKey::of(node), node);
            pending.extend(node.children.iter());
        }
        let null_guard = *nodes
            .keys()
            .find(|key| {
                key.file == scenario.node.file
                    && key.start >= scenario.node.start
                    && key.end <= scenario.node.end
                    && key.kind == SyntaxKind::Binary as u8
                    && db.get(key.file).unwrap().text[key.start as usize..key.end as usize].trim()
                        == "conversation==null"
            })
            .unwrap();
        let call = *types
            .selected_calls
            .keys()
            .find(|key| {
                key.file == scenario.node.file
                    && key.start >= scenario.node.start
                    && key.end <= scenario.node.end
                    && db.get(key.file).unwrap().text[key.start as usize..key.end as usize].trim()
                        == "can_use(actor,conversation)"
            })
            .unwrap();
        macro_rules! make {
            ($types:expr,$effects:expr,$resolved:expr) => {
                Closure {
                    catalog: Some(&catalog),
                    db: &db,
                    resolve: $resolved,
                    types: $types,
                    effects: $effects,
                    nodes: nodes.clone(),
                    stack: HashSet::new(),
                    steps: 0,
                    depth: 0,
                    statement_depth: 1,
                    authorization: true,
                    effect_proofs: Vec::new(),
                    require_consumptions: Vec::new(),
                    effect_visits: 0,
                    loop_node: None,
                    complete_children: HashSet::new(),
                    complete_model_children: HashMap::new(),
                    result_model: None,
                    statement_expressions: None,
                    source_facts: RefCell::new(ImmutableSourceFacts::default()),
                }
            };
        }
        let mut cx = make!(&types, &effects, &resolve);
        assert_eq!(cx.nullable_model_input(scenario, parameter), Some(model));
        let inventory = cx
            .checked_stored_contracts(scenario)
            .expect("original optional input schema census");
        let conversation = inventory
            .iter()
            .find(|schema| schema.id == model)
            .expect("same imported Conversation");
        assert_eq!(conversation.source.module, "chat");
        assert!(
            conversation
                .fields
                .iter()
                .any(|field| field.name == "account"
                    && field.ty == ResolvedType::Scalar(Scalar::User))
        );
        assert!(
            conversation
                .fields
                .iter()
                .any(|field| field.name == "active"
                    && field.ty == ResolvedType::Scalar(Scalar::Bool))
        );
        let mut env = Env::new();
        env.insert(
            Local::Symbol(parameter.param),
            ValuePath {
                record: Some(model),
                reference_origin: Some(ReferenceOrigin::NullableParameter(parameter.param)),
                ..Default::default()
            },
        );
        let values = cx
            .expr(null_guard, scenario.module, &env, &[])
            .expect("actual optional input null comparison");
        assert!(values.iter().all(|value| value.record.is_none()
            && value.reference_origin.is_none()
            && value.reads.is_empty()
            && value.intrinsics.is_empty()
            && value.influences.is_empty()));
        let (helper, actual_model, actual_input, membership) = cx
            .checked_authorization_derive(call, scenario.module)
            .expect("actual genuine imported helper and narrowed input");
        assert_eq!(helper, resolve.by_canonical["chat.can_use"]);
        assert_eq!(actual_model, model);
        assert!(
            matches!(cx.query_binding(actual_input), Some(Binding::Symbol(actual)) if *actual==parameter.param)
        );
        assert_ne!(membership.file, call.file);
        cx.expr(call, scenario.module, &env, &[])
            .expect("actual imported helper source evaluation");
        let from_turn = &effects.scenarios[&resolve.by_canonical["creative.from_turn"]];
        let required = from_turn
            .params
            .iter()
            .find(|param| resolve.symbols[param.param.0 as usize].name == "turn")
            .unwrap();
        let parent_call = *types
            .selected_calls
            .keys()
            .find(|key| {
                key.file == from_turn.node.file
                    && from_turn.node.start <= key.start
                    && key.end <= from_turn.node.end
                    && db.get(key.file).unwrap().text[key.start as usize..key.end as usize].trim()
                        == "can_use(actor,turn.parent.parent)"
            })
            .unwrap();
        let (parent_helper, parent_model, parent_input, _) = cx
            .checked_authorization_derive(parent_call, from_turn.module)
            .expect("original required imported two-parent authorization");
        assert_eq!(parent_helper, helper);
        assert_eq!(parent_model, model);
        assert_eq!(
            cx.checked_call_parent_path(parent_input, required.param, 0),
            Some((model, 2))
        );
        let (intermediate, _) = cx.count_member(parent_input).unwrap();
        let (receiver, _) = cx.count_member(intermediate).unwrap();
        assert!(
            matches!(cx.query_binding(receiver), Some(Binding::Symbol(actual)) if *actual == required.param)
        );
        let root = resolve.by_canonical["chat.Turn"];
        let branch = resolve.by_canonical["chat.Branch"];
        let mut required_env = Env::new();
        required_env.insert(
            Local::Symbol(required.param),
            ValuePath {
                record: Some(root),
                reference_origin: Some(ReferenceOrigin::Parameter(required.param)),
                reference: Some(DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter: required.param,
                    parameter_name: "turn".into(),
                    model: root,
                    model_name: "chat.Turn".into(),
                }),
                ..Default::default()
            },
        );
        let values = cx
            .expr(parent_call, from_turn.module, &required_env, &[])
            .expect("actual imported required parent source evaluation");
        assert!(!values.is_empty());
        assert!(values.iter().all(|value| {
            value.reads.iter().any(|read| {
                read.node == parent_input && read.field_name == "parent" && read.calls.is_empty()
            })
        }));
        assert!(
            values.iter().all(|value| [intermediate, parent_input]
                .iter()
                .all(|node| value.observed.contains(&(*node, Vec::new())))),
            "eager original parent observations"
        );
        for mode in [
            "required-default",
            "root-import",
            "bound-root",
            "wrong-root-import",
            "root-type",
            "root-module",
            "root-export",
            "edge-type",
            "edge-owner",
            "authored-parent",
        ] {
            let mut changed_types = types.clone();
            let mut changed_effects = effects.clone();
            let mut changed_resolve = resolve.clone();
            match mode {
                "required-default" => {
                    changed_effects
                        .scenarios
                        .get_mut(&from_turn.scenario)
                        .unwrap()
                        .params
                        .iter_mut()
                        .find(|param| param.param == required.param)
                        .unwrap()
                        .default = parameter.default
                }
                "root-import" => {
                    changed_resolve.module_scopes[from_turn.module.0 as usize]
                        .prod
                        .remove("Turn");
                }
                "bound-root" => {
                    changed_resolve.module_scopes[from_turn.module.0 as usize]
                        .prod
                        .insert(
                            "Turn".into(),
                            ScopedName::Imported {
                                target: root,
                                bound: true,
                            },
                        );
                }
                "wrong-root-import" => {
                    changed_resolve.module_scopes[from_turn.module.0 as usize]
                        .prod
                        .insert(
                            "Turn".into(),
                            ScopedName::Imported {
                                target: model,
                                bound: false,
                            },
                        );
                }
                "root-type" => {
                    changed_types.symbol_types.insert(
                        required.param,
                        ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        },
                    );
                }
                "root-module" => changed_resolve.symbols[root.0 as usize].module = from_turn.module,
                "root-export" => changed_resolve.symbols[root.0 as usize].exported = false,
                "edge-type" => {
                    changed_types.node_types.insert(
                        intermediate,
                        ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        },
                    );
                }
                "edge-owner" => {
                    changed_effects.models.get_mut(&branch).unwrap().owner = ModelOwner::Team
                }
                "authored-parent" => {
                    changed_resolve.symbols[resolve.by_canonical["chat.Turn.run"].0 as usize].name =
                        "parent".into()
                }
                _ => unreachable!(),
            }
            assert!(
                make!(&changed_types, &changed_effects, &changed_resolve)
                    .checked_authorization_derive(parent_call, from_turn.module)
                    .is_none(),
                "{mode}"
            );
        }

        for mode in [
            "default",
            "type",
            "binding",
            "import",
            "export",
            "slots",
            "team",
            "bound",
            "model-import",
            "module",
        ] {
            let mut types = types.clone();
            let mut effects = effects.clone();
            let mut resolved = resolve.clone();
            match mode {
                "default" => {
                    effects
                        .scenarios
                        .get_mut(&scenario.scenario)
                        .unwrap()
                        .params
                        .iter_mut()
                        .find(|param| param.param == parameter.param)
                        .unwrap()
                        .default = None
                }
                "type" => {
                    types.symbol_types.insert(
                        parameter.param,
                        ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        },
                    );
                }
                "binding" => {
                    resolved.node_binding.insert(
                        actual_input,
                        Binding::Symbol(
                            scenario
                                .params
                                .iter()
                                .find(|param| {
                                    resolve.symbols[param.param.0 as usize].name == "template"
                                })
                                .unwrap()
                                .param,
                        ),
                    );
                }
                "import" => {
                    resolved.module_scopes[scenario.module.0 as usize]
                        .prod
                        .remove("can_use");
                }
                "export" => resolved.symbols[helper.0 as usize].exported = false,
                "bound" => {
                    resolved.module_scopes[scenario.module.0 as usize]
                        .prod
                        .insert(
                            "can_use".into(),
                            ScopedName::Imported {
                                target: helper,
                                bound: true,
                            },
                        );
                }
                "model-import" => {
                    resolved.module_scopes[scenario.module.0 as usize]
                        .prod
                        .remove("Conversation");
                }
                "module" => effects.derives.get_mut(&helper).unwrap().module = scenario.module,
                "slots" => types
                    .selected_calls
                    .get_mut(&call)
                    .unwrap()
                    .slots
                    .swap(0, 1),
                "team" => {
                    let selected = &types.selected_calls[&membership];
                    let team = selected.arguments[1];
                    resolved
                        .node_binding
                        .insert(team, Binding::Context(ContextVar::Operation));
                }
                _ => unreachable!(),
            }
            assert!(
                make!(&types, &effects, &resolved)
                    .checked_authorization_derive(call, scenario.module)
                    .is_none(),
                "{mode}"
            );
        }
    }
}
