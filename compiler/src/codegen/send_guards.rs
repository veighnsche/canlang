//! Private original SEND predicate preparation; no execution authority.
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::analysis::effects::{Effect, EffectVerb, ScenarioData};
use crate::analysis::resolve::{self, Binding, Symbol, SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::{
    CheckedDecisionPosition, CheckedDecisionSite, CheckedDecisionStage, CheckedScenarioSource,
    DisclosureFirstQuery, DisclosureQuery,
};
use crate::analysis::types::{
    CheckedCollectionCall, CheckedQuery, SelectedCall, SelectedCallTarget,
};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, kids, name_text};
use crate::source::{SourceDb, Span};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{
    IrBinOp, IrExpr, IrItem, IrItemKind, IrProgram, IrQuery, IrQueryDomain, IrStmt, TypedExpr,
};
use super::scenario_decisions::serial_type;

#[derive(Debug)]
pub(super) struct SendGuardGap {
    pub reason: &'static str,
    pub span: Option<Span>,
}

fn gap(reason: &'static str, span: Option<Span>) -> SendGuardGap {
    SendGuardGap { reason, span }
}

#[derive(Clone)]
pub(super) struct PreparedSendInput {
    pub name: String,
    pub type_id: String,
    pub value: TypedExpr,
    /// Original lexical declaration; never reconstructed from an emitted name.
    pub declaration: NodeKey,
    pub symbol: Option<SymbolId>,
    pub owner: SymbolId,
    pub ordinal: usize,
    /// Only an earlier successful original first-row presence Require refines
    /// the captured type. The nullable lexical declaration remains retained.
    #[allow(dead_code)]
    pub narrowing: Option<PreparedFirstRowNarrowing>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub(super) struct PreparedFirstRowNarrowing {
    pub declared_type: ResolvedType,
    pub model: SymbolId,
    pub query_id: String,
    pub first_call: NodeKey,
    pub binding: NodeKey,
    pub presence: NodeKey,
    pub require: NodeKey,
    pub occurrence: NodeKey,
    pub source: crate::analysis::scenario_disclosure::DisclosureSource,
}

#[derive(Clone)]
pub(super) struct PreparedSendGuard {
    pub rule: String,
    pub predicate: TypedExpr,
    pub descriptor: serde_json::Value,
    pub inputs: Vec<PreparedSendInput>,
}

/// Only this module constructs a prepared inventory. All editable IR is sealed.
pub(super) struct PreparedSendGuards {
    guards: HashMap<Span, PreparedSendGuard>,
    by_owner: BTreeMap<String, serde_json::Value>,
    closure: String,
}

impl PreparedSendGuards {
    pub fn guards(&self, ir: &IrProgram) -> Option<&HashMap<Span, PreparedSendGuard>> {
        (self.closure == format!("{ir:?}")).then_some(&self.guards)
    }

    pub fn by_owner(&self, ir: &IrProgram) -> Option<&BTreeMap<String, serde_json::Value>> {
        (self.closure == format!("{ir:?}")).then_some(&self.by_owner)
    }
}

// Source-proof internals contain maps. Compare the emitted execution closure in
// stable declaration order; the prepared snapshot additionally seals every field.
fn execution_closure(ir: &IrProgram) -> String {
    format!(
        "{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
        ir.modules,
        ir.items,
        ir.read_rules,
        ir.callback_read_rules,
        ir.invariants,
        ir.locks,
        ir.retention,
        ir.crud_when,
        ir.preferences_valid,
        ir.catalog_version,
        ir.referenced_builtins,
        ir.suites,
        ir.migrations
    )
}

pub(super) fn source_preparation_gap(
    error: super::scenario_decisions::SourcePreparationGap,
) -> SendGuardGap {
    use super::scenario_decisions::SourcePreparationGap;
    match error {
        SourcePreparationGap::Cohort => gap("checked source cohort mismatch", None),
        SourcePreparationGap::Analysis => gap("original SEND source no longer checks", None),
        SourcePreparationGap::Ir => gap("original whole IR execution closure mismatch", None),
        SourcePreparationGap::MissingSource => gap("missing original source", None),
        SourcePreparationGap::Cst(span) => gap("original SEND CST is invalid", Some(span)),
        SourcePreparationGap::Resolution => gap("original SEND lexical resolution failed", None),
    }
}

fn prepare_send_guard(
    original: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    resolved: &resolve::ResolveTables,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    owner: &IrItem,
    source_facts: &[CheckedDecisionSite],
    send: &IrStmt,
    site: &super::scenario_decisions::SerialDecisionSite,
) -> Result<(Span, PreparedSendGuard), SendGuardGap> {
    let IrStmt::Send {
        operation,
        when: Some(predicate),
        deployment_binding,
        binding,
        span,
        ..
    } = send
    else {
        unreachable!()
    };
    if predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        || site.owner != owner.canonical
        || site.statement.start != span.start
        || site.statement.end != span.end
    {
        return Err(gap(
            "original SEND owner/Boolean site mismatch",
            Some(*span),
        ));
    }
    let fact = source_facts
        .iter()
        .find(|fact| {
            fact.stage
                == crate::analysis::scenario_disclosure::CheckedDecisionStage::SendDispatch
                && fact.statement.file == span.file
                && fact.statement.start == span.start
                && fact.statement.end == span.end
                && fact.node.start == site.node.start
                && fact.node.end == site.node.end
        })
        .ok_or_else(|| gap("original SEND predicate node mismatch", Some(*span)))?;
    let source = db
        .get(span.file)
        .ok_or_else(|| gap("missing SEND source", Some(*span)))?;
    if site.source.path != source.path
        || site.source.sha256 != source.sha256
        || original
            .modules
            .get(owner.module.0 as usize)
            .is_none_or(|module| module.name != site.source.module)
    {
        return Err(gap("original SEND source identity mismatch", Some(*span)));
    }
    let node = nodes
        .get(&fact.node)
        .ok_or_else(|| gap("missing original SEND predicate CST", Some(*span)))?;
    let inputs = free_inputs(
        FreeInputSource {
            program: original,
            ir,
            db,
            resolved,
            nodes,
            owner: owner.id,
        },
        fact.node,
        node,
        predicate,
    )?;
    let rule = format!(
        "{}.sendWhen.{}.{}.{}",
        owner.canonical, site.source.sha256, site.node.start, site.node.end
    );
    let descriptor = serde_json::json!({
        "rule": rule, "owner": owner.canonical, "source": site.source,
        "node": site.node, "statement": site.statement,
        "target": operation, "binding": deployment_binding, "sourceBinding": binding,
        "inputs": inputs.iter().map(|input| serde_json::json!({"name":input.name,"type":input.type_id})).collect::<Vec<_>>(),
    });
    Ok((
        *span,
        PreparedSendGuard {
            rule,
            predicate: predicate.clone(),
            descriptor,
            inputs,
        },
    ))
}

fn prepare_owner_guards(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    owner: &IrItem,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    guards: &mut HashMap<Span, PreparedSendGuard>,
) -> Result<Option<Vec<serde_json::Value>>, SendGuardGap> {
    let original = context.original();
    let ir = context.ir();
    let db = context.db();
    let resolved = context.resolved();
    let IrItemKind::Scenario {
        guards: leading,
        effects,
        ..
    } = &owner.kind
    else {
        return Ok(None);
    };
    let mut sends = Vec::new();
    collect_sends(leading, &mut sends, 0)?;
    collect_sends(effects, &mut sends, 0)?;
    if sends.is_empty() {
        return Ok(None);
    }
    let sites = super::scenario_decisions::serialize_original_decision_sources_with_context(
        context, owner,
    )
    .ok_or_else(|| {
        gap(
            "complete original SEND decision correspondence unavailable",
            Some(owner.span),
        )
    })?;
    let sites = sites
        .iter()
        .filter(|site| site.stage == "send-dispatch")
        .collect::<Vec<_>>();
    if sites.len() != sends.len() {
        return Err(gap(
            "original SEND dispatch census mismatch",
            Some(owner.span),
        ));
    }
    let source_facts = original
        .scenario_disclosures()
        .get(&owner.id)
        .and_then(|disclosure| disclosure.source_facts())
        .and_then(|facts| facts.decision_sites.as_ref())
        .ok_or_else(|| gap("original SEND source facts unavailable", Some(owner.span)))?;
    let mut descriptors = Vec::new();
    for (send, site) in sends.into_iter().zip(sites) {
        let (span, guard) = prepare_send_guard(
            original,
            ir,
            db,
            resolved,
            nodes,
            owner,
            source_facts,
            send,
            site,
        )?;
        descriptors.push(guard.descriptor.clone());
        if guards.len() >= 200 || guards.insert(span, guard).is_some() {
            return Err(gap(
                "duplicate or excessive original SEND guard",
                Some(span),
            ));
        }
    }
    Ok(Some(descriptors))
}

pub(super) fn prepare_with_context(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Result<PreparedSendGuards, SendGuardGap> {
    let program = context.program();
    let ir = context.ir();
    let original = context.original();
    let fresh = context.fresh();
    let trees = context.trees();
    if original.types.node_types != program.types.node_types
        || original.types.symbol_types != program.types.symbol_types
    {
        return Err(gap(
            "original SEND checked type correspondence mismatch",
            None,
        ));
    }
    if execution_closure(ir) != execution_closure(fresh)
        || ir.value_constraints != fresh.value_constraints
    {
        return Err(gap("original whole IR execution closure mismatch", None));
    }
    let mut nodes = HashMap::new();
    for (_, tree) in trees {
        for node in tree.descendants() {
            if nodes.len() >= 200000 {
                return Err(gap("SEND source census capacity exceeded", Some(node.span)));
            }
            nodes.insert(NodeKey::of(node), node);
        }
    }
    let mut guards = HashMap::new();
    let mut by_owner = BTreeMap::new();
    for owner in &ir.items {
        if let Some(descriptors) = prepare_owner_guards(context, owner, &nodes, &mut guards)? {
            by_owner.insert(
                owner.canonical.clone(),
                serde_json::Value::Array(descriptors),
            );
        }
    }
    Ok(PreparedSendGuards {
        guards,
        by_owner,
        closure: format!("{ir:?}"),
    })
}

fn collect_sends<'a>(
    statements: &'a [IrStmt],
    out: &mut Vec<&'a IrStmt>,
    depth: usize,
) -> Result<(), SendGuardGap> {
    if depth > 64 {
        return Err(gap("SEND statement depth exceeded", None));
    }
    for statement in statements {
        match statement {
            IrStmt::Send { when: Some(_), .. } => {
                if out.len() >= 200 {
                    return Err(gap("SEND dispatch capacity exceeded", None));
                }
                out.push(statement);
            }
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => {
                collect_sends(then_branch, out, depth + 1)?;
                collect_sends(else_branch, out, depth + 1)?;
            }
            IrStmt::For { body, .. } => collect_sends(body, out, depth + 1)?,
            IrStmt::Match { arms, .. } => {
                for arm in arms {
                    collect_sends(&arm.body, out, depth + 1)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn contained(outer: NodeKey, inner: NodeKey) -> bool {
    inner.file == outer.file && inner.start >= outer.start && inner.end <= outer.end
}

fn declaration_type(
    program: &CheckedProgram,
    resolved: &resolve::ResolveTables,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    owner: SymbolId,
    predicate: NodeKey,
    key: NodeKey,
    binding: &Binding,
) -> Result<Option<ResolvedType>, SendGuardGap> {
    let fail = || {
        gap(
            "free SEND lexical declaration has no supported transport",
            Some(Span::new(key.file, key.start, key.end)),
        )
    };
    let ty = match binding {
        Binding::Context(_) | Binding::Builtin { .. } | Binding::Predicate => return Ok(None),
        Binding::Symbol(id) => {
            let symbol = resolved.symbols.get(id.0 as usize).ok_or_else(fail)?;
            let SymbolKind::Param {
                owner: declared_owner,
                ..
            } = symbol.kind
            else {
                return Ok(None);
            };
            if declared_owner != owner {
                return Err(fail());
            }
            program
                .types
                .symbol_types
                .get(id)
                .cloned()
                .ok_or_else(fail)?
        }
        Binding::QueryAlias { node } if contained(predicate, *node) => return Ok(None),
        Binding::Let { node } => {
            if contained(predicate, *node) {
                return Ok(None);
            }
            let declaration = nodes.get(node).ok_or_else(fail)?;
            let initializer = kids(declaration)
                .into_iter()
                .find(|child| resolve::is_expression(child.kind))
                .ok_or_else(fail)?;
            program
                .types
                .node_types
                .get(&NodeKey::of(initializer))
                .cloned()
                .ok_or_else(fail)?
        }
        Binding::CreateAs { node } => {
            let declaration = nodes.get(node).ok_or_else(fail)?;
            if declaration.kind != SyntaxKind::Create {
                return Err(fail());
            }
            let target = kids(declaration)
                .into_iter()
                .find(|child| child.kind == SyntaxKind::Path)
                .ok_or_else(fail)?;
            let model = *resolved
                .node_symbol
                .get(&NodeKey::of(target))
                .ok_or_else(fail)?;
            if !matches!(
                resolved
                    .symbols
                    .get(model.0 as usize)
                    .ok_or_else(fail)?
                    .kind,
                SymbolKind::Model { .. }
            ) {
                return Err(fail());
            }
            ResolvedType::Record {
                symbol: model,
                stored: true,
            }
        }
        Binding::CohortChild { model, .. } => ResolvedType::Record {
            symbol: *model,
            stored: true,
        },
        // Defaults and callee bodies are not visited. External lexical query,
        // loop, effect-result and opaque imported values require their own codec.
        _ => return Err(fail()),
    };
    Ok(Some(ty))
}

#[derive(Clone, Copy)]
struct FreeInputSource<'a> {
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &'a SourceDb,
    resolved: &'a resolve::ResolveTables,
    nodes: &'a HashMap<NodeKey, &'a SyntaxNode>,
    owner: SymbolId,
}

/// Refine one captured first-row value only at its original SEND occurrence.
/// No guard-local check, copied nullable alias, scalar or nullable parameter
/// acquires this proof. The existing whole original/fresh seal precedes this
/// producer, and the native receiver must still supply the actual selected row.
fn narrowing_owner_mismatch(
    owner: &IrItem,
    scenario: &ScenarioData,
    facts: &CheckedScenarioSource,
    symbol: &Symbol,
    actual_model: &IrItem,
    source_owner: SymbolId,
    occurrence_type_ok: bool,
    model: SymbolId,
    module_name: &str,
    occurrence_kind: SyntaxKind,
) -> bool {
    owner.id != source_owner
        || owner.module != scenario.module
        || facts.scenario != source_owner
        || facts.node != scenario.node
        || facts.source.module != module_name
        || !matches!(symbol.kind, SymbolKind::Model { .. })
        || symbol.id != model
        || symbol.module != scenario.module
        || actual_model.id != model
        || actual_model.module != symbol.module
        || actual_model.canonical != symbol.canonical
        || !matches!(actual_model.kind, IrItemKind::Model { .. })
        || !occurrence_type_ok
        || occurrence_kind != SyntaxKind::NameRef
}

fn narrowing_header<'a>(
    source: FreeInputSource<'a>,
    occurrence: NodeKey,
    declaration: NodeKey,
    model: SymbolId,
    declared_type: &ResolvedType,
) -> Option<(
    &'a ScenarioData,
    &'a CheckedScenarioSource,
    &'a IrItem,
    ResolvedType,
)> {
    let scenario = source.program.effects.scenarios.get(&source.owner)?;
    let facts = source
        .program
        .scenario_disclosures()
        .get(&source.owner)?
        .source_facts()?;
    let owner = source.ir.items.get(source.owner.0 as usize)?;
    let IrItemKind::Scenario { .. } = &owner.kind else {
        return None;
    };
    let symbol = source.resolved.symbols.get(model.0 as usize)?;
    let actual_model = source.ir.items.get(model.0 as usize)?;
    let capture_type = ResolvedType::Record {
        symbol: model,
        stored: true,
    };
    let module_name = source
        .program
        .modules
        .get(scenario.module.0 as usize)
        .map(|module| module.name.as_str())?;
    let occurrence_kind = source.nodes.get(&occurrence).map(|node| node.kind)?;
    let occurrence_type_ok =
        source.program.types.node_types.get(&occurrence) == Some(&capture_type);
    if narrowing_owner_mismatch(
        owner,
        scenario,
        facts,
        symbol,
        actual_model,
        source.owner,
        occurrence_type_ok,
        model,
        module_name,
        occurrence_kind,
    ) {
        return None;
    }
    Some((scenario, facts, owner, capture_type))
}

fn select_narrowing_query(
    facts: &CheckedScenarioSource,
    declaration: NodeKey,
    model: SymbolId,
) -> Option<(&DisclosureQuery, &DisclosureFirstQuery)> {
    let mut queries = facts.queries.as_deref()?.iter().filter(|query| {
        query
            .first
            .as_ref()
            .is_some_and(|first| first.binding == declaration)
    });
    let query = queries.next()?;
    if queries.next().is_some()
        || query.model != model
        || query.source != facts.source
        || query.count.is_some()
        || query.projection.is_some()
    {
        return None;
    }
    Some((query, query.first.as_ref()?))
}

fn resolve_narrowing_positions(
    scenario: &ScenarioData,
    declaration: NodeKey,
    predicate: NodeKey,
) -> Option<((usize, &Effect), (usize, &Effect))> {
    let (let_index, let_effect) = scenario
        .effects
        .iter()
        .enumerate()
        .find(|(_, effect)| effect.node == declaration)?;
    let (send_index, send_effect) =
        scenario.effects.iter().enumerate().find(|(_, effect)| {
            effect.verb == EffectVerb::Send && effect.when == Some(predicate)
        })?;
    if let_index >= send_index
        || declaration.end > send_effect.node.start
        || !contained(send_effect.node, predicate)
    {
        return None;
    }
    Some(((let_index, let_effect), (send_index, send_effect)))
}

fn resolve_narrowing_call<'a>(
    source: FreeInputSource<'a>,
    first: &DisclosureFirstQuery,
    query: &DisclosureQuery,
    let_value: NodeKey,
) -> Option<(
    NodeKey,
    &'a SelectedCall,
    &'a CheckedCollectionCall,
    &'a CheckedQuery,
    NodeKey,
)> {
    let call = first_send_group(source, let_value)?;
    let selected = source.program.types.selected_calls.get(&call)?;
    let collection = source.program.types.checked_collection_calls.get(&call)?;
    let [argument] = selected.arguments.as_slice() else {
        return None;
    };
    let checked_query = source.program.types.checked_queries.get(&query.node)?;
    let arg_group = first_send_group(source, *argument)?;
    Some((call, selected, collection, checked_query, arg_group))
}

fn narrowing_call_mismatch(
    source: FreeInputSource<'_>,
    call: NodeKey,
    selected: &SelectedCall,
    collection: &CheckedCollectionCall,
    checked_query: &CheckedQuery,
    arg_group: NodeKey,
    first: &DisclosureFirstQuery,
    query: &DisclosureQuery,
    model: SymbolId,
    declared_type: &ResolvedType,
    let_value: NodeKey,
) -> bool {
    call != first.call
        || collection.node != call
        || collection.builtin != "first"
        || collection.model != model
        || collection.query != query.node
        || Some(collection.alias) != query.alias
        || collection.predicate.is_some()
        || collection.overload != first.overload
        || !matches!(&selected.target,SelectedCallTarget::Builtin {id,overload}
            if id=="first" && *overload==first.overload)
        || selected.slots.as_slice() != [Some(0)]
        || arg_group != query.node
        || checked_query.node != query.node
        || checked_query.projection.is_some()
        || checked_query.domain != query.domain
        || source.program.types.node_types.get(&call) != Some(declared_type)
        || source.program.types.node_types.get(&let_value) != Some(declared_type)
}

fn resolve_narrowing_let<'a>(
    source: FreeInputSource<'a>,
    let_effect: &Effect,
    declaration: NodeKey,
    let_value: NodeKey,
) -> Option<Vec<&'a str>> {
    let let_node = source.nodes.get(&declaration)?;
    let let_values: Vec<_> = kids(let_node)
        .into_iter()
        .filter(|child| resolve::is_expression(child.kind))
        .map(NodeKey::of)
        .collect();
    let text = &source.db.get(declaration.file)?.text;
    let let_names: Vec<_> = kids(let_node)
        .into_iter()
        .filter_map(|child| name_text(child, text))
        .collect();
    if let_effect.verb != EffectVerb::Let
        || let_effect.binding.as_deref() != let_names.get(1).copied()
        || let_node.kind != SyntaxKind::Let
        || let_names.first().copied() != Some("let")
        || let_names.len() != 2
        || let_values.as_slice() != [let_value]
    {
        return None;
    }
    Some(let_names)
}

fn check_narrowing_seal(
    source: FreeInputSource<'_>,
    owner: &IrItem,
    facts: &CheckedScenarioSource,
    query: &DisclosureQuery,
    call: NodeKey,
    let_index: usize,
    send_index: usize,
    declaration: NodeKey,
    predicate: NodeKey,
    send_node: NodeKey,
    occurrence: NodeKey,
    capture_type: &ResolvedType,
    declared_type: &ResolvedType,
    binding_name: &str,
) -> Option<()> {
    let IrItemKind::Scenario {
        effects: actual_effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrStmt::Let {
        name: actual_name,
        value: actual_value,
        span: actual_let,
    } = actual_effects.get(let_index)?
    else {
        return None;
    };
    let IrStmt::Send {
        when: Some(actual_predicate),
        span: actual_send,
        ..
    } = actual_effects.get(send_index)?
    else {
        return None;
    };
    let original = facts
        .creates
        .as_deref()?
        .iter()
        .find(|created| created.source == facts.source)?;
    let sealed = super::scenario_receipts::checked_first_query_ir(
        source.ir,
        original,
        actual_value,
        call,
        source.db,
    )?;
    if *actual_let != send_key_span(declaration)
        || actual_name.as_str() != binding_name
        || actual_value.ty != *declared_type
        || actual_value.span != send_key_span(call)
        || *actual_send != send_key_span(send_node)
        || actual_predicate.span != send_key_span(predicate)
        || sealed != query
        || !same_send_occurrence(actual_predicate, occurrence, binding_name, capture_type)
        || !contained(predicate, occurrence)
    {
        return None;
    }
    Some(())
}

fn check_require_control(
    source: FreeInputSource<'_>,
    facts: &CheckedScenarioSource,
    sites: &[CheckedDecisionSite],
    owner: &IrItem,
    effect: &Effect,
    index: usize,
    send_node: NodeKey,
    declaration: NodeKey,
    declared_type: &ResolvedType,
    binding_name: &str,
) -> Option<Option<NodeKey>> {
    let mut controls = sites.iter().filter(|site| {
        site.owner == source.owner
            && site.stage == CheckedDecisionStage::BodyRequire
            && site.statement == effect.node
            && Some(site.node) == effect.cond
    });
    let control = controls.next()?;
    if controls.next().is_some()
        || control.source != facts.source
        || control.position.as_slice() != [CheckedDecisionPosition::Body(index)]
    {
        return None;
    }
    let Some(presence) =
        compulsory_first_presence(source, control.node, declaration, declared_type, 0)
    else {
        return Some(None);
    };
    let IrItemKind::Scenario {
        effects: actual_effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrStmt::Require { cond, span, .. } = actual_effects.get(index)? else {
        return None;
    };
    if *span != send_key_span(effect.node)
        || !compiled_first_presence(
            source,
            cond,
            control.node,
            presence,
            binding_name,
            declared_type,
            0,
        )
    {
        return None;
    }
    Some(Some(presence))
}

fn find_compulsory_narrowing(
    source: FreeInputSource<'_>,
    scenario: &ScenarioData,
    facts: &CheckedScenarioSource,
    owner: &IrItem,
    query: &DisclosureQuery,
    call: NodeKey,
    declaration: NodeKey,
    predicate: NodeKey,
    send_node: NodeKey,
    occurrence: NodeKey,
    binding_name: &str,
    declared_type: &ResolvedType,
    model: SymbolId,
    send_index: usize,
    let_index: usize,
) -> Option<PreparedFirstRowNarrowing> {
    let sites = facts.decision_sites.as_deref()?;
    let mut dispatches = sites.iter().filter(|site| {
        site.owner == source.owner
            && site.stage == CheckedDecisionStage::SendDispatch
            && site.statement == send_node
            && site.node == predicate
    });
    let dispatch = dispatches.next()?;
    if dispatches.next().is_some()
        || dispatch.source != facts.source
        || dispatch.position.as_slice() != [CheckedDecisionPosition::Body(send_index)]
    {
        return None;
    }
    // An earlier top-level Require is compulsory if execution reaches SEND.
    // Only AND operands are compulsory within its true predicate; OR and a
    // local when= presence check cannot justify freezing a nonnull snapshot.
    for (index, effect) in scenario
        .effects
        .iter()
        .enumerate()
        .take(send_index)
        .skip(let_index + 1)
    {
        if effect.verb != EffectVerb::Require
            || effect.node.end > send_node.start
            || !effect.then_effects.is_empty()
            || !effect.else_effects.is_empty()
            || !effect.match_arms.is_empty()
        {
            continue;
        }
        let Some(presence) = check_require_control(
            source,
            facts,
            sites,
            owner,
            effect,
            index,
            send_node,
            declaration,
            declared_type,
            binding_name,
        )? else {
            continue;
        };
        return Some(PreparedFirstRowNarrowing {
            declared_type: declared_type.clone(),
            model,
            query_id: query.id.clone(),
            first_call: call,
            binding: declaration,
            presence,
            require: effect.node,
            occurrence,
            source: facts.source.clone(),
        });
    }
    None
}

fn checked_first_row_narrowing(
    source: FreeInputSource<'_>,
    predicate: NodeKey,
    occurrence: NodeKey,
    binding: &Binding,
    declared_type: &ResolvedType,
) -> Option<PreparedFirstRowNarrowing> {
    let Binding::Let { node: declaration } = binding else {
        return None;
    };
    let ResolvedType::Nullable(inner) = declared_type else {
        return None;
    };
    let ResolvedType::Record {
        symbol: model,
        stored: true,
    } = inner.as_ref()
    else {
        return None;
    };
    let (scenario, facts, owner, capture_type) = narrowing_header(
        source,
        occurrence,
        *declaration,
        *model,
        declared_type,
    )?;
    let (query, first) = select_narrowing_query(facts, *declaration, *model)?;
    let ((let_index, let_effect), (send_index, send_effect)) =
        resolve_narrowing_positions(scenario, *declaration, predicate)?;
    let let_value = let_effect.value?;
    let (call, selected, collection, checked_query, arg_group) =
        resolve_narrowing_call(source, first, query, let_value)?;
    if narrowing_call_mismatch(
        source,
        call,
        selected,
        collection,
        checked_query,
        arg_group,
        first,
        query,
        *model,
        declared_type,
        let_value,
    ) {
        return None;
    }
    let let_names = resolve_narrowing_let(source, let_effect, *declaration, let_value)?;
    check_narrowing_seal(
        source,
        owner,
        facts,
        query,
        call,
        let_index,
        send_index,
        *declaration,
        predicate,
        send_effect.node,
        occurrence,
        &capture_type,
        declared_type,
        let_names[1],
    )?;
    find_compulsory_narrowing(
        source,
        scenario,
        facts,
        owner,
        query,
        call,
        *declaration,
        predicate,
        send_effect.node,
        occurrence,
        let_names[1],
        declared_type,
        *model,
        send_index,
        let_index,
    )
}

fn send_key_span(key: NodeKey) -> Span {
    Span::new(key.file, key.start, key.end)
}

fn same_send_occurrence(root: &TypedExpr, key: NodeKey, name: &str, ty: &ResolvedType) -> bool {
    let mut pending = vec![(root, 0usize)];
    let mut visits = 0;
    while let Some((value, depth)) = pending.pop() {
        visits += 1;
        if visits > 16384 || depth >= 64 {
            return false;
        }
        if value.span == send_key_span(key) {
            return value.ty == *ty && matches!(&value.expr,IrExpr::Name(actual) if actual==name);
        }
        match &value.expr {
            IrExpr::Member { base, .. }
            | IrExpr::Unary { operand: base, .. }
            | IrExpr::Lambda { body: base, .. }
            | IrExpr::DeliveryRead { record: base, .. } => pending.push((base, depth + 1)),
            IrExpr::Binary { left, right, .. } => {
                pending.extend([(left.as_ref(), depth + 1), (right.as_ref(), depth + 1)])
            }
            IrExpr::Call { args, .. }
            | IrExpr::BoundCall { args, .. }
            | IrExpr::Array(args)
            | IrExpr::Format { args, .. } => {
                pending.extend(args.iter().map(|value| (value, depth + 1)))
            }
            IrExpr::Object(entries) => {
                pending.extend(entries.iter().map(|(_, value)| (value, depth + 1)))
            }
            IrExpr::HasRole {
                person: Some(person),
                ..
            } => pending.push((person, depth + 1)),
            _ => {}
        }
    }
    false
}

/// Verify the same compulsory path in actual typed IR. Source-only proof does
/// not repair changed order, OR control or a different lexical occurrence.
fn compiled_first_presence(
    source: FreeInputSource<'_>,
    actual: &TypedExpr,
    key: NodeKey,
    presence: NodeKey,
    name: &str,
    declared_type: &ResolvedType,
    depth: usize,
) -> bool {
    if depth >= 64 || actual.ty != ResolvedType::Scalar(Scalar::Bool) {
        return false;
    }
    let Some(key) = first_send_group(source, key) else {
        return false;
    };
    let Some(node) = source.nodes.get(&key) else {
        return false;
    };
    if actual.span != send_key_span(key) || node.kind != SyntaxKind::Binary {
        return false;
    }
    let operands: Vec<_> = kids(node)
        .into_iter()
        .filter(|child| resolve::is_expression(child.kind))
        .map(NodeKey::of)
        .collect();
    let [left_key, right_key] = operands.as_slice() else {
        return false;
    };
    let Some(text) = source.db.get(key.file).map(|source| source.text.as_str()) else {
        return false;
    };
    let operator = kids(node)
        .into_iter()
        .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))
        .and_then(|node| node.token())
        .map(|token| token.text(text));
    if key == presence {
        let IrExpr::Binary {
            op: IrBinOp::Ne,
            left,
            right,
        } = &actual.expr
        else {
            return false;
        };
        return operator == Some("!=")
            && left.span == send_key_span(*left_key)
            && right.span == send_key_span(*right_key)
            && left.ty == *declared_type
            && matches!(&left.expr,IrExpr::Name(actual) if actual==name)
            && right.ty == ResolvedType::Null
            && matches!(right.expr, IrExpr::Null);
    }
    let IrExpr::Binary {
        op: IrBinOp::And,
        left,
        right,
    } = &actual.expr
    else {
        return false;
    };
    operator == Some("and")
        && (compiled_first_presence(
            source,
            left,
            *left_key,
            presence,
            name,
            declared_type,
            depth + 1,
        ) || compiled_first_presence(
            source,
            right,
            *right_key,
            presence,
            name,
            declared_type,
            depth + 1,
        ))
}

fn first_send_group(source: FreeInputSource<'_>, mut key: NodeKey) -> Option<NodeKey> {
    for _ in 0..64 {
        let node = source.nodes.get(&key)?;
        if node.kind != SyntaxKind::Group {
            return Some(key);
        }
        let values: Vec<_> = kids(node)
            .into_iter()
            .filter(|child| resolve::is_expression(child.kind))
            .map(NodeKey::of)
            .collect();
        let [value] = values.as_slice() else {
            return None;
        };
        key = *value;
    }
    None
}

fn check_presence_operands(
    source: FreeInputSource<'_>,
    key: NodeKey,
    left: NodeKey,
    right: NodeKey,
    binding: NodeKey,
    declared_type: &ResolvedType,
    text: &str,
) -> Option<NodeKey> {
    let value = first_send_group(source, left)?;
    let absent = first_send_group(source, right)?;
    let null = source.nodes.get(&absent)?;
    (source.nodes.get(&value)?.kind==SyntaxKind::NameRef
        && matches!(source.resolved.node_binding.get(&value),Some(Binding::Let {node}) if *node==binding)
        && source.program.types.node_types.get(&value)==Some(declared_type)
        && null.kind==SyntaxKind::Literal && text.get(absent.start as usize..absent.end as usize)?.trim()=="null"
        && source.program.types.node_types.get(&absent)==Some(&ResolvedType::Null))
        .then_some(key)
}

fn compulsory_first_presence(
    source: FreeInputSource<'_>,
    key: NodeKey,
    binding: NodeKey,
    declared_type: &ResolvedType,
    depth: usize,
) -> Option<NodeKey> {
    if depth >= 64 {
        return None;
    }
    let key = first_send_group(source, key)?;
    let node = source.nodes.get(&key)?;
    if node.kind != SyntaxKind::Binary
        || source.program.types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return None;
    }
    let text = &source.db.get(key.file)?.text;
    let operands: Vec<_> = kids(node)
        .into_iter()
        .filter(|child| resolve::is_expression(child.kind))
        .map(NodeKey::of)
        .collect();
    let [left, right] = operands.as_slice() else {
        return None;
    };
    let operator = kids(node)
        .into_iter()
        .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?
        .token()?
        .text(text);
    if operator == "and" {
        return compulsory_first_presence(source, *left, binding, declared_type, depth + 1)
            .or_else(|| {
                compulsory_first_presence(source, *right, binding, declared_type, depth + 1)
            });
    }
    if operator != "!=" {
        return None;
    }
    check_presence_operands(
        source,
        key,
        *left,
        *right,
        binding,
        declared_type,
        text,
    )
}

fn collect_source_names(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    predicate_node: &SyntaxNode,
) -> Result<
    (
        Vec<PreparedSendInput>,
        HashMap<String, String>,
        HashSet<Span>,
    ),
    SendGuardGap,
> {
    let original_source = source;
    let FreeInputSource {
        program,
        ir,
        db,
        resolved,
        nodes,
        owner,
    } = source;
    let mut inputs = Vec::<PreparedSendInput>::new();
    let mut identities = HashMap::<String, String>::new();
    let mut source_reads = HashSet::new();
    for node in predicate_node
        .descendants()
        .filter(|node| node.kind == SyntaxKind::NameRef)
    {
        let key = NodeKey::of(node);
        let Some(binding) = resolved.node_binding.get(&key) else {
            if program.types.resolved_cases.contains(&key) {
                continue;
            }
            return Err(gap(
                "SEND source name has no original binding",
                Some(node.span),
            ));
        };
        let Some(ty) =
            declaration_type(program, resolved, nodes, owner, predicate_key, key, binding)?
        else {
            continue;
        };
        let source = db
            .get(key.file)
            .ok_or_else(|| gap("missing SEND name source", Some(node.span)))?;
        let name = kids(node)
            .into_iter()
            .find_map(|child| name_text(child, &source.text))
            .ok_or_else(|| gap("SEND lexical name missing original token", Some(node.span)))?
            .to_string();
        let (declaration, symbol) = match binding {
            Binding::Symbol(id) => {
                let SymbolKind::Param { type_node, .. } = resolved.symbols[id.0 as usize].kind
                else {
                    unreachable!("declaration_type admits only owning parameters")
                };
                (type_node, Some(*id))
            }
            Binding::Let { node }
            | Binding::CreateAs { node }
            | Binding::CohortChild { node, .. } => (*node, None),
            _ => unreachable!("declaration_type admits only original lexical declarations"),
        };
        let narrowing =
            checked_first_row_narrowing(original_source, predicate_key, key, binding, &ty);
        let capture_type = match &narrowing {
            Some(fact) => ResolvedType::Record {
                symbol: fact.model,
                stored: true,
            },
            None => ty,
        };
        let type_id = input_type(&capture_type, program, ir, symbol, 0).ok_or_else(|| {
            gap(
                "free SEND lexical type has no canonical finite codec",
                Some(node.span),
            )
        })?;
        source_reads.insert(node.span);
        let identity = format!("{binding:?}");
        if let Some(prior) = identities.get(&name) {
            if prior != &identity {
                return Err(gap(
                    "different free SEND bindings share an emitted name",
                    Some(node.span),
                ));
            }
            continue;
        }
        if inputs.len() >= 200 {
            return Err(gap("free SEND input capacity exceeded", Some(node.span)));
        }
        identities.insert(name.clone(), identity);
        inputs.push(PreparedSendInput {
            name: name.clone(),
            type_id,
            value: TypedExpr::new(IrExpr::Name(name), capture_type, node.span),
            declaration,
            symbol,
            owner,
            ordinal: inputs.len(),
            narrowing,
        });
    }
    Ok((inputs, identities, source_reads))
}

fn push_query_values<'e>(
    query: &'e IrQuery,
    pending: &mut Vec<(&'e TypedExpr, usize)>,
    depth: usize,
) {
    if let IrQueryDomain::Value { base, .. } = &query.domain {
        pending.push((base, depth + 1));
    }
    if let Some(order) = &query.value_order {
        pending.push((&order.key, depth + 1));
    }
    for value in [
        &query.parent,
        &query.where_pred,
        &query.limit,
        &query.archived,
        &query.select,
    ]
    .into_iter()
    .flatten()
    {
        pending.push((value, depth + 1));
    }
}

fn check_evaluated_name(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    owner: SymbolId,
    value: &TypedExpr,
    name: &str,
    identities: &HashMap<String, String>,
    evaluated: &mut HashSet<Span>,
) -> Result<(), SendGuardGap> {
    let program = source.program;
    let resolved = source.resolved;
    let nodes = source.nodes;
    let key = NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: SyntaxKind::NameRef as u8,
    };
    let binding = resolved.node_binding.get(&key).ok_or_else(|| {
        gap(
            "evaluated SEND name lacks original lexical source",
            Some(value.span),
        )
    })?;
    if declaration_type(program, resolved, nodes, owner, predicate_key, key, binding)?.is_some()
    {
        if !identities.contains_key(name) {
            return Err(gap(
                "evaluated SEND lexical name differs from source binding",
                Some(value.span),
            ));
        }
        evaluated.insert(value.span);
    }
    Ok(())
}

fn check_evaluated_names(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    predicate: &TypedExpr,
    identities: &HashMap<String, String>,
) -> Result<HashSet<Span>, SendGuardGap> {
    let owner = source.owner;
    let mut pending = vec![(predicate, 0usize)];
    let mut evaluated = HashSet::new();
    let mut count = 0usize;
    while let Some((value, depth)) = pending.pop() {
        count += 1;
        if depth > 64 || count > 16384 {
            return Err(gap(
                "SEND evaluated name census capacity exceeded",
                Some(value.span),
            ));
        }
        match &value.expr {
            IrExpr::Name(name) => {
                check_evaluated_name(
                    source,
                    predicate_key,
                    owner,
                    value,
                    name,
                    identities,
                    &mut evaluated,
                )?;
            }
            IrExpr::Member { base, .. }
            | IrExpr::Unary { operand: base, .. }
            | IrExpr::Lambda { body: base, .. }
            | IrExpr::DeliveryRead { record: base, .. } => pending.push((base, depth + 1)),
            IrExpr::Binary { left, right, .. } => {
                pending.push((left, depth + 1));
                pending.push((right, depth + 1));
            }
            IrExpr::Call { args, .. }
            | IrExpr::BoundCall { args, .. }
            | IrExpr::Array(args)
            | IrExpr::Format { args, .. } => {
                pending.extend(args.iter().map(|value| (value, depth + 1)))
            }
            IrExpr::Object(fields) => {
                pending.extend(fields.iter().map(|(_, value)| (value, depth + 1)))
            }
            IrExpr::Query(query) => {
                push_query_values(query, &mut pending, depth);
            }
            IrExpr::HasRole { person, .. } => {
                if let Some(value) = person {
                    pending.push((value, depth + 1));
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
            | IrExpr::Datetime(_) => {}
            _ => {
                return Err(gap(
                    "SEND predicate expression has no complete lexical transport",
                    Some(value.span),
                ));
            }
        }
    }
    Ok(evaluated)
}

fn free_inputs(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    predicate_node: &SyntaxNode,
    predicate: &TypedExpr,
) -> Result<Vec<PreparedSendInput>, SendGuardGap> {
    let (inputs, identities, source_reads) =
        collect_source_names(source, predicate_key, predicate_node)?;
    let evaluated = check_evaluated_names(source, predicate_key, predicate, &identities)?;
    if source_reads != evaluated {
        return Err(gap(
            "source/evaluated free SEND name census differs",
            Some(predicate.span),
        ));
    }
    Ok(inputs)
}

/// Keep only exact catalog-produced nominal leaves and source-owned aliases.
/// The emitter additionally requires their sealed schema inventory.
fn input_type(
    ty: &ResolvedType,
    program: &CheckedProgram,
    ir: &IrProgram,
    symbol: Option<SymbolId>,
    depth: usize,
) -> Option<String> {
    if depth > 64 {
        return None;
    }
    match ty {
        ResolvedType::Nullable(inner) => Some(format!(
            "{}?",
            input_type(inner, program, ir, symbol, depth + 1)?
        )),
        ResolvedType::Array { element, .. } => Some(format!(
            "{}[]",
            input_type(element, program, ir, symbol, depth + 1)?
        )),
        _ => {
            if let Some(alias) = symbol.and_then(|id| ir.value_constraints.get(&id)?.alias) {
                let item = ir.items.get(alias.0 as usize)?;
                let original = program.symbols.get(alias.0 as usize)?;
                if item.id != alias
                    || original.id != alias
                    || item.canonical != original.canonical
                    || item.module != original.module
                    || ir.value_constraints.get(&alias)?.alias != Some(alias)
                {
                    return None;
                }
                return Some(item.canonical.clone());
            }
            if let Some(name) = crate::analysis::types::checked_standard_nominal_name(ty) {
                return Some(name.to_string());
            }
            serial_type(ty, program, ir, depth)
        }
    }
}

