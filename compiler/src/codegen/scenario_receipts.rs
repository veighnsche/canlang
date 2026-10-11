//! Match complete checked disclosure paths to actual executable native IR sites.
//! This helper never activates capture or publishes a plan on its own.
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::analysis::scenario_disclosure::{
    DependencyRole, DisclosureChoice, DisclosureEffectKind, DisclosureIntrinsicKind,
    DisclosureModelResult, DisclosureSource, ScenarioDisclosure,
};
use crate::analysis::{ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrDeleteMode, IrEffectCallTarget, IrExpr, IrGuard, IrItem,
    IrItemKind, IrOwner, IrProgram, IrStmt, IrType, TypedExpr,
};
use super::js::{JsFieldDefault, JsModel, JsModelField, JsModelFieldType, JsValueTypes};
use super::send_guards::PreparedSendGuard;

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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub queries: Vec<ReceiptQuery>,
    pub returns: Vec<ReceiptReturn>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQuery {
    pub id: String,
    pub source: ReceiptSource,
    pub model: String,
    pub order: Vec<ReceiptQueryOrder>,
    pub limit: Option<u16>,
    pub archived: String,
    pub dependencies: Vec<ReceiptQueryDependency>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryOrder {
    pub field: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryDependency {
    pub id: String,
    pub source: ReceiptSource,
    pub role: ReceiptRole,
    pub field: String,
    #[serde(rename = "type")]
    pub type_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryProjection {
    pub kind: String,
    #[serde(rename = "queryId")]
    pub query_id: String,
    pub source: ReceiptSource,
    pub fields: Vec<ReceiptQueryProjectionField>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryProjectionField {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptReturn {
    pub id: String,
    pub source: ReceiptSource,
    pub influences: Vec<ReceiptInfluence>,
    pub dependencies: Vec<ReceiptDependency>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub intrinsics: Vec<ReceiptIntrinsic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection: Option<ReceiptQueryProjection>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptInfluence {
    pub id: String,
    pub kind: String,
    #[serde(rename = "queryId", skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptIntrinsic {
    pub id: String,
    pub source: ReceiptSource,
    pub role: ReceiptRole,
    #[serde(rename = "type")]
    pub type_id: String,
    #[serde(flatten)]
    pub kind: NativeIntrinsicKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(super) enum NativeIntrinsicKind {
    OperationId,
    AdmittedInput { parameter: String },
    AdmittedReferenceVersion { parameter: String, model: String },
}

#[derive(Debug, Clone)]
pub(super) struct NativeIntrinsic {
    pub id: String,
    pub kind: NativeIntrinsicKind,
}

#[derive(Debug, Clone)]
pub(super) struct NativeDependency {
    pub id: String,
    pub model: String,
    pub field: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NativeDecisionKind {
    ParameterDefault,
    If,
    For,
    Match,
    And,
    Or,
    Coalesce,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct NativeSite {
    pub calls: Vec<Span>,
    pub span: Span,
    /// Omission and the default expression's own decision may share a span.
    pub default_selection: bool,
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
    pub intrinsics: HashMap<NativeSite, Vec<NativeIntrinsic>>,
    pub decisions: HashMap<NativeSite, NativeDecisionKind>,
    pub decision_keys: HashMap<NativeSite, String>,
    pub calls: HashMap<NativeSite, String>,
    pub returns: Vec<NativeReturn>,
}

/// Nongrant checked result provenance. The owning receipt collector still
/// seals the actual executable effects, source, descriptors and return sites.
pub(super) fn has_original_created_model_result(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    let Some(ScenarioDisclosure::Complete(checked)) = ir.scenario_disclosures.get(&scenario) else {
        return false;
    };
    let Some(facts) = checked.source_facts.as_deref() else {
        return false;
    };
    let Some(ResolvedType::Record {
        symbol: model,
        stored: true,
    }) = &facts.result
    else {
        return false;
    };
    checked.scenario == scenario
        && facts.scenario == scenario
        && facts.node == checked.node
        && facts.source == checked.source
        && !facts.read
        && !checked.returns.is_empty()
        && checked.returns.iter().all(|returned| {
            returned.source == checked.source
                && returned
                    .model_result
                    .is_some_and(|origin| origin.model() == *model)
        })
}

/// Retain the original dispatch requirement even if editable executable SEND
/// IR no longer contains its predicate. A missing sealed Rule is not a plain SEND.
pub(super) fn has_original_guarded_send(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    ir.scenario_disclosures
        .get(&scenario)
        .is_some_and(|disclosure| {
            matches!(disclosure, ScenarioDisclosure::Complete(checked)
                if checked.effects.iter().any(|effect| matches!(effect.kind,
                    DisclosureEffectKind::Send { when: Some(_), .. })))
                || disclosure.source_facts().is_some_and(|facts| {
                    facts.decision_sites.as_ref().is_some_and(|sites| {
                        sites.iter().any(|site| {
                            site.owner == scenario
                                && site.stage
                                    == crate::analysis::scenario_disclosure::CheckedDecisionStage::SendDispatch
                        })
                    })
                })
        })
}

/// Retain this original source requirement independently of editable effects
/// or owner IDs. The private census carries checked catalog identities.
pub(super) fn has_original_images_source(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    let Some(facts) = ir
        .scenario_disclosures
        .get(&scenario)
        .and_then(|value| value.source_facts())
    else {
        return false;
    };
    let Some(types) = facts.expression_types.as_deref() else {
        return false;
    };
    ["ImageRequest", "WorkflowDefinition"].iter().all(|name| {
        types
            .iter()
            .any(|(_, ty)| crate::analysis::types::checked_standard_nominal_name(ty) == Some(*name))
    })
}

pub(super) fn checked_created_model_result(
    ir: &IrProgram,
    item: &IrItem,
) -> Option<crate::analysis::SymbolId> {
    fn visit(ir: &IrProgram, item: &IrItem, depth: usize) -> Option<crate::analysis::SymbolId> {
        if depth > 16 {
            return None;
        }
        let IrItemKind::Scenario {
            trusted: false,
            event_source: None,
            hook: None,
            cohort: None,
            read: false,
            expose_excluded: false,
            result:
                Some(ResolvedType::Record {
                    symbol: model,
                    stored: true,
                }),
            effects,
            ..
        } = &item.kind
        else {
            return None;
        };
        let declaration = ir.items.get(model.0 as usize)?;
        if declaration.id != *model || !matches!(declaration.kind, IrItemKind::Model { .. }) {
            return None;
        }
        let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&item.id)? else {
            return None;
        };
        let facts = checked.source_facts.as_deref()?;
        if checked.scenario != item.id
            || facts.scenario != item.id
            || facts.node != checked.node
            || facts.source != checked.source
            || facts.read
            || facts.result
                != Some(ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                })
            || checked.returns.is_empty()
            || checked.returns.len() > 200
        {
            return None;
        }
        for returned in &checked.returns {
            let origin = returned.model_result?;
            if origin.model() != *model || returned.source != checked.source {
                return None;
            }
            let (node, binding) = match origin {
                DisclosureModelResult::Create {
                    model: actual,
                    node,
                } => {
                    let proof = checked
                        .effects
                        .iter()
                        .find(|proof| proof.node == node && proof.source == checked.source)?;
                    let DisclosureEffectKind::Create {
                        model: proven,
                        binding,
                        ..
                    } = &proof.kind
                    else {
                        return None;
                    };
                    let IrStmt::Create {model: target, binding: Some(actual_binding), when: None, ..} = effects.iter().find(|effect|
                        matches!(effect, IrStmt::Create {span, ..} if *span == node_span(node)))? else { return None; };
                    if actual != *proven
                        || target != &declaration.canonical
                        || binding != actual_binding
                    {
                        return None;
                    }
                    (node, binding)
                }
                DisclosureModelResult::Call {
                    model: actual,
                    node,
                    operation,
                } => {
                    let proof = checked
                        .effects
                        .iter()
                        .find(|proof| proof.node == node && proof.source == checked.source)?;
                    let DisclosureEffectKind::Call {
                        operation: proven, ..
                    } = &proof.kind
                    else {
                        return None;
                    };
                    let IrStmt::Call { target: IrEffectCallTarget::Operation {operation: target, ..}, binding: Some(binding), result,
                        .. } = effects.iter().find(|effect| matches!(effect, IrStmt::Call {span, ..} if *span == node_span(node)))?
                        else { return None; };
                    let source_call = facts.calls.iter().find(|call| call.node == node)?;
                    if operation != *proven
                        || target != &operation
                        || source_call.operation != operation
                        || source_call.binding.as_ref() != Some(binding)
                        || source_call.result != *result
                        || *result
                            != Some(ResolvedType::Record {
                                symbol: actual,
                                stored: true,
                            })
                        || visit(ir, ir.items.get(operation.0 as usize)?, depth + 1)? != actual
                    {
                        return None;
                    }
                    (node, binding)
                }
            };
            let IrStmt::Return {value: Some(value), ..} = effects.iter().find(|effect|
                matches!(effect, IrStmt::Return {span, ..} if *span == node_span(returned.node)))? else { return None; };
            if node.file != returned.node.file
                || node.end > returned.node.start
                || value.ty
                    != (ResolvedType::Record {
                        symbol: *model,
                        stored: true,
                    })
                || !matches!(&value.expr, IrExpr::Name(name) if name == binding)
            {
                return None;
            }
        }
        Some(*model)
    }
    visit(ir, item, 0)
}

/// `models` must be the actual descriptors emitted by the owning emitter.
/// `entry_module` is the actual artifact callable module, not an inferred
/// package path: native scenario implementations currently execute in entry.
pub(super) fn collect_native_scenario_receipt(
    ir: &IrProgram,
    item: &IrItem,
    models: &[JsModel],
    entry_module: &str,
    db: Option<&SourceDb>,
    value_types: Option<&JsValueTypes>,
    send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
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
        params,
        ..
    } = &item.kind
    else {
        return None;
    };
    let created_model = checked_created_model_result(ir, item);
    if (!result.as_ref().is_none_or(native_result_type) && created_model.is_none())
        || entry_module.is_empty()
    {
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
    if created_model.is_some()
        || has_original_guarded_send(ir, item.id)
        || has_original_images_source(ir, item.id)
    {
        let db = db?;
        super::scenario_calls::checked_source(ir, item, db)?;
        if item.canonical != format!("{}.{}", module.name, item.name)
            || db
                .get(item.span.file)?
                .text
                .get(item.span.start as usize..item.span.end as usize)?
                != item.name
        {
            return None;
        }
    }
    if has_original_images_source(ir, item.id) {
        checked_images_source(ir, item, db?)?;
    }
    let sites = Sites::collect(ir, item, params, by, guards, effects, send_guards)?;
    match_effect_proofs(ir, item, models, checked, &sites, db, send_guards)?;
    let mut recipe = NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            version: 1,
            source,
            queries: Vec::new(),
            returns: Vec::new(),
        },
        dependencies: HashMap::new(),
        intrinsics: HashMap::new(),
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
    let mut intrinsic_ids =
        HashMap::<String, (NativeSite, NativeIntrinsicKind, String, ReceiptRole)>::new();
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
        if returned
            .dependencies
            .len()
            .checked_add(returned.intrinsics.len())?
            > 200
        {
            return None;
        }
        data_nodes = data_nodes
            .checked_add(9 + 10 * returned.dependencies.len() + 16 * returned.intrinsics.len())?;
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
        if let Some(model) = created_model {
            let IrStmt::Return {
                value: Some(value),
                span,
            } = effects.iter().find(
                |effect| matches!(effect, IrStmt::Return {span, ..} if *span == return_span),
            )?
            else {
                return None;
            };
            let IrExpr::Name(binding) = &value.expr else {
                return None;
            };
            created_record_name_matches(
                value,
                &ResolvedType::Record {
                    symbol: model,
                    stored: true,
                },
                binding,
                *span,
                db?,
            )?;
            checked_effect_node(ir, item, returned.node, db?)?;
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
            intrinsics: Vec::new(),
            projection: None,
        };
        for decision in &returned.decisions {
            let mut site = checked_site(decision.node, &decision.calls)?;
            site.default_selection = matches!(
                decision.choice,
                DisclosureChoice::DefaultEvaluated | DisclosureChoice::DefaultProvided
            );
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
                NativeDecisionKind::ParameterDefault => decision.node.kind,
                NativeDecisionKind::If => SyntaxKind::If as u8,
                NativeDecisionKind::For => SyntaxKind::For as u8,
                NativeDecisionKind::Match => SyntaxKind::Match as u8,
                _ => SyntaxKind::Binary as u8,
            };
            if decision.node.kind != expected {
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
                let mut stamp = format!(
                    "receipt-choice:{}:{}:{}:{}",
                    returned.id, span.start, span.end, site.default_selection
                );
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
            let is_transition = dependency.node.kind == SyntaxKind::Transition as u8;
            if (!is_transition && dependency.node.kind != SyntaxKind::Member as u8)
                || dependency.id.is_empty()
                || intrinsic_ids.contains_key(&dependency.id)
                || !source_matches(ir, &dependency.source, node_span(dependency.node))
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
            let (base, field, transition) = if is_transition {
                if !dependency.calls.is_empty() || dependency.role != DependencyRole::Control {
                    return None;
                }
                let statements = sites.transitions.get(&site)?;
                if statements.len() != 1 {
                    return None;
                }
                let IrStmt::Transition {
                    model,
                    record,
                    field,
                    from,
                    to,
                    ..
                } = statements[0]
                else {
                    return None;
                };
                if model != &dependency.model_name {
                    return None;
                }
                (record, field, Some((from, to)))
            } else {
                let expressions = sites.members.get(&site)?;
                if expressions.len() != 1 {
                    return None;
                }
                let IrExpr::Member { base, field } = &expressions[0].expr else {
                    return None;
                };
                (base.as_ref(), field, None)
            };
            if field != &dependency.field_name
                || base.ty
                    != (ResolvedType::Record {
                        symbol: dependency.model,
                        stored: true,
                    })
            {
                return None;
            }
            let owner = ir.items.get(dependency.model.0 as usize)?;
            let IrItemKind::Model { fields, .. } = &owner.kind else {
                return None;
            };
            let id_read = field == "id" && dependency.field == dependency.model;
            let parent_read = field == "parent" && dependency.field == dependency.model;
            let transport_type = if id_read {
                if transition.is_some()
                    || !dependency.calls.is_empty()
                    || dependency.ty != ResolvedType::Scalar(Scalar::Text)
                    || dependency.type_id != "text"
                {
                    return None;
                }
                let expression = sites.members.get(&site)?.first()?;
                let original = checked_parameter_row_id(ir, item, expression, models, db?)?;
                if original.id != dependency.model || original.canonical != dependency.model_name {
                    return None;
                }
                "text".to_string()
            } else if parent_read {
                if transition.is_some() || !dependency.calls.is_empty() {
                    return None;
                }
                let expression = sites.members.get(&site)?.first()?;
                let (child, parent) = checked_parent_reference(ir, item, expression, db?)?;
                let mut descriptors = models.iter().filter(|model| model.name == child.canonical);
                let descriptor = descriptors.next()?;
                if descriptors.next().is_some()
                    || child.id != dependency.model
                    || parent.canonical != dependency.type_id
                    || dependency.ty
                        != (ResolvedType::Record {
                            symbol: parent.id,
                            stored: true,
                        })
                    || descriptor.parent.as_deref() != Some(parent.canonical.as_str())
                    || descriptor.scope_app
                    || descriptor.fields.iter().any(|field| field.name == "parent")
                {
                    return None;
                }
                parent.canonical.clone()
            } else {
                let stored = ir.items.get(dependency.field.0 as usize)?;
                let IrItemKind::Field {
                    owner: field_owner,
                    ty: IrType::Known(ty),
                    required_array,
                    modifiers,
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
                if declared.len() != 1 {
                    return None;
                }
                if !matches!(base.expr, IrExpr::Name(_)) {
                    let (_, parent) = checked_parent_reference(ir, item, base, db?)?;
                    if parent.id != dependency.model {
                        return None;
                    }
                }
                let reference_type = reference_operand_type_id(ir, ty);
                if let Some(reference_type) = reference_type {
                    if transition.is_some() || !dependency.calls.is_empty() {
                        return None;
                    }
                    let expression = sites.members.get(&site)?.first()?;
                    let original = stored_reference_operand(ir, item, expression, db?)?;
                    if original.id != stored.id
                        || reference_type != dependency.type_id
                        || !stored_reference_descriptor_matches(ir, original, declared[0])
                    {
                        return None;
                    }
                    reference_type
                } else if *required_array {
                    return None;
                } else if let ResolvedType::Enum {
                    owner: Some(enum_owner),
                    cases,
                } = ty
                {
                    // This inventory adaptation belongs only to a real transition
                    // recipe. Standalone machine-field reads retain their refusal.
                    if sites.transitions.is_empty()
                        || *enum_owner != stored.id
                        || dependency.type_id != stored.canonical
                        || !modifiers.machine
                    {
                        return None;
                    }
                    let descriptor = declared[0];
                    let JsModelFieldType::Enum { values } = &descriptor.field else {
                        return None;
                    };
                    let machine = descriptor.machine.as_ref()?;
                    if descriptor.nullable
                        || descriptor.array_required.is_some()
                        || values != cases
                        || &machine.states != cases
                        || !cases.contains(&machine.initial)
                    {
                        return None;
                    }
                    if let Some((from, to)) = transition
                        && (!cases.contains(from)
                            || !cases.contains(to)
                            || !machine.transitions.iter().any(|edge| {
                                edge.from == *from
                                    && edge.to == *to
                                    && edge.operation == item.canonical
                            }))
                    {
                        return None;
                    }
                    let inline = format!("enum({})", cases.join(","));
                    if inventory_type(descriptor)? != inline {
                        return None;
                    }
                    inline
                } else if let Some(contract) = stored_contract_inventory_type(
                    ir,
                    value_types,
                    ty,
                    declared[0],
                    stored,
                    checked.source_facts.as_deref(),
                    db,
                ) {
                    if transition.is_some() || contract != dependency.type_id {
                        return None;
                    }
                    contract
                } else {
                    if transition.is_some()
                        || !supported_type_id(&dependency.type_id)
                        || inventory_type(declared[0])?.as_str() != dependency.type_id
                    {
                        return None;
                    }
                    dependency.type_id.clone()
                }
            };
            let role = match dependency.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            let identity = (
                site.clone(),
                dependency.model_name.clone(),
                dependency.field_name.clone(),
                transport_type.clone(),
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
                if dependency_ids.len() + intrinsic_ids.len() > 200 {
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
                type_id: transport_type,
            });
        }
        for intrinsic in &returned.intrinsics {
            if intrinsic.id.is_empty()
                || dependency_ids.contains_key(&intrinsic.id)
                || plan_return
                    .intrinsics
                    .iter()
                    .any(|value| value.id == intrinsic.id)
                || !source_matches(ir, &intrinsic.source, node_span(intrinsic.node))
                || (intrinsic.calls.is_empty() && intrinsic.source != checked.source)
            {
                return None;
            }
            let source_key = (intrinsic.node.file, intrinsic.source.module.clone());
            if let Some(previous) = source_origins.get(&source_key) {
                if previous != &intrinsic.source {
                    return None;
                }
            } else {
                source_origins.insert(source_key, intrinsic.source.clone());
            }
            let site = checked_site(intrinsic.node, &intrinsic.calls)?;
            let input = matches!(
                intrinsic.kind,
                DisclosureIntrinsicKind::AdmittedInput { .. }
            );
            if if input {
                intrinsic.node.kind != SyntaxKind::NameRef as u8
                    && intrinsic.node.kind != SyntaxKind::Path as u8
                    && intrinsic.node.kind != SyntaxKind::Name as u8
            } else {
                intrinsic.node.kind != SyntaxKind::Member as u8
            } {
                return None;
            }
            let expressions = if input {
                sites.names.get(&site)?
            } else {
                sites.members.get(&site)?
            };
            if expressions.len() != 1 {
                return None;
            }
            let expression = expressions[0];
            if expression.ty != intrinsic.ty {
                return None;
            }
            let kind = match &intrinsic.kind {
                DisclosureIntrinsicKind::OperationId => {
                    let IrExpr::Member { base, field } = &expression.expr else {
                        return None;
                    };
                    if field != "id"
                        || base.ty != ResolvedType::OperationContext
                        || !matches!(&base.expr, IrExpr::Member { base: context, field: operation }
                            if operation == "operation" && context.ty == ResolvedType::Unknown
                                && matches!(&context.expr, IrExpr::Name(name) if name == "c"))
                        || intrinsic.ty != ResolvedType::Scalar(Scalar::Text)
                        || intrinsic.type_id != "text"
                    {
                        return None;
                    }
                    NativeIntrinsicKind::OperationId
                }
                DisclosureIntrinsicKind::AdmittedInput {
                    parameter,
                    parameter_name,
                } => {
                    if !matches!(expression.expr, IrExpr::Name(_))
                        || !direct_field_name(parameter_name)
                    {
                        return None;
                    }
                    let ResolvedType::Scalar(scalar) = &intrinsic.ty else {
                        return None;
                    };
                    if !matches!(
                        scalar,
                        Scalar::Text
                            | Scalar::Bool
                            | Scalar::Int
                            | Scalar::Date
                            | Scalar::Datetime
                            | Scalar::Decimal
                            | Scalar::Money
                            | Scalar::Duration
                            | Scalar::User
                    ) || intrinsic.type_id != scalar.as_str()
                    {
                        return None;
                    }
                    let parameter_item = ir.items.get(parameter.0 as usize)?;
                    let IrItemKind::Param {
                        owner: parameter_owner,
                        index,
                        ty: IrType::Known(parameter_ty),
                        default,
                        ..
                    } = &parameter_item.kind
                    else {
                        return None;
                    };
                    if parameter_item.id != *parameter
                        || *parameter_owner != item.id
                        || params.get(*index) != Some(parameter)
                        || parameter_item.name != *parameter_name
                        || parameter_ty != &intrinsic.ty
                        || default.is_some()
                    {
                        return None;
                    }
                    NativeIntrinsicKind::AdmittedInput {
                        parameter: parameter_name.clone(),
                    }
                }
                DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter,
                    parameter_name,
                    model,
                    model_name,
                } => {
                    let IrExpr::Member { base, field } = &expression.expr else {
                        return None;
                    };
                    if field != "version"
                        || !matches!(base.expr, IrExpr::Name(_))
                        || base.ty
                            != (ResolvedType::Record {
                                symbol: *model,
                                stored: true,
                            })
                        || intrinsic.ty != ResolvedType::Scalar(Scalar::Int)
                        || intrinsic.type_id != "int"
                        || !direct_field_name(parameter_name)
                    {
                        return None;
                    }
                    let parameter_item = ir.items.get(parameter.0 as usize)?;
                    let IrItemKind::Param {
                        owner: parameter_owner,
                        index,
                        ty: IrType::Known(parameter_ty),
                        default,
                        ..
                    } = &parameter_item.kind
                    else {
                        return None;
                    };
                    if parameter_item.id != *parameter
                        || *parameter_owner != item.id
                        || params.get(*index) != Some(parameter)
                        || parameter_item.name != *parameter_name
                        || parameter_ty != &base.ty
                        || default.is_some()
                    {
                        return None;
                    }
                    let model_item = ir.items.get(model.0 as usize)?;
                    if model_item.id != *model
                        || model_item.canonical != *model_name
                        || !matches!(model_item.kind, IrItemKind::Model { .. })
                        || models
                            .iter()
                            .filter(|value| value.name == *model_name)
                            .count()
                            != 1
                    {
                        return None;
                    }
                    NativeIntrinsicKind::AdmittedReferenceVersion {
                        parameter: parameter_name.clone(),
                        model: model_name.clone(),
                    }
                }
            };
            let role = match intrinsic.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            let identity = (site.clone(), kind.clone(), intrinsic.type_id.clone(), role);
            if let Some(previous) = intrinsic_ids.get(&intrinsic.id) {
                if previous != &identity {
                    return None;
                }
            } else {
                intrinsic_ids.insert(intrinsic.id.clone(), identity);
                if dependency_ids.len() + intrinsic_ids.len() > 200 {
                    return None;
                }
            }
            let observed = recipe.intrinsics.entry(site).or_default();
            if !observed.iter().any(|value| value.id == intrinsic.id) {
                observed.push(NativeIntrinsic {
                    id: intrinsic.id.clone(),
                    kind: kind.clone(),
                });
            }
            plan_return.intrinsics.push(ReceiptIntrinsic {
                id: intrinsic.id.clone(),
                source: transport_source(&intrinsic.source, entry_module)?,
                role,
                type_id: intrinsic.type_id.clone(),
                kind,
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

fn checked_images_source(ir: &IrProgram, owner: &IrItem, db: &SourceDb) -> Option<()> {
    use crate::analysis::NodeKey;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        params,
        by,
        guards,
        effects,
        result: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let file = db.get(source.node.file)?;
    let (tree, diagnostics) = crate::syntax::parse_source(source.node.file, &file.text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut nodes = HashMap::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        if nodes.len() >= 200000 || nodes.insert(NodeKey::of(node), node).is_some() {
            return None;
        }
        pending.extend(node.children.iter());
    }
    let authored = nodes.get(&source.node)?;
    if authored.kind != SyntaxKind::Scenario
        || !guards.is_empty()
        || authored
            .children
            .iter()
            .any(|part| part.kind == SyntaxKind::Require)
    {
        return None;
    }
    match (
        crate::analysis::attribute_value(authored, "by", &file.text),
        by.as_slice(),
    ) {
        (Some(node), [IrGuard::Role(role)])
            if node.kind == SyntaxKind::NameRef
                && matches!(
                    role.as_str(),
                    "members" | "owner" | "authenticated" | "public"
                )
                && images_source_name(node, &file.text)? == role => {}
        (None, []) => {}
        _ => return None,
    }
    let census = source.expression_types.as_deref()?;
    if census.len() > 16384 {
        return None;
    }
    let mut types = HashMap::new();
    for (node, ty) in census {
        if !nodes.contains_key(node) || types.insert(*node, ty).is_some() {
            return None;
        }
    }
    let mut names = HashMap::new();
    for (position, (id, fact)) in params.iter().zip(&source.parameters).enumerate() {
        let parameter = ir.items.get(id.0 as usize)?;
        let IrItemKind::Param {
            owner: parent,
            index,
            ty: IrType::Known(ty),
            array_bounds: None,
            default: None,
            default_node: None,
            default_copy_source: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let declaration = nodes.get(&fact.node)?;
        let name = declaration
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Name)?;
        if declaration.kind != SyntaxKind::Parameter
            || parameter.id != fact.parameter
            || *parent != owner.id
            || *index != position
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
            || parameter.span != name.span
            || name.token()?.text(&file.text) != parameter.name
            || ty != &fact.ty
            || fact.default.is_some()
            || names.insert(parameter.name.clone(), ty.clone()).is_some()
        {
            return None;
        }
    }
    let mut blocks = authored
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::DoBlock);
    let block = blocks.next()?;
    let statements: Vec<_> = block
        .children
        .iter()
        .filter(|part| {
            !matches!(
                part.kind,
                SyntaxKind::Trivia | SyntaxKind::Comment | SyntaxKind::Name | SyntaxKind::Punct
            )
        })
        .collect();
    if blocks.next().is_some()
        || statements.is_empty()
        || statements.len() > 200
        || statements.len() != effects.len()
    {
        return None;
    }
    for (actual, original) in effects.iter().zip(statements) {
        let matcher = ImagesSourceExpressions {
            text: &file.text,
            types: &types,
            names: &names,
        };
        match (actual, original.kind) {
            (IrStmt::Let { name, value, span }, SyntaxKind::Let) if *span == original.span => {
                let mut bindings = original
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Name);
                if bindings.next()?.token()?.text(&file.text) != "let"
                    || bindings.next()?.token()?.text(&file.text) != name
                    || bindings.next().is_some()
                {
                    return None;
                }
                let values = images_source_values(original);
                let [authored_value] = values.as_slice() else {
                    return None;
                };
                matcher.expression(value, authored_value, 0)?;
                if names.insert(name.clone(), value.ty.clone()).is_some() {
                    return None;
                }
            }
            (
                IrStmt::Send {
                    args,
                    operation,
                    binding: Some(binding),
                    when: None,
                    span,
                    ..
                },
                SyntaxKind::Send,
            ) if *span == original.span => {
                let parts: Vec<_> = original
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Name)
                    .collect();
                let [send, as_word, authored_binding] = parts.as_slice() else {
                    return None;
                };
                if send.token()?.text(&file.text) != "send"
                    || as_word.token()?.text(&file.text) != "as"
                    || authored_binding.token()?.text(&file.text) != binding
                    || args.span != *span
                    || args.ty != ResolvedType::Unknown
                {
                    return None;
                }
                let mut objects = original
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Object);
                matcher.entries(args, objects.next()?, 0)?;
                if objects.next().is_some() {
                    return None;
                }
                let mut bindings = census.iter().filter(|(key, _)| {
                    nodes.get(key).is_some_and(|node| {
                        node.kind == SyntaxKind::NameRef
                            && images_source_name(node, &file.text) == Some(binding.as_str())
                    })
                });
                let (_, delivery) = bindings.next()?;
                let ResolvedType::StdDelivery { capability, op } = delivery else {
                    return None;
                };
                if *capability != "std.ImagesV1"
                    || op.name != "submit"
                    || *operation != format!("{capability}.{}", op.name)
                    || bindings.any(|(_, ty)| ty != delivery)
                    || names.insert(binding.clone(), delivery.clone()).is_some()
                {
                    return None;
                }
            }
            (
                IrStmt::Set {
                    record,
                    changes,
                    when: None,
                    span,
                },
                SyntaxKind::Set,
            ) if *span == original.span => {
                let mut paths = original
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Path);
                matcher.expression(record, paths.next()?, 0)?;
                let mut objects = original
                    .children
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::Object);
                matcher.entries(changes, objects.next()?, 0)?;
                if paths.next().is_some()
                    || objects.next().is_some()
                    || changes.span != *span
                    || changes.ty != ResolvedType::Unknown
                {
                    return None;
                }
            }
            (IrStmt::Require { cond, span }, SyntaxKind::Require) if *span == original.span => {
                let values = images_source_values(original);
                let [value] = values.as_slice() else {
                    return None;
                };
                if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
                    return None;
                }
                matcher.expression(cond, value, 0)?;
            }
            _ => return None,
        }
    }
    Some(())
}

struct ImagesSourceExpressions<'a> {
    text: &'a str,
    types: &'a HashMap<crate::analysis::NodeKey, &'a ResolvedType>,
    names: &'a HashMap<String, ResolvedType>,
}

impl ImagesSourceExpressions<'_> {
    fn expression(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        depth: usize,
    ) -> Option<()> {
        use crate::analysis::NodeKey;
        if depth > 64
            || actual.span != original.span
            || self.types.get(&NodeKey::of(original)).copied()? != &actual.ty
            || matches!(actual.ty, ResolvedType::Unknown | ResolvedType::Error)
        {
            return None;
        }
        let mut original = original;
        for _ in depth..=64 {
            if original.kind != SyntaxKind::Group {
                break;
            }
            let values = images_source_values(original);
            let [value] = values.as_slice() else {
                return None;
            };
            if self.types.get(&NodeKey::of(value)).copied()? != &actual.ty {
                return None;
            }
            original = value;
        }
        let leaf = |kind| original.children.iter().find(|part| part.kind == kind);
        let matched = match (&actual.expr, original.kind) {
            (IrExpr::Name(name), SyntaxKind::Name | SyntaxKind::NameRef | SyntaxKind::Path) => {
                images_source_name(original, self.text)? == name
                    && self.names.get(name) == Some(&actual.ty)
            }
            (IrExpr::Text(value), SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Scalar(Scalar::Text)
                    && leaf(SyntaxKind::String)?.token()?.string_value.as_ref()? == value
            }
            (IrExpr::Int(value), SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Scalar(Scalar::Int)
                    && leaf(SyntaxKind::Integer)?
                        .token()?
                        .text(self.text)
                        .parse::<i128>()
                        .ok()?
                        == *value
            }
            (IrExpr::Decimal(value), SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Scalar(Scalar::Decimal)
                    && leaf(SyntaxKind::Decimal)?.token()?.text(self.text) == value
            }
            (IrExpr::Bool(value), SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Scalar(Scalar::Bool)
                    && leaf(SyntaxKind::Name)?.token()?.text(self.text)
                        == if *value { "true" } else { "false" }
            }
            (IrExpr::Null, SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Null
                    && leaf(SyntaxKind::Name)?.token()?.text(self.text) == "null"
            }
            (IrExpr::DurationMs(value), SyntaxKind::Literal) => {
                let spelling = leaf(SyntaxKind::Duration)?.token()?.text(self.text);
                let mut duration = None;
                for (unit, factor) in [
                    ("ms", 1i128),
                    ("s", 1000),
                    ("m", 60000),
                    ("h", 3600000),
                    ("d", 86400000),
                ] {
                    if let Some(digits) = spelling.strip_suffix(unit).filter(|digits| {
                        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
                    }) {
                        duration = digits.parse::<i128>().ok()?.checked_mul(factor);
                        break;
                    }
                }
                actual.ty == ResolvedType::Scalar(Scalar::Duration) && duration == Some(*value)
            }
            (IrExpr::Member { base, field }, SyntaxKind::Member) => {
                let parts: Vec<_> = original
                    .children
                    .iter()
                    .filter(|part| part.kind != SyntaxKind::Trivia)
                    .collect();
                let [receiver, dot, member] = parts.as_slice() else {
                    return None;
                };
                if dot.token()?.text(self.text) != "."
                    || member.kind != SyntaxKind::Name
                    || member.token()?.text(self.text) != field
                {
                    return None;
                }
                self.expression(base, receiver, depth + 1)?;
                true
            }
            (IrExpr::Object(entries), SyntaxKind::Construct) => {
                let name = crate::analysis::types::checked_standard_nominal_name(&actual.ty)?;
                if !matches!(
                    name,
                    "WorkflowInput" | "WorkflowDefinition" | "ImageRequest"
                ) {
                    return None;
                }
                let values = images_source_values(original);
                let [target, object] = values.as_slice() else {
                    return None;
                };
                let ResolvedType::StdNominal { fields, .. } = &actual.ty else {
                    return None;
                };
                if target.kind != SyntaxKind::NameRef
                    || images_source_name(target, self.text)? != name
                    || object.kind != SyntaxKind::Object
                    || fields.len() != entries.len()
                    || entries.iter().any(|(name, value)| {
                        fields
                            .iter()
                            .find(|(field, _)| field == name)
                            .is_none_or(|(_, ty)| ty != &value.ty)
                    })
                {
                    return None;
                }
                self.entries(actual, object, depth + 1)?;
                true
            }
            (IrExpr::Object(_), SyntaxKind::Object) => {
                if !matches!(actual.ty, ResolvedType::Object(_)) {
                    return None;
                }
                self.entries(actual, original, depth + 1)?;
                true
            }
            _ => false,
        };
        matched.then_some(())
    }

    fn entries(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        depth: usize,
    ) -> Option<()> {
        let IrExpr::Object(entries) = &actual.expr else {
            return None;
        };
        let authored: Vec<_> = original
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::ObjectEntry)
            .collect();
        if depth > 64
            || original.kind != SyntaxKind::Object
            || entries.len() > 200
            || entries.len() != authored.len()
        {
            return None;
        }
        let mut seen = HashSet::new();
        for ((name, value), entry) in entries.iter().zip(authored) {
            let key = entry
                .children
                .iter()
                .find(|part| part.kind == SyntaxKind::Name)?;
            if key.token()?.text(self.text) != name || !seen.insert(name) {
                return None;
            }
            let values = images_source_values(entry);
            match values.as_slice() {
                [] => self.expression(value, key, depth + 1)?,
                [original] => self.expression(value, original, depth + 1)?,
                _ => return None,
            }
        }
        Some(())
    }
}

fn images_source_name<'a>(node: &crate::syntax::SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        return Some(node.token()?.text(text));
    }
    if !matches!(node.kind, SyntaxKind::NameRef | SyntaxKind::Path) {
        return None;
    }
    let mut parts = node
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia);
    let name = parts.next()?;
    (name.kind == SyntaxKind::Name && parts.next().is_none())
        .then(|| name.token().map(|token| token.text(text)))
        .flatten()
}

fn images_source_values(node: &crate::syntax::SyntaxNode) -> Vec<&crate::syntax::SyntaxNode> {
    node.children
        .iter()
        .filter(|part| {
            matches!(
                part.kind,
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
        })
        .collect()
}

/// Reserved row IDs belong to the original required model parameter. They
/// are receipt dependencies, not authored fields or reconstructed references.
fn checked_parameter_row_id<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    models: &[JsModel],
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    if field != "id" || value.ty != ResolvedType::Scalar(Scalar::Text) {
        return None;
    }
    let mut parameters = params
        .iter()
        .enumerate()
        .filter_map(|(position, id)| Some((position, ir.items.get(id.0 as usize)?)))
        .filter(|(_, parameter)| parameter.name == *name);
    let (position, parameter) = parameters.next()?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol,
                stored: true,
            }),
        array_bounds: None,
        default: None,
        default_node: None,
        default_copy_source: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let fact = source.parameters.get(position)?;
    let module = ir.modules.get(owner.module.0 as usize)?;
    let text = &db.get(source.node.file)?.text;
    if parameters.next().is_some()
        || *parameter_owner != owner.id
        || *index != position
        || parameter.id != fact.parameter
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
        || owner.canonical != format!("{}.{}", module.name, owner.name)
        || text.get(owner.span.start as usize..owner.span.end as usize) != Some(owner.name.as_str())
        || base.ty != fact.ty
        || fact.default.is_some()
        || fact.constraints.is_some()
        || !reference_read_matches(ir, owner, value, *symbol, *symbol, "text")
    {
        return None;
    }
    let authored = checked_effect_node(
        ir,
        owner,
        crate::analysis::NodeKey {
            file: value.span.file,
            start: value.span.start,
            end: value.span.end,
            kind: SyntaxKind::Member as u8,
        },
        db,
    )?;
    let parts: Vec<_> = authored
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    let [receiver, dot, member] = parts.as_slice() else {
        return None;
    };
    let declaration = checked_effect_node(ir, owner, fact.node, db)?;
    let parameter_name = declaration
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::Name)?;
    let declared_type = declaration
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::NamedType)?;
    let mut paths = declared_type
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Path);
    let type_path = paths.next()?;
    if receiver.kind != SyntaxKind::NameRef
        || receiver.span != base.span
        || text.get(base.span.start as usize..base.span.end as usize) != Some(name.as_str())
        || dot.token()?.text(text) != "."
        || member.kind != SyntaxKind::Name
        || member.token()?.text(text) != "id"
        || declaration.kind != SyntaxKind::Parameter
        || parameter_name.span != parameter.span
        || parameter_name.token()?.text(text) != name
        || crate::analysis::NodeKey::of(declared_type) != fact.type_node
        || paths.next().is_some()
    {
        return None;
    }
    let mut schemas = source
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == *symbol);
    let original = schemas.next()?;
    let model = ir.items.get(symbol.0 as usize)?;
    if schemas.next().is_some()
        || model.module != owner.module
        || direct_source_path_name(type_path, text)? != model.name
        || original.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "id")
        })
    {
        return None;
    }
    match_stored_contract_schema(ir, original, db)?;
    for field in &original.fields {
        match_stored_contract_field(ir, field, db)?;
    }
    let generated = super::js::Emitter::new(ir).collect_models();
    let mut expected = generated
        .iter()
        .filter(|model| model.name == original.canonical);
    let mut supplied = models
        .iter()
        .filter(|model| model.name == original.canonical);
    let expected_descriptor = expected.next()?;
    let descriptor = supplied.next()?;
    if expected.next().is_some()
        || supplied.next().is_some()
        || descriptor.fields.iter().any(|field| field.name == "id")
        || serde_json::to_value(expected_descriptor).ok()?
            != serde_json::to_value(descriptor).ok()?
    {
        return None;
    }
    Some(original)
}

/// The selected source operand follows at most two genuine containment edges
/// from its original required input. Each edge retains its own observed site.
pub(super) fn checked_parent_reference<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
)> {
    checked_parent_reference_at(ir, owner, value, db, 2)
}

fn checked_parent_reference_at<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    remaining: usize,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
)> {
    if remaining == 0 {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    if field != "parent"
        || base.span.file != value.span.file
        || base.span.start != value.span.start
        || base.span.end >= value.span.end
    {
        return None;
    }
    let symbol = match &base.expr {
        IrExpr::Name(name) => {
            let mut parameters = params
                .iter()
                .filter_map(|id| ir.items.get(id.0 as usize))
                .filter(|parameter| parameter.name == *name);
            let parameter = parameters.next()?;
            let IrItemKind::Param {
                owner: parameter_owner,
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                default: None,
                default_node: None,
                array_bounds: None,
                ..
            } = &parameter.kind
            else {
                return None;
            };
            let file = db.get(base.span.file)?;
            if parameters.next().is_some()
                || *parameter_owner != owner.id
                || file
                    .text
                    .get(base.span.start as usize..base.span.end as usize)?
                    != name
            {
                return None;
            }
            *symbol
        }
        IrExpr::Member { field, .. } if field == "parent" => {
            let (_, parent) = checked_parent_reference_at(ir, owner, base, db, remaining - 1)?;
            parent.id
        }
        _ => return None,
    };
    if base.ty
        != (ResolvedType::Record {
            symbol,
            stored: true,
        })
    {
        return None;
    }
    let inventory = source.stored_contracts.as_deref()?;
    let mut children = inventory
        .iter()
        .filter(|schema| schema.model && schema.id == symbol);
    let child = children.next()?;
    let mut parents = inventory
        .iter()
        .filter(|schema| schema.model && Some(schema.id) == child.parent);
    let parent = parents.next()?;
    if children.next().is_some()
        || parents.next().is_some()
        || value.ty
            != (ResolvedType::Record {
                symbol: parent.id,
                stored: true,
            })
        || child.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "parent")
        })
        || !reference_read_matches(ir, owner, value, child.id, child.id, &parent.canonical)
    {
        return None;
    }
    match_stored_contract_schema(ir, child, db)?;
    match_stored_contract_schema(ir, parent, db)?;
    Some((child, parent))
}

fn reference_read_matches(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    model: crate::analysis::resolve::SymbolId,
    field: crate::analysis::resolve::SymbolId,
    type_id: &str,
) -> bool {
    let Some(ScenarioDisclosure::Complete(checked)) = ir.scenario_disclosures.get(&owner.id) else {
        return false;
    };
    checked
        .returns
        .iter()
        .flat_map(|returned| &returned.dependencies)
        .any(|read| {
            read.model == model
                && read.field == field
                && read.ty == value.ty
                && read.type_id == type_id
                && read.calls.is_empty()
                && read.source == checked.source
                && node_span(read.node) == value.span
        })
}

pub(super) fn stored_reference_operand<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let (_, parent) = checked_parent_reference(ir, owner, base, db)?;
    let mut fields = parent
        .fields
        .iter()
        .filter(|original| original.name == *field);
    let original = fields.next()?;
    let member = ir.items.get(original.id.0 as usize)?;
    let IrItemKind::Field {
        default: None,
        server: None,
        modifiers,
        ..
    } = &member.kind
    else {
        return None;
    };
    let type_id = reference_operand_type_id(ir, &original.ty)?;
    if fields.next().is_some()
        || original.owner != parent.id
        || original.ty != value.ty
        || modifiers.machine
        || !reference_read_matches(ir, owner, value, parent.id, original.id, &type_id)
    {
        return None;
    }
    match_stored_contract_field(ir, original, db)?;
    // Reused array bounds retain the actual Scope declaration. Target models
    // are checked nominal identities; they do not become recursive row views.
    if matches!(original.ty, ResolvedType::Array { .. }) {
        let source = super::scenario_calls::checked_source(ir, owner, db)?;
        let inventory = source.stored_contracts.as_deref()?;
        let reused = original.reuse?;
        let mut scopes = inventory.iter().filter(|schema| {
            !schema.model
                && schema
                    .fields
                    .iter()
                    .any(|field| field.id == reused && field.ty == original.ty)
        });
        let scope = scopes.next()?;
        if scopes.next().is_some() {
            return None;
        }
        match_stored_contract_schema(ir, scope, db)?;
        for field in &scope.fields {
            match_stored_contract_field(ir, field, db)?;
        }
        let (min, max) = (original.min.as_ref()?.1, original.max.as_ref()?.1);
        let reused = scope.fields.iter().find(|field| field.id == reused)?;
        if !(1..=200).contains(&min)
            || max < min
            || max > 200
            || reused.min.as_ref()?.1 != min
            || reused.max.as_ref()?.1 != max
        {
            return None;
        }
    }
    Some(original)
}

fn reference_operand_type_id(ir: &IrProgram, ty: &ResolvedType) -> Option<String> {
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
    let model = ir.items.get(symbol.0 as usize)?;
    (model.id == *symbol && matches!(model.kind, IrItemKind::Model { .. }))
        .then(|| format!("{}{}", model.canonical, if array { "[]" } else { "" }))
}

fn stored_reference_descriptor_matches(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    field: &JsModelField,
) -> bool {
    let Some(type_id) = reference_operand_type_id(ir, &original.ty) else {
        return false;
    };
    let array = matches!(original.ty, ResolvedType::Array { .. });
    let base = type_id.strip_suffix("[]").unwrap_or(&type_id);
    let bound = |value: &Option<(crate::analysis::NodeKey, i64, DisclosureSource)>| {
        value
            .as_ref()
            .map(|(_, value, _)| serde_json::Value::from(*value))
    };
    field.name == original.name
        && matches!(&field.field, JsModelFieldType::Ref { model } if model == base)
        && field.value_type.as_deref() == Some(type_id.as_str())
        && !field.nullable
        && !field.server_only
        && field.default.is_none()
        && field.machine.is_none()
        && field.required == (!array || original.required_array)
        && field.array_required == array.then_some(original.required_array)
        && field.trim == original.trim.then_some(true)
        && field.min == bound(&original.min)
        && field.max == bound(&original.max)
}

/// Only an owning whole stored contract dependency uses this codec. Its local
/// members are already canonical values; neither nominal results nor stored
/// reference views gain admission here.
fn stored_contract_inventory_type(
    ir: &IrProgram,
    value_types: Option<&JsValueTypes>,
    ty: &ResolvedType,
    field: &JsModelField,
    stored: &IrItem,
    source: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
    db: Option<&SourceDb>,
) -> Option<String> {
    let ResolvedType::Record { symbol, .. } = ty else {
        return None;
    };
    let declaration = ir.items.get(symbol.0 as usize)?;
    let IrItemKind::Contract { fields, .. } = &declaration.kind else {
        return None;
    };
    let JsModelFieldType::Nominal { name } = &field.field else {
        return None;
    };
    if declaration.id != *symbol
        || name != &declaration.canonical
        || field.value_type.as_deref() != Some(declaration.canonical.as_str())
        || field.nullable
        || field.array_required.is_some()
        || field.machine.is_some()
        || fields.is_empty()
        || fields.len() > 200
    {
        return None;
    }
    let db = db?;
    let inventory = source?.stored_contracts.as_deref()?;
    let mut roots = inventory
        .iter()
        .filter(|schema| schema.model && schema.fields.iter().any(|field| field.id == stored.id));
    let root = roots.next()?;
    if roots.next().is_some() {
        return None;
    }
    match_stored_contract_schema(ir, root, db)?;
    let original = root.fields.iter().find(|field| field.id == stored.id)?;
    match_stored_contract_field(ir, original, db)?;
    if original.ty != *ty {
        return None;
    }
    let value_types = value_types?;
    let mut pending = vec![*symbol];
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > 200 {
            return None;
        }
        let mut schemas = inventory
            .iter()
            .filter(|schema| !schema.model && schema.id == id);
        let schema = schemas.next()?;
        if schemas.next().is_some() {
            return None;
        }
        match_stored_contract_schema(ir, schema, db)?;
        let mut contracts = value_types
            .contracts
            .iter()
            .filter(|contract| contract.name == schema.canonical);
        let contract = contracts.next()?;
        if contracts.next().is_some() || contract.fields.len() != schema.fields.len() {
            return None;
        }
        for (original, leaf) in schema.fields.iter().zip(&contract.fields) {
            match_stored_contract_field(ir, original, db)?;
            let mut constraints = original.constraints.as_ref().map_or_else(
                super::js::JsValueConstraints::default,
                super::js::JsValueConstraints::from,
            );
            if original.trim {
                constraints.trim = Some(true);
            }
            if original.constraints.is_none() {
                let mut base = &original.ty;
                while let ResolvedType::Nullable(inner) = base {
                    base = inner;
                }
                let length = matches!(base, ResolvedType::Array { .. })
                    || matches!(base, ResolvedType::Scalar(scalar) if scalar.is_string_like());
                let bound = |value: i64| {
                    if length {
                        serde_json::Value::from(value)
                    } else {
                        serde_json::Value::String(value.to_string())
                    }
                };
                constraints.min = original.min.as_ref().map(|(_, value, _)| bound(*value));
                constraints.max = original.max.as_ref().map(|(_, value, _)| bound(*value));
            }
            let expected = super::js::JsNominalLeaf {
                name: original.name.clone(),
                declared: original.declared.clone(),
                constraints,
            };
            if serde_json::to_value(leaf).ok()? != serde_json::to_value(&expected).ok()? {
                return None;
            }
            let mut base = &original.ty;
            let mut depth = 0;
            while let ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } =
                base
            {
                depth += 1;
                if depth > 64 {
                    return None;
                }
                base = inner;
            }
            if let ResolvedType::Record { symbol, .. } = base
                && (inventory
                    .iter()
                    .any(|schema| !schema.model && schema.id == *symbol)
                    || matches!(
                        ir.items.get(symbol.0 as usize)?.kind,
                        IrItemKind::Contract { .. }
                    ))
            {
                pending.push(*symbol);
                if pending.len() > 4096 {
                    return None;
                }
            }
        }
    }
    Some(declaration.canonical.clone())
}

fn match_stored_contract_schema(
    ir: &IrProgram,
    schema: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    db: &SourceDb,
) -> Option<()> {
    let item = ir.items.get(schema.id.0 as usize)?;
    let fields = match &item.kind {
        IrItemKind::Model { fields, owner, .. }
            if schema.model
                && match owner {
                    IrOwner::ChildOf(parent) => {
                        schema.parent == Some(*parent)
                            && schema.owner
                                == Some(crate::analysis::resolve::ModelOwner::ChildOf(*parent))
                    }
                    IrOwner::Team => {
                        schema.parent.is_none()
                            && schema.owner == Some(crate::analysis::resolve::ModelOwner::Team)
                    }
                    IrOwner::App => {
                        schema.parent.is_none()
                            && schema.owner == Some(crate::analysis::resolve::ModelOwner::App)
                    }
                } =>
        {
            fields
        }
        IrItemKind::Contract { fields, .. }
            if !schema.model && schema.parent.is_none() && schema.owner.is_none() =>
        {
            fields
        }
        _ => return None,
    };
    if item.id != schema.id
        || item.canonical != schema.canonical
        || item.module != schema.module
        || item.span != schema.span
        || fields != &schema.field_order
        || (!schema.model
            && schema
                .fields
                .iter()
                .map(|field| field.id)
                .collect::<Vec<_>>()
                != *fields)
    {
        return None;
    }
    match_stored_contract_source(ir, &schema.source, item.span, db)
}

fn match_stored_contract_field(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    db: &SourceDb,
) -> Option<()> {
    let member = ir.items.get(original.id.0 as usize)?;
    let IrItemKind::Field {
        owner,
        ty: IrType::Known(ty),
        required_array,
        modifiers,
        ..
    } = &member.kind
    else {
        return None;
    };
    if member.id != original.id
        || member.canonical != original.canonical
        || member.name != original.name
        || member.span != original.span
        || *owner != original.owner
        || ty != &original.ty
        || *required_array != original.required_array
        || ir.value_constraints.get(&member.id) != original.constraints.as_ref()
        || modifiers.trim != original.trim
    {
        return None;
    }
    for (actual, expected) in [
        (&modifiers.min, original.min.as_ref()),
        (&modifiers.max, original.max.as_ref()),
    ] {
        match (actual, expected) {
            (None, None) => {}
            (Some(actual), Some((node, value, source)))
                if actual.span == node_span(*node)
                    && matches!(actual.expr, IrExpr::Int(actual) if actual == i128::from(*value)) =>
            {
                match_stored_contract_source(ir, source, actual.span, db)?;
            }
            _ => return None,
        }
    }
    match_stored_contract_source(ir, &original.source, member.span, db)
}

fn match_stored_contract_source(
    ir: &IrProgram,
    source: &DisclosureSource,
    span: Span,
    db: &SourceDb,
) -> Option<()> {
    let module = owning_module(ir, span)?;
    let file = db.get(module.file)?;
    (module.name == source.module
        && file.path == source.path
        && file.sha256 == source.sha256
        && file.sha256 == sha256_hex(file.text.as_bytes())
        && span.end as usize <= file.text.len()
        && db
            .iter()
            .filter(|(_, file)| file.path == source.path)
            .count()
            == 1)
        .then_some(())
}

fn valid_choice(
    kind: NativeDecisionKind,
    choice: &DisclosureChoice,
    cases: Option<&HashSet<String>>,
) -> bool {
    match (kind, choice) {
        (
            NativeDecisionKind::ParameterDefault,
            DisclosureChoice::DefaultEvaluated | DisclosureChoice::DefaultProvided,
        ) => true,
        (
            NativeDecisionKind::If | NativeDecisionKind::For,
            DisclosureChoice::Then | DisclosureChoice::Else,
        ) => true,
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

/// Every admitted mutation/external site needs one source-checked proof;
/// neither an unused proof nor an unproved executable effect is harmless.
fn match_effect_proofs(
    ir: &IrProgram,
    owner: &IrItem,
    models: &[JsModel],
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    sites: &Sites<'_>,
    db: Option<&SourceDb>,
    send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
) -> Option<()> {
    if checked.effects.len() > 200 || checked.effects.len() != sites.effects.len() {
        return None;
    }
    let mut matched = HashSet::new();
    for proof in &checked.effects {
        let site = checked_site(proof.node, &[])?;
        if !matched.insert(site.clone())
            || proof.source != checked.source
            || !source_matches(ir, &proof.source, site.span)
            || owning_module(ir, site.span)?.id != owner.module
        {
            return None;
        }
        match (&proof.kind, *sites.effects.get(&site)?) {
            (
                DisclosureEffectKind::Create {
                    model,
                    crud,
                    binding: checked_binding,
                    defaults,
                    inputs: checked_inputs,
                },
                IrStmt::Create {
                    model: actual_model,
                    input,
                    when: None,
                    binding: Some(binding),
                    ..
                },
            ) => {
                let db = db?;
                if crud.is_none() {
                    checked_scenario_create(
                        ir,
                        owner,
                        models,
                        checked,
                        proof,
                        *sites.effects.get(&site)?,
                        db,
                    )?;
                    continue;
                }
                if !checked_inputs.is_empty() {
                    return None;
                }
                let (model_item, descriptor) =
                    root_effect_model(ir, owner, models, *model, (*crud)?, true)?;
                if checked_created_model_result(ir, owner).is_some() {
                    ordered_created_model_effects(owner, proof.node, *model, checked_binding, db)?;
                } else {
                    ordered_root_effects(owner, proof.node, *model, checked_binding, db)?;
                }
                let IrItemKind::Model { fields, .. } = &model_item.kind else {
                    return None;
                };
                let authored = checked_effect_node(ir, owner, proof.node, db)?;
                let text = &db.get(proof.node.file)?.text;
                let target = authored
                    .children
                    .iter()
                    .find(|node| node.kind == SyntaxKind::Path)?;
                let object = authored
                    .children
                    .iter()
                    .find(|node| node.kind == SyntaxKind::Object)?;
                let names: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .filter_map(|node| node.token().map(|token| token.text(text)))
                    .collect();
                if proof.node.kind != SyntaxKind::Create as u8
                    || actual_model != &model_item.canonical
                    || !direct_field_name(binding)
                    || binding != checked_binding
                    || names.as_slice() != ["create", "as", binding.as_str()]
                    || direct_source_path_name(target, text)? != model_item.name
                    || object
                        .children
                        .iter()
                        .any(|node| node.kind == SyntaxKind::ObjectEntry)
                    || input.span != site.span
                    || !matches!(&input.expr, IrExpr::Object(entries) if entries.is_empty())
                    || fields.len() != defaults.len()
                    || descriptor.fields.len() != defaults.len()
                    || defaults.is_empty()
                {
                    return None;
                }
                let mut seen = HashSet::new();
                for ((id, original), emitted) in fields.iter().zip(defaults).zip(&descriptor.fields)
                {
                    let field = ir.items.get(id.0 as usize)?;
                    let IrItemKind::Field {
                        owner: field_owner,
                        ty: IrType::Known(ty),
                        required_array: false,
                        default: Some(IrDefault::Literal(default)),
                        server: None,
                        modifiers,
                        ..
                    } = &field.kind
                    else {
                        return None;
                    };
                    let wire_value = serde_json::to_string(&original.value.to_string()).ok()?;
                    if *id != original.field
                        || field.id != *id
                        || !seen.insert(*id)
                        || field.module != owner.module
                        || *field_owner != *model
                        || field.canonical != format!("{}.{}", model_item.canonical, field.name)
                        || *ty != ResolvedType::Scalar(Scalar::Int)
                        || default.ty != *ty
                        || default.span != node_span(original.default)
                        || original.default.kind != SyntaxKind::Literal as u8
                        || !matches!(default.expr, IrExpr::Int(value) if value == original.value)
                        || modifiers.trim
                        || modifiers.min.is_some()
                        || modifiers.max.is_some()
                        || modifiers.unique
                        || modifiers.machine
                        || emitted.name != field.name
                        || !matches!(emitted.field, JsModelFieldType::Integer)
                        || inventory_type(emitted).as_deref() != Some("int")
                        || emitted.array_required.is_some()
                        || emitted.nullable
                        || emitted.server_only
                        || emitted.required
                        || emitted.machine.is_some()
                        || emitted.trim.is_some()
                        || emitted.min.is_some()
                        || emitted.max.is_some()
                        || !matches!(&emitted.default, Some(JsFieldDefault::Literal(value)) if value == &wire_value)
                    {
                        return None;
                    }
                    match_stored_contract_source(ir, &proof.source, field.span, db)?;
                    match_stored_contract_source(ir, &proof.source, default.span, db)?;
                    if text.get(field.span.start as usize..field.span.end as usize)? != field.name
                        || text
                            .get(default.span.start as usize..default.span.end as usize)?
                            .parse::<i128>()
                            .ok()?
                            != original.value
                    {
                        return None;
                    }
                }
            }
            (
                DisclosureEffectKind::Delete {
                    model,
                    crud,
                    receiver,
                },
                IrStmt::Delete {
                    record,
                    mode: IrDeleteMode::Archive,
                    ..
                },
            ) => {
                let db = db?;
                let (model_item, _) = root_effect_model(ir, owner, models, *model, *crud, false)?;
                let IrItemKind::Scenario {
                    params,
                    effects,
                    result: None,
                    ..
                } = &owner.kind
                else {
                    return None;
                };
                if effects.len() != 1 {
                    return None;
                }
                let authored = checked_effect_node(ir, owner, proof.node, db)?;
                let target = authored
                    .children
                    .iter()
                    .find(|node| node.kind == SyntaxKind::Path)?;
                let IrExpr::Name(name) = &record.expr else {
                    return None;
                };
                if proof.node.kind != SyntaxKind::Delete as u8
                    || receiver.kind != SyntaxKind::Path as u8
                    || crate::analysis::NodeKey::of(target) != *receiver
                    || record.span != node_span(*receiver)
                    || record.ty
                        != (ResolvedType::Record {
                            symbol: model_item.id,
                            stored: true,
                        })
                    || !direct_field_name(name)
                    || direct_source_path_name(target, &db.get(receiver.file)?.text)? != name
                {
                    return None;
                }
                let mut parameters = params.iter().filter_map(|id| {
                    ir.items
                        .get(id.0 as usize)
                        .filter(|parameter| parameter.name == *name)
                });
                let parameter = parameters.next()?;
                let IrItemKind::Param {
                    owner: parameter_owner,
                    index,
                    ty: IrType::Known(ty),
                    default: None,
                    default_node: None,
                    array_bounds: None,
                    ..
                } = &parameter.kind
                else {
                    return None;
                };
                if parameters.next().is_some()
                    || *parameter_owner != owner.id
                    || parameter.module != owner.module
                    || params.get(*index) != Some(&parameter.id)
                    || *ty != record.ty
                    || db
                        .get(parameter.span.file)?
                        .text
                        .get(parameter.span.start as usize..parameter.span.end as usize)?
                        != name
                {
                    return None;
                }
            }
            (
                DisclosureEffectKind::For {
                    domain: checked_domain,
                    limit: checked_limit,
                    maximum,
                    item: checked_item,
                    parameter,
                    model,
                    body: checked_body,
                },
                IrStmt::For {
                    item,
                    domain,
                    limit: Some(limit),
                    body,
                    ..
                },
            ) => {
                let parameter_item = ir.items.get(parameter.0 as usize)?;
                let IrItemKind::Param {
                    owner: parameter_owner,
                    index,
                    ty: IrType::Known(parameter_type),
                    default: None,
                    ..
                } = &parameter_item.kind
                else {
                    return None;
                };
                let IrItemKind::Scenario { params, .. } = &owner.kind else {
                    return None;
                };
                let ResolvedType::Array { element, .. } = parameter_type else {
                    return None;
                };
                let expected_record = ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                };
                let model_item = ir.items.get(model.0 as usize)?;
                if proof.node.kind != SyntaxKind::For as u8
                    || !direct_field_name(item)
                    || item != checked_item
                    || *maximum == 0
                    || *maximum > 200
                    || parameter_item.id != *parameter
                    || *parameter_owner != owner.id
                    || params.get(*index) != Some(parameter)
                    || element.as_ref() != &expected_record
                    || domain.ty != *parameter_type
                    || !matches!(&domain.expr, IrExpr::Name(name) if name == &parameter_item.name)
                    || domain.span != node_span(*checked_domain)
                    || limit.span != node_span(*checked_limit)
                    || limit.ty != ResolvedType::Scalar(Scalar::Int)
                    || !matches!(limit.expr, IrExpr::Int(value) if value == i128::from(*maximum))
                    || model_item.id != *model
                    || model_item.module != owner.module
                    || !matches!(model_item.kind, IrItemKind::Model { .. })
                    || body.is_empty()
                    || body.len() != checked_body.len()
                {
                    return None;
                }
                for (statement, node) in body.iter().zip(checked_body) {
                    let IrStmt::Set {
                        record,
                        changes,
                        when: None,
                        span,
                    } = statement
                    else {
                        return None;
                    };
                    if *span != node_span(*node)
                        || node.kind != SyntaxKind::Set as u8
                        || record.ty != expected_record
                        || !matches!(&record.expr, IrExpr::Name(name) if name == item)
                        || !closed_loop_changes(changes, item, &expected_record)
                    {
                        return None;
                    }
                }
            }
            (
                DisclosureEffectKind::Call {
                    operation,
                    input_keys,
                },
                IrStmt::Call {
                    target:
                        IrEffectCallTarget::Operation {
                            source,
                            operation: actual,
                        },
                    inputs,
                    binding,
                    result,
                    ..
                },
            ) => {
                let target = ir.items.get(operation.0 as usize)?;
                let IrItemKind::Scenario {
                    trusted: false,
                    event_source: None,
                    hook: None,
                    cohort: None,
                    read,
                    expose_excluded: false,
                    result: declared_result,
                    ..
                } = &target.kind
                else {
                    return None;
                };
                let ScenarioDisclosure::Complete(child) = ir.scenario_disclosures.get(operation)?
                else {
                    return None;
                };
                let IrExpr::Object(entries) = &inputs.expr else {
                    return None;
                };
                let query_child =
                    *read && super::scenario_calls::complete_read_query_child(ir, target).is_some();
                let model_child = checked_created_model_result(ir, target).is_some();
                let source_call = checked
                    .source_facts
                    .as_deref()?
                    .calls
                    .iter()
                    .find(|call| call.node == proof.node)?;
                if proof.node.kind != SyntaxKind::Call as u8
                    || operation != actual
                    || target.id != *operation
                    || target.id == owner.id
                    || child.scenario != *operation
                    || result != declared_result
                    || (!query_child
                        && (*read
                            || (binding.is_some() && !model_child)
                            || (!declared_result.as_ref().is_none_or(native_result_type)
                                && !model_child)))
                    || source_call.operation != *operation
                    || source_call.binding != *binding
                    || source_call.result != *result
                    || source_call.inputs.len() != entries.len()
                    || source_call
                        .inputs
                        .iter()
                        .zip(entries)
                        .any(|(fact, (name, value))| {
                            fact.name != *name
                                || fact.ty != value.ty
                                || fact.node.file != value.span.file
                                || fact.node.start != value.span.start
                                || fact.node.end != value.span.end
                        })
                    || source.file != site.span.file
                    || source.start < site.span.start
                    || source.end > site.span.end
                    || owning_module(ir, *source)?.id != owner.module
                    || entries.len() != input_keys.len()
                    || entries
                        .iter()
                        .zip(input_keys)
                        .any(|((key, _), expected)| key != expected)
                    || entries
                        .iter()
                        .map(|(key, _)| key)
                        .collect::<HashSet<_>>()
                        .len()
                        != entries.len()
                {
                    return None;
                }
            }
            (
                DisclosureEffectKind::Set {
                    model,
                    fields,
                    file_inputs,
                },
                IrStmt::Set {
                    record,
                    changes,
                    when: None,
                    ..
                },
            ) => {
                if proof.node.kind != SyntaxKind::Set as u8
                    || !matches!(record.expr, IrExpr::Name(_))
                    || record.ty
                        != (ResolvedType::Record {
                            symbol: *model,
                            stored: true,
                        })
                {
                    return None;
                }
                let model_item = ir.items.get(model.0 as usize)?;
                let IrItemKind::Model {
                    fields: own_fields, ..
                } = &model_item.kind
                else {
                    return None;
                };
                if model_item.id != *model || model_item.module != owner.module {
                    return None;
                }
                let IrExpr::Object(entries) = &changes.expr else {
                    return None;
                };
                if entries.len() != fields.len() || fields.is_empty() {
                    return None;
                }
                let mut descriptors = models.iter().filter(|m| m.name == model_item.canonical);
                let descriptor = descriptors.next()?;
                if descriptors.next().is_some() {
                    return None;
                }
                let mut seen_fields = HashSet::new();
                let mut matched_files = HashSet::new();
                for ((name, value), id) in entries.iter().zip(fields) {
                    let field = ir.items.get(id.0 as usize)?;
                    let IrItemKind::Field {
                        owner: field_owner,
                        ty: IrType::Known(ty),
                        required_array,
                        modifiers,
                        ..
                    } = &field.kind
                    else {
                        return None;
                    };
                    if field.id != *id
                        || *field_owner != *model
                        || !own_fields.contains(id)
                        || field.name != *name
                        || !seen_fields.insert(*id)
                        || *required_array
                        || modifiers.machine
                    {
                        return None;
                    }
                    let mut declared = descriptor.fields.iter().filter(|f| f.name == *name);
                    let emitted = declared.next()?;
                    if declared.next().is_some() || !assignment_inventory_matches(ty, emitted) {
                        return None;
                    }
                    let compatible = value.ty == *ty
                        || matches!(ty, ResolvedType::Nullable(inner) if value.ty == **inner || value.ty == ResolvedType::Null);
                    if !compatible {
                        return None;
                    }
                    let base = match ty {
                        ResolvedType::Nullable(inner) => inner.as_ref(),
                        ty => ty,
                    };
                    if *base == ResolvedType::Scalar(Scalar::File) {
                        let mut inputs = file_inputs.iter().filter(|input| input.field == *id);
                        let input = inputs.next()?;
                        if inputs.next().is_some() || !matched_files.insert(input.field) {
                            return None;
                        }
                        file_assignment_input_matches(
                            ir, owner, checked, input, value, proof.node, db?,
                        )?;
                    }
                }
                if matched_files.len() != file_inputs.len() {
                    return None;
                }
            }
            (DisclosureEffectKind::Send { .. }, statement @ IrStmt::Send { .. }) => {
                checked_send_guard(ir, owner, proof, statement, send_guards)?;
            }
            _ => return None,
        }
    }
    Some(())
}

fn checked_send_guard(
    ir: &IrProgram,
    owner: &IrItem,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    statement: &IrStmt,
    send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
) -> Option<()> {
    let DisclosureEffectKind::Send {
        operation,
        deployment_binding,
        when: original_when,
    } = &proof.kind
    else {
        return None;
    };
    let IrStmt::Send {
        operation: actual,
        deployment_binding: binding,
        when,
        binding: source_binding,
        span,
        ..
    } = statement
    else {
        return None;
    };
    if proof.node.kind != SyntaxKind::Send as u8
        || node_span(proof.node) != *span
        || operation != actual
        || deployment_binding != binding
        || binding.as_ref().is_none_or(|b| b.is_empty())
    {
        return None;
    }
    let (node, predicate) = match (original_when, when) {
        (None, None) => return Some(()),
        (Some(node), Some(predicate)) => (node, predicate),
        _ => return None,
    };
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let facts = checked.source_facts.as_deref()?;
    let module = owning_module(ir, *span)?;
    if checked.scenario != owner.id
        || facts.scenario != owner.id
        || facts.node != checked.node
        || facts.source != checked.source
        || proof.source != checked.source
        || module.id != owner.module
        || owner.canonical != format!("{}.{}", module.name, owner.name)
        || !source_matches(ir, &proof.source, *span)
        || node.file != proof.node.file
        || node.start < proof.node.start
        || node.end > proof.node.end
        || predicate.span.file != node.file
        || predicate.span.start < node.start
        || predicate.span.end > node.end
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    let mut original_sites = facts.decision_sites.as_ref()?.iter().filter(|site| {
        site.stage == crate::analysis::scenario_disclosure::CheckedDecisionStage::SendDispatch
            && site.statement == proof.node
    });
    let original = original_sites.next()?;
    if original_sites.next().is_some()
        || original.owner != owner.id
        || original.source != proof.source
        || original.node != *node
    {
        return None;
    }
    let guard = send_guards?.get(span)?;
    let expected_rule = format!(
        "{}.sendWhen.{}.{}.{}",
        owner.canonical, proof.source.sha256, node.start, node.end
    );
    let descriptor = &guard.descriptor;
    if guard.rule != expected_rule
        || format!("{:?}", guard.predicate) != format!("{predicate:?}")
        || descriptor["rule"] != expected_rule
        || descriptor["owner"] != owner.canonical
        || descriptor["source"]
            != serde_json::json!({
                "path": proof.source.path,
                "sha256": proof.source.sha256,
                "module": proof.source.module,
            })
        || descriptor["node"] != serde_json::json!({"start": node.start, "end": node.end})
        || descriptor["statement"] != serde_json::json!({"start": span.start, "end": span.end})
        || descriptor["target"] != *operation
        || descriptor["binding"] != serde_json::json!(binding)
        || descriptor["sourceBinding"] != serde_json::json!(source_binding)
    {
        return None;
    }
    Some(())
}

/// These two effect proofs admit only the existing root-model constructor and
/// archive operation. Neither containment nor hard removal inherits them.
fn root_effect_model<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    models: &'a [JsModel],
    model: crate::analysis::SymbolId,
    crud: crate::analysis::SymbolId,
    creating: bool,
) -> Option<(&'a IrItem, &'a JsModel)> {
    let item = ir.items.get(model.0 as usize)?;
    let declaration = ir.items.get(crud.0 as usize)?;
    let IrItemKind::Model {
        owner: IrOwner::Team,
        crud: Some(actual_crud),
        invariants,
        locks,
        uniques,
        retain: None,
        ..
    } = &item.kind
    else {
        return None;
    };
    let IrItemKind::Crud {
        model: declared_model,
        create,
        delete,
        ..
    } = &declaration.kind
    else {
        return None;
    };
    let module = ir.modules.get(owner.module.0 as usize)?;
    if item.id != model
        || item.module != owner.module
        || !direct_field_name(&item.name)
        || item.canonical != format!("{}.{}", module.name, item.name)
        || !invariants.is_empty()
        || !locks.is_empty()
        || !uniques.is_empty()
        || ir.items.iter().any(|candidate| {
            matches!(&candidate.kind, IrItemKind::Scenario { hook: Some(hook), .. }
                if hook.model == model)
        })
        || *actual_crud != crud
        || declaration.id != crud
        || declaration.module != owner.module
        || declaration.canonical != format!("{}.crud", item.canonical)
        || *declared_model != model
        || !(if creating { *create } else { *delete })
        || ir.crud_when.iter().any(|guard| guard.name == item.name)
    {
        return None;
    }
    let operation = if creating {
        crate::analysis::resolve::CrudOp::Create
    } else {
        crate::analysis::resolve::CrudOp::Delete
    };
    let mut operations = ir.items.iter().filter(|candidate| {
        matches!(&candidate.kind, IrItemKind::CrudOp { model: target, op, .. }
            if *target == model && *op == operation)
    });
    let operation_item = operations.next()?;
    let IrItemKind::CrudOp {
        has_when: false,
        delete_mode,
        ..
    } = &operation_item.kind
    else {
        return None;
    };
    if operations.next().is_some()
        || operation_item.module != owner.module
        || (!creating && *delete_mode != IrDeleteMode::Archive)
    {
        return None;
    }
    let mut descriptors = models
        .iter()
        .filter(|descriptor| descriptor.name == item.canonical);
    let descriptor = descriptors.next()?;
    if descriptors.next().is_some()
        || descriptor.parent.is_some()
        || descriptor.scope_app
        || !descriptor.unique_keys.is_empty()
        || (!creating && descriptor.delete_mode != "archive")
    {
        return None;
    }
    Some((item, descriptor))
}

/// Match this scenario's original populated/contained constructor. The owning
/// schema supplies defaults and server fields; source supplies explicit operands.
fn checked_scenario_create(
    ir: &IrProgram,
    owner: &IrItem,
    models: &[JsModel],
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    statement: &IrStmt,
    db: &SourceDb,
) -> Option<()> {
    let DisclosureEffectKind::Create {
        model,
        crud: None,
        binding,
        defaults,
        inputs,
    } = &proof.kind
    else {
        return None;
    };
    let IrStmt::Create {
        model: target,
        input,
        binding: Some(actual),
        when: None,
        span,
    } = statement
    else {
        return None;
    };
    let facts = checked.source_facts.as_deref()?;
    let mut sources = facts
        .creates
        .as_deref()?
        .iter()
        .filter(|source| source.node == proof.node);
    let original = sources.next()?;
    if sources.next().is_some()
        || !defaults.is_empty()
        || original.source != checked.source
        || proof.source != checked.source
        || original.model != *model
        || original.binding != *binding
        || original.inputs != *inputs
        || actual != binding
        || *span != node_span(proof.node)
        || input.span != *span
        || target != &original.definition.canonical
        || !direct_field_name(binding)
        || checked_created_model_result(ir, owner) != Some(*model)
    {
        return None;
    }
    super::scenario_create_sources::checked_created_schema(ir, owner, models, original, db)?;
    ordered_created_model_effects(owner, proof.node, *model, binding, db)?;
    checked_created_statements(ir, owner, checked, original, db)?;
    let authored = checked_effect_node(ir, owner, proof.node, db)?;
    let text = &db.get(span.file)?.text;
    let target_node = authored
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Path)?;
    let object = authored
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Object)?;
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let authored_entries: Vec<_> = object
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::ObjectEntry)
        .collect();
    let model_item = ir.items.get(model.0 as usize)?;
    if crate::analysis::NodeKey::of(target_node) != original.target_node
        || direct_source_path_name(target_node, text)? != model_item.name
        || entries.len() != inputs.len()
        || entries.len() != authored_entries.len()
    {
        return None;
    }
    for (((name, value), source), authored) in entries.iter().zip(inputs).zip(authored_entries) {
        let key = authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        if name != &source.name
            || crate::analysis::NodeKey::of(key) != source.key_node
            || key.token()?.text(text) != name
            || value.ty != source.ty
            || value.span != node_span(source.value_node)
        {
            return None;
        }
        if let Some(field) = source.field {
            let declared = original
                .definition
                .fields
                .iter()
                .find(|declared| declared.field == field)?;
            if declared.name != *name {
                return None;
            }
        } else if name != "parent"
            || !matches!(original.definition.declaration.owner,
            crate::analysis::resolve::ModelOwner::ChildOf(parent) if source.ty == ResolvedType::Record {symbol:parent,stored:true})
        {
            return None;
        }
        super::scenario_create_sources::checked_create_operand(
            ir,
            original,
            value,
            source.value_node,
            db,
        )?;
    }
    Some(())
}

fn checked_created_statements(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    db: &SourceDb,
) -> Option<()> {
    use crate::analysis::NodeKey;
    let facts = checked.source_facts.as_deref()?;
    let scenario = checked_effect_node(ir, owner, facts.node, db)?;
    let text = &db.get(facts.node.file)?.text;
    let IrItemKind::Scenario {
        params,
        by,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    match (
        crate::analysis::attribute_value(&scenario, "by", text),
        by.as_slice(),
    ) {
        (None, []) => {}
        (Some(node), [IrGuard::Role(role)])
            if node.kind == SyntaxKind::NameRef
                && matches!(
                    role.as_str(),
                    "members" | "owner" | "authenticated" | "public"
                )
                && text.get(node.span.start as usize..node.span.end as usize)
                    == Some(role.as_str()) => {}
        _ => return None,
    }
    for (position, (id, fact)) in params.iter().zip(&facts.parameters).enumerate() {
        let parameter = ir.items.get(id.0 as usize)?;
        let IrItemKind::Param {
            owner: parent,
            index,
            default,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let authored = checked_effect_node(ir, owner, fact.node, db)?;
        let name = authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        if *parent != owner.id
            || *index != position
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
            || parameter.span != name.span
            || name.token()?.text(text) != parameter.name
        {
            return None;
        }
        match (default, fact.default) {
            (None, None) => {}
            (Some(super::ir::IrDefault::Literal(value)), Some(node)) => {
                super::scenario_create_sources::checked_create_expression(
                    ir, original, value, node, db,
                )?;
            }
            _ => return None,
        }
    }
    let authored_guards: Vec<_> = scenario
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Require)
        .collect();
    let mut blocks = scenario
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::DoBlock);
    let block = blocks.next()?;
    if blocks.next().is_some() {
        return None;
    }
    let authored_effects: Vec<_> = block
        .children
        .iter()
        .filter(|node| {
            !matches!(
                node.kind,
                SyntaxKind::Name | SyntaxKind::Trivia | SyntaxKind::Comment
            )
        })
        .collect();
    if authored_guards.len() != guards.len() || authored_effects.len() != effects.len() {
        return None;
    }
    for (statement, authored) in guards
        .iter()
        .zip(authored_guards)
        .chain(effects.iter().zip(authored_effects))
    {
        let (kind, at, value) = match statement {
            IrStmt::Let { name, value, span } => {
                let names: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .collect();
                let [keyword, binding] = names.as_slice() else {
                    return None;
                };
                if keyword.token()?.text(text) != "let" || binding.token()?.text(text) != name {
                    return None;
                }
                (SyntaxKind::Let, *span, Some(value))
            }
            IrStmt::Require { cond, span } => (SyntaxKind::Require, *span, Some(cond)),
            IrStmt::Create { span, .. } => (SyntaxKind::Create, *span, None),
            IrStmt::Return { span, .. } => (SyntaxKind::Return, *span, None),
            _ => return None,
        };
        if authored.kind != kind || authored.span != at {
            return None;
        }
        if let Some(value) = value {
            let node = authored.children.iter().find(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::NameRef
                        | SyntaxKind::Literal
                        | SyntaxKind::Group
                        | SyntaxKind::Array
                        | SyntaxKind::Member
                        | SyntaxKind::Unary
                        | SyntaxKind::Binary
                        | SyntaxKind::Call
                )
            })?;
            super::scenario_create_sources::checked_create_expression(
                ir,
                original,
                value,
                NodeKey::of(node),
                db,
            )?;
        }
    }
    Some(())
}

fn ordered_created_model_effects(
    owner: &IrItem,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if effects.len() < 2
        || !matches!(effects.get(effects.len() - 2), Some(IrStmt::Create {span, ..}) if *span == node_span(create))
        || effects[..effects.len() - 2]
            .iter()
            .any(|effect| !matches!(effect, IrStmt::Let { .. } | IrStmt::Require { .. }))
    {
        return None;
    }
    let IrStmt::Return {
        value: Some(value),
        span,
    } = effects.last()?
    else {
        return None;
    };
    if span.file != create.file || create.end > span.start {
        return None;
    }
    created_record_name_matches(
        value,
        &ResolvedType::Record {
            symbol: model,
            stored: true,
        },
        binding,
        *span,
        db,
    )
}

fn ordered_root_effects(
    owner: &IrItem,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if effects.len() < 3
        || !matches!(effects.first(), Some(IrStmt::Create { .. }))
        || !matches!(effects.get(1), Some(IrStmt::Set { .. }))
        || !matches!(effects.last(), Some(IrStmt::Return { .. }))
        || effects[2..effects.len() - 1]
            .iter()
            .any(|effect| !matches!(effect, IrStmt::Require { .. }))
    {
        return None;
    }
    let record_type = ResolvedType::Record {
        symbol: model,
        stored: true,
    };
    let IrStmt::Set {
        record,
        changes,
        when: None,
        span: set_span,
    } = &effects[1]
    else {
        return None;
    };
    created_record_name_matches(record, &record_type, binding, *set_span, db)?;
    if !closed_loop_changes(changes, binding, &record_type) {
        return None;
    }
    let IrExpr::Object(entries) = &changes.expr else {
        return None;
    };
    let mut pending: Vec<_> = entries.iter().map(|(_, value)| value).collect();
    let mut visited = 0usize;
    while let Some(value) = pending.pop() {
        visited += 1;
        if visited > 16384
            || value.span.file != set_span.file
            || value.span.start < set_span.start
            || value.span.end > set_span.end
        {
            return None;
        }
        match &value.expr {
            IrExpr::Member { base, .. } => {
                created_record_name_matches(base, &record_type, binding, value.span, db)?;
            }
            IrExpr::Binary { left, right, .. } => {
                pending.push(left);
                pending.push(right);
            }
            IrExpr::Unary { operand, .. } => pending.push(operand),
            _ => {}
        }
    }
    let IrStmt::Return {
        value: Some(value),
        span: return_span,
    } = effects.last()?
    else {
        return None;
    };
    let IrExpr::Member { base, .. } = &value.expr else {
        return None;
    };
    if value.span.file != return_span.file
        || value.span.start < return_span.start
        || value.span.end > return_span.end
    {
        return None;
    }
    created_record_name_matches(base, &record_type, binding, value.span, db)?;
    let mut previous_end = 0;
    let mut found = false;
    for effect in effects {
        let span = match effect {
            IrStmt::Create { span, .. }
            | IrStmt::Set { span, .. }
            | IrStmt::Require { span, .. }
            | IrStmt::Return { span, .. } => *span,
            _ => return None,
        };
        if span.file != create.file || span.start < previous_end {
            return None;
        }
        previous_end = span.end;
        found |= span == node_span(create) && matches!(effect, IrStmt::Create { .. });
    }
    found.then_some(())
}

/// A created binding is the current owner-session row, never another same-type
/// local or admitted input whose copied Member site happens to match the proof.
fn created_record_name_matches(
    value: &TypedExpr,
    record: &ResolvedType,
    binding: &str,
    containing: Span,
    db: &SourceDb,
) -> Option<()> {
    if value.ty != *record
        || !matches!(&value.expr, IrExpr::Name(name) if name == binding)
        || value.span.file != containing.file
        || value.span.start < containing.start
        || value.span.end > containing.end
        || db
            .get(value.span.file)?
            .text
            .get(value.span.start as usize..value.span.end as usize)?
            .trim()
            != binding
    {
        return None;
    }
    Some(())
}

fn checked_effect_node(
    ir: &IrProgram,
    owner: &IrItem,
    key: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<crate::syntax::SyntaxNode> {
    let original = super::scenario_calls::checked_source(ir, owner, db)?;
    if key.file != original.node.file
        || key.start < original.node.start
        || key.end > original.node.end
    {
        return None;
    }
    let file = db.get(key.file)?;
    let (tree, diagnostics) = crate::syntax::parse_source(key.file, &file.text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut pending = vec![&tree];
    let mut steps = 0usize;
    while let Some(node) = pending.pop() {
        steps += 1;
        if steps > 200000 {
            return None;
        }
        if crate::analysis::NodeKey::of(node) == key {
            return Some(node.clone());
        }
        pending.extend(node.children.iter().rev());
    }
    None
}

/// CST path spans own their leading trivia. Match the sole actual name token
/// while preserving the original whole-path span used by the checked proof.
fn direct_source_path_name<'a>(node: &crate::syntax::SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind != SyntaxKind::Path {
        return None;
    }
    let mut parts = node
        .children
        .iter()
        .filter(|child| child.kind != SyntaxKind::Trivia);
    let name = parts.next()?;
    if name.kind != SyntaxKind::Name || parts.next().is_some() {
        return None;
    }
    Some(name.token()?.text(text))
}

/// The initial loop profile reads only its current element through direct
/// fields and eager scalar expressions. A different receiver or helper cannot
/// inherit the source loop's per-element provenance by sharing a record type.
fn closed_loop_changes(changes: &TypedExpr, item: &str, record: &ResolvedType) -> bool {
    let IrExpr::Object(entries) = &changes.expr else {
        return false;
    };
    let mut pending: Vec<_> = entries.iter().map(|(_, value)| value).collect();
    let mut visited = 0usize;
    while let Some(value) = pending.pop() {
        visited += 1;
        if visited > 16384 {
            return false;
        }
        match &value.expr {
            IrExpr::Member { base, .. } => {
                if base.ty != *record || !matches!(&base.expr, IrExpr::Name(name) if name == item) {
                    return false;
                }
            }
            IrExpr::Binary { op, left, right } => {
                if matches!(op, IrBinOp::And | IrBinOp::Or | IrBinOp::Coalesce) {
                    return false;
                }
                pending.push(left);
                pending.push(right);
            }
            IrExpr::Unary { operand, .. } => pending.push(operand),
            IrExpr::Int(_)
            | IrExpr::Decimal(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Money { .. }
            | IrExpr::DurationMs(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_) => {}
            _ => return false,
        }
    }
    true
}

fn assignment_inventory_matches(ty: &ResolvedType, field: &JsModelField) -> bool {
    let (base, nullable) = match ty {
        ResolvedType::Nullable(inner) => (inner.as_ref(), true),
        ty => (ty, false),
    };
    if *base == ResolvedType::Scalar(Scalar::File) {
        // Assignment lifetime belongs to Files/State. This does not admit
        // File through the scalar result or dependency observation codecs.
        return matches!(field.field, JsModelFieldType::File)
            && field.value_type.as_deref() == Some(if nullable { "file?" } else { "file" })
            && field.nullable == nullable
            && field.array_required.is_none()
            && field.machine.is_none();
    }
    if let ResolvedType::StdDelivery { capability, op } = base {
        let Some(expected) = super::js::delivery_descriptor(capability, op) else {
            return false;
        };
        return matches!(&field.field, JsModelFieldType::Delivery(delivery)
            if delivery.capability == expected.capability
                && delivery.operation == expected.operation
                && delivery.version == expected.version
                && delivery.result.to_json() == expected.result.to_json())
            && field.nullable == nullable
            && field.array_required.is_none()
            && field.machine.is_none()
            && field.value_type.is_none();
    }
    let (element, array) = match base {
        ResolvedType::Array { element, .. } => (element.as_ref(), true),
        ty => (ty, false),
    };
    let ResolvedType::Scalar(scalar) = element else {
        return false;
    };
    let expected = format!(
        "{}{}{}",
        scalar.as_str(),
        if array { "[]" } else { "" },
        if nullable { "?" } else { "" }
    );
    native_result_type(ty) && inventory_type(field).as_deref() == Some(expected.as_str())
}

fn file_assignment_input_matches(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    input: &crate::analysis::scenario_disclosure::DisclosureFileInput,
    value: &TypedExpr,
    statement: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<()> {
    let IrItemKind::Scenario {
        params,
        trusted: false,
        read: false,
        event_source: None,
        hook: None,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let parameter = ir.items.get(input.parameter.0 as usize)?;
    let IrItemKind::Param {
        owner: declared_owner,
        index,
        ty: IrType::Known(ty),
        default: None,
        default_node: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let file = ResolvedType::Scalar(Scalar::File);
    let source = checked
        .source_facts
        .as_ref()?
        .parameters
        .iter()
        .find(|parameter| parameter.parameter == input.parameter)?;
    if parameter.id != input.parameter
        || *declared_owner != owner.id
        || params.get(*index) != Some(&input.parameter)
        || parameter.module != owner.module
        || *ty != file
        || source.ty != file
        || source.default.is_some()
        || value.ty != file
        || value.span != node_span(input.value)
        || input.value.kind != SyntaxKind::NameRef as u8
        || !matches!(&value.expr,IrExpr::Name(name) if name == &parameter.name)
        || input.value.file != checked.node.file
        || input.value.start < checked.node.start
        || input.value.end > checked.node.end
        || input.value.file != statement.file
        || input.value.start < statement.start
        || input.value.end > statement.end
    {
        return None;
    }
    // Both the proof and executable IR are mutable carriers. Join the actual
    // name to the original value and parameter declaration in verified source
    // bytes, so changing both carriers to another valid File input cannot pass.
    let original = super::scenario_calls::checked_source(ir, owner, db)?;
    let authored = db.get(input.value.file)?;
    if authored
        .text
        .get(input.value.start as usize..input.value.end as usize)?
        != parameter.name
    {
        return None;
    }
    let declaration = original.parameters.get(*index)?;
    if declaration.parameter != input.parameter || declaration.node != source.node {
        return None;
    }
    let (tree, diagnostics) = crate::syntax::parse_source(input.value.file, &authored.text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut pending = vec![&tree];
    let mut steps = 0usize;
    let mut matched_declaration = false;
    let mut matched_value = false;
    while let Some(node) = pending.pop() {
        steps += 1;
        if steps > 200000 {
            return None;
        }
        if crate::analysis::NodeKey::of(node) == declaration.node {
            let name = node
                .children
                .iter()
                .find(|child| child.kind == SyntaxKind::Name)?;
            if node.kind != SyntaxKind::Parameter
                || name.span != parameter.span
                || name.token()?.text(&authored.text) != parameter.name
            {
                return None;
            }
            matched_declaration = true;
        }
        if crate::analysis::NodeKey::of(node) == input.value {
            matched_value = node.kind == SyntaxKind::NameRef;
        }
        if matched_declaration && matched_value {
            return Some(());
        }
        pending.extend(node.children.iter().rev());
    }
    None
}

#[derive(Default)]
struct Sites<'a> {
    members: HashMap<NativeSite, Vec<&'a TypedExpr>>,
    names: HashMap<NativeSite, Vec<&'a TypedExpr>>,
    transitions: HashMap<NativeSite, Vec<&'a IrStmt>>,
    effects: HashMap<NativeSite, &'a IrStmt>,
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
        owner: &'a IrItem,
        params: &'a [crate::analysis::SymbolId],
        by: &'a [IrGuard],
        guards: &'a [IrStmt],
        effects: &'a [IrStmt],
        send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
    ) -> Option<Self> {
        let mut out = Self::default();
        let mut pending = Vec::new();
        for (index, id) in params.iter().enumerate() {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                owner: declared_owner,
                index: declared_index,
                default,
                default_node,
                ..
            } = &param.kind
            else {
                return None;
            };
            if param.id != *id || *declared_owner != owner.id || *declared_index != index {
                return None;
            }
            if let Some(IrDefault::Literal(expr) | IrDefault::Computed { expr, .. }) = default {
                if owning_module(ir, expr.span)?.id != owner.module {
                    return None;
                }
                let node = (*default_node)?;
                if node.file != expr.span.file
                    || node.start > expr.span.start
                    || node.end < expr.span.end
                {
                    return None;
                }
                let mut site = Walk::default().site(node_span(node));
                site.default_selection = true;
                if out
                    .decisions
                    .insert(site, NativeDecisionKind::ParameterDefault)
                    .is_some()
                {
                    return None;
                }
                pending.push((Visit::Expression(expr), Walk::default()));
            }
        }
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
                    IrStmt::Create {
                        input,
                        when: None,
                        binding: Some(_),
                        span,
                        ..
                    } if matches!(&input.expr, IrExpr::Object(_)) => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(input));
                    }
                    IrStmt::Delete {
                        record,
                        mode: IrDeleteMode::Archive,
                        span,
                    } if matches!(record.expr, IrExpr::Name(_)) => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(record));
                    }
                    IrStmt::For {
                        domain,
                        limit: Some(limit),
                        body,
                        span,
                        ..
                    } => {
                        if out.effects.insert(context.site(*span), statement).is_some()
                            || out
                                .decisions
                                .insert(context.site(*span), NativeDecisionKind::For)
                                .is_some()
                        {
                            return None;
                        }
                        push!(Visit::Expression(domain));
                        push!(Visit::Expression(limit));
                        extend!(body.iter().map(Visit::Statement));
                    }
                    IrStmt::Call {
                        target: IrEffectCallTarget::Operation { operation, .. },
                        inputs,
                        binding,
                        span,
                        ..
                    } => {
                        if binding.is_some()
                            && super::scenario_calls::complete_read_query_child(
                                ir,
                                ir.items.get(operation.0 as usize)?,
                            )
                            .is_none()
                            && checked_created_model_result(ir, ir.items.get(operation.0 as usize)?)
                                .is_none()
                        {
                            return None;
                        }
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(inputs));
                    }
                    IrStmt::Set {
                        record,
                        changes,
                        span,
                        ..
                    } => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(record));
                        push!(Visit::Expression(changes));
                    }
                    IrStmt::Send {
                        args, when, span, ..
                    } => {
                        if when.is_some() {
                            let ScenarioDisclosure::Complete(checked) =
                                ir.scenario_disclosures.get(&owner.id)?
                            else {
                                return None;
                            };
                            let mut proofs = checked
                                .effects
                                .iter()
                                .filter(|proof| node_span(proof.node) == *span);
                            let proof = proofs.next()?;
                            if proofs.next().is_some() {
                                return None;
                            }
                            checked_send_guard(ir, owner, proof, statement, send_guards)?;
                        }
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        // Only request expressions belong to the parent capture.
                        // The sealed Rule evaluates its predicate at dispatch.
                        push!(Visit::Expression(args));
                    }
                    IrStmt::Transition { record, span, .. } => {
                        out.transitions
                            .entry(context.site(*span))
                            .or_default()
                            .push(statement);
                        push!(Visit::Expression(record));
                    }
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
                    IrExpr::Array(items) => extend!(items.iter().map(Visit::Expression)),
                    IrExpr::Object(entries) => {
                        let mut names = HashSet::new();
                        if entries
                            .iter()
                            .any(|(name, _)| !direct_field_name(name) || !names.insert(name))
                        {
                            return None;
                        }
                        extend!(entries.iter().map(|(_, value)| Visit::Expression(value)));
                    }
                    IrExpr::Unary { operand, .. } => push!(Visit::Expression(operand)),
                    IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                        // A checked bound-child predicate reads only the
                        // retained projection. Its element-local decisions
                        // belong to Values, not once-per-parent observations.
                        if let Some(domain) = retained_contract_predicate(expression, target, args)
                        {
                            // The domain is evaluated once outside the callback.
                            // Stored contract domains capture their real root
                            // field here; nested alias leaves create no sites.
                            push!(Visit::Expression(domain));
                            continue;
                        }
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
                    | IrExpr::Datetime(_) => {}
                    IrExpr::Name(_) => {
                        out.names
                            .entry(context.site(expression.span))
                            .or_default()
                            .push(expression);
                    }
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

fn retained_contract_predicate<'a>(
    expression: &TypedExpr,
    target: &IrCallTarget,
    args: &'a [TypedExpr],
) -> Option<&'a TypedExpr> {
    let IrCallTarget::Builtin { id, awaited: false } = target else {
        return None;
    };
    if !matches!(id.as_str(), "any" | "all") || args.len() != 2 {
        return None;
    }
    let mut candidates = args.iter().filter_map(|argument| match &argument.expr {
        IrExpr::Query(query) => query
            .contract_collection_call
            .as_deref()
            .map(|fact| (query, fact)),
        _ => None,
    });
    let (query, fact) = candidates.next()?;
    if candidates.next().is_some()
        || fact.builtin != *id
        || node_span(fact.node) != expression.span
        || expression.ty != ResolvedType::Scalar(Scalar::Bool)
        || fact.arguments.len() != 2
        || fact.slots[0] == fact.slots[1]
    {
        return None;
    }
    let source = query.source.as_deref()?;
    let [alias] = source.clauses.as_slice() else {
        return None;
    };
    let crate::analysis::types::CheckedQueryClauseKind::As { name } = &alias.kind else {
        return None;
    };
    let super::ir::IrQueryDomain::Value {
        base,
        alias: actual_alias,
    } = &query.domain
    else {
        return None;
    };
    let IrExpr::Lambda { param, body } = &args.get(fact.slots[1])?.expr else {
        return None;
    };
    let domain = args.get(fact.slots[0])?;
    if !matches!(&domain.expr, IrExpr::Query(actual) if std::ptr::eq(actual,query))
        || source.node != fact.query
        || source.domain != fact.domain
        || alias.node != fact.alias
        || name != actual_alias
        || name != param
        || query.collection_call.is_some()
        || source.projection.is_some()
        || !alias.expressions.is_empty()
        || source.domain_type != source.result
        || domain.ty != source.result
        || base.ty != source.domain_type
        || base.span.file != fact.domain.file
        || base.span.start < fact.domain.start
        || base.span.end > fact.domain.end
        || !matches!(base.expr, IrExpr::Name(_) | IrExpr::Member { .. })
        || query.parent.is_some()
        || query.where_pred.is_some()
        || query.where_async
        || !query.order.is_empty()
        || query.limit.is_some()
        || query.archived.is_some()
        || query.select.is_some()
        || query.select_param.is_some()
        || body.ty != fact.predicate.ty
        || args.get(fact.slots[1])?.ty != fact.predicate.ty
        || fact.predicate.ty != expression.ty
        || fact.arguments.get(fact.slots[1]) != Some(&fact.predicate.node)
        || args.iter().zip(&fact.arguments).any(|(arg, node)| {
            arg.span.file != node.file || arg.span.start < node.start || arg.span.end > node.end
        })
    {
        return None;
    }
    let slots = match &expression.expr {
        IrExpr::BoundCall { slots, .. } => slots.clone(),
        _ => (0..args.len()).map(Some).collect(),
    };
    (slots.as_slice() == [Some(fact.slots[0]), Some(fact.slots[1])]).then_some(base.as_ref())
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
            default_selection: false,
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
        default_selection: false,
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
