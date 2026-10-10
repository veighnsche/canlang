//! Internal source-bound static call facts. No artifact or execution transport.
use super::ir::{IrEffectCallTarget, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType};
use super::js::{JsOperation, JsOperationKind};
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
    pub inputs: Vec<CallInput>,
}

/// Arguments must come from the same checked IR/cohort and real operation
/// producer. Refusal is whole-parent; source/descriptor facts alone activate no
/// runtime producer. The finite closure excludes reads, dynamic calls and
/// defaulted/composite inputs, and rejects cycles before descending.
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
        read: false,
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
                binding: None,
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
                    read: false,
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
                let descriptor = operations.iter().find(|op| op.name == child.canonical)?;
                if descriptor.kind != JsOperationKind::Scenario {
                    return None;
                }
                let result_fact = match declared {
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
                if entries.len() != params.len()
                    || params.len() != descriptor.inputs.len()
                    || params.len() > 256
                {
                    return None;
                }
                let mut keys = HashSet::new();
                let mut authored = Vec::new();
                for (name, value) in entries {
                    if !keys.insert(name)
                        || !simple_value(value)
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
                    let type_id = scalar_id(ty)?;
                    if *param_owner != child.id || ty != &value.ty {
                        return None;
                    }
                    let input = descriptor.inputs.iter().find(|input| input.name == *name)?;
                    if !input.required
                        || input.nullable
                        || input.array_required.is_some()
                        || input.default.is_some()
                        || input.computed_default
                        || input.value_type.as_deref() != Some(type_id)
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
