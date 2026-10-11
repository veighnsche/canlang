//! Internal source-bound static call facts. No artifact or execution transport.
use super::ir::{IrEffectCallTarget, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType};
use super::js::{JsMcpField, JsOperation, JsOperationField, JsOperationKind};
use crate::analysis::resolve::SymbolId;
use crate::analysis::scenario_disclosure::{DisclosureEffectKind, ScenarioDisclosure};
use crate::analysis::{ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallSource {
    pub path: String,
    pub sha256: String,
    pub module: String,
}
#[derive(Debug, Clone, PartialEq)]
pub enum CallResultFact {
    Void,
    Scalar(ResolvedType),
    Opaque(ResolvedType),
    Model(ResolvedType),
}
#[derive(Debug, Clone)]
pub struct CallInput {
    pub name: String,
    pub source: Span,
    pub ty: ResolvedType,
}
#[derive(Debug, Clone)]
pub struct StaticScenarioCall {
    pub id: String,
    pub source: CallSource,
    pub span: Span,
    pub parent: String,
    pub target: String,
    pub operation: SymbolId,
    /// Exact owning emitted descriptor; no independently reconstructed schema.
    pub interface: JsOperation,
    pub result: CallResultFact,
    pub binding: Option<String>,
    pub inputs: Vec<CallInput>,
}

/// Checked authored call/source correspondence, including reads, references,
/// composite results and `as`. It is not a disclosure or execution grant.
#[derive(Debug, Clone)]
pub struct ScenarioSourceCall {
    pub source: CallSource,
    pub span: Span,
    pub parent: String,
    pub target: String,
    pub operation: SymbolId,
    pub read: bool,
    pub binding: Option<String>,
    pub result: Option<ResolvedType>,
    pub inputs: Vec<CallInput>,
}

/// Join the real checked source facts to the actual lowered body and owning
/// checked declaration. Unsupported runtime profiles may have this structural
/// correspondence while their disclosure remains explicitly declined.
pub fn collect_scenario_source_calls(
    ir: &IrProgram,
    parent: &IrItem,
    db: &SourceDb,
) -> Option<Vec<ScenarioSourceCall>> {
    let source = checked_source(ir, parent, db)?;
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &parent.kind
    else {
        return None;
    };
    let mut pending: Vec<_> = guards.iter().chain(effects).collect();
    pending.reverse();
    let mut sites = Vec::new();
    let mut matched = HashSet::new();
    let mut steps = 0usize;
    while let Some(stmt) = pending.pop() {
        steps += 1;
        if steps > 16384 || pending.len() > 16384 {
            return None;
        }
        match stmt {
            IrStmt::Call {
                target:
                    IrEffectCallTarget::Operation {
                        source: target_source,
                        operation,
                    },
                inputs,
                binding,
                result,
                span,
            } => {
                let mut proofs = source.calls.iter().filter(|proof| {
                    proof.node.file == span.file
                        && proof.node.start == span.start
                        && proof.node.end == span.end
                });
                let proof = proofs.next()?;
                let node = proof.node;
                if proofs.next().is_some()
                    || !matched.insert(node)
                    || source.calls.get(sites.len()).map(|proof| proof.node) != Some(node)
                    || proof.operation != *operation
                    || proof.binding != *binding
                    || proof.result != *result
                    || proof.target_node.file != target_source.file
                    || proof.target_node.start != target_source.start
                    || proof.target_node.end != target_source.end
                {
                    return None;
                }
                let child = ir.items.get(operation.0 as usize)?;
                let child_source = checked_source(ir, child, db)?;
                if child.id != *operation || child_source.result != *result {
                    return None;
                }
                let IrExpr::Object(entries) = &inputs.expr else {
                    return None;
                };
                if entries.len() != proof.inputs.len() || sites.len() >= 200 {
                    return None;
                }
                let mut keys = HashSet::new();
                let mut authored = Vec::new();
                for ((name, value), fact) in entries.iter().zip(&proof.inputs) {
                    if !keys.insert(name)
                        || name != &fact.name
                        || value.ty != fact.ty
                        || value.span.file != fact.node.file
                        || value.span.start != fact.node.start
                        || value.span.end != fact.node.end
                    {
                        return None;
                    }
                    authored.push(CallInput {
                        name: name.clone(),
                        source: value.span,
                        ty: value.ty.clone(),
                    });
                }
                sites.push(ScenarioSourceCall {
                    source: CallSource {
                        path: source.source.path.clone(),
                        sha256: source.source.sha256.clone(),
                        module: source.source.module.clone(),
                    },
                    span: *span,
                    parent: parent.canonical.clone(),
                    target: child.canonical.clone(),
                    operation: *operation,
                    read: child_source.read,
                    binding: binding.clone(),
                    result: result.clone(),
                    inputs: authored,
                });
            }
            IrStmt::Call { .. } | IrStmt::Unsupported { .. } => return None,
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => {
                pending.extend(else_branch.iter().rev());
                pending.extend(then_branch.iter().rev());
            }
            IrStmt::Match { arms, .. } => {
                for arm in arms.iter().rev() {
                    pending.extend(arm.body.iter().rev());
                }
            }
            IrStmt::For { body, .. } => pending.extend(body.iter().rev()),
            _ => {}
        }
    }
    if matched.len() != source.calls.len() {
        return None;
    }
    Some(sites)
}

pub(crate) fn checked_source<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedScenarioSource> {
    let source = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let module = ir.modules.get(owner.module.0 as usize)?;
    let file = db.get(module.file)?;
    let IrItemKind::Scenario {
        params,
        result,
        read,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if source.scenario != owner.id
        || source.read != *read
        || source.result != *result
        || source.source.path != file.path
        || source.source.sha256 != file.sha256
        || source.source.module != module.name
        || file.sha256 != sha256_hex(file.text.as_bytes())
        || source.node.file != module.file
        || source.node.start >= source.node.end
        || source.node.end as usize > file.text.len()
        || db
            .iter()
            .filter(|(_, candidate)| candidate.path == file.path)
            .count()
            != 1
        || params.len() != source.parameters.len()
    {
        return None;
    }
    if super::scenario_receipts::checked_created_model_result(ir, owner).is_some()
        && (owner.canonical != format!("{}.{}", module.name, owner.name)
            || file
                .text
                .get(owner.span.start as usize..owner.span.end as usize)?
                != owner.name)
    {
        return None;
    }
    for (id, fact) in params.iter().zip(&source.parameters) {
        let parameter = ir.items.get(id.0 as usize)?;
        let IrItemKind::Param {
            owner: parent,
            ty: IrType::Known(ty),
            default_node,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        if parameter.id != fact.parameter
            || *parent != owner.id
            || ty != &fact.ty
            || *default_node != fact.default
        {
            return None;
        }
    }
    Some(source)
}

/// Arguments must come from the same checked IR/cohort and real operation
/// producer. Refusal is whole-parent; source/descriptor facts alone activate no
/// runtime producer. Only the complete finite query child may carry reference
/// inputs and an unused binding. Real published child disclosure is mandatory.
pub fn collect_static_scenario_calls(
    ir: &IrProgram,
    parent: &IrItem,
    operations: &[JsOperation],
    db: &SourceDb,
    entry_module: &str,
) -> Option<Vec<StaticScenarioCall>> {
    if entry_module.is_empty() || operations.len() > 16384 {
        return None;
    }
    let mut names = HashSet::new();
    if operations.iter().any(|op| !names.insert(op.name.as_str())) {
        return None;
    }
    let mut pending = vec![(parent.id, vec![parent.id])];
    let mut root_sites = None;
    let mut steps = 0usize;
    let mut occurrences = 0usize;
    while let Some((id, path)) = pending.pop() {
        steps += 1;
        if steps > 201 || path.len() > 17 {
            return None;
        }
        let owner = ir.items.get(id.0 as usize)?;
        if owner.id != id {
            return None;
        }
        let sites = collect_owner(ir, owner, operations, db, entry_module, id != parent.id)?;
        occurrences = occurrences.checked_add(sites.len())?;
        if occurrences > 200 {
            return None;
        }
        for site in &sites {
            if path.contains(&site.operation) {
                return None;
            }
            let mut next = path.clone();
            next.push(site.operation);
            pending.push((site.operation, next));
            if pending.len() > 200 {
                return None;
            }
        }
        if id == parent.id {
            root_sites = Some(sites);
        }
    }
    root_sites
}
fn scalar_id(ty: &ResolvedType) -> Option<&'static str> {
    let ResolvedType::Scalar(scalar) = ty else {
        return None;
    };
    match scalar {
        Scalar::Int
        | Scalar::Text
        | Scalar::Bool
        | Scalar::Decimal
        | Scalar::Money
        | Scalar::Date
        | Scalar::Datetime
        | Scalar::Duration
        | Scalar::User => Some(scalar.as_str()),
        _ => None,
    }
}
fn collect_owner(
    ir: &IrProgram,
    owner: &IrItem,
    operations: &[JsOperation],
    db: &SourceDb,
    entry: &str,
    is_child: bool,
) -> Option<Vec<StaticScenarioCall>> {
    let IrItemKind::Scenario {
        trusted: false,
        read,
        event_source: None,
        hook: None,
        cohort: None,
        expose_excluded: false,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if *read && (!is_child || complete_read_query_child(ir, owner).is_none()) {
        return None;
    }
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let module = ir.modules.get(owner.module.0 as usize)?;
    let source = db.get(module.file)?;
    if module.id != owner.module
        || source.path.is_empty()
        || checked.source.path != source.path
        || checked.source.sha256 != source.sha256
        || source.sha256 != sha256_hex(source.text.as_bytes())
        || checked.source.module != module.name
        || owner.span.file != module.file
        || db
            .iter()
            .filter(|(_, value)| value.path == source.path)
            .count()
            != 1
    {
        return None;
    }
    let origin = CallSource {
        path: source.path.clone(),
        sha256: source.sha256.clone(),
        module: entry.into(),
    };
    let mut pending: Vec<_> = guards
        .iter()
        .chain(effects)
        .map(|stmt| (stmt, 0usize))
        .collect();
    pending.reverse();
    let mut sites = Vec::new();
    let mut matched_calls = HashSet::new();
    let source_calls = collect_scenario_source_calls(ir, owner, db)?;
    let mut steps = 0;
    while let Some((stmt, depth)) = pending.pop() {
        steps += 1;
        if steps > 16384 || depth > 64 {
            return None;
        }
        match stmt {
            IrStmt::Call {
                target:
                    IrEffectCallTarget::Operation {
                        source: target_source,
                        operation,
                    },
                inputs,
                binding,
                result,
                span,
            } => {
                if sites.len() >= 200
                    || span.file != module.file
                    || target_source.file != module.file
                    || span.start >= span.end
                    || span.end as usize > source.text.len()
                    || target_source.start < span.start
                    || target_source.end > span.end
                {
                    return None;
                }
                let child = ir.items.get(operation.0 as usize)?;
                if child.id != *operation {
                    return None;
                }
                let IrItemKind::Scenario {
                    params,
                    result: declared,
                    trusted: false,
                    read: child_read,
                    hook: None,
                    event_source: None,
                    cohort: None,
                    expose_excluded: false,
                    ..
                } = &child.kind
                else {
                    return None;
                };
                if result != declared {
                    return None;
                }
                let model_result =
                    super::scenario_receipts::checked_created_model_result(ir, child);
                let query = if *child_read {
                    checked_source(ir, child, db)?;
                    Some(complete_read_query_child(ir, child)?)
                } else {
                    if binding.is_some() && model_result.is_none() {
                        return None;
                    }
                    None
                };
                let descriptor = operations.iter().find(|op| op.name == child.canonical)?;
                if descriptor.kind
                    != if query.is_some() {
                        JsOperationKind::Read
                    } else {
                        JsOperationKind::Scenario
                    }
                {
                    return None;
                }
                let result_fact = match declared {
                    Some(ty) if model_result.is_some() && binding.is_some() => {
                        let model = ir.items.get(model_result?.0 as usize)?;
                        if descriptor.result.as_deref() != Some(model.canonical.as_str()) {
                            return None;
                        }
                        CallResultFact::Model(ty.clone())
                    }
                    Some(ty) if query.is_some() => {
                        let query = query?;
                        let contract = ir.items.get(query.projection.contract.0 as usize)?;
                        if descriptor.result.as_deref()
                            != Some(format!("{}[]", contract.canonical).as_str())
                        {
                            return None;
                        }
                        CallResultFact::Opaque(ty.clone())
                    }
                    None if descriptor.result.as_deref() == Some("void") => CallResultFact::Void,
                    Some(ty)
                        if scalar_id(ty) == descriptor.result.as_deref()
                            && scalar_id(ty).is_some() =>
                    {
                        CallResultFact::Scalar(ty.clone())
                    }
                    _ => return None,
                };
                let ScenarioDisclosure::Complete(child_checked) =
                    ir.scenario_disclosures.get(operation)?
                else {
                    return None;
                };
                let disclosure = descriptor.disclosure.as_ref()?;
                if disclosure["version"] != 1
                    || disclosure["source"]["path"] != child_checked.source.path
                    || disclosure["source"]["sha256"] != child_checked.source.sha256
                    || disclosure["source"]["module"] != entry
                {
                    return None;
                }
                let actual_returns = disclosure["returns"].as_array()?;
                if actual_returns.len() != child_checked.returns.len()
                    || actual_returns.iter().any(|value| {
                        !child_checked
                            .returns
                            .iter()
                            .any(|returned| value["id"] == returned.id)
                    })
                {
                    return None;
                }
                if let Some(query) = query {
                    match_query_disclosure(ir, query, disclosure, entry)?;
                }
                let IrExpr::Object(entries) = &inputs.expr else {
                    return None;
                };
                let mut proofs = checked.effects.iter().filter(|proof| {
                    proof.node.file == span.file
                        && proof.node.start == span.start
                        && proof.node.end == span.end
                });
                let proof = proofs.next()?;
                if proofs.next().is_some()
                    || !matched_calls.insert(proof.node)
                    || proof.source != checked.source
                    || !matches!(&proof.kind, DisclosureEffectKind::Call {operation:checked_operation,input_keys} if checked_operation==operation && input_keys==&entries.iter().map(|(name,_)|name.clone()).collect::<Vec<_>>())
                {
                    return None;
                }
                // Preserve the indexed authored source inputs, including the
                // exact unused binding, rather than matching by name alone.
                let source_call = source_calls.get(sites.len())?;
                if source_call.span != *span
                    || source_call.operation != *operation
                    || source_call.binding != *binding
                    || source_call.result != *result
                    || source_call.inputs.len() != entries.len()
                {
                    return None;
                }
                if entries.len() != params.len()
                    || params.len() != descriptor.inputs.len()
                    || params.len() > 256
                {
                    return None;
                }
                // The declaration owns positional interface order; authored
                // CALL argument order is checked separately below.
                if params.iter().zip(&descriptor.inputs).any(|(id, input)| {
                    ir.items
                        .get(id.0 as usize)
                        .is_none_or(|parameter| parameter.name != input.name)
                }) {
                    return None;
                }
                let mut keys = HashSet::new();
                let mut authored = Vec::new();
                for ((name, value), fact) in entries.iter().zip(&source_call.inputs) {
                    if !keys.insert(name)
                        || (query.is_none() && !simple_value(value))
                        || fact.name != *name
                        || fact.source != value.span
                        || fact.ty != value.ty
                        || value.span.file != module.file
                        || value.span.start >= value.span.end
                        || value.span.start < span.start
                        || value.span.end > span.end
                    {
                        return None;
                    }
                    let param = params
                        .iter()
                        .filter_map(|id| ir.items.get(id.0 as usize))
                        .find(|param| param.name == *name)?;
                    let IrItemKind::Param {
                        owner: param_owner,
                        ty: IrType::Known(ty),
                        default: None,
                        ..
                    } = &param.kind
                    else {
                        return None;
                    };
                    if *param_owner != child.id || ty != &value.ty {
                        return None;
                    }
                    let input = descriptor.inputs.iter().find(|input| input.name == *name)?;
                    if query.is_some() {
                        protected_query_input(ir, owner, param, value, input, operations, db)?;
                    } else if !input.required
                        || input.nullable
                        || input.array_required.is_some()
                        || input.default.is_some()
                        || input.computed_default
                        || input.value_type.as_deref() != Some(scalar_id(ty)?)
                    {
                        return None;
                    }
                    authored.push(CallInput {
                        name: name.clone(),
                        source: value.span,
                        ty: value.ty.clone(),
                    });
                }
                let encoded = serde_json::to_string(&(
                    "static-scenario-call-v1",
                    &owner.canonical,
                    &origin.path,
                    &origin.sha256,
                    &origin.module,
                    span.start,
                    span.end,
                ))
                .ok()?;
                sites.push(StaticScenarioCall {
                    id: format!("call_{}", sha256_hex(encoded.as_bytes())),
                    source: origin.clone(),
                    span: *span,
                    parent: owner.canonical.clone(),
                    target: child.canonical.clone(),
                    operation: *operation,
                    interface: descriptor.clone(),
                    result: result_fact,
                    binding: binding.clone(),
                    inputs: authored,
                });
            }
            IrStmt::Call { .. } => return None,
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => {
                for next in then_branch.iter().chain(else_branch).rev() {
                    pending.push((next, depth + 1));
                }
            }
            IrStmt::Match { arms, .. } => {
                for arm in arms.iter().rev() {
                    for next in arm.body.iter().rev() {
                        pending.push((next, depth + 1));
                    }
                }
            }
            // The finite nested-call consumer profile excludes framework Send effects.
            // Root/standalone receipt profiles retain their existing Send support.
            IrStmt::Send { .. } if is_child => return None,
            IrStmt::Create { .. }
                if super::scenario_receipts::checked_created_model_result(ir, owner).is_some() => {}
            IrStmt::Let { .. }
            | IrStmt::Require { .. }
            | IrStmt::Return { .. }
            | IrStmt::Set { .. }
            | IrStmt::Send { .. }
            | IrStmt::Transition { .. } => {}
            _ => return None,
        }
    }
    if checked.effects.iter().any(|proof| {
        matches!(proof.kind, DisclosureEffectKind::Call { .. })
            && !matched_calls.contains(&proof.node)
    }) || checked
        .effects
        .iter()
        .filter(|proof| matches!(proof.kind, DisclosureEffectKind::Call { .. }))
        .count()
        != sites.len()
    {
        return None;
    }
    Some(sites)
}
/// Check the structural admitted query shape for parent recipe preparation.
/// Executable/source correspondence remains owned by the immutable prepared
/// query recipe; the operation producer must publish that real plan before any
/// call capture can be enabled.
pub(super) fn complete_read_query_child<'a>(
    ir: &'a IrProgram,
    child: &IrItem,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&child.id)? else {
        return None;
    };
    let source = checked.source_facts.as_deref()?;
    let IrItemKind::Scenario {
        read: true,
        result,
        effects,
        ..
    } = &child.kind
    else {
        return None;
    };
    let [query] = source.queries.as_deref()? else {
        return None;
    };
    let [returned] = checked.returns.as_slice() else {
        return None;
    };
    let [
        IrStmt::Let { value: scan, .. },
        IrStmt::Require { span: guard, .. },
        IrStmt::Return {
            value: Some(selected),
            span: returned_span,
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let (IrExpr::Query(scan), IrExpr::Query(select)) = (&scan.expr, &selected.expr) else {
        return None;
    };
    let scan_source = scan.source.as_deref()?;
    let select_source = select.source.as_deref()?;
    let projection = select_source.projection.as_deref()?;
    let contract = ir.items.get(query.projection.contract.0 as usize)?;
    if checked.scenario != child.id
        || source.scenario != child.id
        || !source.read
        || source.result != *result
        || source.source != checked.source
        || source.node != checked.node
        || !source.calls.is_empty()
        || !checked.effects.is_empty()
        || query.source != source.source
        || query.projection.source != source.source
        || query.model != query.projection.model
        || query.node != scan_source.node
        || query.domain != scan_source.domain
        || query.projection.node != select_source.node
        || projection.contract != query.projection.contract
        || projection.model != query.model
        || projection.alias != query.projection.alias
        || projection.fields != query.projection.fields
        || contract.id != query.projection.contract
        || !matches!(contract.kind, IrItemKind::Contract { .. })
        || !matches!(result, Some(ResolvedType::Array { element, ordered: true, nonempty: false })
            if matches!(element.as_ref(), ResolvedType::Record {symbol, ..} if *symbol == contract.id))
        || query.limit.is_some()
        || query.archived
        || !query.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || !scan.order.is_empty()
        || scan.parent.is_some()
        || scan.select.is_some()
        || scan.where_async
        || scan.collection_call.is_some()
        || scan.contract_collection_call.is_some()
        || select.parent.is_some()
        || select.where_pred.is_some()
        || select.where_async
        || !select.order.is_empty()
        || select.limit.is_some()
        || select.archived.is_some()
        || select.collection_call.is_some()
        || select.contract_collection_call.is_some()
        || !matches!(&scan.domain, super::ir::IrQueryDomain::Model(name) if name == &query.model_name)
        || !matches!(&select.domain, super::ir::IrQueryDomain::Value { .. })
        || query.cardinality_guard.file != guard.file
        || query.cardinality_guard.start != guard.start
        || query.cardinality_guard.end != guard.end
        || query.return_node.file != returned_span.file
        || query.return_node.start != returned_span.start
        || query.return_node.end != returned_span.end
        || returned.id != query.return_id()
        || returned.node != query.return_node
        || returned.source != query.source
        || returned.influences != query.influences
        || !returned.dependencies.is_empty()
        || !returned.intrinsics.is_empty()
        || !returned.decisions.is_empty()
    {
        return None;
    }
    // Join projection slots by their original index and authored expression,
    // so swapped/copied values cannot retain a nominal source plan.
    let selected = select.select.as_deref()?;
    let IrExpr::Object(entries) = &selected.expr else {
        return None;
    };
    let alias = select.select_param.as_ref()?;
    if entries.len() != projection.fields.len() {
        return None;
    }
    let IrItemKind::Contract {
        fields: contract_fields,
        ..
    } = &contract.kind
    else {
        return None;
    };
    if contract_fields.len() != entries.len() {
        return None;
    }
    for ((name, value), fact) in entries.iter().zip(&projection.fields) {
        let field = ir.items.get(fact.field.0 as usize)?;
        if field.id != fact.field
            || field.name != *name
            || value.ty != fact.ty
            || !contract_fields.contains(&field.id)
            || !matches!(&field.kind, IrItemKind::Field {owner, ty: IrType::Known(ty), ..} if *owner == contract.id && ty == &fact.ty)
            || value.span.file != fact.node.file
            || value.span.start != fact.node.start
            || value.span.end != fact.node.end
        {
            return None;
        }
        use crate::analysis::types::CheckedQueryProjectionMapping as Mapping;
        let matched = match (&fact.mapping, &value.expr) {
            (Mapping::StoredReference, IrExpr::Name(name)) => name == alias,
            (Mapping::Version, IrExpr::Member { base, field }) => {
                field == "version" && matches!(&base.expr, IrExpr::Name(name) if name == alias)
            }
            (Mapping::DirectField { field: input }, IrExpr::Member { base, field }) => {
                ir.items
                    .get(input.0 as usize)
                    .is_some_and(|input| input.name == *field)
                    && matches!(&base.expr, IrExpr::Name(name) if name == alias)
            }
            _ => false,
        };
        if !matched {
            return None;
        }
    }
    Some(query)
}

fn match_query_disclosure(
    ir: &IrProgram,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    disclosure: &serde_json::Value,
    entry: &str,
) -> Option<()> {
    use crate::analysis::scenario_disclosure::{DependencyRole, InfluenceKind};
    use crate::analysis::types::CheckedQueryProjectionMapping;
    let source = serde_json::json!({"path": query.source.path, "sha256": query.source.sha256, "module": entry});
    let dependencies = query.dependencies.iter().map(|dep| serde_json::json!({
        "id": dep.id, "source": source, "role": match dep.role {DependencyRole::Data => "data", DependencyRole::Control => "control"},
        "field": dep.field_name, "type": dep.type_id
    })).collect::<Vec<_>>();
    let mut fields = Vec::new();
    for mapped in &query.projection.fields {
        let field = ir.items.get(mapped.field.0 as usize)?;
        let mut value = serde_json::json!({"name": field.name, "kind": match mapped.mapping {
            CheckedQueryProjectionMapping::StoredReference => "reference",
            CheckedQueryProjectionMapping::Version => "version",
            CheckedQueryProjectionMapping::DirectField {..} => "field"
        }});
        if let CheckedQueryProjectionMapping::DirectField { field } = mapped.mapping {
            value["field"] =
                serde_json::Value::String(ir.items.get(field.0 as usize)?.name.clone());
        }
        fields.push(value);
    }
    let mut influences = Vec::new();
    for influence in &query.influences {
        let kind = match influence.kind {
            InfluenceKind::QueryExistence => "query-existence",
            InfluenceKind::QueryCardinality => "query-cardinality",
            InfluenceKind::QueryMembership => "query-membership",
            InfluenceKind::QueryOrder => "query-order",
            InfluenceKind::AbsentReference => return None,
        };
        influences.push(serde_json::json!({"id": influence.id, "kind": kind, "queryId": query.id}));
    }
    // Compare the whole actual published plan, with ordered projection fields,
    // dependencies and influences; an ID-only disclosure cannot satisfy this.
    let expected = serde_json::json!({"version":1,"source":source,
        "queries":[{"id":query.id,"source":source,"model":query.model_name,
            "order":[],"limit":null,"archived":"exclude","dependencies":dependencies}],
        "returns":[{"id":query.return_id(),"source":source,"influences":influences,
            "dependencies":[],"projection":{"kind":"query-contract-array","queryId":query.id,"source":source,"fields":fields}}]});
    (disclosure == &expected).then_some(())
}

fn protected_query_input(
    ir: &IrProgram,
    owner: &IrItem,
    child_param: &IrItem,
    value: &super::ir::TypedExpr,
    input: &JsOperationField,
    operations: &[JsOperation],
    db: &SourceDb,
) -> Option<()> {
    if matches!(value.expr, IrExpr::Member { .. }) {
        return protected_stored_query_input(ir, owner, child_param, value, input, operations, db);
    }
    let IrExpr::Name(name) = &value.expr else {
        return None;
    };
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let parent = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .find(|param| param.name == *name)?;
    let IrItemKind::Param {
        owner: parent_owner,
        ty: IrType::Known(parent_ty),
        default: None,
        default_node: None,
        array_bounds: parent_bounds,
        ..
    } = &parent.kind
    else {
        return None;
    };
    let IrItemKind::Param {
        ty: IrType::Known(child_ty),
        default: None,
        default_node: None,
        array_bounds: child_bounds,
        ..
    } = &child_param.kind
    else {
        return None;
    };
    if *parent_owner != owner.id || parent_ty != child_ty || child_ty != &value.ty {
        return None;
    }
    let parent_descriptor = operations.iter().find(|op| op.name == owner.canonical)?;
    let original = parent_descriptor
        .inputs
        .iter()
        .find(|field| field.name == parent.name)?;
    for (bounds, descriptor, require_version) in [
        (parent_bounds, original, true),
        (child_bounds, input, false),
    ] {
        if descriptor.nullable || descriptor.default.is_some() || descriptor.computed_default {
            return None;
        }
        match child_ty {
            ResolvedType::Record {
                symbol,
                stored: true,
            } => {
                let model = ir.items.get(symbol.0 as usize)?;
                if model.id != *symbol
                    || !matches!(model.kind, IrItemKind::Model { .. })
                    || !descriptor.required
                    || descriptor.array_required.is_some()
                    || bounds.is_some()
                    || descriptor.value_type.is_some()
                    || descriptor.min.is_some()
                    || descriptor.max.is_some()
                    || !matches!(&descriptor.field, JsMcpField::Ref {model: name, require_version: actual}
                        if name == &model.canonical && *actual == require_version)
                {
                    return None;
                }
            }
            ResolvedType::Array {
                element,
                ordered: true,
                nonempty: false,
            } if matches!(element.as_ref(), ResolvedType::Record { stored: true, .. }) => {
                let bounds = bounds.as_ref()?;
                let (min, max) = (bounds.min?, bounds.max?);
                let ResolvedType::Record {
                    symbol,
                    stored: true,
                } = element.as_ref()
                else {
                    return None;
                };
                let model = ir.items.get(symbol.0 as usize)?;
                // Ordinary reused reference arrays retain owning model/bounds
                // metadata, rather than a nominal value-constraint alias.
                if model.id != *symbol
                    || !matches!(model.kind, IrItemKind::Model { .. })
                    || min == 0
                    || max < min
                    || max > 200
                    || descriptor.required
                    || descriptor.array_required != Some(false)
                    || descriptor.min != Some(min)
                    || descriptor.max != Some(max)
                    || !matches!(&descriptor.field, JsMcpField::Ref {model: name, require_version: actual}
                        if name == &model.canonical && *actual == require_version)
                    || descriptor.value_type.is_some()
                {
                    return None;
                }
            }
            _ => return None,
        }
    }
    if parent_bounds.as_ref().map(|b| (b.min, b.max))
        != child_bounds.as_ref().map(|b| (b.min, b.max))
    {
        return None;
    }
    Some(())
}

fn protected_stored_query_input(
    ir: &IrProgram,
    owner: &IrItem,
    child_param: &IrItem,
    value: &super::ir::TypedExpr,
    input: &JsOperationField,
    operations: &[JsOperation],
    db: &SourceDb,
) -> Option<()> {
    let original = super::scenario_receipts::stored_reference_operand(ir, owner, value, db)?;
    let IrExpr::Member { base, .. } = &value.expr else {
        return None;
    };
    let IrExpr::Member { base, .. } = &base.expr else {
        return None;
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let parent = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .find(|parameter| parameter.name == *name)?;
    let IrItemKind::Param {
        ty:
            IrType::Known(ResolvedType::Record {
                symbol,
                stored: true,
            }),
        default: None,
        default_node: None,
        array_bounds: None,
        ..
    } = &parent.kind
    else {
        return None;
    };
    let model = ir.items.get(symbol.0 as usize)?;
    let original_input = operations
        .iter()
        .find(|operation| operation.name == owner.canonical)?
        .inputs
        .iter()
        .find(|field| field.name == *name)?;
    if !original_input.required
        || original_input.nullable
        || original_input.array_required.is_some()
        || original_input.value_type.is_some()
        || original_input.min.is_some()
        || original_input.max.is_some()
        || original_input.default.is_some()
        || original_input.computed_default
        || !matches!(&original_input.field, JsMcpField::Ref { model: name, require_version: true } if name == &model.canonical)
    {
        return None;
    }
    let IrItemKind::Param {
        ty: IrType::Known(ty),
        default: None,
        default_node: None,
        array_bounds: bounds,
        ..
    } = &child_param.kind
    else {
        return None;
    };
    if ty != &value.ty
        || ty != &original.ty
        || input.nullable
        || input.value_type.is_some()
        || input.default.is_some()
        || input.computed_default
    {
        return None;
    }
    let target = match ty {
        ResolvedType::Record {
            symbol,
            stored: true,
        } => {
            if !input.required
                || input.array_required.is_some()
                || bounds.is_some()
                || input.min.is_some()
                || input.max.is_some()
            {
                return None;
            }
            symbol
        }
        ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        } => {
            let ResolvedType::Record {
                symbol,
                stored: true,
            } = element.as_ref()
            else {
                return None;
            };
            let bounds = bounds.as_ref()?;
            let min = u64::try_from(original.min.as_ref()?.1).ok()?;
            let max = u64::try_from(original.max.as_ref()?.1).ok()?;
            if min == 0
                || max < min
                || max > 200
                || (bounds.min, bounds.max) != (Some(min), Some(max))
                || input.required
                || input.array_required != Some(false)
                || input.min != Some(min)
                || input.max != Some(max)
            {
                return None;
            }
            symbol
        }
        _ => return None,
    };
    let model = ir.items.get(target.0 as usize)?;
    (model.id == *target && matches!(model.kind, IrItemKind::Model { .. })
        && matches!(&input.field, JsMcpField::Ref { model: name, require_version: false } if name == &model.canonical))
        .then_some(())
}

fn simple_value(value: &super::ir::TypedExpr) -> bool {
    if scalar_id(&value.ty).is_none() {
        return false;
    }
    let mut pending = vec![(value, 0usize)];
    let mut steps = 0;
    while let Some((value, depth)) = pending.pop() {
        steps += 1;
        if steps > 4096 || depth > 64 {
            return false;
        }
        match &value.expr {
            IrExpr::Name(_)
            | IrExpr::Int(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Decimal(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_)
            | IrExpr::DurationMs(_)
            | IrExpr::Money { .. } => {}
            IrExpr::Member { base, .. } => pending.push((base, depth + 1)),
            IrExpr::Binary { left, right, .. } => {
                pending.push((right, depth + 1));
                pending.push((left, depth + 1));
            }
            _ => return false,
        }
    }
    true
}
