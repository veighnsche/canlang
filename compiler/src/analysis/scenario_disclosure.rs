//! Checked return-specific provenance, before lowering erases lexical identities.
//!
//! These facts are not grants. Only `Complete` may become a disclosure plan.
//! A failed closure declines the whole scenario, including earlier returns.
use std::collections::{HashMap, HashSet};

use super::catalog::{nominal_schema, std_capability, std_operation};
use super::effects::{Effect, EffectTables, EffectTarget, EffectVerb};
use super::resolve::{Binding, ContextVar, ResolveTables, ScopedName, SymbolKind, TypeRef};
use super::types::SelectedCallTarget;
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
#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
pub struct DisclosureInfluence {
    pub id: String,
    pub source: DisclosureSource,
    pub node: NodeKey,
    pub kind: InfluenceKind,
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisclosureEffect {
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub kind: DisclosureEffectKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisclosureEffectKind {
    Set {
        model: SymbolId,
        fields: Vec<SymbolId>,
    },
    Send {
        operation: String,
        deployment_binding: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioDisclosure {
    pub scenario: SymbolId,
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub returns: Vec<DisclosureReturn>,
    pub effects: Vec<DisclosureEffect>,
}

#[derive(Debug, Clone)]
pub struct DisclosureDecline {
    pub node: NodeKey,
    pub reason: &'static str,
    pub influences: Vec<DisclosureInfluence>,
}

#[derive(Debug, Clone)]
pub enum ScenarioDisclosure {
    Complete(CheckedScenarioDisclosure),
    Declined(DisclosureDecline),
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
    };
    let mut out = HashMap::new();
    for scenario in effects.scenarios.values() {
        cx.steps = 0;
        cx.stack.clear();
        cx.effect_proofs.clear();
        cx.effect_visits = 0;
        let result = (|| {
            if scenario.on.is_some() {
                return Err(cx.fail(scenario.node, "trusted handler"));
            }
            let signature = types
                .symbol_results
                .get(&scenario.scenario)
                .ok_or_else(|| cx.fail(scenario.node, "missing checked result signature"))?;
            if signature.as_ref().is_some_and(|ty| !result_type(ty)) {
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
                        let parameter =
                            resolve.symbols.get(param.param.0 as usize).ok_or_else(|| {
                                cx.fail(param.node, "missing admitted parameter declaration")
                            })?;
                        let model = resolve.symbols.get(symbol.0 as usize).ok_or_else(|| {
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
                        return Err(cx.fail(param.node, "parameter default evaluation path bound"));
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
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Local {
    Symbol(SymbolId),
    Let(NodeKey),
    Send(NodeKey),
}
type Env = HashMap<Local, ValuePath>;

#[derive(Debug, Clone, Default)]
struct ValuePath {
    reads: Vec<DisclosureDependency>,
    intrinsics: Vec<DisclosureIntrinsic>,
    observed: Vec<(NodeKey, Vec<NodeKey>)>,
    decisions: Vec<DisclosureDecision>,
    record: Option<SymbolId>,
    reference: Option<DisclosureIntrinsicKind>,
    input: Option<(SymbolId, String, Scalar)>,
    members: Option<Vec<(String, ValuePath)>>,
    schema: Option<String>,
    delivery: Option<ResolvedType>,
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
    evaluated: Vec<DisclosureDecision>,
    observed: Vec<(NodeKey, Vec<NodeKey>)>,
}

struct Closure<'a> {
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
            node,
            reason,
            influences: Vec::new(),
        }
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
                    Some(Binding::Let { node }) => env
                        .get(&Local::Let(*node))
                        .cloned()
                        .map(|p| vec![p])
                        .ok_or_else(|| self.fail(key, "unaccounted immutable binding")),
                    Some(Binding::SendAs { node }) => env
                        .get(&Local::Send(*node))
                        .cloned()
                        .map(|value| vec![value])
                        .ok_or_else(|| self.fail(key, "unaccounted send binding")),
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
                if provider != "std" || !matches!(name.as_str(), "TextRequest" | "TextMessage") {
                    return Err(self.fail(key, "unsupported closed std schema"));
                }
                let schema = nominal_schema(name)
                    .ok_or_else(|| self.fail(key, "missing defining std schema"))?;
                let ResolvedType::Object(fields) = ty else {
                    return Err(self.fail(key, "missing checked schema object type"));
                };
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
            SyntaxKind::Array => {
                let base = match ty {
                    ResolvedType::Nullable(inner) => inner.as_ref(),
                    ty => ty,
                };
                let ResolvedType::Array { element, .. } = base else {
                    return Err(self.fail(key, "unsupported array expression type"));
                };
                let composite = matches!(element.as_ref(), ResolvedType::Object(_));
                let empty_files = children.is_empty()
                    && matches!(element.as_ref(), ResolvedType::Scalar(Scalar::File));
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
                    if !primitive_type(element_ty) && !matches!(element_ty, ResolvedType::Object(_))
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
            SyntaxKind::Binary => {
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
                    self.product(key, &left, &right)
                }
            }
            SyntaxKind::Member => {
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
                    if let Some(members) = &value.members {
                        let ResolvedType::Object(fields) = self
                            .types
                            .node_types
                            .get(&base_key)
                            .ok_or_else(|| self.fail(key, "missing composite receiver type"))?
                        else {
                            return Err(self.fail(key, "unestablished composite receiver"));
                        };
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
                        return Err(
                            self.fail(key, "derived field requires its complete body closure")
                        );
                    }
                    let type_id = self.field_type_id(key, field.id, field_ty)?;
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
        let mut argument_paths = vec![(ValuePath::default(), Vec::<ValuePath>::new())];
        for argument in &selected.arguments {
            let alternatives = self.expr(*argument, module, env, calls)?;
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
            Some(Binding::SendAs { node }) => Local::Send(*node),
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
        let ResolvedType::Object(fields) = ty else {
            return Err(self.fail(key, "unsupported object type"));
        };
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
            if !delivery {
                if matches!(base, ResolvedType::Array { .. }) {
                    return Err(self.fail(arg.key_node, "set array outside scalar effect profile"));
                }
                self.field_type_id(arg.key_node, field.id, ty)?;
            }
            let values = match arg.value {
                Some(value) => self.expr(value, module, env, calls)?,
                None => self.lexical(arg.key_node, module, env, calls)?,
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
            },
        )?;
        Ok(paths)
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
        // Conditional provider dispatch has a separate durable predicate contract.
        if node.kind != SyntaxKind::Send || effect.when.is_some() {
            return Err(self.fail(effect.node, "unsupported conditional send profile"));
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
        if effect.args.len() != input_names.len()
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
            },
        )?;
        Ok((paths, effect.binding.as_ref().map(|_| delivery)))
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
        if merged.reads.len() + merged.intrinsics.len() > 200 {
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
        })
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
        let mut returns = Vec::new();
        for effect in effects {
            self.steps += 1;
            if self.steps > 16384 {
                return Err(self.fail(effect.node, "statement closure item bound"));
            }
            let mut next = Vec::new();
            for flow in flows {
                match effect.verb {
                    EffectVerb::Let => {
                        let value = effect.value.ok_or_else(|| {
                            self.fail(effect.node, "missing immutable initializer")
                        })?;
                        for evaluated in self.expr(value, module, &flow.env, calls)? {
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
                        // primitive guard values control successful effects,
                        // while stored guard reads retain their existing policy.
                        for value in alternatives {
                            if !compatible(&flow.evaluated, &value.decisions) {
                                continue;
                            }
                            let mut path = flow.clone();
                            let admitted_guard = self.control(ValuePath {
                                intrinsics: value
                                    .intrinsics
                                    .iter()
                                    .filter(|intrinsic| {
                                        matches!(
                                            intrinsic.kind,
                                            DisclosureIntrinsicKind::AdmittedInput { .. }
                                        )
                                    })
                                    .cloned()
                                    .collect(),
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
                    EffectVerb::Set | EffectVerb::Send => {
                        let (alternatives, delivery) = if effect.verb == EffectVerb::Set {
                            (self.set(effect, module, &flow.env, calls)?, None)
                        } else {
                            self.send(effect, module, &flow.env, calls)?
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
                            Some(key) => self.expr(key, module, &flow.env, calls)?,
                            None => vec![ValuePath::default()],
                        };
                        for value in values {
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
                        return Err(self.influence(
                            effect.node,
                            module,
                            &[InfluenceKind::QueryMembership, InfluenceKind::QueryOrder],
                            "loop closure",
                        ));
                    }
                    EffectVerb::Call => {
                        return Err(self.fail(
                            effect.node,
                            "effect call lacks executable canonical lowering",
                        ));
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
                matches!(&plan.effects[0].kind,DisclosureEffectKind::Send {operation:actual,deployment_binding:Some(binding)}
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
    fn guarded_send_and_reference_writes_remain_outside_effect_profile() {
        let send = "app Bounds\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\n Item {source:text,revision:int}\n policy Item read=members\nWhen\n scenario probe(item:Item) by=members\n  do\n   send LLM.cancel {source=item.source,revision=item.revision} when=false as stop\nThen\n";
        let ScenarioDisclosure::Declined(decline) = checked(send) else {
            panic!("dispatch guard must decline")
        };
        assert_eq!(decline.reason, "unsupported conditional send profile");
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
}
