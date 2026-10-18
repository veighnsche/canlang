//! Private original SEND predicate preparation; no execution authority.
use std::collections::{BTreeMap, HashMap, HashSet};

#[cfg(test)]
use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::{self, Binding, SymbolId, SymbolKind};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, kids, name_text};
use crate::source::{SourceDb, Span};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{IrBinOp, IrExpr, IrItemKind, IrProgram, IrQueryDomain, IrStmt, TypedExpr};
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

#[cfg(test)]
pub(super) fn prepare(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Result<PreparedSendGuards, SendGuardGap> {
    let context = super::scenario_decisions::FreshSourceContext::prepare(program, ir, db, catalog)
        .map_err(source_preparation_gap)?;
    prepare_with_context(&context)
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

pub(super) fn prepare_with_context(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Result<PreparedSendGuards, SendGuardGap> {
    let program = context.program();
    let ir = context.ir();
    let db = context.db();
    let original = context.original();
    let fresh = context.fresh();
    let trees = context.trees();
    let resolved = context.resolved();
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
        let IrItemKind::Scenario {
            guards: leading,
            effects,
            ..
        } = &owner.kind
        else {
            continue;
        };
        let mut sends = Vec::new();
        collect_sends(leading, &mut sends, 0)?;
        collect_sends(effects, &mut sends, 0)?;
        if sends.is_empty() {
            continue;
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
                    nodes: &nodes,
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
            descriptors.push(descriptor.clone());
            if guards.len() >= 200
                || guards
                    .insert(
                        *span,
                        PreparedSendGuard {
                            rule,
                            predicate: predicate.clone(),
                            descriptor,
                            inputs,
                        },
                    )
                    .is_some()
            {
                return Err(gap(
                    "duplicate or excessive original SEND guard",
                    Some(*span),
                ));
            }
        }
        by_owner.insert(
            owner.canonical.clone(),
            serde_json::Value::Array(descriptors),
        );
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
fn checked_first_row_narrowing(
    source: FreeInputSource<'_>,
    predicate: NodeKey,
    occurrence: NodeKey,
    binding: &Binding,
    declared_type: &ResolvedType,
) -> Option<PreparedFirstRowNarrowing> {
    use crate::analysis::effects::EffectVerb;
    use crate::analysis::scenario_disclosure::{CheckedDecisionPosition, CheckedDecisionStage};
    use crate::analysis::types::SelectedCallTarget;
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
    let scenario = source.program.effects.scenarios.get(&source.owner)?;
    let facts = source
        .program
        .scenario_disclosures()
        .get(&source.owner)?
        .source_facts()?;
    let owner = source.ir.items.get(source.owner.0 as usize)?;
    let IrItemKind::Scenario {
        effects: actual_effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let symbol = source.resolved.symbols.get(model.0 as usize)?;
    let actual_model = source.ir.items.get(model.0 as usize)?;
    let capture_type = ResolvedType::Record {
        symbol: *model,
        stored: true,
    };
    if owner.id != source.owner
        || owner.module != scenario.module
        || facts.scenario != source.owner
        || facts.node != scenario.node
        || facts.source.module != source.program.modules.get(scenario.module.0 as usize)?.name
        || !matches!(symbol.kind, SymbolKind::Model { .. })
        || symbol.id != *model
        || symbol.module != scenario.module
        || actual_model.id != *model
        || actual_model.module != symbol.module
        || actual_model.canonical != symbol.canonical
        || !matches!(actual_model.kind, IrItemKind::Model { .. })
        || source.program.types.node_types.get(&occurrence) != Some(&capture_type)
        || source.nodes.get(&occurrence)?.kind != SyntaxKind::NameRef
    {
        return None;
    }
    let mut queries = facts.queries.as_deref()?.iter().filter(|query| {
        query
            .first
            .as_ref()
            .is_some_and(|first| first.binding == *declaration)
    });
    let query = queries.next()?;
    let first = query.first.as_ref()?;
    let (let_index, let_effect) = scenario
        .effects
        .iter()
        .enumerate()
        .find(|(_, effect)| effect.node == *declaration)?;
    let (send_index, send_effect) =
        scenario.effects.iter().enumerate().find(|(_, effect)| {
            effect.verb == EffectVerb::Send && effect.when == Some(predicate)
        })?;
    let call = first_send_group(source, let_effect.value?)?;
    let selected = source.program.types.selected_calls.get(&call)?;
    let collection = source.program.types.checked_collection_calls.get(&call)?;
    let [argument] = selected.arguments.as_slice() else {
        return None;
    };
    let checked_query = source.program.types.checked_queries.get(&query.node)?;
    let let_node = source.nodes.get(declaration)?;
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
    if queries.next().is_some()
        || query.model != *model
        || query.source != facts.source
        || query.count.is_some()
        || query.projection.is_some()
        || let_effect.verb != EffectVerb::Let
        || let_effect.binding.as_deref() != let_names.get(1).copied()
        || let_node.kind != SyntaxKind::Let
        || let_names.first().copied() != Some("let")
        || let_names.len() != 2
        || let_values.as_slice() != [let_effect.value?]
        || let_index >= send_index
        || declaration.end > send_effect.node.start
        || !contained(send_effect.node, predicate)
        || !contained(predicate, occurrence)
        || call != first.call
        || collection.node != call
        || collection.builtin != "first"
        || collection.model != *model
        || collection.query != query.node
        || Some(collection.alias) != query.alias
        || collection.predicate.is_some()
        || collection.overload != first.overload
        || !matches!(&selected.target,SelectedCallTarget::Builtin {id,overload}
            if id=="first" && *overload==first.overload)
        || selected.slots.as_slice() != [Some(0)]
        || first_send_group(source, *argument)? != query.node
        || checked_query.node != query.node
        || checked_query.projection.is_some()
        || checked_query.domain != query.domain
        || source.program.types.node_types.get(&call) != Some(declared_type)
        || source.program.types.node_types.get(&let_effect.value?) != Some(declared_type)
    {
        return None;
    }
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
    if *actual_let != send_key_span(*declaration)
        || actual_name.as_str() != let_names[1]
        || actual_value.ty != *declared_type
        || actual_value.span != send_key_span(call)
        || *actual_send != send_key_span(send_effect.node)
        || actual_predicate.span != send_key_span(predicate)
        || super::scenario_receipts::checked_first_query_ir(
            source.ir,
            original,
            actual_value,
            call,
            source.db,
        )? != query
        || !same_send_occurrence(actual_predicate, occurrence, let_names[1], &capture_type)
    {
        return None;
    }
    let sites = facts.decision_sites.as_deref()?;
    let mut dispatches = sites.iter().filter(|site| {
        site.owner == source.owner
            && site.stage == CheckedDecisionStage::SendDispatch
            && site.statement == send_effect.node
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
            || effect.node.end > send_effect.node.start
            || !effect.then_effects.is_empty()
            || !effect.else_effects.is_empty()
            || !effect.match_arms.is_empty()
        {
            continue;
        }
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
        if let Some(presence) =
            compulsory_first_presence(source, control.node, *declaration, declared_type, 0)
        {
            let IrStmt::Require { cond, span, .. } = actual_effects.get(index)? else {
                return None;
            };
            if *span != send_key_span(effect.node)
                || !compiled_first_presence(
                    source,
                    cond,
                    control.node,
                    presence,
                    let_names[1],
                    declared_type,
                    0,
                )
            {
                return None;
            }
            return Some(PreparedFirstRowNarrowing {
                declared_type: declared_type.clone(),
                model: *model,
                query_id: query.id.clone(),
                first_call: call,
                binding: *declaration,
                presence,
                require: effect.node,
                occurrence,
                source: facts.source.clone(),
            });
        }
    }
    None
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
    let value = first_send_group(source, *left)?;
    let absent = first_send_group(source, *right)?;
    let null = source.nodes.get(&absent)?;
    (source.nodes.get(&value)?.kind==SyntaxKind::NameRef
        && matches!(source.resolved.node_binding.get(&value),Some(Binding::Let {node}) if *node==binding)
        && source.program.types.node_types.get(&value)==Some(declared_type)
        && null.kind==SyntaxKind::Literal && text.get(absent.start as usize..absent.end as usize)?.trim()=="null"
        && source.program.types.node_types.get(&absent)==Some(&ResolvedType::Null))
        .then_some(key)
}

fn free_inputs(
    source: FreeInputSource<'_>,
    predicate_key: NodeKey,
    predicate_node: &SyntaxNode,
    predicate: &TypedExpr,
) -> Result<Vec<PreparedSendInput>, SendGuardGap> {
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
                if declaration_type(program, resolved, nodes, owner, predicate_key, key, binding)?
                    .is_some()
                {
                    if !identities.contains_key(name) {
                        return Err(gap(
                            "evaluated SEND lexical name differs from source binding",
                            Some(value.span),
                        ));
                    }
                    evaluated.insert(value.span);
                }
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

#[cfg(test)]
mod tests {
    use super::super::ir;
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    use crate::analysis::check_program;
    use crate::analysis::resolve::SymbolKind;
    use crate::syntax;

    const SOURCE: &str = r#"app SendSources
use std {TextGenerationV1 as LLM} from=deployment.llm
Given
 Branch {enabled:bool}
 Template {enabled:bool}
 Run {author:user}
 derive positive(value:int=abs(-1)):bool=value>0
 policy Branch read=members
 policy Template read=members
 policy Run read=members
When
 scenario ask(person:user,branch:Branch,amount:int?,prompt:text) by=members
  do
   let allowance=amount
   require allowance!=null
   create Run {author=person} as run
   send LLM.cancel {revision=1,source=prompt} when=active_member(run.author,team) and branch.enabled and allowance>0 and any(Run as candidate,candidate.author==run.author) and positive() as asked
 scenario generate(person:user,template:Template?,amount:int?,prompt:text) by=members
  require template!=null
  do
   let budget=amount
   require budget!=null
   create Run {author=person} as run
   send LLM.cancel {revision=1,source=prompt} when=active_member(run.author,team) and template.enabled and budget>0 as generated
Then
"#;

    fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
        let mut db = SourceDb::new();
        let file = db.add("send-sources.can".into(), SOURCE.into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, program, ir, catalog)
    }

    #[test]
    fn original_free_values_keep_declaration_types_and_exclude_context_statics_and_query_aliases() {
        let (db, program, ir, catalog) = fixture();
        let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let descriptors = prepared.by_owner(&ir).unwrap();
        assert_eq!(descriptors.len(), 2);
        for (owner, names, types, source_binding) in [
            (
                "SendSources.ask",
                vec!["run", "branch", "allowance"],
                vec!["SendSources.Run", "SendSources.Branch", "int?"],
                "asked",
            ),
            (
                "SendSources.generate",
                vec!["run", "template", "budget"],
                vec!["SendSources.Run", "SendSources.Template?", "int?"],
                "generated",
            ),
        ] {
            let descriptor = &descriptors[owner][0];
            assert_eq!(descriptor["owner"], owner);
            assert_eq!(descriptor["target"], "std.TextGenerationV1.cancel");
            assert_eq!(descriptor["binding"], "SendSources.LLM");
            assert_eq!(descriptor["sourceBinding"], source_binding);
            assert_eq!(descriptor["source"]["path"], "send-sources.can");
            assert_eq!(
                descriptor["source"]["sha256"],
                crate::source::sha256_hex(SOURCE.as_bytes())
            );
            let actual_names = descriptor["inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| input["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            let actual_types = descriptor["inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| input["type"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(actual_names, names);
            assert_eq!(actual_types, types);
            let start = descriptor["statement"]["start"].as_u64().unwrap() as u32;
            let end = descriptor["statement"]["end"].as_u64().unwrap() as u32;
            let guard = prepared
                .guards(&ir)
                .unwrap()
                .get(&Span::new(program.checked_files()[0], start, end))
                .unwrap();
            assert_eq!(guard.descriptor, *descriptor);
            assert!(guard.rule.starts_with(&format!("{owner}.sendWhen.")));
            assert_eq!(guard.predicate.ty, ResolvedType::Scalar(Scalar::Bool));
            for input in &guard.inputs {
                assert!(matches!(&input.value.expr, IrExpr::Name(name) if name == &input.name));
                assert_eq!(
                    serial_type(&input.value.ty, &program, &ir, 0).as_deref(),
                    Some(input.type_id.as_str())
                );
                assert!(matches!(
                    input.name.as_str(),
                    "run" | "branch" | "allowance" | "template" | "budget"
                ));
            }
        }
        let rules = descriptors
            .values()
            .map(|values| values[0]["rule"].as_str().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(rules.len(), 2);
    }

    #[test]
    fn original_chat_send_capture_seals_same_first_row_and_compulsory_presence() {
        const CHAT: &str = include_str!("../../tests/fixtures/original-a850/CanChat.can");
        let mut db = SourceDb::new();
        let file = db.add("CanChat.can".into(), CHAT.into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let path = root
            .parent()
            .unwrap()
            .join("packages/cloudflare/dist/native-catalog.json");
        let (catalog, errors) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(errors.is_empty(), "{errors:?}");
        let catalog = catalog.unwrap();
        let (program, errors) = check_program(&db, &[file], Some(&catalog));
        assert!(errors.is_empty(), "{errors:?}");
        let (ir, errors) = ir::build(&program, &db, Some(&catalog));
        assert!(errors.is_empty(), "{errors:?}");
        let prepared =
            prepare(&program, &ir, &db, Some(&catalog)).expect("unchanged original Chat guard");
        let guard = prepared
            .guards(&ir)
            .unwrap()
            .values()
            .find(|guard| guard.descriptor["owner"] == "chat.ask")
            .unwrap();
        let input = guard
            .inputs
            .iter()
            .find(|input| input.name == "allowance")
            .unwrap();
        assert_eq!(input.type_id, "chat.Allowance");
        let narrowing = input
            .narrowing
            .as_ref()
            .expect("original prior first-row Require proof");
        assert!(
            matches!(&narrowing.declared_type,ResolvedType::Nullable(inner) if **inner==input.value.ty)
        );
        assert_eq!(input.declaration, narrowing.binding);
        assert_eq!(narrowing.occurrence.start, input.value.span.start);
        assert_eq!(
            CHAT[narrowing.presence.start as usize..narrowing.presence.end as usize].trim(),
            "allowance!=null"
        );
        assert!(
            narrowing.binding.end <= narrowing.require.start
                && narrowing.require.end <= narrowing.occurrence.start
        );
        assert!(
            matches!(input.value.ty,ResolvedType::Record {symbol,stored:true} if symbol==narrowing.model)
        );
        let (tree, errors) = syntax::parse_source(file, CHAT);
        assert!(errors.is_empty());
        let trees = [(file, tree)];
        let mut errors = Vec::new();
        let resolved =
            resolve::try_resolve_program(&db, &trees, Some(&catalog), &mut errors).unwrap();
        assert!(errors.is_empty());
        let mut nodes = HashMap::new();
        let mut pending = vec![&trees[0].1];
        while let Some(node) = pending.pop() {
            nodes.insert(NodeKey::of(node), node);
            pending.extend(node.children.iter());
        }
        let owner = input.owner;
        let predicate_key = NodeKey {
            file: guard.predicate.span.file,
            start: guard.predicate.span.start,
            end: guard.predicate.span.end,
            kind: SyntaxKind::Binary as u8,
        };
        let binding = Binding::Let {
            node: narrowing.binding,
        };
        let source = FreeInputSource {
            program: &program,
            ir: &ir,
            db: &db,
            resolved: &resolved,
            nodes: &nodes,
            owner,
        };
        assert!(
            checked_first_row_narrowing(
                source,
                predicate_key,
                narrowing.occurrence,
                &binding,
                &narrowing.declared_type
            )
            .is_some()
        );
        for mode in [
            "missing",
            "late",
            "or",
            "copied",
            "initializer-type",
            "occurrence-type",
        ] {
            let mut changed = ir.clone();
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("ask")
            };
            let require=effects.iter().position(|stmt|matches!(stmt,IrStmt::Require {span,..} if span.start==narrowing.require.start)).unwrap();
            if mode == "missing" {
                effects.remove(require);
            } else if mode == "late" {
                let send = effects
                    .iter()
                    .position(|stmt| matches!(stmt, IrStmt::Send { when: Some(_), .. }))
                    .unwrap();
                effects.swap(require, send);
            } else if mode == "initializer-type" {
                let IrStmt::Let {value,..}=effects.iter_mut().find(|stmt|matches!(stmt,IrStmt::Let {span,..} if span.start==narrowing.binding.start)).unwrap() else {panic!("Let")};
                value.ty = ResolvedType::Scalar(Scalar::Text);
            } else if mode == "occurrence-type" {
                let IrStmt::Send {
                    when: Some(predicate),
                    ..
                } = effects
                    .iter_mut()
                    .find(|stmt| matches!(stmt, IrStmt::Send { when: Some(_), .. }))
                    .unwrap()
                else {
                    panic!("SEND")
                };
                fn alter(value: &mut TypedExpr, span: Span) {
                    if value.span == span {
                        value.ty = ResolvedType::Nullable(Box::new(value.ty.clone()));
                    }
                    match &mut value.expr {
                        IrExpr::Member { base, .. } | IrExpr::Unary { operand: base, .. } => {
                            alter(base, span)
                        }
                        IrExpr::Binary { left, right, .. } => {
                            alter(left, span);
                            alter(right, span);
                        }
                        IrExpr::Call { args, .. } => {
                            for arg in args {
                                alter(arg, span);
                            }
                        }
                        _ => {}
                    }
                }
                alter(predicate, input.value.span);
            } else {
                let IrStmt::Require { cond, .. } = &mut effects[require] else {
                    panic!("Require")
                };
                let IrExpr::Binary { op, left, .. } = &mut cond.expr else {
                    panic!("AND")
                };
                if mode == "or" {
                    *op = super::super::ir::IrBinOp::Or;
                } else {
                    let IrExpr::Binary { left, .. } = &mut left.expr else {
                        panic!("presence")
                    };
                    left.expr = IrExpr::Name("branch".into());
                }
            }
            assert!(
                checked_first_row_narrowing(
                    FreeInputSource {
                        ir: &changed,
                        ..source
                    },
                    predicate_key,
                    narrowing.occurrence,
                    &binding,
                    &narrowing.declared_type
                )
                .is_none(),
                "{mode}"
            );
            assert!(prepared.guards(&changed).is_none(), "stale {mode}");
        }
    }

    #[test]
    fn original_chat_and_creative_guards_keep_lexical_values_over_same_named_fixtures() {
        const CHAT: &str = include_str!("../../tests/fixtures/original-a850/CanChat.can");
        const CREATIVE: &str = include_str!("../../tests/fixtures/original-a850/CanCreative.can");
        assert_eq!(
            crate::source::sha256_hex(CREATIVE.as_bytes()),
            "9e2b7ff93759f2f1a1127db9bee2f12f60235688648aff458466de75c92f65eb"
        );
        let mut db = SourceDb::new();
        let chat = db.add("CanChat.can".into(), CHAT.into());
        let creative = db.add("CanCreative.can".into(), CREATIVE.into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(chat, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[chat, creative], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let prepared =
            prepare(&program, &ir, &db, Some(&catalog)).expect("original lexical binding census");
        let descriptors = prepared.by_owner(&ir).unwrap();
        assert!(descriptors.contains_key("chat.ask"));
        let descriptor = &descriptors["creative.generate"][0];
        assert_eq!(descriptor["source"]["path"], "CanCreative.can");
        assert_eq!(
            descriptor["source"]["sha256"],
            crate::source::sha256_hex(CREATIVE.as_bytes())
        );
        assert_eq!(
            descriptor["inputs"],
            serde_json::json!([
                {"name":"run","type":"creative.Run"},
                {"name":"template","type":"creative.Template"},
                {"name":"budget","type":"creative.Budget"},
            ])
        );
        // The same-named authored fixture stays available to its original test
        // channel; the production let is an independent lexical value.
        assert!(
            ir.items
                .iter()
                .any(|item| item.canonical == "creative.budget"
                    && matches!(item.kind, IrItemKind::Fixture { .. }))
        );
        let guard = prepared
            .guards(&ir)
            .unwrap()
            .values()
            .find(|guard| guard.descriptor["owner"] == "creative.generate")
            .unwrap();
        let budget = guard
            .inputs
            .iter()
            .find(|input| input.name == "budget")
            .unwrap();
        assert!(matches!(&budget.value.expr, IrExpr::Name(name) if name == "budget"));
        assert_eq!(budget.declaration.kind, SyntaxKind::Let as u8);
        assert_eq!(
            &db.get(budget.declaration.file).unwrap().text
                [budget.declaration.start as usize..budget.declaration.end as usize]
                .trim(),
            &"let budget=first(Budget as row where row.account==actor order=row.id)"
        );
        let mut changed = ir.clone();
        let owner = changed
            .items
            .iter_mut()
            .find(|item| item.canonical == "creative.generate")
            .unwrap();
        let IrItemKind::Scenario { effects, .. } = &mut owner.kind else {
            panic!("original scenario")
        };
        let IrStmt::Let { name, .. } = &mut effects[0] else {
            panic!("original budget declaration")
        };
        *name = "foreign_budget".into();
        assert!(prepared.guards(&changed).is_none());
        assert!(prepare(&program, &changed, &db, Some(&catalog)).is_err());
    }

    #[test]
    fn prepared_guards_keep_fresh_context_without_incomplete_native_receipts() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let (db, program, ir, catalog) = fixture();
        let guards = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let membership = super::super::membership::prepare(&program, &ir, &db, Some(&catalog));
        let emitted = super::super::js::emit_program_with_query_sources(
            &ir,
            true,
            &db,
            &BTreeMap::new(),
            &BTreeMap::new(),
            super::super::js::EmitDecisionSources {
                source_context: None,
                owner_handlers: None,
                local_policies: None,
                unique_conditions: None,
                model_rule_origins: None,
                query_any: None,
                query_selections: None,
                transcript_queries: None,
                membership: membership.as_ref(),
                mailbox_events: None,
                send_guards: Some(&guards),
                send_guard_gap: None,
                read_predicates: None,
            },
        );
        // The required-Branch ask body now carries the complete admitted receipt
        // profile (exact requiredModel input + priorCreate SET + ordered void tail);
        // the nullable-Template generate body still lacks it.
        // Prepared Rule syntax is independent of executable artifact admission.
        let send_diags: Vec<_> = emitted
            .diagnostics
            .iter()
            .filter(|d| d.code == "E6008" && d.message.contains("send dispatch"))
            .collect();
        assert_eq!(send_diags.len(), 1, "{:?}", emitted.diagnostics);
        assert_eq!(
            (send_diags[0].primary.start, send_diags[0].primary.end),
            (655, 663),
            "{:?}",
            emitted.diagnostics
        );
        for operation in &emitted.operations {
            match operation.name.as_str() {
                "SendSources.ask" => assert!(
                    operation.disclosure.is_some(),
                    "ask now admits its exact receipt: {:?}",
                    emitted.diagnostics
                ),
                _ => assert!(
                    operation.disclosure.is_none(),
                    "only ask admits a receipt: {}",
                    operation.name
                ),
            }
        }
        let js = &emitted.entry.js;
        assert_eq!(js.matches("when:{rule:").count(), 2, "{js}");
        assert_eq!(js.matches("async(c,$can$send$inputs)=>").count(), 2, "{js}");
        assert!(!js.contains("when:()=>"), "{js}");
        assert!(
            js.contains("inputDeclaration:") || js.contains("\"inputDeclaration\":"),
            "{js}"
        );
        for guard in guards.guards(&ir).unwrap().values() {
            let callable = emitted
                .callables
                .iter()
                .find(|callable| callable.id == guard.rule)
                .unwrap();
            assert_eq!(callable.kind, super::super::js::JsCallableKind::Rule);
            assert_eq!(callable.member, ["sendWhen", guard.rule.as_str()]);
            assert_eq!(callable.span, guard.predicate.span);
        }
        let mut syntax = Command::new("node")
            .args(["--check", "--input-type=module"])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        syntax
            .stdin
            .take()
            .unwrap()
            .write_all(js.as_bytes())
            .unwrap();
        let output = syntax.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // The raw public IR entrypoint never receives the sealed preparation.
        let raw = super::super::js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(
            raw.diagnostics
                .iter()
                .any(|d| d.code == "E6008" && d.message.contains("dispatch")),
            "{:?}",
            raw.diagnostics
        );
        let generic = super::super::js::emit_program(&ir);
        assert!(
            generic
                .diagnostics
                .iter()
                .any(|d| d.code == "E6008" && d.message.contains("dispatch")),
            "{:?}",
            generic.diagnostics
        );
        let scratch = tempfile::tempdir().unwrap();
        let module = scratch.path().join("emitted.mjs");
        std::fs::write(&module, js).unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let runner = scratch.path().join("producer-flow.mjs");
        std::fs::write(&runner,r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json'));
const values=await import(pathToFileURL(require.resolve('@canlang/stdlib')));
const js=readFileSync(process.argv[3],'utf8');
const imports=[...js.matchAll(/import\s*\{([^}]+)\}\s*from\s*[^;]+;/g)].flatMap(match=>match[1].split(',').map(name=>{const parts=name.trim().split(/\s+as\s+/);return {name:parts[0],local:parts.at(-1)}}));
let calls=0;
const fresh={team:{id:'fresh-team'},allow:true},root={team:{id:'closed-root'},allow:false};
const ports={...values,active_member:async(c,person,team,site)=>{assert.equal(c,fresh);assert.equal(team,fresh.team);assert.equal(person.id,'person');assert.equal(site.source.module,'SendSources');calls++;return c.allow;}};
const body=js.replace(/import\s*\{[^}]+\}\s*from\s*[^;]+;/g,'').replace(/\bexport\s+(?=(?:async\s+)?(?:function|const))/g,'');
const app=new Function(...imports.map(value=>value.local),body+';return canApp();')(...imports.map(value=>ports[value.name]));
const guard=app.sendWhen[Object.keys(app.sendWhen).find(key=>key.startsWith('SendSources.generate.'))];
const inputs={run:{author:{id:'person'}},template:{enabled:true},budget:1n};
assert.equal(await guard(fresh,inputs),true);
assert.equal(calls,1);
fresh.allow=false;
assert.equal(await guard(fresh,inputs),false);
assert.equal(calls,2,'complete original short circuit invokes one current read per dispatch');
assert.equal(root.allow,false,'no captured root is needed or changed');
await assert.rejects(()=>guard(undefined,inputs));
const first=new Error('membership-first');
ports.active_member=async()=>{throw first};
const failing=new Function(...imports.map(value=>value.local),body+';return canApp();')(...imports.map(value=>ports[value.name]));
const failed=failing.sendWhen[Object.keys(failing.sendWhen).find(key=>key.startsWith('SendSources.generate.'))];
await assert.rejects(()=>failed(fresh,inputs),error=>error===first);
"#).unwrap();
        let output = Command::new("node")
            .arg(&runner)
            .arg(root)
            .arg(&module)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn guarded_email_native_receipt_requires_the_original_whole_ir_preparation() {
        use super::super::ir::{IrDefault, IrType};
        use super::super::js::{EmitDecisionSources, emit_program_with_query_sources};

        let source = include_str!("../../tests/fixtures/native-guarded-email.can");
        let mut db = SourceDb::new();
        let file = db.add("native-guarded-email.can".into(), source.into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let guards = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let membership = super::super::membership::prepare(&program, &ir, &db, Some(&catalog));
        let emit = |changed: &IrProgram| {
            emit_program_with_query_sources(
                changed,
                true,
                &db,
                &BTreeMap::new(),
                &BTreeMap::new(),
                EmitDecisionSources {
                    source_context: None,
                    owner_handlers: None,
                    local_policies: None,
                    unique_conditions: None,
                    model_rule_origins: None,
                    query_any: None,
                    query_selections: None,
                    transcript_queries: None,
                    membership: membership.as_ref(),
                    mailbox_events: None,
                    send_guards: Some(&guards),
                    send_guard_gap: None,
                    read_predicates: None,
                },
            )
        };
        let delivered = emit(&ir);
        assert!(
            delivered.diagnostics.is_empty(),
            "{:?}",
            delivered.diagnostics
        );
        let descriptor = delivered
            .operations
            .iter()
            .find(|operation| operation.name == "NativeGuardedEmail.deliver")
            .unwrap();
        assert_eq!(descriptor.result.as_deref(), Some("int"));
        assert_eq!(descriptor.disclosure.as_ref().unwrap()["version"], 1);
        let plain = delivered
            .operations
            .iter()
            .find(|operation| operation.name == "NativeGuardedEmail.plain")
            .unwrap()
            .to_json();
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "NativeGuardedEmail.deliver")
            .unwrap()
            .id;
        let original_span = ir.items[owner.0 as usize].span;

        for mutation in 0..10 {
            let mut changed = ir.clone();
            if mutation == 9 {
                changed.items[owner.0 as usize].id =
                    crate::analysis::SymbolId(changed.items.len() as u32);
            } else if mutation == 2 || mutation == 3 {
                let parameter = changed
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "NativeGuardedEmail.deliver.enabled")
                    .unwrap();
                let parameter_span = parameter.span;
                let IrItemKind::Param {
                    ty,
                    default,
                    default_node,
                    ..
                } = &mut parameter.kind
                else {
                    panic!("original lexical parameter");
                };
                if mutation == 2 {
                    *ty = IrType::Known(ResolvedType::Scalar(Scalar::Int));
                } else {
                    *default = Some(IrDefault::Literal(TypedExpr {
                        expr: IrExpr::Bool(true),
                        ty: ResolvedType::Scalar(Scalar::Bool),
                        span: parameter_span,
                    }));
                    *default_node = Some(NodeKey {
                        file: parameter_span.file,
                        start: parameter_span.start,
                        end: parameter_span.end,
                        kind: SyntaxKind::Literal as u8,
                    });
                }
            } else {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!("original owner scenario");
                };
                if mutation == 7 {
                    let IrStmt::Set { changes, .. } = &mut effects[1] else {
                        panic!("original Set");
                    };
                    let IrExpr::Object(fields) = &mut changes.expr else {
                        panic!("original Set fields");
                    };
                    fields
                        .iter_mut()
                        .find(|(name, _)| name == "count")
                        .unwrap()
                        .1
                        .expr = IrExpr::Int(42);
                } else if mutation == 8 {
                    let IrStmt::Require { cond, .. } = &mut effects[2] else {
                        panic!("original late Require");
                    };
                    cond.expr = IrExpr::Bool(true);
                } else {
                    let IrStmt::Send {
                        when,
                        operation,
                        deployment_binding,
                        binding,
                        ..
                    } = &mut effects[0]
                    else {
                        panic!("original guarded SEND");
                    };
                    match mutation {
                        0 => when.as_mut().unwrap().expr = IrExpr::Bool(false),
                        1 => *when = None,
                        4 => *operation = "std.EmailV1.edited".into(),
                        5 => *deployment_binding = Some("NativeGuardedEmail.other".into()),
                        6 => *binding = Some("copied_attempt".into()),
                        _ => unreachable!(),
                    }
                }
            }
            assert!(
                guards.guards(&changed).is_none(),
                "stale guard registry {mutation}"
            );
            assert!(
                guards.by_owner(&changed).is_none(),
                "stale source descriptor {mutation}"
            );
            assert!(
                prepare(&program, &changed, &db, Some(&catalog)).is_err(),
                "fresh mutant {mutation}"
            );
            let refused = emit(&changed);
            assert!(
                refused
                    .operations
                    .iter()
                    .find(|operation| operation.name == "NativeGuardedEmail.deliver")
                    .unwrap()
                    .disclosure
                    .is_none(),
                "mutated guarded native receipt {mutation}"
            );
            assert!(
                refused.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == "E6008"
                        && diagnostic.primary == original_span
                        && diagnostic.message.contains("send dispatch guard")
                }),
                "original guarded source refusal {mutation}: {:?}",
                refused.diagnostics
            );
            assert_eq!(
                refused
                    .operations
                    .iter()
                    .find(|operation| operation.name == "NativeGuardedEmail.plain")
                    .unwrap()
                    .to_json(),
                plain,
                "unrelated plain SEND {mutation}"
            );
        }
        let raw = super::super::js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(
            raw.operations
                .iter()
                .find(|operation| operation.name == "NativeGuardedEmail.deliver")
                .unwrap()
                .disclosure
                .is_none()
        );
        assert!(raw.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "E6008"
                && diagnostic.primary == original_span
                && diagnostic.message.contains("send dispatch guard")
        }));
        assert_eq!(
            raw.operations
                .iter()
                .find(|operation| operation.name == "NativeGuardedEmail.plain")
                .unwrap()
                .to_json(),
            plain
        );
    }

    #[test]
    fn source_ir_type_target_binding_payload_order_and_post_preparation_edits_refuse() {
        let (db, program, ir, catalog) = fixture();
        let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "SendSources.generate")
            .unwrap()
            .id;
        for mutation in 0..12 {
            let mut changed = ir.clone();
            if mutation == 8 {
                changed.modules[0].imports[0].from = Some("deployment.edited".into());
            } else if mutation == 9 {
                let template = changed
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "SendSources.generate.template")
                    .unwrap();
                let IrItemKind::Param { ty, .. } = &mut template.kind else {
                    panic!()
                };
                *ty = super::super::ir::IrType::Known(ResolvedType::Scalar(Scalar::Bool));
            } else if mutation == 10 {
                changed.items[owner.0 as usize].canonical.push_str("Edited");
            } else if mutation == 11 {
                changed.catalog_version.push_str("Edited");
            } else {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!()
                };
                if mutation == 7 {
                    effects.swap(0, 1);
                } else {
                    let IrStmt::Send {
                        operation,
                        args,
                        when,
                        deployment_binding,
                        binding,
                        span,
                    } = &mut effects[3]
                    else {
                        panic!()
                    };
                    match mutation {
                        0 => *operation = "std.TextGenerationV1.generate".into(),
                        1 => *deployment_binding = Some("SendSources.other".into()),
                        2 => *binding = Some("edited".into()),
                        3 => when.as_mut().unwrap().expr = IrExpr::Bool(true),
                        4 => when.as_mut().unwrap().span.start += 1,
                        5 => span.start += 1,
                        _ => {
                            let IrExpr::Object(fields) = &mut args.expr else {
                                panic!()
                            };
                            fields[0].1.expr = IrExpr::Int(2);
                        }
                    }
                }
            }
            assert!(
                prepare(&program, &changed, &db, Some(&catalog)).is_err(),
                "initial IR mutation {mutation}"
            );
            assert!(
                prepared.guards(&changed).is_none(),
                "prepared IR mutation {mutation}"
            );
            assert!(
                prepared.by_owner(&changed).is_none(),
                "prepared descriptors mutation {mutation}"
            );
        }
        let mut foreign_db = SourceDb::new();
        foreign_db.add("send-sources.can".into(), SOURCE.into());
        assert!(prepare(&program, &ir, &foreign_db, Some(&catalog)).is_err());
        let mut edited_db = SourceDb::new();
        let file = edited_db.add(
            "send-sources.can".into(),
            SOURCE.replace("budget>0", "budget>1"),
        );
        let (edited, diagnostics) = check_program(&edited_db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(prepare(&edited, &ir, &edited_db, Some(&catalog)).is_err());
        let (mut edited_types, diagnostics) =
            check_program(&db, program.checked_files(), Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let template = edited_types
            .symbols
            .iter()
            .find(|symbol| {
                symbol.canonical == "SendSources.generate.template"
                    && matches!(symbol.kind, SymbolKind::Param { .. })
            })
            .unwrap()
            .id;
        edited_types
            .types
            .symbol_types
            .insert(template, ResolvedType::Scalar(Scalar::Bool));
        assert!(prepare(&edited_types, &ir, &db, Some(&catalog)).is_err());
    }
}
