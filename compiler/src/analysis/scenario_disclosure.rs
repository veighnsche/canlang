//! Checked return-specific provenance, before lowering erases lexical identities.
//!
//! These facts are not grants. Only `Complete` may become a disclosure plan.
//! A failed closure declines the whole scenario, including earlier returns.
use std::collections::{HashMap, HashSet};

use super::effects::{Effect, EffectTables, EffectTarget, EffectVerb};
use super::resolve::{Binding, ContextVar, ResolveTables, SymbolKind};
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
    pub influences: Vec<DisclosureInfluence>,
}

#[derive(Debug, Clone)]
pub struct CheckedScenarioDisclosure {
    pub scenario: SymbolId,
    pub node: NodeKey,
    pub source: DisclosureSource,
    pub returns: Vec<DisclosureReturn>,
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
    };
    let mut out = HashMap::new();
    for scenario in effects.scenarios.values() {
        cx.steps = 0;
        cx.stack.clear();
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
                        && alternatives
                            .iter()
                            .any(|value| !value.reads.is_empty() || !value.decisions.is_empty())
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
}
type Env = HashMap<Local, ValuePath>;

#[derive(Debug, Clone, Default)]
struct ValuePath {
    reads: Vec<DisclosureDependency>,
    observed: Vec<(NodeKey, Vec<NodeKey>)>,
    decisions: Vec<DisclosureDecision>,
    record: Option<SymbolId>,
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
}

impl Closure<'_> {
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
                    Some(Binding::Symbol(id)) => env
                        .get(&Local::Symbol(*id))
                        .cloned()
                        .map(|p| vec![p])
                        .ok_or_else(|| self.fail(key, "unaccounted symbol value")),
                    Some(Binding::Let { node }) => env
                        .get(&Local::Let(*node))
                        .cloned()
                        .map(|p| vec![p])
                        .ok_or_else(|| self.fail(key, "unaccounted immutable binding")),
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
                if !matches!(base, ResolvedType::Array { element, .. } if primitive_type(element)) {
                    return Err(self.fail(key, "unsupported array expression type"));
                }
                let mut paths = vec![ValuePath::default()];
                for child in children {
                    let element_ty = self
                        .types
                        .node_types
                        .get(&NodeKey::of(child))
                        .ok_or_else(|| self.fail(key, "missing checked array element type"))?;
                    if !primitive_type(element_ty) {
                        return Err(self.fail(key, "unsupported array element type"));
                    }
                    let element = self.expr(NodeKey::of(child), module, env, calls)?;
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
                let mut values = self.expr(base_key, module, env, calls)?;
                for value in &mut values {
                    let model = value
                        .record
                        .ok_or_else(|| self.fail(key, "non-direct stored field traversal"))?;
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
                        // Business-check failure does not disclose a successful
                        // independent return. Do not add guard reads as control.
                        for value in alternatives {
                            if !compatible(&flow.evaluated, &value.decisions) {
                                continue;
                            }
                            let mut path = flow.clone();
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
                    EffectVerb::Transition => {
                        for write in self.transition(effect, module, &flow.env, calls)? {
                            if !compatible(&flow.evaluated, &write.decisions) {
                                continue;
                            }
                            let mut path = flow.clone();
                            path.writes.join(&flow.controls);
                            path.writes.join(&write);
                            if path.writes.reads.len() > 200 {
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
                            let selects_writes = continuing.iter().any(|path| {
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
                                    if path.writes.reads.len() > 200 {
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
        let mut db = SourceDb::new();
        let file = db.add("bounds.can".into(), source.into());
        let (program, diagnostics) = super::super::check_program(&db, &[file], None);
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
