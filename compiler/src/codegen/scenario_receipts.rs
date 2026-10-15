//! Match complete checked disclosure paths to actual executable native IR sites.
//! This helper never activates capture or publishes a plan on its own.
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::analysis::scenario_disclosure::{
    DependencyRole, DisclosureChoice, DisclosureEffectKind, DisclosureIntrinsicKind,
    DisclosureModelResult, DisclosureSource, InfluenceKind, ScenarioDisclosure,
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

/// Apply an already authenticated borrowed subset; preserve surviving rows
/// verbatim and retain the existing transport capacity.
pub(super) fn project_plan_returns(
    plan: &mut ReceiptDisclosurePlan,
    returned: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
) -> Option<()> {
    if returned.is_empty() || returned.len() > 200 {
        return None;
    }
    plan.returns
        .retain(|row| returned.iter().any(|original| original.id == row.id));
    if plan.returns.len() != returned.len()
        || plan
            .returns
            .iter()
            .zip(returned)
            .any(|(row, original)| row.id != original.id)
    {
        return None;
    }
    let nodes = plan
        .returns
        .iter()
        .try_fold(7usize + 40 * plan.queries.len(), |nodes, row| {
            nodes.checked_add(
                9 + 5 * row.influences.len()
                    + 10 * row.dependencies.len()
                    + row
                        .dependencies
                        .iter()
                        .filter(|read| read.query_id.is_some())
                        .count()
                    + 16 * row.intrinsics.len(),
            )
        })?;
    if nodes > 20_000 {
        return None;
    }
    Some(())
}

/// Original source and the independently prepared guards/query plan consumed
/// together by the native receipt matcher. This is private compiler input.
pub(super) struct NativeReceiptSources<'a> {
    pub db: Option<&'a SourceDb>,
    pub send_guards: Option<&'a HashMap<Span, PreparedSendGuard>>,
    pub query_plan: Option<&'a ReceiptDisclosurePlan>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQuery {
    pub id: String,
    pub source: ReceiptSource,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<ReceiptQueryParent>,
    pub order: Vec<ReceiptQueryOrder>,
    pub limit: Option<u16>,
    pub archived: String,
    pub dependencies: Vec<ReceiptQueryDependency>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryParent {
    pub source: ReceiptSource,
    pub model: String,
    pub origin: ReceiptQueryParentOrigin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(super) enum ReceiptQueryParentOrigin {
    AdmittedReference {
        parameter: String,
    },
    StoredReference {
        #[serde(rename = "dependencyId")]
        dependency_id: String,
    },
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
    #[serde(rename = "queryId", skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
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
    /// Original observed reference paired with this scalar read; private
    /// lowering input, never part of the transported disclosure plan.
    pub source_dependency_id: Option<String>,
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
    /// Private original occurrence join, never a transported recipe field.
    pub current_revision: Option<NativeCurrentRevision>,
}

#[derive(Debug, Clone)]
pub(super) struct NativeCurrentRevision {
    pub template: String,
    pub revision: String,
    pub parameter: String,
    pub published_source: Span,
    pub published: Span,
    pub retained_source: Span,
    pub digest_control: Span,
    pub digest_data: Span,
    pub outputs: Span,
    pub duration: Span,
    pub published_source_id: String,
    pub published_id: String,
    pub retained_control_id: String,
    pub retained_data_id: String,
    pub digest_control_id: String,
    pub digest_data_id: String,
    pub outputs_id: String,
    pub duration_id: String,
}

impl NativeCurrentRevision {
    fn from_sites(
        sites: &super::scenario_current_revision::CurrentRevisionSites<'_>,
    ) -> Option<Self> {
        if !matches!(sites.revision_statement, IrStmt::Let { value, .. }
            if std::ptr::eq(value, sites.revision_read.value))
            || sites.active.as_ref().is_some_and(|active| {
                active.value.span.end > sites.presence.span.start
                    || active.dependency.role != DependencyRole::Control
                    || active.dependency.node.end > sites.presence_read.control.node.start
            })
            || sites.presence.span.start > sites.presence_read.value.span.start
            || sites.presence.span.end < sites.presence_read.value.span.end
            || sites.digest_presence.span.start > sites.digest_control.value.span.start
            || sites.digest_presence.span.end < sites.digest_control.value.span.end
        {
            return None;
        }
        Some(Self {
            template: sites.template.canonical.clone(),
            revision: sites.revision.canonical.clone(),
            parameter: sites.parameter.name.clone(),
            published_source: sites.published_read.value.span,
            published: sites.published.value.span,
            retained_source: sites.revision_read.value.span,
            digest_control: sites.digest_control.value.span,
            digest_data: sites.digest_data.value.span,
            outputs: sites.outputs.value.span,
            duration: sites.duration.value.span,
            published_source_id: sites.published_read.control.id.clone(),
            published_id: sites.published.dependency.id.clone(),
            retained_control_id: sites.revision_read.control.id.clone(),
            retained_data_id: sites.revision_read.data?.id.clone(),
            digest_control_id: sites.digest_control.dependency.id.clone(),
            digest_data_id: sites.digest_data.dependency.id.clone(),
            outputs_id: sites.outputs.dependency.id.clone(),
            duration_id: sites.duration.dependency.id.clone(),
        })
    }
}

/// Nongrant checked result provenance. The owning receipt collector still
/// seals the actual executable effects, source, descriptors and return sites.
pub(super) fn has_original_created_model_result(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    if ir
        .committed_sources
        .requires_native_model_result(scenario.0 as usize)
    {
        return true;
    }
    let Some(disclosure) = ir.scenario_disclosures.get(&scenario) else {
        return false;
    };
    let Some(facts) = disclosure.source_facts() else {
        return false;
    };
    let Some(ResolvedType::Record {
        symbol: model,
        stored: true,
    }) = &facts.result
    else {
        return false;
    };
    if facts.scenario != scenario || facts.read {
        return false;
    }
    if let ScenarioDisclosure::Complete(checked) = disclosure {
        return checked.scenario == scenario
            && facts.node == checked.node
            && facts.source == checked.source
            && !checked.returns.is_empty()
            && checked.returns.iter().all(|returned| {
                returned.source == checked.source
                    && returned
                        .model_result
                        .is_some_and(|origin| origin.model() == *model)
            });
    }
    // Keep this pair's native source requirement when a copied binding or
    // unsupported continuation prevents its complete provenance proof. The
    // immutable constructor/count census supplies no executable recipe.
    let Some([first, second]) = facts.creates.as_deref() else {
        return false;
    };
    first.model == *model
        && second.model != first.model
        && first.source == facts.source
        && second.source == facts.source
        && first.node.file == second.node.file
        && first.node.end <= second.node.start
        && facts.queries.as_deref().is_some_and(|queries| {
            queries.iter().any(|query| {
                query.source == facts.source
                    && query.model == second.model
                    && query.count.as_ref().is_some_and(|count| {
                        count.statement == second.node && count.contained_parent.is_some()
                    })
            })
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

/// Original transcript attribution is source evidence only. Its native query
/// and stored-message consumer must be released before a recipe can be emitted.
pub(super) fn has_original_transcript_source(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    ir.scenario_disclosures
        .get(&scenario)
        .and_then(|disclosure| disclosure.source_facts())
        .and_then(|facts| facts.transcripts.as_deref())
        .is_some_and(|transcripts| !transcripts.is_empty())
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
        {
            return None;
        }
        for returned in &checked.returns {
            let origin = returned.model_result?;
            if origin.model() != *model || returned.source != checked.source {
                return None;
            }
            let (node, binding) = match origin {
                DisclosureModelResult::Parameter {
                    model: actual,
                    parameter,
                    node,
                } => {
                    let param = ir.items.get(parameter.0 as usize)?;
                    let IrItemKind::Param {
                        owner: parameter_owner,
                        index,
                        ty: IrType::Known(ty),
                        default: None,
                        default_node: None,
                        default_copy_source: None,
                        array_bounds: None,
                        ..
                    } = &param.kind
                    else {
                        return None;
                    };
                    let fact = facts.parameters.get(*index)?;
                    if actual != *model
                        || *parameter_owner != item.id
                        || fact.parameter != parameter
                        || fact.default.is_some()
                        || fact.constraints.is_some()
                        || *ty
                            != (ResolvedType::Record {
                                symbol: actual,
                                stored: true,
                            })
                        || !returned.dependencies.iter().any(|dependency| {
                            dependency.node == node
                                && dependency.calls.is_empty()
                                && dependency.query_id.is_none()
                                && dependency.role == DependencyRole::Data
                                && dependency.model == actual
                                && dependency.field == actual
                                && dependency.field_name == "id"
                                && dependency.type_id == "text"
                                && dependency.ty == ResolvedType::Scalar(Scalar::Text)
                        })
                    {
                        return None;
                    }
                    // The parameter declaration precedes its original direct return.
                    (fact.node, &param.name)
                }
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
#[cfg(test)]
pub(super) fn collect_native_scenario_receipt(
    ir: &IrProgram,
    item: &IrItem,
    models: &[JsModel],
    entry_module: &str,
    value_types: Option<&JsValueTypes>,
    sources: NativeReceiptSources<'_>,
) -> Option<NativeScenarioReceipt> {
    collect_native_scenario_receipt_with_feasibility(
        ir,
        item,
        models,
        entry_module,
        value_types,
        sources,
        None,
    )
}

pub(super) fn collect_native_scenario_receipt_with_feasibility(
    ir: &IrProgram,
    item: &IrItem,
    models: &[JsModel],
    entry_module: &str,
    value_types: Option<&JsValueTypes>,
    sources: NativeReceiptSources<'_>,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
) -> Option<NativeScenarioReceipt> {
    let transcript = has_original_transcript_source(ir, item.id);
    let NativeReceiptSources {
        db,
        send_guards,
        query_plan,
    } = sources;
    let IrItemKind::Scenario {
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        result,
        read: false,
        expose_excluded: false,
        effects,
        params,
        ..
    } = &item.kind
    else {
        return None;
    };
    let created_model = checked_created_model_result(ir, item);
    if (transcript && created_model.is_none())
        || (!result.as_ref().is_none_or(native_result_type) && created_model.is_none())
        || entry_module.is_empty()
    {
        return None;
    }
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&item.id)? else {
        return None;
    };
    let returned_paths: Vec<_> = match feasibility
        .filter(|_| super::scenario_feasibility::requires_projection(checked, ir))
    {
        Some(prepared) => prepared.returns(ir, item.id)?,
        None => checked.returns.iter().collect(),
    };
    if checked.scenario != item.id || returned_paths.is_empty() || returned_paths.len() > 200 {
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
    let first_plan = checked_native_first_query_plan(
        ir,
        item,
        checked,
        query_plan,
        entry_module,
        db,
        &returned_paths,
    )?;
    let sites = Sites::collect(ir, item, send_guards, db)?;
    match_effect_proofs(ir, item, models, checked, &sites, db, send_guards)?;
    let mut profile_scalar_pairs = HashMap::new();
    let mut profile_source_pairs = HashMap::new();
    if created_model.is_some()
        && let Some(db) = db
    {
        for (site, expressions) in &sites.members {
            let [expression] = expressions.as_slice() else {
                continue;
            };
            let Some(pairs) = checked_profile_scalar_pairs(ir, item, expression, db) else {
                continue;
            };
            let IrExpr::Member { base, .. } = &expression.expr else {
                return None;
            };
            let first = pairs.first()?;
            let source_site = checked_site(first.0.node, &first.0.calls)?;
            let [source_expression] = sites.members.get(&source_site)?.as_slice() else {
                return None;
            };
            if !std::ptr::eq(*source_expression, base.as_ref())
                || pairs.iter().any(|(source, _)| {
                    checked_site(source.node, &source.calls).as_ref() != Some(&source_site)
                })
                || profile_scalar_pairs
                    .insert(site.clone(), pairs.clone())
                    .is_some()
                || profile_source_pairs.insert(source_site, pairs).is_some()
            {
                return None;
            }
        }
    }
    let current_sites =
        db.and_then(|db| super::scenario_current_revision::checked_current_revision(ir, item, db));
    if current_sites.is_some() && feasibility.is_none() {
        return None;
    }
    let current_revision = match current_sites.as_ref() {
        Some(current) => Some(NativeCurrentRevision::from_sites(current)?),
        None => None,
    };
    let profile_descriptors = if current_sites.is_some() || !profile_scalar_pairs.is_empty() {
        Some(super::js::Emitter::source_models(ir, db?)?)
    } else {
        None
    };
    let mut recipe = NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            version: 1,
            source,
            queries: first_plan.map_or_else(Vec::new, |plan| plan.queries.clone()),
            returns: Vec::new(),
        },
        dependencies: HashMap::new(),
        intrinsics: HashMap::new(),
        decisions: HashMap::new(),
        decision_keys: HashMap::new(),
        calls: sites.calls.clone(),
        returns: Vec::new(),
        current_revision,
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
    let mut data_nodes: usize = first_plan.map_or(7, |plan| 7 + 40 * plan.queries.len());
    for returned in returned_paths {
        if (first_plan.is_none() && !returned.influences.is_empty())
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
        data_nodes = data_nodes.checked_add(
            9 + 5 * returned.influences.len()
                + 10 * returned.dependencies.len()
                + returned
                    .dependencies
                    .iter()
                    .filter(|read| read.query_id.is_some())
                    .count()
                + 16 * returned.intrinsics.len(),
        )?;
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
            influences: first_plan.map_or_else(Vec::new, |plan| {
                plan.returns
                    .iter()
                    .find(|candidate| candidate.id == returned.id)
                    .map_or_else(Vec::new, |candidate| candidate.influences.clone())
            }),
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
            let result_identity = match returned.model_result {
                Some(DisclosureModelResult::Parameter { model, node, .. })
                    if dependency.node == node
                        && dependency.model == model
                        && dependency.field == model
                        && dependency.field_name == "id"
                        && dependency.role == DependencyRole::Data
                        && dependency.calls.is_empty()
                        && dependency.query_id.is_none() =>
                {
                    let IrStmt::Return { value: Some(value), .. } = effects.iter().find(|effect|
                        matches!(effect, IrStmt::Return { span, .. } if *span == node_span(returned.node)))?
                    else { return None; };
                    if value.span != node_span(node) {
                        return None;
                    }
                    Some(value)
                }
                _ => None,
            };
            let is_transition = dependency.node.kind == SyntaxKind::Transition as u8;
            if (result_identity.is_none()
                && !is_transition
                && dependency.node.kind != SyntaxKind::Member as u8)
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
            let profile_scalar_pair = profile_scalar_pairs.get(&site).and_then(|pairs| {
                pairs
                    .iter()
                    .copied()
                    .find(|(_, scalar)| *scalar == dependency)
            });
            let profile_source_pair = profile_source_pairs.get(&site).and_then(|pairs| {
                pairs
                    .iter()
                    .copied()
                    .find(|(reference, _)| *reference == dependency)
            });
            if profile_scalar_pairs.contains_key(&site) && profile_scalar_pair.is_none()
                || profile_source_pairs.contains_key(&site) && profile_source_pair.is_none()
            {
                return None;
            }
            let source_dependency_id =
                profile_scalar_pair.map(|(reference, _)| reference.id.clone());
            let current_reference = current_sites.as_ref().is_some_and(|current| {
                [
                    current.presence_read.control,
                    current.published_read.control,
                    current.revision_read.control,
                    current
                        .revision_read
                        .data
                        .expect("checked original Let DATA"),
                ]
                .contains(&dependency)
            });
            let current_published = current_sites
                .as_ref()
                .is_some_and(|current| current.published.dependency == dependency);
            let current_digest_data = current_sites
                .as_ref()
                .is_some_and(|current| current.digest_data.dependency == dependency);
            let result_id_field = "id".to_string();
            let (base, field, transition) = if let Some(value) = result_identity {
                (value, &result_id_field, None)
            } else if is_transition {
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
                || !current_published
                    && base.ty
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
            let selected_transcript = checked
                .source_facts
                .as_deref()
                .and_then(|source| source.transcripts.as_deref())
                .and_then(|facts| {
                    facts.iter().find_map(|fact| {
                        let index = fact
                            .dependencies
                            .iter()
                            .position(|read| read == dependency)?;
                        let query = fact.query_dependencies.get(index)?;
                        (transcript
                            && query.role == DependencyRole::Data
                            && query.id != dependency.id
                            && query.source == dependency.source
                            && query.node == dependency.node
                            && query.calls == dependency.calls
                            && query.model == dependency.model
                            && query.field == dependency.field
                            && query.ty == dependency.ty
                            && query.type_id == dependency.type_id)
                            .then_some(fact)
                    })
                });
            let selected_inline = checked
                .source_facts
                .as_deref()
                .and_then(|source| source.inline_selections.as_deref())
                .and_then(|facts| {
                    facts.iter().find(|fact| {
                        dependency == &fact.bound_dependency
                            || fact.dependencies.iter().any(|read| read == dependency)
                    })
                });
            if let Some(fact) = selected_inline {
                let expression = sites.members.get(&site)?.first()?;
                checked_inline_selection_member(ir, item, fact, dependency, expression, db?)?;
            }
            if dependency.query_id.is_some()
                && !parent_read
                && selected_transcript.is_none()
                && selected_inline.is_none()
            {
                return None;
            }
            let transport_type = if id_read {
                if transition.is_some()
                    || !dependency.calls.is_empty()
                    || dependency.ty != ResolvedType::Scalar(Scalar::Text)
                    || dependency.type_id != "text"
                {
                    return None;
                }
                let expression = match result_identity {
                    Some(value) => value,
                    None => *sites.members.get(&site)?.first()?,
                };
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
                let (child, parent) = if dependency.query_id.is_some() {
                    let (child, parent, query_id) = checked_candidate_parent_association(
                        ir, item, dependency, expression, db?,
                    )?;
                    if !recipe.plan.queries.iter().any(|query| query.id == query_id) {
                        return None;
                    }
                    (child, parent)
                } else {
                    checked_parent_reference(ir, item, expression, db?)?
                };
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
                    || ty != &dependency.ty && !current_reference && !current_digest_data
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
                if profile_scalar_pair.is_some() {
                    let mut expected_models = profile_descriptors
                        .as_ref()?
                        .iter()
                        .filter(|model| model.name == owner.canonical);
                    let expected_model = expected_models.next()?;
                    let mut expected_fields = expected_model
                        .fields
                        .iter()
                        .filter(|field| field.name == stored.name);
                    let expected = expected_fields.next()?;
                    if expected_models.next().is_some()
                        || expected_fields.next().is_some()
                        || serde_json::to_value(expected_model).ok()?
                            != serde_json::to_value(descriptors[0]).ok()?
                        || declared[0].nullable
                        || declared[0].server_only
                        || declared[0].array_required.is_some()
                        || declared[0].machine.is_some()
                        || !matches!(&stored.kind, IrItemKind::Field { server: None, .. })
                        || serde_json::to_value(expected).ok()?
                            != serde_json::to_value(declared[0]).ok()?
                    {
                        return None;
                    }
                }
                if !matches!(base.expr, IrExpr::Name(_)) {
                    if let Some((reference, scalar)) = profile_scalar_pair {
                        if reference.ty != base.ty || scalar.model != dependency.model {
                            return None;
                        }
                    } else if !current_published {
                        let (_, parent) = checked_parent_reference(ir, item, base, db?)?;
                        if parent.id != dependency.model {
                            return None;
                        }
                    }
                } else if checked
                    .source_facts
                    .as_deref()
                    .and_then(|facts| facts.queries.as_deref())
                    .is_some_and(|queries| {
                        queries
                            .iter()
                            .any(|query| query.first.is_some() && query.model == dependency.model)
                    })
                    && checked_first_query_row(ir, item, base, db?)?.id != dependency.model
                {
                    return None;
                }
                if let Some(fact) = selected_transcript {
                    let expression = sites.members.get(&site)?.first()?;
                    checked_transcript_selected_member(ir, item, fact, expression, db?)?;
                }
                let reference_type = reference_operand_type_id(ir, ty);
                if current_reference || current_digest_data {
                    if transition.is_some() || !dependency.calls.is_empty() {
                        return None;
                    }
                    let mut expected_models = profile_descriptors
                        .as_ref()?
                        .iter()
                        .filter(|model| model.name == owner.canonical);
                    let expected = expected_models.next()?;
                    if expected_models.next().is_some()
                        || serde_json::to_value(expected).ok()?
                            != serde_json::to_value(descriptors[0]).ok()?
                        || !declared[0].nullable
                        || declared[0].server_only
                        || declared[0].array_required.is_some()
                        || declared[0].machine.is_some()
                    {
                        return None;
                    }
                    dependency.type_id.clone()
                } else if let Some(reference_type) = reference_type {
                    if transition.is_some() || !dependency.calls.is_empty() {
                        return None;
                    }
                    let expression = sites.members.get(&site)?.first()?;
                    let original = if let Some((reference, _)) = profile_source_pair {
                        checked
                            .source_facts
                            .as_deref()?
                            .stored_contracts
                            .as_deref()?
                            .iter()
                            .find(|schema| schema.id == reference.model && schema.model)?
                            .fields
                            .iter()
                            .find(|field| field.id == reference.field)?
                    } else {
                        stored_reference_operand(ir, item, expression, db?)?
                    };
                    if original.id != stored.id
                        || reference_type != dependency.type_id
                        || !stored_reference_descriptor_matches(ir, original, declared[0])
                    {
                        return None;
                    }
                    reference_type
                } else if matches!(ty, ResolvedType::Array { element, .. }
                    if **element == ResolvedType::Scalar(Scalar::File))
                {
                    if transition.is_some()
                        || (!dependency.calls.is_empty() && selected_transcript.is_none())
                        || dependency.role != DependencyRole::Data
                        || dependency.type_id != "file[]"
                    {
                        return None;
                    }
                    let expression = sites.members.get(&site)?.first()?;
                    let original = if let Some(fact) = selected_inline {
                        checked
                            .source_facts
                            .as_deref()?
                            .stored_contracts
                            .as_deref()?
                            .iter()
                            .find(|schema| schema.id == fact.query.model && schema.model)?
                            .fields
                            .iter()
                            .find(|field| field.id == dependency.field)?
                    } else if let Some(fact) = selected_transcript {
                        checked
                            .source_facts
                            .as_deref()?
                            .stored_contracts
                            .as_deref()?
                            .iter()
                            .find(|schema| schema.id == fact.model && schema.model)?
                            .fields
                            .iter()
                            .find(|field| field.id == dependency.field)?
                    } else {
                        stored_file_array_operand(ir, item, expression, db?)?
                    };
                    if original.id != stored.id
                        || !stored_file_array_descriptor_matches(ir, original, declared[0])
                    {
                        return None;
                    }
                    "file[]".into()
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
                } else if let Some(prefix) = checked_transcript_prefix_inventory(
                    ir,
                    item,
                    dependency,
                    declared[0],
                    value_types,
                    db,
                ) {
                    if transition.is_some() || prefix != dependency.type_id {
                        return None;
                    }
                    prefix
                } else if let Some(prefix) = checked_inline_prefix_inventory(
                    ir,
                    item,
                    dependency,
                    declared[0],
                    value_types,
                    db,
                ) {
                    if transition.is_some() || prefix != dependency.type_id {
                        return None;
                    }
                    prefix
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
            if let Some(previous) = observed.iter().find(|read| read.id == dependency.id) {
                if previous.source_dependency_id != source_dependency_id {
                    return None;
                }
            } else {
                observed.push(NativeDependency {
                    id: dependency.id.clone(),
                    model: dependency.model_name.clone(),
                    field: dependency.field_name.clone(),
                    source_dependency_id,
                });
            }
            plan_return.dependencies.push(ReceiptDependency {
                id: dependency.id.clone(),
                source: transport_source(&dependency.source, entry_module)?,
                role,
                model: dependency.model_name.clone(),
                field: dependency.field_name.clone(),
                type_id: transport_type,
                query_id: dependency.query_id.clone(),
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
    if transcript
        && serde_json::to_value(&recipe.plan).ok()? != serde_json::to_value(query_plan?).ok()?
    {
        return None;
    }
    Some(recipe)
}

/// A prepared first-query plan contributes only its original source domain
/// associations. Effects, row reads, decisions and the created result remain
/// owned by this collector rather than the query preparation's skeleton.
/// Existing native selectors admit only their individual source profile or
/// the authored first-then-contained-count composition on the same result.
pub(super) fn checked_any_query_ir<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    actual: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    if checked_scenario_query_influences(facts)?.len() != 24 {
        return None;
    }
    let [query, _, _, _] = facts.queries.as_deref()? else {
        return None;
    };
    let IrItemKind::Scenario { guards, params, .. } = &owner.kind else {
        return None;
    };
    let mut statements = guards.iter().filter_map(|statement| {
        let IrStmt::Require { cond, span } = statement else {
            return None;
        };
        let IrExpr::Unary {
            op: super::ir::IrUnOp::Not,
            operand,
        } = &cond.expr
        else {
            return None;
        };
        std::ptr::eq(operand.as_ref(), actual).then_some((cond, *span))
    });
    let (condition, statement) = statements.next()?;
    let (target, args, slots) = match &actual.expr {
        IrExpr::Call { target, args } => (target, args, None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args, Some(slots.as_slice())),
        _ => return None,
    };
    let [domain, predicate] = args.as_slice() else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let IrExpr::Lambda { param, body } = &predicate.expr else {
        return None;
    };
    let checked = scan.source.as_deref()?;
    let collection = scan.collection_call.as_deref()?;
    let [alias] = checked.clauses.as_slice() else {
        return None;
    };
    let crate::analysis::types::CheckedQueryClauseKind::As { name } = &alias.kind else {
        return None;
    };
    let [(receiver, parameter_id)] = query.inputs.as_slice() else {
        return None;
    };
    let parameter = ir.items.get(parameter_id.0 as usize)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol: parent_id,
                stored: true,
            }),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let original_parameter = facts.parameters.get(*index)?;
    let parent = scan.parent.as_deref()?;
    let [dependency] = query.dependencies.as_slice() else {
        return None;
    };
    let boolean = ResolvedType::Scalar(Scalar::Bool);
    let record = ResolvedType::Record {
        symbol: query.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    let model = ir.items.get(query.model.0 as usize)?;
    let IrExpr::Member { base, field } = &body.expr else {
        return None;
    };
    let sites = facts.decision_sites.as_deref()?;
    let mut original_calls =
        sites
            .iter()
            .filter(|site| {
                site.owner==owner.id
        && node_span(site.statement)==statement && node_span(site.node)==condition.span
        && site.stage==crate::analysis::scenario_disclosure::CheckedDecisionStage::LeadingRequire
        && site.source==facts.source
            })
            .flat_map(|site| &site.calls)
            .filter(|call| node_span(call.node) == actual.span);
    let original_call = original_calls.next()?;
    let census = facts.expression_types.as_deref()?;
    if statements.next().is_some()
        || original_calls.next().is_some()
        || !matches!(target,IrCallTarget::Builtin {id,awaited:false} if id=="any")
        || slots.is_some_and(|slots| slots != [Some(0), Some(1)])
        || actual.ty != boolean
        || condition.ty != boolean
        || predicate.ty != boolean
        || body.ty != boolean
        || collection.node != original_call.node
        || collection.builtin != "any"
        || collection.overload != 0
        || collection.model != query.model
        || collection.query != query.node
        || Some(collection.alias) != query.alias
        || collection.alias != alias.node
        || collection
            .predicate
            .as_ref()
            .is_none_or(|value| Some(value.node) != query.predicate || value.ty != boolean)
        || original_call.target
            != (crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Builtin {
                id: "any".into(),
                overload: 0,
            })
        || original_call.arguments
            != vec![
                (query.node, array.clone()),
                (query.predicate?, boolean.clone()),
            ]
        || original_call.slots != [Some(0), Some(1)]
        || !original_call.defaults.is_empty()
        || !original_call.chain.is_empty()
        || original_call.source != facts.source
        || original_call.module != owner.module
        || checked.node != query.node
        || checked.domain != query.domain
        || checked.projection.is_some()
        || checked.domain_type != array
        || checked.result != array
        || domain.ty != array
        || domain.span != node_span(query.node)
        || body.span != node_span(query.predicate?)
        || param != name
        || param != "run"
        || field != "unfinished"
        || base.ty != record
        || !matches!(&base.expr,IrExpr::Name(value) if value==param)
        || scan.contract_collection_call.is_some()
        || scan.where_pred.is_some()
        || scan.where_async
        || scan.select.is_some()
        || scan.select_param.is_some()
        || !scan.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || !matches!(&scan.domain,super::ir::IrQueryDomain::Model(value) if value==&model.canonical)
        || *parameter_owner != owner.id
        || params.get(*index) != Some(parameter_id)
        || original_parameter.parameter != *parameter_id
        || original_parameter.default.is_some()
        || original_parameter.ty != parent.ty
        || parent.span != node_span(*receiver)
        || !matches!(&parent.expr,IrExpr::Name(value) if value==&parameter.name)
        || !matches!(&model.kind,IrItemKind::Model {owner:IrOwner::ChildOf(value),..} if value==parent_id)
        || dependency.role != DependencyRole::Control
        || dependency.ty != boolean
        || dependency.type_id != "bool"
        || dependency.model != query.model
        || dependency.model_name != model.canonical
        || dependency.node != query.predicate?
        || dependency.field_name != *field
        || !dependency.calls.is_empty()
        || dependency.query_id.is_some()
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == actual.span && ty == &actual.ty)
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == body.span && ty == &body.ty)
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == base.span && ty == &base.ty)
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == parent.span && ty == &parent.ty)
    {
        return None;
    }
    let source_receiver = checked_effect_node(ir, owner, *receiver, db)?;
    let source_predicate = checked_effect_node(ir, owner, query.predicate?, db)?;
    let text = &db.get(receiver.file)?.text;
    let source_base = source_predicate
        .children
        .iter()
        .find(|part| matches!(part.kind, SyntaxKind::NameRef))?;
    let source_field = source_predicate
        .children
        .iter()
        .rev()
        .find(|part| part.kind == SyntaxKind::Name)?;
    if source_receiver.kind != SyntaxKind::NameRef
        || text.get(receiver.start as usize..receiver.end as usize)? != parameter.name
        || source_predicate.kind != SyntaxKind::Member
        || source_base.span != base.span
        || text.get(source_base.span.start as usize..source_base.span.end as usize)? != param
        || source_field.token()?.text(text) != "unfinished"
    {
        return None;
    }
    for id in [query.model, *parent_id] {
        let mut schemas = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.id == id && schema.model);
        let schema = schemas.next()?;
        if schemas.next().is_some() || schema.source != query.source {
            return None;
        }
        match_stored_contract_schema(ir, schema, db)?;
        for field in &schema.fields {
            match_stored_contract_field(ir, field, db)?;
        }
        if id == query.model
            && schema
                .fields
                .iter()
                .filter(|field| {
                    field.id == dependency.field
                        && field.name == dependency.field_name
                        && field.ty == boolean
                })
                .count()
                != 1
        {
            return None;
        }
    }
    Some(query)
}

pub(super) fn checked_native_any_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptQuery> {
    let IrItemKind::Scenario { guards, .. } = &owner.kind else {
        return None;
    };
    let mut calls = guards.iter().filter_map(|statement| {
        let IrStmt::Require { cond, .. } = statement else {
            return None;
        };
        let IrExpr::Unary {
            op: super::ir::IrUnOp::Not,
            operand,
        } = &cond.expr
        else {
            return None;
        };
        (checked_any_query_ir(ir, owner, operand, db) == Some(query)).then_some(operand.as_ref())
    });
    calls.next()?;
    if calls.next().is_some() {
        return None;
    }
    let [(_, parameter)] = query.inputs.as_slice() else {
        return None;
    };
    let parameter = ir.items.get(parameter.0 as usize)?;
    let IrItemKind::Param {
        ty: IrType::Known(ResolvedType::Record { symbol: parent, .. }),
        ..
    } = &parameter.kind
    else {
        return None;
    };
    Some(ReceiptQuery {
        id: query.id.clone(),
        source: transport_source(&query.source, entry)?,
        model: query.model_name.clone(),
        parent: Some(ReceiptQueryParent {
            source: transport_source(&query.source, entry)?,
            model: ir.items.get(parent.0 as usize)?.canonical.clone(),
            origin: ReceiptQueryParentOrigin::AdmittedReference {
                parameter: parameter.name.clone(),
            },
        }),
        order: Vec::new(),
        limit: None,
        archived: "exclude".into(),
        dependencies: query
            .dependencies
            .iter()
            .map(|read| {
                Some(ReceiptQueryDependency {
                    id: read.id.clone(),
                    source: transport_source(&read.source, entry)?,
                    role: ReceiptRole::Control,
                    field: read.field_name.clone(),
                    type_id: read.type_id.clone(),
                })
            })
            .collect::<Option<Vec<_>>>()?,
    })
}

pub(super) fn checked_native_query_influences(
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    match queries {
        [query]
            if query.first.is_some() != query.count.is_some()
                && query.projection.is_none()
                && query.cardinality_guard.is_none() => {}
        [first, count]
            if first.first.is_some()
                && first.count.is_none()
                && count.first.is_none()
                && count.count.is_some()
                && first.projection.is_none()
                && first.cardinality_guard.is_none()
                && count.projection.is_none()
                && count.cardinality_guard.is_none()
                && first.source == count.source
                && first.return_node == count.return_node
                && first.id != count.id
                && first.first.as_ref()?.binding.file == count.count.as_ref()?.statement.file
                && first.first.as_ref()?.binding.end <= count.count.as_ref()?.statement.start
                && count.count.as_ref()?.contained_parent.is_some()
                && count.count.as_ref()?.parent_edges.is_empty() => {}
        [ancestor, first, count]
            if ancestor.first.is_none()
                && ancestor.count.is_some()
                && ancestor.projection.is_none()
                && ancestor.cardinality_guard.is_none()
                && ancestor.count.as_ref()?.contained_parent.is_none()
                && ancestor.count.as_ref()?.parent_edges.len() == 3
                && ancestor.count.as_ref()?.statement.kind == SyntaxKind::Require as u8
                && checked_native_query_influences(&queries[1..]).is_some()
                && ancestor.source == first.source
                && ancestor.return_node == first.return_node
                && ancestor.id != first.id
                && ancestor.id != count.id
                && ancestor.count.as_ref()?.statement.file
                    == first.first.as_ref()?.binding.file
                && ancestor.count.as_ref()?.statement.end
                    <= first.first.as_ref()?.binding.start
                && ancestor.inputs.len() == 1
                && ancestor.inputs[0].1 == count.count.as_ref()?.contained_parent?.1 => {}
        [any, ancestor, first, count]
            if any.first.is_none()
                && any.count.is_none()
                && any.projection.is_none()
                && any.cardinality_guard.is_none()
                && any.alias.is_some()
                && any.predicate.is_some()
                && checked_native_query_influences(&queries[1..]).is_some()
                && any.source == ancestor.source
                && any.return_node == ancestor.return_node
                && any.model == ancestor.model
                && any.inputs.len() == 1
                && any.inputs[0].1 == ancestor.inputs[0].1
                && any.node.file == ancestor.count.as_ref()?.statement.file
                && any.node.end <= ancestor.count.as_ref()?.statement.start
                && any.id != ancestor.id
                && any.id != first.id
                && any.id != count.id => {}
        _ => return None,
    }
    let mut ids = HashSet::new();
    let mut influences = Vec::new();
    for query in queries {
        if query.influences.len() != 4 {
            return None;
        }
        for influence in &query.influences {
            if influence.id.is_empty()
                || !ids.insert(&influence.id)
                || influence.source != query.source
                || influence.node != query.node
                || influence.query_id.as_deref() != Some(query.id.as_str())
            {
                return None;
            }
            influences.push(influence.clone());
        }
    }
    Some(influences)
}

/// The original ask composes four ordinary selectors with two independent
/// transcript calls. This exact source cohort retains all six identities in
/// authored evaluation order, without granting a generic mixed-query surface.
pub(super) fn checked_scenario_query_influences(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    let queries = facts.queries.as_deref()?;
    let transcripts = facts.transcripts.as_deref().unwrap_or_default();
    if let Some([fact]) = facts
        .inline_selections
        .as_deref()
        .filter(|facts| !facts.is_empty())
    {
        let [query] = queries else {
            return None;
        };
        if query != &fact.query
            || !transcripts.is_empty()
            || query.influences.len() != 4
            || query.first.is_some()
            || query.count.is_some()
            || query.projection.is_some()
            || query.source != facts.source
            || query.return_node.file != facts.node.file
        {
            return None;
        }
        let mut ids = HashSet::new();
        for (influence, kind) in query.influences.iter().zip([
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder,
        ]) {
            if influence.kind != kind
                || influence.id.is_empty()
                || !ids.insert(influence.id.as_str())
                || influence.source != query.source
                || influence.node != query.node
                || influence.query_id.as_deref() != Some(query.id.as_str())
            {
                return None;
            }
        }
        return Some(query.influences.clone());
    }
    if facts
        .inline_selections
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return None;
    }
    if transcripts.is_empty() {
        return checked_native_query_influences(queries);
    }
    let [early, later] = transcripts else {
        return None;
    };
    let ordered = if queries.is_empty() {
        vec![early.influences.as_slice(), later.influences.as_slice()]
    } else {
        let [any, ancestor, first, count] = queries else {
            return None;
        };
        checked_native_query_influences(queries)?;
        let [run, turn] = facts.creates.as_deref()? else {
            return None;
        };
        let branch = early.parameter;
        if early.source != facts.source
            || later.source != facts.source
            || early.parameter != later.parameter
            || early.derive != later.derive
            || early.body != later.body
            || early.query != later.query
            || early.branch != later.branch
            || early.model != later.model
            || any.inputs[0].1 != branch
            || ancestor.inputs[0].1 != branch
            || count.count.as_ref()?.contained_parent?.1 != branch
            || early.call.file != any.node.file
            || early.call.end > any.node.start
            || first.first.as_ref()?.call.end > later.call.start
            || later.call.end > count.count.as_ref()?.call.start
            || early.statement.kind != SyntaxKind::Require as u8
            || later.statement.kind != SyntaxKind::Let as u8
            || run.model != any.model
            || turn.model != count.model
            || turn.model != early.model
            || count.count.as_ref()?.statement != turn.node
            || run.source != facts.source
            || turn.source != facts.source
            || run.definition.declaration.owner
                != crate::analysis::resolve::ModelOwner::ChildOf(early.branch)
            || turn.definition.declaration.owner
                != crate::analysis::resolve::ModelOwner::ChildOf(early.branch)
        {
            return None;
        }
        vec![
            early.influences.as_slice(),
            any.influences.as_slice(),
            ancestor.influences.as_slice(),
            first.influences.as_slice(),
            later.influences.as_slice(),
            count.influences.as_slice(),
        ]
    };
    let mut ids = HashSet::new();
    let mut query_ids = HashSet::new();
    let mut out = Vec::new();
    for group in ordered {
        if group.len() != 4 {
            return None;
        }
        let query = group[0].query_id.as_deref()?;
        if !query_ids.insert(query) {
            return None;
        }
        for (influence, kind) in group.iter().zip([
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder,
        ]) {
            if influence.kind != kind
                || influence.source != facts.source
                || influence.id.is_empty()
                || !ids.insert(influence.id.as_str())
                || influence.query_id.as_deref() != Some(query)
            {
                return None;
            }
            out.push(influence.clone());
        }
    }
    Some(out)
}

/// Merge already checked individual selectors, retaining original query and
/// Return identity/order. Each individual plan contributes only its own four
/// influences; no complete recipe or ordinary observations are reconstructed.
pub(super) fn merge_native_query_plans(
    mut first: ReceiptDisclosurePlan,
    count: ReceiptDisclosurePlan,
) -> Option<ReceiptDisclosurePlan> {
    if first.version != count.version
        || serde_json::to_value(&first.source).ok()? != serde_json::to_value(&count.source).ok()?
        || first.queries.is_empty()
        || first.queries.len() > 2
        || count.queries.len() != 1
        || first
            .queries
            .iter()
            .any(|query| query.id == count.queries[0].id)
        || first.returns.len() != count.returns.len()
    {
        return None;
    }
    for (returned, counted) in first.returns.iter_mut().zip(count.returns) {
        if returned.id != counted.id
            || serde_json::to_value(&returned.source).ok()?
                != serde_json::to_value(&counted.source).ok()?
            || returned.influences.len() != 4 * first.queries.len()
            || counted.influences.len() != 4
            || !returned.dependencies.is_empty()
            || !counted.dependencies.is_empty()
            || !returned.intrinsics.is_empty()
            || !counted.intrinsics.is_empty()
            || returned.projection.is_some()
            || counted.projection.is_some()
            || returned.influences.iter().any(|influence| {
                counted
                    .influences
                    .iter()
                    .any(|other| other.id == influence.id)
            })
        {
            return None;
        }
        returned.influences.extend(counted.influences);
    }
    first.queries.extend(count.queries);
    Some(first)
}

fn checked_native_first_query_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    supplied: Option<&'a ReceiptDisclosurePlan>,
    entry_module: &str,
    db: Option<&SourceDb>,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
) -> Option<Option<&'a ReceiptDisclosurePlan>> {
    let facts = checked.source_facts.as_deref()?;
    if facts
        .inline_selections
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return checked_native_inline_selection_plan(
            ir,
            owner,
            checked,
            supplied?,
            entry_module,
            returned_paths,
            db?,
        )
        .map(Some);
    }
    if facts
        .transcripts
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return checked_native_transcript_plan(
            ir,
            owner,
            checked,
            supplied?,
            entry_module,
            returned_paths,
            db?,
        )
        .map(Some);
    }
    let queries = facts.queries.as_deref().unwrap_or_default();
    if queries
        .iter()
        .all(|query| query.first.is_none() && query.count.is_none())
    {
        if queries
            .iter()
            .any(|query| query.alias.is_none() || query.predicate.is_none())
        {
            return None;
        }
        return supplied.is_none().then_some(None);
    }
    checked_native_query_influences(queries)?;
    let plan = supplied?;
    let db = db?;
    let mut expected = match queries {
        [query] if query.count.is_some() => {
            checked_native_count_query_plan(ir, owner, query, db, entry_module)?
        }
        [query] => {
            checked_native_first_query_source_plan(ir, owner, checked, query, entry_module, db)?
        }
        [first, count] => merge_native_query_plans(
            checked_native_first_query_source_plan(ir, owner, checked, first, entry_module, db)?,
            checked_native_count_query_plan(ir, owner, count, db, entry_module)?,
        )?,
        [ancestor, first, count] => merge_native_query_plans(
            merge_native_query_plans(
                checked_native_count_query_plan(ir, owner, ancestor, db, entry_module)?,
                checked_native_first_query_source_plan(
                    ir,
                    owner,
                    checked,
                    first,
                    entry_module,
                    db,
                )?,
            )?,
            checked_native_count_query_plan(ir, owner, count, db, entry_module)?,
        )?,
        _ => return None,
    };
    project_plan_returns(&mut expected, returned_paths)?;
    (serde_json::to_value(plan).ok()? == serde_json::to_value(expected).ok()?).then_some(Some(plan))
}

/// The private source selection is authenticated against its actual complete
/// prefix Let using the existing owning Branch create expression seal. This
/// returns borrowed executable operands, never a reconstructed getter or row.
fn checked_inline_selection_ir<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    db: &SourceDb,
) -> Option<&'a super::ir::IrQuery> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let [original_fact] = facts.inline_selections.as_deref()? else {
        return None;
    };
    let [original_query] = facts.queries.as_deref()? else {
        return None;
    };
    let IrItemKind::Scenario {
        effects,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut statements = effects.iter().filter(
        |statement| matches!(statement,IrStmt::Let {span,..} if *span==node_span(fact.statement)),
    );
    let IrStmt::Let { value, .. } = statements.next()? else {
        return None;
    };
    let mut creates = facts.creates.as_deref()?.iter().filter(|created| {
        created.model == fact.parent.parent && created.node.start >= fact.statement.end
    });
    let original = creates.next()?;
    if statements.next().is_some()
        || creates.next().is_some()
        || original_fact != fact
        || original_query != &fact.query
        || !facts.transcripts.as_deref()?.is_empty()
        || fact.query.source != facts.source
        || fact.parent.child != fact.query.model
        || fact.parent.parent != fact.prefix_parent.parent
        || fact.parent.child != fact.prefix_parent.child
        || fact.parent_dependency.node != fact.parent.node
        || fact.parent_dependency.model != fact.parent.child
        || fact.parent_dependency.field != fact.parent.child
        || fact.parent_dependency.field_name != "parent"
        || fact.parent_dependency.role != DependencyRole::Data
        || fact.parent_dependency.query_id.is_some()
        || !fact.parent_dependency.calls.is_empty()
    {
        return None;
    }
    super::scenario_create_sources::checked_create_expression(ir, original, value, fact.value, db)?;
    let IrExpr::Binary {
        op: IrBinOp::Add,
        left,
        right,
    } = &value.expr
    else {
        return None;
    };
    let IrExpr::Query(query) = &right.expr else {
        return None;
    };
    if left.span != node_span(fact.prefix_node)
        || right.span != node_span(fact.query.node)
        || value.ty != fact.ty
        || right.ty != fact.ty
        || query.source.as_deref() != Some(&fact.checked)
        || query.where_pred.as_deref()?.span != node_span(fact.query.predicate?)
        || query.parent.as_deref()?.span != node_span(fact.parent.node)
        || query.select.as_deref()?.span != node_span(fact.select)
        || query.value_order.is_some()
        || query.order.len() != 1
        || query.order[0].field != fact.order_dependency.field_name
        || query.order[0].descending
        || query.limit.is_some()
        || query.archived.is_some()
        || query.collection_call.is_some()
        || query.contract_collection_call.is_some()
    {
        return None;
    }
    Some(query)
}

fn checked_native_inline_selection_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    plan: &'a ReceiptDisclosurePlan,
    entry: &str,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
    db: &SourceDb,
) -> Option<&'a ReceiptDisclosurePlan> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let [fact] = facts.inline_selections.as_deref()? else {
        return None;
    };
    checked_inline_selection_ir(ir, owner, fact, db)?;
    let query = &fact.query;
    let [actual] = plan.queries.as_slice() else {
        return None;
    };
    let parent = ir.items.get(fact.parent.parent.0 as usize)?;
    let model = ir.items.get(query.model.0 as usize)?;
    let origin = actual.parent.as_ref()?;
    let ReceiptQueryParentOrigin::StoredReference { dependency_id } = &origin.origin else {
        return None;
    };
    let expected_influences = checked_scenario_query_influences(facts)?;
    // The producer deliberately gives query predicate/order/selection reads
    // different IDs from the ordinary receipt observations of the same fields.
    // Reconstruct those exact source-owned identities; all other fields still
    // compare as a complete dependency, and the returned observations stay unchanged.
    let identity = |kind: &str, node: crate::analysis::NodeKey, discriminator: &str| {
        sha256_hex(
            format!(
                "scenario-disclosure/v1:{kind}:{}:{}:{}:{}:{}:{discriminator}",
                query.source.path, query.source.sha256, query.source.module, node.start, node.end,
            )
            .as_bytes(),
        )
    };
    if query.id != identity("inline-selection-query", query.node, "")
        || plan.version != 1
        || plan.returns.len() != returned_paths.len()
        || returned_paths.is_empty()
        || !matches!(model.kind,IrItemKind::Model {owner:IrOwner::ChildOf(id),..} if id==parent.id)
        || query.dependencies.len() != 5
        || fact.dependencies.len() != 3
        || fact.fields.len() != 3
        || actual.id != query.id
        || actual.model != model.canonical
        || origin.model != parent.canonical
        || dependency_id != &fact.parent_dependency.id
        || actual.order.len() != 1
        || actual.order[0].field != fact.order_dependency.field_name
        || actual.order[0].direction != "asc"
        || actual.limit.is_some()
        || actual.archived != "exclude"
        || actual.dependencies.len() != query.dependencies.len()
        || serde_json::to_value(&plan.source).ok()?
            != serde_json::to_value(transport_source(&checked.source, entry)?).ok()?
        || serde_json::to_value(&actual.source).ok()?
            != serde_json::to_value(transport_source(&query.source, entry)?).ok()?
        || serde_json::to_value(&origin.source).ok()?
            != serde_json::to_value(&actual.source).ok()?
    {
        return None;
    }
    let mut ids = HashSet::new();
    for ((original, emitted), expected) in query.dependencies.iter().zip(&actual.dependencies).zip(
        std::iter::once(&fact.predicate_dependency)
            .chain(std::iter::once(&fact.order_dependency))
            .chain(&fact.dependencies),
    ) {
        let mut expected_query = expected.clone();
        expected_query.id = identity(
            if expected.role == DependencyRole::Data {
                "query-data"
            } else {
                "query-control"
            },
            expected.node,
            &query.id,
        );
        expected_query.query_id = None;
        let role = expected.role;
        let field = expected.field_name.as_str();
        let emitted_role = match role {
            DependencyRole::Data => ReceiptRole::Data,
            DependencyRole::Control => ReceiptRole::Control,
        };
        if original.id.is_empty()
            || !ids.insert(original.id.as_str())
            || original.model != query.model
            || original.source != query.source
            || original != &expected_query
            || original.role != role
            || original.field_name != field
            || !original.calls.is_empty()
            || original.query_id.is_some()
            || emitted.id != original.id
            || emitted.role != emitted_role
            || emitted.field != field
            || emitted.type_id != original.type_id
            || serde_json::to_value(&emitted.source).ok()?
                != serde_json::to_value(transport_source(&original.source, entry)?).ok()?
        {
            return None;
        }
    }
    for (returned, emitted) in returned_paths.iter().zip(&plan.returns) {
        if returned.source!=checked.source || returned.influences!=expected_influences
            || emitted.id!=returned.id || emitted.projection.is_some()
            || emitted.dependencies.len()!=returned.dependencies.len()
            || emitted.intrinsics.len()!=returned.intrinsics.len()
            || emitted.influences.len()!=returned.influences.len()
            || serde_json::to_value(&emitted.source).ok()?!=serde_json::to_value(transport_source(&returned.source,entry)?).ok()?
            || !fact.dependencies.iter().chain([&fact.bound_dependency,&fact.parent_dependency])
                .all(|required| returned.dependencies.iter().any(|read| read==required))
            // Candidate WHERE and engine ORDER controls belong to the genuine
            // query, not invented ordinary root/source getter observations.
            || returned.dependencies.iter().any(|read|
                read==&fact.predicate_dependency || read==&fact.order_dependency)
        {
            return None;
        }
        for (read, emitted) in returned.dependencies.iter().zip(&emitted.dependencies) {
            let role = match read.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            if emitted.id != read.id
                || emitted.model != read.model_name
                || emitted.field != read.field_name
                || emitted.type_id != read.type_id
                || emitted.role != role
                || emitted.query_id != read.query_id
                || serde_json::to_value(&emitted.source).ok()?
                    != serde_json::to_value(transport_source(&read.source, entry)?).ok()?
            {
                return None;
            }
        }
        for (read, emitted) in returned.intrinsics.iter().zip(&emitted.intrinsics) {
            let role = match read.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            let kind = match &read.kind {
                DisclosureIntrinsicKind::OperationId => NativeIntrinsicKind::OperationId,
                DisclosureIntrinsicKind::AdmittedInput { parameter_name, .. } => {
                    NativeIntrinsicKind::AdmittedInput {
                        parameter: parameter_name.clone(),
                    }
                }
                DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter_name,
                    model_name,
                    ..
                } => NativeIntrinsicKind::AdmittedReferenceVersion {
                    parameter: parameter_name.clone(),
                    model: model_name.clone(),
                },
            };
            if emitted.id != read.id
                || emitted.type_id != read.type_id
                || emitted.role != role
                || emitted.kind != kind
                || serde_json::to_value(&emitted.source).ok()?
                    != serde_json::to_value(transport_source(&read.source, entry)?).ok()?
            {
                return None;
            }
        }
        for (influence, emitted) in returned.influences.iter().zip(&emitted.influences) {
            let kind = match influence.kind {
                InfluenceKind::QueryExistence => "query-existence",
                InfluenceKind::QueryCardinality => "query-cardinality",
                InfluenceKind::QueryMembership => "query-membership",
                InfluenceKind::QueryOrder => "query-order",
                InfluenceKind::AbsentReference => return None,
            };
            if emitted.id != influence.id
                || emitted.query_id != influence.query_id
                || emitted.kind != kind
            {
                return None;
            }
        }
    }
    Some(plan)
}

/// Ordinary observations exist only for eager selected values and the real
/// supplied Turn.position WHERE-bound read. Candidate controls remain query-only.
fn checked_inline_selection_member(
    ir: &IrProgram,
    owner: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let query = checked_inline_selection_ir(ir, owner, fact, db)?;
    let actual = if read == &fact.bound_dependency {
        let IrExpr::Binary {
            op: IrBinOp::Lt,
            right,
            ..
        } = &query.where_pred.as_deref()?.expr
        else {
            return None;
        };
        right.as_ref()
    } else {
        let field = fact
            .fields
            .iter()
            .zip(&fact.dependencies)
            .find_map(|(field, dependency)| (dependency == read).then_some(field))?;
        let IrExpr::Object(entries) = &query.select.as_deref()?.expr else {
            return None;
        };
        &entries
            .iter()
            .find(|(name, actual)| {
                name == &field.name && actual.span == node_span(field.value_node)
            })?
            .1
    };
    if !std::ptr::eq(actual, value)
        || value.span != node_span(read.node)
        || value.ty != read.ty
        || read.query_id.as_deref() != Some(fact.query.id.as_str())
        || !read.calls.is_empty()
        || read.source != fact.query.source
        || read.model != fact.query.model
    {
        return None;
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    if base.ty
        != (ResolvedType::Record {
            symbol: fact.query.model,
            stored: true,
        })
        || field != &read.field_name
    {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == read.model);
    let schema = schemas.next()?;
    if schemas.next().is_some() {
        return None;
    }
    match_stored_contract_schema(ir, schema, db)?;
    let original = schema.fields.iter().find(|field| field.id == read.field)?;
    match_stored_contract_field(ir, original, db)?;
    (original.ty == read.ty && original.name == read.field_name && original.source == read.source)
        .then_some(())
}

fn checked_native_transcript_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    plan: &'a ReceiptDisclosurePlan,
    entry: &str,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
    db: &SourceDb,
) -> Option<&'a ReceiptDisclosurePlan> {
    let facts = checked.source_facts.as_deref()?;
    let [first, later] = facts.transcripts.as_deref()? else {
        return None;
    };
    let mixed = !facts.queries.as_deref()?.is_empty();
    let expected_influences = checked_scenario_query_influences(facts)?;
    if mixed && expected_influences.len() != 24 {
        return None;
    }
    if checked_created_model_result(ir, owner).is_none()
        || first.id == later.id
        || first.call.end > later.call.start
        || first.parameter != later.parameter
        || first.derive != later.derive
        || first.query != later.query
        || first.source != checked.source
        || later.source != checked.source
        || plan.version != 1
        || plan.queries.len() != if mixed { 6 } else { 2 }
        || plan.returns.len() != returned_paths.len()
        || serde_json::to_value(&plan.source).ok()?
            != serde_json::to_value(transport_source(&checked.source, entry)?).ok()?
    {
        return None;
    }
    if mixed {
        let [any, ancestor, first, count] = facts.queries.as_deref()? else {
            return None;
        };
        let expected_any = checked_native_any_query_plan(ir, owner, any, db, entry)?;
        let expected_ancestor = checked_native_count_query_plan(ir, owner, ancestor, db, entry)?;
        let expected_first =
            checked_native_first_query_source_plan(ir, owner, checked, first, entry, db)?;
        let expected_count = checked_native_count_query_plan(ir, owner, count, db, entry)?;
        for (actual, expected) in [
            (1, &expected_any),
            (2, expected_ancestor.queries.first()?),
            (3, expected_first.queries.first()?),
            (5, expected_count.queries.first()?),
        ] {
            if serde_json::to_value(&plan.queries[actual]).ok()?
                != serde_json::to_value(expected).ok()?
            {
                return None;
            }
        }
    }
    let mut influences = Vec::new();
    for (fact, query) in [first, later]
        .into_iter()
        .zip([&plan.queries[0], &plan.queries[if mixed { 4 } else { 1 }]])
    {
        let model = ir.items.get(fact.model.0 as usize)?;
        let branch = ir.items.get(fact.branch.0 as usize)?;
        let parameter = ir.items.get(fact.parameter.0 as usize)?;
        let parent = query.parent.as_ref()?;
        let ReceiptQueryParentOrigin::AdmittedReference {
            parameter: selected,
        } = &parent.origin
        else {
            return None;
        };
        if query.id != fact.id
            || query.model != model.canonical
            || parent.model != branch.canonical
            || selected != &parameter.name
            || query.limit.is_some()
            || query.archived != "exclude"
            || query.order.len() != 1
            || query.order[0].field != fact.order_dependency.field_name
            || query.order[0].direction != "asc"
            || fact.query_dependencies.len() != 3
            || fact.dependencies.len() != 3
            || query.dependencies.len() != 4
            || fact.influences.len() != 4
            || serde_json::to_value(&query.source).ok()?
                != serde_json::to_value(transport_source(&fact.source, entry)?).ok()?
            || serde_json::to_value(&parent.source).ok()?
                != serde_json::to_value(&query.source).ok()?
        {
            return None;
        }
        for (original, actual) in std::iter::once(&fact.order_dependency)
            .chain(&fact.query_dependencies)
            .zip(&query.dependencies)
        {
            let role = match original.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            if original.id != actual.id
                || original.field_name != actual.field
                || original.type_id != actual.type_id
                || role != actual.role
                || serde_json::to_value(&actual.source).ok()?
                    != serde_json::to_value(transport_source(&original.source, entry)?).ok()?
            {
                return None;
            }
        }
        influences.extend(fact.influences.iter().cloned());
    }
    if mixed {
        influences = expected_influences;
    }
    for (returned, actual) in returned_paths.iter().zip(&plan.returns) {
        if returned.influences != influences
            || actual.id != returned.id
            || actual.dependencies.len() != returned.dependencies.len()
            || actual.projection.is_some()
            || actual.influences.len() != influences.len()
            || serde_json::to_value(&actual.source).ok()?
                != serde_json::to_value(transport_source(&returned.source, entry)?).ok()?
        {
            return None;
        }
        for (read, emitted) in returned.dependencies.iter().zip(&actual.dependencies) {
            let role = match read.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            if emitted.id != read.id
                || emitted.model != read.model_name
                || emitted.field != read.field_name
                || emitted.type_id != read.type_id
                || emitted.role != role
                || emitted.query_id != read.query_id
                || serde_json::to_value(&emitted.source).ok()?
                    != serde_json::to_value(transport_source(&read.source, entry)?).ok()?
            {
                return None;
            }
        }
        for (original, emitted) in influences.iter().zip(&actual.influences) {
            let kind = match original.kind {
                InfluenceKind::QueryExistence => "query-existence",
                InfluenceKind::QueryCardinality => "query-cardinality",
                InfluenceKind::QueryMembership => "query-membership",
                InfluenceKind::QueryOrder => "query-order",
                InfluenceKind::AbsentReference => return None,
            };
            if emitted.id != original.id
                || emitted.query_id != original.query_id
                || emitted.kind != kind
            {
                return None;
            }
        }
    }
    Some(plan)
}

fn checked_native_first_query_source_plan(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    entry_module: &str,
    db: &SourceDb,
) -> Option<ReceiptDisclosurePlan> {
    let facts = checked.source_facts.as_deref()?;
    let expected_influences = checked_scenario_query_influences(facts)?;
    if checked.returns.is_empty() {
        return None;
    }
    let first = query.first.as_ref()?;
    let [dependency] = query.dependencies.as_slice() else {
        return None;
    };
    let [order] = query.order.as_slice() else {
        return None;
    };
    if checked_created_model_result(ir, owner).is_none()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.source != checked.source
        || checked.returns.iter().any(|returned| {
            returned.source != checked.source
                || query.return_node != returned.node
                || returned.influences != expected_influences
        })
        || query.id.is_empty()
        || first.binding.kind != SyntaxKind::Let as u8
        || query.limit.is_some()
        || query.archived
        || !query.inputs.is_empty()
        || order.field.is_some()
        || order.field_name != "id"
        || order.descending
        || dependency.id.is_empty()
        || dependency.source != query.source
        || dependency.model != query.model
        || dependency.model_name != query.model_name
        || dependency.field_name != "account"
        || dependency.type_id != "user"
        || dependency.ty != ResolvedType::Scalar(Scalar::User)
        || dependency.role != DependencyRole::Control
        || !dependency.calls.is_empty()
        || query.influences.len() != 4
    {
        return None;
    }
    // Retain exact source and declaration membership even when the selected
    // row is not an original parameter or the model being returned.
    let model = checked_first_query_schema(ir, owner, query, db)?;
    if !model.fields.iter().any(|field| {
        field.id == dependency.field && field.name == "account" && field.ty == dependency.ty
    }) {
        return None;
    }
    let kinds = [
        InfluenceKind::QueryExistence,
        InfluenceKind::QueryCardinality,
        InfluenceKind::QueryMembership,
        InfluenceKind::QueryOrder,
    ];
    let mut ids = HashSet::new();
    let influences = query
        .influences
        .iter()
        .zip(kinds)
        .map(|(influence, expected)| {
            if influence.id.is_empty()
                || !ids.insert(influence.id.as_str())
                || influence.source != query.source
                || influence.node != query.node
                || influence.kind != expected
                || influence.query_id.as_deref() != Some(query.id.as_str())
            {
                return None;
            }
            Some(ReceiptInfluence {
                id: influence.id.clone(),
                query_id: influence.query_id.clone(),
                kind: match expected {
                    InfluenceKind::QueryExistence => "query-existence",
                    InfluenceKind::QueryCardinality => "query-cardinality",
                    InfluenceKind::QueryMembership => "query-membership",
                    InfluenceKind::QueryOrder => "query-order",
                    _ => return None,
                }
                .into(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let expected = ReceiptDisclosurePlan {
        version: 1,
        source: transport_source(&checked.source, entry_module)?,
        queries: vec![ReceiptQuery {
            id: query.id.clone(),
            source: transport_source(&query.source, entry_module)?,
            model: query.model_name.clone(),
            parent: None,
            order: vec![ReceiptQueryOrder {
                field: "id".into(),
                direction: "asc".into(),
            }],
            limit: None,
            archived: "exclude".into(),
            dependencies: vec![ReceiptQueryDependency {
                id: dependency.id.clone(),
                source: transport_source(&dependency.source, entry_module)?,
                role: ReceiptRole::Control,
                field: dependency.field_name.clone(),
                type_id: "user".into(),
            }],
        }],
        returns: checked
            .returns
            .iter()
            .map(|returned| {
                Some(ReceiptReturn {
                    id: returned.id.clone(),
                    source: transport_source(&returned.source, entry_module)?,
                    influences: influences.clone(),
                    dependencies: Vec::new(),
                    intrinsics: Vec::new(),
                    projection: None,
                })
            })
            .collect::<Option<Vec<_>>>()?,
    };
    Some(expected)
}

fn checked_first_query_schema<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.id == query.model);
    let schema = schemas.next()?;
    if schemas.next().is_some()
        || !schema.model
        || schema.module != owner.module
        || schema.canonical != query.model_name
        || schema.source != query.source
        || schema.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "id")
        })
    {
        return None;
    }
    match_stored_contract_schema(ir, schema, db)?;
    for field in &schema.fields {
        match_stored_contract_field(ir, field, db)?;
    }
    Some(schema)
}

/// The released contained COUNT selector is the original required singular
/// parent parameter. No aliases, nullable references or stored-path selectors
/// enter this finite producer.
fn checked_count_query_parent<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
) -> Option<&'a IrItem> {
    let count = query.count.as_ref()?;
    let (receiver, parameter_id) = count.contained_parent?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let parameter = ir.items.get(parameter_id.0 as usize)?;
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol: parent_id,
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
    let fact = facts.parameters.get(*index)?;
    let child = checked_first_query_schema(ir, owner, query, db)?;
    let mut parents = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == *parent_id);
    let parent = parents.next()?;
    let source_receiver = checked_effect_node(ir, owner, receiver, db)?;
    let authored_parameter = checked_effect_node(ir, owner, fact.node, db)?;
    let parameter_name = authored_parameter
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    let text = &db.get(receiver.file)?.text;
    if parents.next().is_some()
        || parameter.id != parameter_id
        || *parameter_owner != owner.id
        || params.get(*index) != Some(&parameter_id)
        || params.iter().filter(|id| **id == parameter_id).count() != 1
        || fact.parameter != parameter_id
        || fact.ty
            != (ResolvedType::Record {
                symbol: *parent_id,
                stored: true,
            })
        || fact.default.is_some()
        || fact.constraints.is_some()
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
        || parameter.span != parameter_name.span
        || parameter_name.token()?.text(text) != parameter.name
        || source_receiver.kind != SyntaxKind::NameRef
        || text.get(receiver.start as usize..receiver.end as usize)? != parameter.name
        || child.parent != Some(*parent_id)
        || child.owner != Some(crate::analysis::resolve::ModelOwner::ChildOf(*parent_id))
        || parent.source != query.source
        || parent.module != owner.module
        || parent.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == ir.items[query.model.0 as usize].name)
        })
        || child.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "parent")
        })
    {
        return None;
    }
    match_stored_contract_schema(ir, parent, db)?;
    for field in &parent.fields {
        match_stored_contract_field(ir, field, db)?;
    }
    Some(parameter)
}

/// Match the actual original COUNT call to its true contained Member. The
/// synthetic IR Query deliberately has no fabricated alias, predicate or CST
/// Query fact; its original Member, parent binding and type census own it.
pub(super) fn checked_count_query_ir<'a>(
    ir: &'a IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    use crate::analysis::NodeKey;
    let mut owners = ir.items.iter().filter(|owner| {
        matches!(owner.kind, IrItemKind::Scenario { .. })
            && ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|facts| {
                    facts.source == original.source
                        && facts.creates.as_deref().is_some_and(|creates| {
                            creates.iter().any(|created| created.node == original.node)
                        })
                })
    });
    let owner = owners.next()?;
    if owners.next().is_some() {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries)?;
    let mut selected = queries
        .iter()
        .filter(|query| query.count.as_ref().is_some_and(|count| count.call == node));
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    let count = query.count.as_ref()?;
    if count.contained_parent.is_none() {
        let (call, _, _) = checked_ancestor_count_query_operands(ir, owner, query, db)?;
        return (count.call == node && std::ptr::eq(call, actual)).then_some(query);
    }
    let (receiver, _) = count.contained_parent?;
    let (target, args, slots) = match &actual.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let parent = scan.parent.as_deref()?;
    let parameter = checked_count_query_parent(ir, owner, query, db)?;
    let IrItemKind::Param {
        ty: IrType::Known(parent_type),
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let array = ResolvedType::Array {
        element: Box::new(ResolvedType::Record {
            symbol: query.model,
            stored: true,
        }),
        ordered: true,
        nonempty: false,
    };
    if !matches!(target, IrCallTarget::Builtin {id, awaited:false} if id == "count")
        || count.call != node
        || count.slots.as_slice() != [Some(0)]
        || slots.is_some_and(|slots| slots != count.slots.as_slice())
        || count.statement != original.node
        || original.model != query.model
        || (checked_created_model_result(ir, owner) != Some(original.model)
            && checked_created_pair(ir, owner, db)?.1.node != original.node)
        || actual.span != node_span(node)
        || actual.ty != ResolvedType::Scalar(Scalar::Int)
        || domain.ty != array
        || query.source != original.source
        || query.domain != query.node
        || query.node.kind != SyntaxKind::Member as u8
        || query.alias.is_some()
        || query.predicate.is_some()
        || query.first.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.limit.is_some()
        || query.archived
        || !query.order.is_empty()
        || !query.dependencies.is_empty()
        || !count.parent_edges.is_empty()
        || query.inputs.as_slice() != [count.contained_parent?]
        || scan.source.is_some()
        || scan.collection_call.is_some()
        || scan.contract_collection_call.is_some()
        || !matches!(&scan.domain, super::ir::IrQueryDomain::Model(name) if name == &query.model_name)
        || scan.where_pred.is_some()
        || scan.where_async
        || !scan.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.select.is_some()
        || scan.select_param.is_some()
        || parent.span != node_span(receiver)
        || &parent.ty != parent_type
        || !matches!(&parent.expr, IrExpr::Name(name) if name == &parameter.name)
    {
        return None;
    }
    let census = facts.expression_types.as_deref()?;
    if !census
        .iter()
        .any(|(at, ty)| *at == node && ty == &actual.ty)
        || !census
            .iter()
            .any(|(at, ty)| *at == receiver && ty == &parent.ty)
    {
        return None;
    }
    let authored = checked_effect_node(ir, owner, node, db)?;
    let text = &db.get(node.file)?.text;
    let mut arguments = authored
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Argument);
    let argument = arguments.next()?;
    if arguments.next().is_some() {
        return None;
    }
    let mut values = argument
        .children
        .iter()
        .filter(|node| matches!(node.kind, SyntaxKind::Group | SyntaxKind::Member));
    let mut source_domain = values.next()?;
    if values.next().is_some() || source_domain.span != domain.span {
        return None;
    }
    for _ in 0..=64 {
        if !census
            .iter()
            .any(|(at, ty)| *at == NodeKey::of(source_domain) && ty == &domain.ty)
        {
            return None;
        }
        if source_domain.kind != SyntaxKind::Group {
            break;
        }
        let mut grouped = source_domain
            .children
            .iter()
            .filter(|node| matches!(node.kind, SyntaxKind::Group | SyntaxKind::Member));
        source_domain = grouped.next()?;
        if grouped.next().is_some() {
            return None;
        }
    }
    let mut heads = authored
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::NameRef);
    let head = heads.next()?;
    let member_name = source_domain
        .children
        .iter()
        .rev()
        .find(|node| node.kind == SyntaxKind::Name)?;
    let mut receivers = source_domain
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::NameRef);
    if heads.next().is_some()
        || text.get(head.span.start as usize..head.span.end as usize)? != "count"
        || NodeKey::of(source_domain) != query.node
        || member_name.token()?.text(text) != ir.items.get(query.model.0 as usize)?.name
        || NodeKey::of(receivers.next()?) != receiver
        || receivers.next().is_some()
    {
        return None;
    }
    Some(query)
}

/// The source-owned ancestor count is the original leading Require. Its two
/// ordinary reads occur inside the actual predicate, never at the root stage.
fn checked_ancestor_count_query_operands<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
) -> Option<(&'a TypedExpr, &'a TypedExpr, &'a TypedExpr)> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries)?;
    let (owning, created) = match queries {
        [owning] => {
            let [created] = facts.creates.as_deref()? else {
                return None;
            };
            (owning, created)
        }
        [owning, _, _] => (owning, checked_created_pair(ir, owner, db)?.0),
        [_, owning, _, _] if facts.transcripts.as_deref()?.len() == 2 => {
            (owning, checked_created_pair(ir, owner, db)?.0)
        }
        _ => return None,
    };
    let count = query.count.as_ref()?;
    let [_, candidate, supplied] = count.parent_edges.as_slice() else {
        return None;
    };
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario { guards, .. } = &owner.kind else {
        return None;
    };
    let mut matching = guards.iter().filter(|statement|
        matches!(statement, IrStmt::Require {span, ..} if *span == node_span(count.statement)));
    let IrStmt::Require { cond, .. } = matching.next()? else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Lt,
        left: call,
        right: bound,
    } = &cond.expr
    else {
        return None;
    };
    let arguments = match &call.expr {
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => args,
        _ => return None,
    };
    let [domain] = arguments.as_slice() else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let predicate = scan.where_pred.as_deref()?;
    let IrExpr::Binary {
        op: IrBinOp::And,
        left: equality,
        ..
    } = &predicate.expr
    else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left: actual_candidate,
        right: actual_supplied,
    } = &equality.expr
    else {
        return None;
    };
    if matching.next().is_some()
        || owning != query
        || count.contained_parent.is_some()
        || count.statement.kind != SyntaxKind::Require as u8
        || count.statement.end > created.node.start
        || created.model != query.model
        || created.source != query.source
        || checked_created_model_result(ir, owner) != Some(created.model)
        || cond.ty != ResolvedType::Scalar(Scalar::Bool)
        || bound.ty != ResolvedType::Scalar(Scalar::Int)
        || !matches!(bound.expr, IrExpr::Int(10))
        || call.span != node_span(count.call)
    {
        return None;
    }
    checked_native_query_influences(facts.queries.as_deref()?)?;
    let returned = proof.returns.first()?;
    for (edge, actual) in [
        (candidate, actual_candidate.as_ref()),
        (supplied, actual_supplied.as_ref()),
    ] {
        let mut reads = returned
            .dependencies
            .iter()
            .filter(|read| read.node == edge.node);
        let read = reads.next()?;
        if reads.next().is_some() {
            return None;
        }
        checked_candidate_parent_association(ir, owner, read, actual, db)?;
    }
    let census = facts.expression_types.as_deref()?;
    let authored_guard = checked_effect_node(ir, owner, count.statement, db)?;
    let source_condition = authored_guard
        .children
        .iter()
        .find(|node| matches!(node.kind, SyntaxKind::Binary | SyntaxKind::Group))?;
    if cond.span != source_condition.span
        || census
            .iter()
            .find(|(node, _)| node_span(*node) == cond.span)?
            .1
            != cond.ty
        || census
            .iter()
            .find(|(node, _)| node_span(*node) == bound.span)?
            .1
            != bound.ty
    {
        return None;
    }
    for id in [query.model, candidate.child, candidate.parent] {
        let mut schemas = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.id == id);
        let schema = schemas.next()?;
        if schemas.next().is_some() || schema.source != query.source {
            return None;
        }
        match_stored_contract_schema(ir, schema, db)?;
        for field in &schema.fields {
            match_stored_contract_field(ir, field, db)?;
        }
    }
    Some((
        call.as_ref(),
        actual_candidate.as_ref(),
        actual_supplied.as_ref(),
    ))
}

fn checked_native_ancestor_count_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    checked_ancestor_count_query_operands(ir, owner, query, db)?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    let expected_influences = checked_scenario_query_influences(facts)?;
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    if queries.len() == 1 {
        let [created] = facts.creates.as_deref()? else {
            return None;
        };
        let IrItemKind::Scenario { effects, .. } = &owner.kind else {
            return None;
        };
        let mut statements = effects.iter().filter(|statement|
            matches!(statement, IrStmt::Create {span,..} if *span == node_span(created.node)));
        let statement = statements.next()?;
        let mut creates = proof
            .effects
            .iter()
            .filter(|effect| effect.node == created.node);
        let create = creates.next()?;
        if statements.next().is_some() || creates.next().is_some() {
            return None;
        }
        let models = super::js::Emitter::source_models(ir, db)?;
        checked_scenario_create(ir, owner, &models, proof, create, statement, db)?;
    }
    // In the triple, the owning contained-count plan and final effect
    // collector seal both constructors; ancestor operand validation does not
    // recurse into their complete query plan or repeat constructor admission.
    let kinds = [
        InfluenceKind::QueryExistence,
        InfluenceKind::QueryCardinality,
        InfluenceKind::QueryMembership,
        InfluenceKind::QueryOrder,
    ];
    let influences = query
        .influences
        .iter()
        .zip(kinds)
        .map(|(influence, kind)| {
            if influence.kind != kind {
                return None;
            }
            Some(ReceiptInfluence {
                id: influence.id.clone(),
                query_id: influence.query_id.clone(),
                kind: match kind {
                    InfluenceKind::QueryExistence => "query-existence",
                    InfluenceKind::QueryCardinality => "query-cardinality",
                    InfluenceKind::QueryMembership => "query-membership",
                    InfluenceKind::QueryOrder => "query-order",
                    _ => return None,
                }
                .into(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    if proof.returns.is_empty()
        || proof.returns.iter().any(|returned| {
            returned.node != query.return_node
                || returned.source != query.source
                || returned.influences != expected_influences
                || returned.model_result.is_none()
        })
    {
        return None;
    }
    Some(ReceiptDisclosurePlan {
        version: 1,
        source: transport_source(&query.source, entry)?,
        queries: vec![ReceiptQuery {
            id: query.id.clone(),
            source: transport_source(&query.source, entry)?,
            model: query.model_name.clone(),
            parent: None,
            order: Vec::new(),
            limit: None,
            archived: "exclude".into(),
            dependencies: query
                .dependencies
                .iter()
                .map(|read| {
                    Some(ReceiptQueryDependency {
                        id: read.id.clone(),
                        source: transport_source(&read.source, entry)?,
                        role: ReceiptRole::Control,
                        field: read.field_name.clone(),
                        type_id: read.type_id.clone(),
                    })
                })
                .collect::<Option<Vec<_>>>()?,
        }],
        returns: proof
            .returns
            .iter()
            .map(|returned| {
                Some(ReceiptReturn {
                    id: returned.id.clone(),
                    source: transport_source(&returned.source, entry)?,
                    influences: influences.clone(),
                    dependencies: Vec::new(),
                    intrinsics: Vec::new(),
                    projection: None,
                })
            })
            .collect::<Option<Vec<_>>>()?,
    })
}

/// A bounded contained COUNT+1 Create uses the same prepared-query skeleton as
/// first. No runtime handle or parent authority is issued by this source join.
pub(super) fn checked_native_count_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    let count = query.count.as_ref()?;
    if count.contained_parent.is_none() {
        return checked_native_ancestor_count_query_plan(ir, owner, query, db, entry);
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let expected_influences = checked_scenario_query_influences(facts)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario {
        effects,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut creates = effects.iter().filter_map(|statement| match statement {
        IrStmt::Create { input, span, .. } if *span == node_span(count.statement) => {
            Some((input, span))
        }
        _ => None,
    });
    let (input, span) = creates.next()?;
    if creates.next().is_some() {
        return None;
    }
    let IrStmt::Return { span: returned, .. } = effects.last()? else {
        return None;
    };
    let originals = facts.creates.as_deref()?;
    let mut owning = originals
        .iter()
        .filter(|created| created.node == count.statement);
    let original = owning.next()?;
    if owning.next().is_some()
        || originals.is_empty()
        || originals.len() > 2
        || facts.queries.as_deref()?.len() >= 2 && originals.len() != 2
    {
        return None;
    }
    if originals.len() == 2 {
        checked_created_pair(ir, owner, db)?;
        let models = super::js::Emitter::source_models(ir, db)?;
        for created in originals {
            let proof = checked
                .effects
                .iter()
                .find(|proof| proof.node == created.node)?;
            let statement = effects.iter().find(|statement|
                matches!(statement, IrStmt::Create {span, ..} if *span == node_span(created.node)))?;
            checked_scenario_create(ir, owner, &models, checked, proof, statement, db)?;
        }
    }
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let mut operands = entries.iter().filter_map(|(_, value)| match &value.expr {
        IrExpr::Binary {
            op: IrBinOp::Add,
            left,
            right,
        } if matches!(right.expr, IrExpr::Int(1)) && left.span == node_span(count.call) => {
            Some(left.as_ref())
        }
        _ => None,
    });
    let operand = operands.next()?;
    if operands.next().is_some()
        || query.id.is_empty()
        || original.node != count.statement
        || *span != node_span(count.statement)
        || *returned != node_span(query.return_node)
        || checked.source != query.source
        || facts.source != query.source
        || checked.returns.is_empty()
        || checked.returns.iter().any(|returned| {
            returned.node != query.return_node
                || returned.source != query.source
                || returned.influences != expected_influences
                || returned.model_result.is_none()
        })
    {
        return None;
    }
    checked_count_query_ir(ir, original, operand, count.call, db)?;
    super::scenario_create_sources::checked_create_expression(
        ir, original, operand, count.call, db,
    )?;
    let parameter = checked_count_query_parent(ir, owner, query, db)?;
    let IrItemKind::Param {
        ty: IrType::Known(ResolvedType::Record {
            symbol: parent_id, ..
        }),
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let mut ids = HashSet::new();
    let kinds = [
        InfluenceKind::QueryExistence,
        InfluenceKind::QueryCardinality,
        InfluenceKind::QueryMembership,
        InfluenceKind::QueryOrder,
    ];
    if query.influences.len() != kinds.len() {
        return None;
    }
    let influences = query
        .influences
        .iter()
        .zip(kinds)
        .map(|(influence, kind)| {
            if influence.id.is_empty()
                || !ids.insert(influence.id.as_str())
                || influence.source != query.source
                || influence.node != query.node
                || influence.kind != kind
                || influence.query_id.as_deref() != Some(query.id.as_str())
            {
                return None;
            }
            Some(ReceiptInfluence {
                id: influence.id.clone(),
                query_id: influence.query_id.clone(),
                kind: match kind {
                    InfluenceKind::QueryExistence => "query-existence",
                    InfluenceKind::QueryCardinality => "query-cardinality",
                    InfluenceKind::QueryMembership => "query-membership",
                    InfluenceKind::QueryOrder => "query-order",
                    _ => return None,
                }
                .into(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ReceiptDisclosurePlan {
        version: 1,
        source: transport_source(&query.source, entry)?,
        queries: vec![ReceiptQuery {
            id: query.id.clone(),
            source: transport_source(&query.source, entry)?,
            model: query.model_name.clone(),
            parent: Some(ReceiptQueryParent {
                source: transport_source(&query.source, entry)?,
                model: ir.items.get(parent_id.0 as usize)?.canonical.clone(),
                origin: ReceiptQueryParentOrigin::AdmittedReference {
                    parameter: parameter.name.clone(),
                },
            }),
            order: Vec::new(),
            limit: None,
            archived: "exclude".into(),
            dependencies: Vec::new(),
        }],
        returns: checked
            .returns
            .iter()
            .map(|returned| {
                Some(ReceiptReturn {
                    id: returned.id.clone(),
                    source: transport_source(&returned.source, entry)?,
                    influences: influences.clone(),
                    dependencies: Vec::new(),
                    intrinsics: Vec::new(),
                    projection: None,
                })
            })
            .collect::<Option<Vec<_>>>()?,
    })
}

fn checked_first_query_row<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries)?;
    let mut selected = queries.iter().filter(|query| query.first.is_some());
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    let first = query.first.as_ref()?;
    let IrExpr::Name(name) = &value.expr else {
        return None;
    };
    let original = facts
        .creates
        .as_deref()?
        .iter()
        .find(|created| checked_created_model_result(ir, owner) == Some(created.model))?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let mut bindings = effects.iter().filter_map(|effect| match effect {
        IrStmt::Let {
            name: binding,
            value,
            span,
        } if *span == node_span(first.binding) => Some((binding, value)),
        _ => None,
    });
    let (binding, selected) = bindings.next()?;
    let authored = checked_effect_node(ir, owner, first.binding, db)?;
    let names: Vec<_> = authored
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .collect();
    let [keyword, source_binding] = names.as_slice() else {
        return None;
    };
    let text = &db.get(first.binding.file)?.text;
    if bindings.next().is_some()
        || keyword.token()?.text(text) != "let"
        || source_binding.token()?.text(text) != name
        || binding != name
        || first.binding.end > value.span.start
        || !facts.expression_types.as_deref()?.iter().any(|(node, ty)| {
            node_span(*node) == value.span
                && ty == &value.ty
                && (node.kind == SyntaxKind::Path as u8 || node.kind == SyntaxKind::NameRef as u8)
        })
    {
        return None;
    }
    created_record_name_matches(
        value,
        &ResolvedType::Record {
            symbol: query.model,
            stored: true,
        },
        name,
        value.span,
        db,
    )?;
    super::scenario_create_sources::checked_create_expression(
        ir, original, selected, first.call, db,
    )?;
    checked_first_query_schema(ir, owner, query, db)
}

/// Exact selected original first call; ordinary Query expressions stay outside
/// the native scalar visitor. The source operand matcher checks its CST too.
pub(super) fn checked_first_query_ir<'a>(
    ir: &'a IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let mut owners = ir.items.iter().filter(|owner| {
        matches!(owner.kind, IrItemKind::Scenario { .. })
            && ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|facts| {
                    facts.source == original.source
                        && facts.creates.as_deref().is_some_and(|creates| {
                            creates.iter().any(|created| created.node == original.node)
                        })
                })
    });
    let owner = owners.next()?;
    if owners.next().is_some() {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries)?;
    let mut selected = queries
        .iter()
        .filter(|query| query.first.as_ref().is_some_and(|first| first.call == node));
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    let first = query.first.as_ref()?;
    let source_alias = query.alias?;
    let source_predicate = query.predicate?;
    let IrExpr::Call {
        target: IrCallTarget::Builtin { id, awaited: false },
        args,
    } = &actual.expr
    else {
        return None;
    };
    let [domain] = args.as_slice() else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let source = scan.source.as_deref()?;
    let collection = scan.collection_call.as_deref()?;
    let record = ResolvedType::Record {
        symbol: query.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    let [alias, predicate, order] = source.clauses.as_slice() else {
        return None;
    };
    let [metadata_order] = query.order.as_slice() else {
        return None;
    };
    if id != "first"
        || first.call != node
        || actual.span != node_span(node)
        || actual.ty != ResolvedType::Nullable(Box::new(record))
        || domain.ty != array
        || query.source != original.source
        || query.count.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.limit.is_some()
        || query.archived
        || !query.inputs.is_empty()
        || source.node != query.node
        || source.domain != query.domain
        || source.domain_type != array
        || source.result != array
        || source.projection.is_some()
        || collection.node != first.call
        || collection.builtin != "first"
        || collection.overload != first.overload
        || collection.query != query.node
        || collection.alias != source_alias
        || collection.model != query.model
        || collection.predicate.is_some()
        || alias.node != source_alias
        || !matches!(&alias.kind,
            crate::analysis::types::CheckedQueryClauseKind::As {name} if !name.is_empty())
        || !alias.expressions.is_empty()
        || predicate.kind != crate::analysis::types::CheckedQueryClauseKind::Where
        || predicate.expressions.as_slice() != [source_predicate]
        || order.kind != crate::analysis::types::CheckedQueryClauseKind::Order
        || order.expressions.as_slice() != [metadata_order.node]
        || metadata_order.field.is_some()
        || metadata_order.field_name != "id"
        || metadata_order.descending
        || !matches!(&scan.domain, super::ir::IrQueryDomain::Model(model) if model == &query.model_name)
        || scan.parent.is_some()
        || scan.where_async
        || scan.select.is_some()
        || scan.select_param.is_some()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.contract_collection_call.is_some()
        || scan.order.len() != 1
        || scan.order[0].field != "id"
        || scan.order[0].descending
        || scan.where_pred.as_ref().is_none_or(|predicate| {
            predicate.span != node_span(source_predicate)
                || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        })
    {
        return None;
    }
    checked_first_query_schema(ir, owner, query, db)?;
    Some(query)
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
    let (base, model_return) = match &value.expr {
        IrExpr::Member { base, field }
            if field == "id" && value.ty == ResolvedType::Scalar(Scalar::Text) =>
        {
            (base.as_ref(), false)
        }
        IrExpr::Name(_) if matches!(value.ty, ResolvedType::Record { stored: true, .. }) => {
            (value, true)
        }
        _ => return None,
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
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
        || !model_return && !reference_read_matches(ir, owner, value, *symbol, *symbol, "text")
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
            kind: if model_return {
                SyntaxKind::NameRef as u8
            } else {
                SyntaxKind::Member as u8
            },
        },
        db,
    )?;
    let parts: Vec<_> = authored
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    if !model_return {
        let [receiver, dot, member] = parts.as_slice() else {
            return None;
        };
        if receiver.kind != SyntaxKind::NameRef
            || receiver.span != base.span
            || dot.token()?.text(text) != "."
            || member.kind != SyntaxKind::Name
            || member.token()?.text(text) != "id"
        {
            return None;
        }
    } else if authored.kind != SyntaxKind::NameRef || authored.span != base.span {
        return None;
    }
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
    if text
        .get(base.span.start as usize..base.span.end as usize)
        .map(|value| if model_return { value.trim() } else { value })
        != Some(name.as_str())
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
    let generated = super::js::Emitter::source_models(ir, db)?;
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
/// The two ordinary Branch.parent reads inside the original unscoped Run
/// predicate are candidate-exclusive. This checks their real IR occurrences;
/// the optional association neither fabricates a read nor completes a query.
fn checked_candidate_parent_association<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    dependency: &crate::analysis::scenario_disclosure::DisclosureDependency,
    expression: &TypedExpr,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a str,
)> {
    use crate::analysis::types::CheckedQueryClauseKind;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let query_id = dependency.query_id.as_deref()?;
    let mut matching = facts
        .queries
        .as_deref()?
        .iter()
        .filter(|query| query.id == query_id);
    let query = matching.next()?;
    let count = query.count.as_ref()?;
    let [first, candidate, supplied] = count.parent_edges.as_slice() else {
        return None;
    };
    let [input] = query.inputs.as_slice() else {
        return None;
    };
    let IrItemKind::Scenario {
        params,
        guards,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut statements = guards.iter().filter(|statement|
        matches!(statement, IrStmt::Require {span,..} if *span == node_span(count.statement)));
    let IrStmt::Require { cond, .. } = statements.next()? else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Lt,
        left: call,
        right: bound,
    } = &cond.expr
    else {
        return None;
    };
    let (target, args, slots) = match &call.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let original = scan.source.as_deref()?;
    let collection = scan.collection_call.as_deref()?;
    let [alias, clause] = original.clauses.as_slice() else {
        return None;
    };
    let CheckedQueryClauseKind::As { name: source_alias } = &alias.kind else {
        return None;
    };
    let predicate = scan.where_pred.as_deref()?;
    let IrExpr::Binary {
        op: IrBinOp::And,
        left: equality,
        right: unfinished,
    } = &predicate.expr
    else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left: actual_candidate,
        right: actual_supplied,
    } = &equality.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: first_parent,
        field: candidate_field,
    } = &actual_candidate.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: row,
        field: first_field,
    } = &first_parent.expr
    else {
        return None;
    };
    let IrExpr::Name(row_name) = &row.expr else {
        return None;
    };
    let IrExpr::Member {
        base: parameter_expr,
        field: supplied_field,
    } = &actual_supplied.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: unfinished_row,
        field: unfinished_field,
    } = &unfinished.expr
    else {
        return None;
    };
    let parameter = ir.items.get(input.1.0 as usize)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty: IrType::Known(parameter_type),
        default: None,
        default_node: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let record = ResolvedType::Record {
        symbol: query.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    let edge = if std::ptr::eq(expression, actual_candidate.as_ref()) {
        candidate
    } else if std::ptr::eq(expression, actual_supplied.as_ref()) {
        supplied
    } else {
        return None;
    };
    let [parent_control, unfinished_control] = query.dependencies.as_slice() else {
        return None;
    };
    let model_schema = checked_first_query_schema(ir, owner, query, db)?;
    let unfinished_schema = model_schema
        .fields
        .iter()
        .find(|field| field.name == "unfinished")?;
    let census = facts.expression_types.as_deref()?;
    let source_text = &db.get(query.node.file)?.text;
    let source_name = |expression: &TypedExpr, expected: &str| {
        source_text
            .get(expression.span.start as usize..expression.span.end as usize)
            .is_some_and(|text| text.trim() == expected)
    };
    if matching.next().is_some()
        || statements.next().is_some()
        || facts
            .queries
            .as_deref()?
            .iter()
            .filter(|other| {
                other.count.as_ref().is_some_and(|other| {
                    other.call == count.call || other.statement == count.statement
                })
            })
            .count()
            != 1
        || query_id.is_empty()
        || count.contained_parent.is_some()
        || query.first.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.limit.is_some()
        || query.archived
        || !query.order.is_empty()
        || query.source != proof.source
        || dependency.source != query.source
        || dependency.node != edge.node
        || dependency.field != edge.child
        || dependency.model != edge.child
        || dependency.field_name != "parent"
        || dependency.role != DependencyRole::Control
        || !dependency.calls.is_empty()
        || expression.span != node_span(edge.node)
        || first.child != query.model
        || first.parent != candidate.child
        || model_schema.parent != Some(first.parent)
        || parent_control.node != first.node
        || parent_control.model != first.child
        || parent_control.field != first.child
        || parent_control.field_name != "parent"
        || parent_control.model_name != query.model_name
        || parent_control.ty
            != (ResolvedType::Record {
                symbol: first.parent,
                stored: true,
            })
        || parent_control.type_id != ir.items.get(first.parent.0 as usize)?.canonical
        || unfinished_control.node
            != crate::analysis::NodeKey::of(&checked_effect_node(
                ir,
                owner,
                unfinished_control.node,
                db,
            )?)
        || node_span(unfinished_control.node) != unfinished.span
        || unfinished_control.model != query.model
        || unfinished_control.field != unfinished_schema.id
        || unfinished_control.field_name != "unfinished"
        || unfinished_control.model_name != query.model_name
        || unfinished_control.ty != ResolvedType::Scalar(Scalar::Bool)
        || unfinished_control.type_id != "bool"
        || [parent_control, unfinished_control].iter().any(|read| {
            read.id.is_empty()
                || read.source != query.source
                || !read.calls.is_empty()
                || read.role != DependencyRole::Control
                || read.query_id.is_some()
        })
        || supplied.child != candidate.child
        || supplied.parent != candidate.parent
        || first.node != candidate.receiver
        || supplied.receiver != input.0
        || candidate_field != "parent"
        || first_field != "parent"
        || supplied_field != "parent"
        || first_parent.span != node_span(first.node)
        || row.span != node_span(first.receiver)
        || actual_candidate.span != node_span(candidate.node)
        || actual_supplied.span != node_span(supplied.node)
        || parameter_expr.span != node_span(input.0)
        || *parameter_owner != owner.id
        || params.get(*index) != Some(&input.1)
        || parameter.id != input.1
        || parameter.module != owner.module
        || parameter_type != &first_parent.ty
        || parameter_expr.ty != *parameter_type
        || !matches!(&parameter_expr.expr,IrExpr::Name(name) if name == &parameter.name)
        || facts.parameters.get(*index)?.parameter != parameter.id
        || facts.parameters.get(*index)?.default.is_some()
        || !matches!(target,super::ir::IrCallTarget::Builtin {id,awaited:false} if id == "count")
        || count.slots != [Some(0)]
        || slots.is_some_and(|slots| slots != [Some(0)])
        || call.span != node_span(count.call)
        || call.ty != ResolvedType::Scalar(Scalar::Int)
        || !matches!(bound.expr, IrExpr::Int(10))
        || bound.ty != ResolvedType::Scalar(Scalar::Int)
        || cond.ty != ResolvedType::Scalar(Scalar::Bool)
        || domain.ty != array
        || domain.span != node_span(query.node)
        || original.node != query.node
        || original.domain != query.domain
        || original.domain_type != array
        || original.result != array
        || original.projection.is_some()
        || collection.node != count.call
        || collection.builtin != "count"
        || collection.overload != count.overload
        || collection.query != query.node
        || collection.model != query.model
        || Some(collection.alias) != query.alias
        || collection.predicate.is_some()
        || Some(alias.node) != query.alias
        || row_name != "row"
        || !alias.expressions.is_empty()
        || clause.kind != CheckedQueryClauseKind::Where
        || clause.expressions.as_slice() != [query.predicate?]
        || predicate.span != node_span(query.predicate?)
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        || equality.ty != ResolvedType::Scalar(Scalar::Bool)
        || row.ty != record
        || unfinished_row.ty != record
        || !matches!(&unfinished_row.expr,IrExpr::Name(name) if name == row_name)
        || !source_name(row, source_alias)
        || !source_name(unfinished_row, source_alias)
        || !source_name(parameter_expr, &parameter.name)
        || unfinished_field != "unfinished"
        || unfinished.ty != ResolvedType::Scalar(Scalar::Bool)
        || scan.parent.is_some()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.select.is_some()
        || scan.select_param.is_some()
        || !scan.order.is_empty()
        || scan.contract_collection_call.is_some()
        || scan.where_async
        || !matches!(&scan.domain,super::ir::IrQueryDomain::Model(name) if name == &query.model_name)
        || proof.returns.is_empty()
        || proof.returns.iter().any(|returned| {
            returned.source != query.source
                || returned.node != query.return_node
                || query.influences.len() != 4
                || query.influences.iter().any(|influence| {
                    influence.query_id.as_deref() != Some(query_id)
                        || !returned.influences.contains(influence)
                })
                || !returned.dependencies.iter().any(|read| read == dependency)
        })
        || [
            call.as_ref(),
            domain,
            predicate,
            equality.as_ref(),
            actual_candidate.as_ref(),
            actual_supplied.as_ref(),
            first_parent.as_ref(),
            row.as_ref(),
            parameter_expr.as_ref(),
            unfinished.as_ref(),
            unfinished_row.as_ref(),
        ]
        .iter()
        .any(|expression| {
            !census
                .iter()
                .any(|(node, ty)| node_span(*node) == expression.span && ty == &expression.ty)
        })
    {
        return None;
    }
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.id == edge.child);
    let child = schemas.next()?;
    let mut parents = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.id == edge.parent);
    let parent = parents.next()?;
    if schemas.next().is_some()
        || parents.next().is_some()
        || child.parent != Some(parent.id)
        || child.owner != Some(crate::analysis::resolve::ModelOwner::ChildOf(parent.id))
        || child.canonical != dependency.model_name
        || parent.canonical != dependency.type_id
        || dependency.ty
            != (ResolvedType::Record {
                symbol: parent.id,
                stored: true,
            })
        || expression.ty != dependency.ty
        || child.source != query.source
        || parent.source != query.source
        || child.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "parent")
        })
    {
        return None;
    }
    match_stored_contract_schema(ir, child, db)?;
    match_stored_contract_schema(ir, parent, db)?;
    checked_effect_node(ir, owner, count.call, db)?;
    checked_effect_node(ir, owner, dependency.node, db)?;
    let authored_alias = checked_effect_node(ir, owner, alias.node, db)?;
    let alias_names = authored_alias
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .map(|node| node.token().map(|token| token.text(source_text)))
        .collect::<Option<Vec<_>>>()?;
    if alias_names != ["as", source_alias.as_str()] {
        return None;
    }
    Some((child, parent, query.id.as_str()))
}

#[cfg(test)]
#[path = "scenario_parent_association_tests.rs"]
mod parent_association_tests;

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

/// The original attachment CALL reads an ordinary owning File array once.
/// This joins source/dependency identity only; Files supplies live authority.
pub(super) fn stored_file_array_operand<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    use crate::analysis::NodeKey;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = &base.ty
    else {
        return None;
    };
    if !matches!(&value.ty, ResolvedType::Array { element, ordered: true, nonempty: false }
        if **element == ResolvedType::Scalar(Scalar::File))
    {
        return None;
    }
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut parameters = params
        .iter()
        .enumerate()
        .filter_map(|(index, id)| Some((index, ir.items.get(id.0 as usize)?)))
        .filter(|(_, parameter)| parameter.name == *name);
    let (position, parameter) = parameters.next()?;
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
    let fact = source.parameters.get(position)?;
    let module = ir.modules.get(owner.module.0 as usize)?;
    let text = &db.get(source.node.file)?.text;
    if parameters.next().is_some()
        || *parent != owner.id
        || *index != position
        || parameter.id != fact.parameter
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, name)
        || owner.canonical != format!("{}.{}", module.name, owner.name)
        || ty != &base.ty
        || fact.ty != base.ty
        || fact.default.is_some()
        || fact.constraints.is_some()
        || text.get(base.span.start as usize..base.span.end as usize)? != name
        || text.get(parameter.span.start as usize..parameter.span.end as usize)? != name
    {
        return None;
    }
    let key = NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: SyntaxKind::Member as u8,
    };
    let authored = checked_effect_node(ir, owner, key, db)?;
    let parts: Vec<_> = authored
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    let [receiver, dot, member] = parts.as_slice() else {
        return None;
    };
    let census = source.expression_types.as_deref()?;
    if receiver.kind != SyntaxKind::NameRef
        || receiver.span != base.span
        || dot.token()?.text(text) != "."
        || member.kind != SyntaxKind::Name
        || member.token()?.text(text) != field
        || census.iter().find(|(node, _)| *node == key)?.1 != value.ty
        || census
            .iter()
            .find(|(node, _)| *node == NodeKey::of(receiver))?
            .1
            != base.ty
    {
        return None;
    }
    let mut schemas = source
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == *symbol);
    let schema = schemas.next()?;
    if schemas.next().is_some() {
        return None;
    }
    match_stored_contract_schema(ir, schema, db)?;
    let mut fields = schema
        .fields
        .iter()
        .filter(|original| original.name == *field);
    let original = fields.next()?;
    let declaration = ir.items.get(original.id.0 as usize)?;
    let IrItemKind::Field {
        default: None,
        server: None,
        modifiers,
        ..
    } = &declaration.kind
    else {
        return None;
    };
    if fields.next().is_some()
        || original.owner != *symbol
        || original.ty != value.ty
        || original.declared != "file[]"
        || original.required_array
        || original.reuse.is_some()
        || original.trim
        || original.min.is_some()
        || original.max.as_ref().map(|(_, max, _)| *max) != Some(8)
        || original
            .constraints
            .as_ref()
            .is_some_and(|constraints| constraints.alias.is_some())
        || modifiers.machine
        || modifiers.unique
        || !reference_read_matches(ir, owner, value, schema.id, original.id, "file[]")
    {
        return None;
    }
    match_stored_contract_field(ir, original, db)?;
    Some(original)
}

pub(super) fn stored_file_array_descriptor_matches(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    descriptor: &JsModelField,
) -> bool {
    let Some(owner) = ir.items.get(original.owner.0 as usize) else {
        return false;
    };
    let generated = super::js::Emitter::new(ir).collect_models();
    let mut models = generated
        .iter()
        .filter(|model| model.name == owner.canonical);
    let Some(model) = models.next() else {
        return false;
    };
    let mut fields = model
        .fields
        .iter()
        .filter(|field| field.name == original.name);
    let Some(expected) = fields.next() else {
        return false;
    };
    models.next().is_none()
        && fields.next().is_none()
        && matches!(descriptor.field, JsModelFieldType::File)
        && descriptor.value_type.as_deref() == Some("file[]")
        && descriptor.array_required == Some(false)
        && !descriptor.nullable
        && !descriptor.server_only
        && descriptor.machine.is_none()
        && serde_json::to_value(expected)
            .ok()
            .is_some_and(|expected| serde_json::to_value(descriptor).ok() == Some(expected))
}

/// Borrow a singular original required Branch.profile read pair. Existing
/// consumers cannot silently discard another role retained by the source.
#[cfg(test)]
pub(super) fn checked_profile_scalar_pair<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    leaf: &TypedExpr,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::DisclosureDependency,
    &'a crate::analysis::scenario_disclosure::DisclosureDependency,
)> {
    let pairs = checked_profile_scalar_pairs(ir, owner, leaf, db)?;
    let [pair] = pairs.as_slice() else {
        return None;
    };
    Some(*pair)
}

/// Borrow the exact required Profile pairs or the leading Turn.run unfinished
/// guard pair. A Profile Let consumed by guard and result retains both roles.
/// This correspondence neither promotes a reference nor emits a recipe.
pub(super) fn checked_profile_scalar_pairs<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    leaf: &TypedExpr,
    db: &SourceDb,
) -> Option<
    Vec<(
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
> {
    use crate::analysis::NodeKey;
    if !std::ptr::eq(ir.items.get(owner.id.0 as usize)?, owner) {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario {
        params,
        read: false,
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrExpr::Member {
        base: reference,
        field: scalar_name,
    } = &leaf.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: receiver,
        field,
    } = &reference.expr
    else {
        return None;
    };
    let IrExpr::Name(binding) = &receiver.expr else {
        return None;
    };
    let run_guard = field == "run" && scalar_name == "unfinished";
    let (reference_name, expected) = if run_guard {
        ("run", Scalar::Bool)
    } else if field == "profile" {
        let expected = match scalar_name.as_str() {
            "active" => Scalar::Bool,
            "system_prompt" | "provider_key" | "policy_revision" => Scalar::Text,
            "input_tokens" | "output_tokens" => Scalar::Int,
            "duration" => Scalar::Duration,
            _ => return None,
        };
        ("profile", expected)
    } else {
        return None;
    };
    let ResolvedType::Record {
        symbol: branch_id,
        stored: true,
    } = receiver.ty
    else {
        return None;
    };
    let ResolvedType::Record {
        symbol: profile_id,
        stored: true,
    } = reference.ty
    else {
        return None;
    };
    if field != reference_name
        || leaf.ty != ResolvedType::Scalar(expected)
        || proof.scenario != owner.id
        || proof.node != source.node
        || proof.source != source.source
        || proof.returns.is_empty()
    {
        return None;
    }
    // This consumer takes the actual owning IR occurrence, not a detached
    // expression copy carrying otherwise identical source spans and types.
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner.kind
    else {
        return None;
    };
    let mut expressions = Vec::new();
    for statement in guards.iter().chain(effects) {
        match statement {
            IrStmt::Require { cond, .. } => expressions.push(cond),
            IrStmt::Let { value, .. } => expressions.push(value),
            IrStmt::Create { input, .. } => expressions.push(input),
            _ => {}
        }
    }
    let mut visited = 0usize;
    let mut occurrences = 0usize;
    while let Some(expression) = expressions.pop() {
        visited += 1;
        if visited > 16384 {
            return None;
        }
        if std::ptr::eq(expression, leaf) {
            occurrences += 1;
        }
        match &expression.expr {
            IrExpr::Member { base, .. } => expressions.push(base),
            IrExpr::Binary { left, right, .. } => {
                expressions.extend([left.as_ref(), right.as_ref()])
            }
            IrExpr::Unary { operand, .. } => expressions.push(operand),
            IrExpr::Array(values) => expressions.extend(values),
            IrExpr::Object(entries) => expressions.extend(entries.iter().map(|(_, value)| value)),
            IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => expressions.extend(args),
            _ => {}
        }
    }
    if occurrences != 1 {
        return None;
    }
    let inventory = source.stored_contracts.as_deref()?;
    let unique_schema = |id| {
        let mut candidates = inventory
            .iter()
            .filter(|schema| schema.id == id && schema.model);
        let schema = candidates.next()?;
        candidates.next().is_none().then_some(schema)
    };
    let branch = unique_schema(branch_id)?;
    let profile = unique_schema(profile_id)?;
    let branch_item = ir.items.get(branch_id.0 as usize)?;
    let profile_item = ir.items.get(profile_id.0 as usize)?;
    if !matches!(branch_item.kind, IrItemKind::Model { .. })
        || !matches!(profile_item.kind, IrItemKind::Model { .. })
        || branch.module != owner.module
        || profile.module != owner.module
        || branch.source != source.source
        || profile.source != source.source
    {
        return None;
    }
    match_stored_contract_schema(ir, branch, db)?;
    match_stored_contract_schema(ir, profile, db)?;
    for field in &profile.fields {
        match_stored_contract_field(ir, field, db)?;
    }
    let mut references = branch
        .fields
        .iter()
        .filter(|candidate| candidate.name == reference_name);
    let reference_field = references.next()?;
    let mut scalars = profile
        .fields
        .iter()
        .filter(|candidate| candidate.name == *scalar_name);
    let scalar_field = scalars.next()?;
    if references.next().is_some()
        || scalars.next().is_some()
        || reference_field.owner != branch.id
        || reference_field.ty != reference.ty
        || scalar_field.owner != profile.id
        || scalar_field.ty != leaf.ty
        || reference_field.reuse.is_some()
        || scalar_field.reuse.is_some()
        || reference_field.source != source.source
        || scalar_field.source != source.source
        || ir.items.get(reference_field.id.0 as usize)?.module != owner.module
        || ir.items.get(scalar_field.id.0 as usize)?.module != owner.module
        || !branch.field_order.contains(&reference_field.id)
        || !profile.field_order.contains(&scalar_field.id)
    {
        return None;
    }
    let IrItemKind::Field {
        default: None,
        server: None,
        modifiers,
        ..
    } = &ir.items.get(reference_field.id.0 as usize)?.kind
    else {
        return None;
    };
    if modifiers.machine || reference_field.required_array {
        return None;
    }
    match_stored_contract_field(ir, reference_field, db)?;
    let mut parameters = params.iter().enumerate().filter_map(|(position, id)| {
        let parameter = ir.items.get(id.0 as usize)?;
        (parameter.name == *binding).then_some((position, parameter))
    });
    let (position, parameter) = parameters.next()?;
    let original_parameter = source.parameters.get(position)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty: IrType::Known(ty),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let authored_parameter = checked_effect_node(ir, owner, original_parameter.node, db)?;
    let parameter_name = authored_parameter
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    let text = &db.get(source.node.file)?.text;
    if parameters.next().is_some()
        || *parameter_owner != owner.id
        || *index != position
        || parameter.id != original_parameter.parameter
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, binding)
        || parameter.span != parameter_name.span
        || parameter_name.token()?.text(text) != binding
        || ty != &receiver.ty
        || original_parameter.ty != receiver.ty
        || original_parameter.default.is_some()
        || original_parameter.constraints.is_some()
        || text
            .get(
                original_parameter.type_node.start as usize
                    ..original_parameter.type_node.end as usize,
            )?
            .trim()
            != branch_item.name
    {
        return None;
    }
    let key = |value: &TypedExpr, kind| NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: kind as u8,
    };
    let reference_key = key(reference, SyntaxKind::Member);
    let leaf_key = key(leaf, SyntaxKind::Member);
    let receiver_key = key(receiver, SyntaxKind::NameRef);
    let census = source.expression_types.as_deref()?;
    for (node, ty) in [
        (reference_key, &reference.ty),
        (leaf_key, &leaf.ty),
        (receiver_key, &receiver.ty),
    ] {
        let mut typed = census.iter().filter(|(at, _)| *at == node);
        if typed.next()?.1 != *ty || typed.next().is_some() {
            return None;
        }
    }
    let authored_leaf = checked_effect_node(ir, owner, leaf_key, db)?;
    let leaf_parts: Vec<_> = authored_leaf
        .children
        .iter()
        .filter(|node| node.kind != SyntaxKind::Trivia)
        .collect();
    let [authored_reference, dot, authored_field] = leaf_parts.as_slice() else {
        return None;
    };
    let reference_parts: Vec<_> = authored_reference
        .children
        .iter()
        .filter(|node| node.kind != SyntaxKind::Trivia)
        .collect();
    let [authored_receiver, reference_dot, authored_reference_field] = reference_parts.as_slice()
    else {
        return None;
    };
    if NodeKey::of(authored_reference) != reference_key
        || NodeKey::of(authored_receiver) != receiver_key
        || authored_field.kind != SyntaxKind::Name
        || authored_field.token()?.text(text) != scalar_name
        || dot.token()?.text(text) != "."
        || reference_dot.token()?.text(text) != "."
        || authored_reference_field.token()?.text(text) != reference_name
        || images_source_name(authored_receiver, text)? != binding
    {
        return None;
    }
    let scenario = checked_effect_node(ir, owner, source.node, db)?;
    let contains = |node: &crate::syntax::SyntaxNode| {
        node.span.file == leaf.span.file
            && node.span.start <= leaf.span.start
            && leaf.span.end <= node.span.end
    };
    let role = if scenario
        .children
        .iter()
        .any(|node| node.kind == SyntaxKind::Require && contains(node))
    {
        DependencyRole::Control
    } else {
        let mut blocks = scenario
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::DoBlock);
        let block = blocks.next()?;
        if blocks.next().is_some()
            || !block.children.iter().any(|node| {
                matches!(node.kind, SyntaxKind::Let | SyntaxKind::Create) && contains(node)
            })
        {
            return None;
        }
        DependencyRole::Data
    };
    if run_guard {
        if role != DependencyRole::Control
            || branch.parent.is_none()
            || branch.parent != profile.parent
        {
            return None;
        }
        // The second exact scope is only the original leading NOT guard.
        // Both the borrowed executable operand and original typed CST must
        // own the same Unary occurrence; a copied read gains no permission.
        let mut pending: Vec<_> = guards
            .iter()
            .filter_map(|statement| {
                if let IrStmt::Require { cond, .. } = statement {
                    Some(cond)
                } else {
                    None
                }
            })
            .collect();
        let mut unary = None;
        while let Some(value) = pending.pop() {
            match &value.expr {
                IrExpr::Unary { op, operand } => {
                    if std::ptr::eq(operand.as_ref(), leaf) {
                        if unary.is_some()
                            || *op != super::ir::IrUnOp::Not
                            || value.ty != ResolvedType::Scalar(Scalar::Bool)
                        {
                            return None;
                        }
                        unary = Some(value);
                    }
                    pending.push(operand);
                }
                IrExpr::Binary { left, right, .. } => {
                    pending.extend([left.as_ref(), right.as_ref()])
                }
                _ => {}
            }
        }
        let unary = unary?;
        let unary_key = key(unary, SyntaxKind::Unary);
        let mut typed = census.iter().filter(|(at, _)| *at == unary_key);
        if typed.next()?.1 != unary.ty || typed.next().is_some() {
            return None;
        }
        let authored_unary = checked_effect_node(ir, owner, unary_key, db)?;
        let parts: Vec<_> = authored_unary
            .children
            .iter()
            .filter(|node| node.kind != SyntaxKind::Trivia)
            .collect();
        let [operator, operand] = parts.as_slice() else {
            return None;
        };
        if operator.token()?.text(text) != "not" || NodeKey::of(operand) != leaf_key {
            return None;
        }
    }
    let multiple_roles = role == DependencyRole::Data
        && checked_scenario_query_influences(source)
            .is_some_and(|influences| influences.len() == 24);
    let read_identity = |node: NodeKey, role: DependencyRole| {
        let kind = match role {
            DependencyRole::Data => "read-data",
            DependencyRole::Control => "read-control",
        };
        sha256_hex(
            format!(
                "scenario-disclosure/v1:{kind}:{}:{}:{}:{}:{}:",
                source.source.path,
                source.source.sha256,
                source.source.module,
                node.start,
                node.end
            )
            .as_bytes(),
        )
    };
    let mut result = None;
    for returned in &proof.returns {
        if returned.source != source.source {
            return None;
        }
        let references: Vec<_> = returned
            .dependencies
            .iter()
            .enumerate()
            .filter(|(_, read)| read.node == reference_key)
            .collect();
        let leaves: Vec<_> = returned
            .dependencies
            .iter()
            .enumerate()
            .filter(|(_, read)| read.node == leaf_key)
            .collect();
        if references.is_empty() && leaves.is_empty() {
            continue;
        }
        if references.len() != leaves.len()
            || references.is_empty()
            || references.len() > if multiple_roles { 2 } else { 1 }
        {
            return None;
        }
        let expected_roles: &[DependencyRole] = if references.len() == 2 {
            &[DependencyRole::Control, DependencyRole::Data]
        } else {
            std::slice::from_ref(&role)
        };
        let mut pairs = Vec::new();
        let mut identities = HashSet::new();
        for (((source_index, reference_read), (leaf_index, scalar_read)), expected_role) in
            references.iter().zip(&leaves).zip(expected_roles)
        {
            if source_index >= leaf_index
                || reference_read.id != read_identity(reference_key, *expected_role)
                || scalar_read.id != read_identity(leaf_key, *expected_role)
                || reference_read.id == scalar_read.id
                || !identities.insert(&reference_read.id)
                || !identities.insert(&scalar_read.id)
                || reference_read.source != source.source
                || scalar_read.source != source.source
                || !reference_read.calls.is_empty()
                || !scalar_read.calls.is_empty()
                || reference_read.query_id.is_some()
                || scalar_read.query_id.is_some()
                || reference_read.role != *expected_role
                || scalar_read.role != *expected_role
                || reference_read.model != branch.id
                || reference_read.field != reference_field.id
                || reference_read.model_name != branch.canonical
                || reference_read.field_name != reference_name
                || reference_read.ty != reference.ty
                || reference_read.type_id != profile.canonical
                || scalar_read.model != profile.id
                || scalar_read.field != scalar_field.id
                || scalar_read.model_name != profile.canonical
                || scalar_read.field_name != *scalar_name
                || scalar_read.ty != leaf.ty
                || scalar_read.type_id != expected.as_str()
            {
                return None;
            }
            pairs.push((*reference_read, *scalar_read));
        }
        if result.as_ref().is_some_and(|previous| previous != &pairs) {
            return None;
        }
        result = Some(pairs);
    }
    result
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

fn checked_transcript_selected_member(
    ir: &IrProgram,
    owner: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let original = fact
        .fields
        .iter()
        .find(|original| node_span(original.value_node) == value.span)?;
    if ir.items.get(original.source_field.0 as usize)?.name != *field
        || original.ty != value.ty
        || !matches!(&base.expr, IrExpr::Name(name)
            if fact.query.clauses.iter().any(|clause| matches!(&clause.kind,
                crate::analysis::types::CheckedQueryClauseKind::As {name: alias} if alias == name)))
        || base.ty
            != (ResolvedType::Record {
                symbol: fact.model,
                stored: true,
            })
    {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let schema = source
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.id == fact.model && schema.model)?;
    match_stored_contract_schema(ir, schema, db)?;
    let field = schema
        .fields
        .iter()
        .find(|field| field.id == original.source_field)?;
    match_stored_contract_field(ir, field, db)?;
    (field.ty == value.ty && field.source == fact.source).then_some(())
}

fn checked_transcript_prefix_inventory(
    ir: &IrProgram,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    descriptor: &JsModelField,
    value_types: Option<&JsValueTypes>,
    db: Option<&SourceDb>,
) -> Option<String> {
    let db = db?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let fact = source.transcripts.as_deref()?.iter().find(|fact| {
        read.calls == [fact.call]
            && read.node == fact.prefix_node
            && read.model == fact.branch
            && read.field == fact.prefix
            && read.ty == fact.ty
            && read.type_id == "TextMessage[]"
            && read.source == fact.source
            && read.query_id.is_none()
    })?;
    checked_message_prefix_inventory(
        ir,
        descriptor,
        value_types,
        db,
        (fact.branch, fact.prefix, &fact.ty, fact.prefix_max),
    )
}

fn checked_inline_prefix_inventory(
    ir: &IrProgram,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    descriptor: &JsModelField,
    value_types: Option<&JsValueTypes>,
    db: Option<&SourceDb>,
) -> Option<String> {
    let db = db?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let fact = facts.inline_selections.as_deref()?.iter().find(|fact| {
        read.calls.is_empty()
            && read.node == fact.prefix_node
            && read.model == fact.parent.parent
            && read.field == fact.prefix
            && read.ty == fact.ty
            && read.type_id == "TextMessage[]"
            && read.role == DependencyRole::Data
            && read.source == fact.query.source
            && read.query_id.is_none()
    })?;
    checked_inline_selection_ir(ir, owner, fact, db)?;
    checked_message_prefix_inventory(
        ir,
        descriptor,
        value_types,
        db,
        (fact.parent.parent, fact.prefix, &fact.ty, fact.prefix_max),
    )
}

fn checked_message_prefix_inventory(
    ir: &IrProgram,
    descriptor: &JsModelField,
    value_types: Option<&JsValueTypes>,
    db: &SourceDb,
    prefix: (
        crate::analysis::SymbolId,
        crate::analysis::SymbolId,
        &ResolvedType,
        crate::analysis::NodeKey,
    ),
) -> Option<String> {
    let (branch_id, prefix_id, prefix_ty, prefix_max) = prefix;
    let branch = ir.items.get(branch_id.0 as usize)?;
    let field = ir.items.get(prefix_id.0 as usize)?;
    let IrItemKind::Field {
        owner: field_owner,
        ty: IrType::Known(ty),
        required_array: false,
        default: None,
        server: None,
        modifiers,
        ..
    } = &field.kind
    else {
        return None;
    };
    let max = modifiers.max.as_ref()?;
    if field.id != prefix_id
        || field.module != branch.module
        || field_owner != &branch_id
        || field.canonical != format!("{}.{}", branch.canonical, field.name)
        || ty != prefix_ty
        || max.span != node_span(prefix_max)
        || !matches!(max.expr, IrExpr::Int(bound) if bound > 0)
        || max.ty != ResolvedType::Scalar(Scalar::Int)
        || modifiers.min.is_some()
        || modifiers.trim
        || modifiers.machine
        || descriptor.value_type.as_deref() != Some("TextMessage[]")
        || !matches!(&descriptor.field, JsModelFieldType::Nominal { name } if name == "TextMessage")
        || descriptor.array_required != Some(false)
        || descriptor.nullable
        || descriptor.server_only
    {
        return None;
    }
    let generated = super::js::Emitter::source_models(ir, db)?;
    let expected = generated
        .iter()
        .find(|model| model.name == branch.canonical)?
        .fields
        .iter()
        .find(|candidate| candidate.name == field.name)?;
    if serde_json::to_value(expected).ok()? != serde_json::to_value(descriptor).ok()? {
        return None;
    }
    let mut emitter = super::js::Emitter::new(ir);
    let expected = emitter.collect_standard_value_inventory(db)?;
    let message = expected
        .contracts
        .iter()
        .find(|contract| contract.name == "TextMessage")?;
    let supplied = value_types?
        .contracts
        .iter()
        .filter(|contract| contract.name == "TextMessage")
        .collect::<Vec<_>>();
    let [supplied] = supplied.as_slice() else {
        return None;
    };
    if serde_json::to_value(message).ok()? != serde_json::to_value(supplied).ok()? {
        return None;
    }
    Some("TextMessage[]".into())
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

pub(super) fn match_stored_contract_schema(
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

pub(super) fn match_stored_contract_field(
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
    if let Some(contributed) = &original.contributed {
        if contributed.field != original.id
            || contributed.canonical != original.canonical
            || contributed.span != original.span
            || contributed.source != original.source
            || contributed.ty != original.ty
            || contributed.constraints != original.constraints
            || original.required_array
            || original.reuse.is_some()
            || original.min.is_some()
            || original.max.is_some()
        {
            return None;
        }
        return super::scenario_create_sources::checked_contributed_field(
            ir,
            ir.items.get(original.owner.0 as usize)?,
            contributed,
            db,
        );
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
                    ordered_created_model_effects(
                        ir,
                        owner,
                        proof.node,
                        *model,
                        checked_binding,
                        db,
                    )?;
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
                    if let Some(schema) = checked
                        .source_facts
                        .as_deref()
                        .and_then(|facts| facts.stored_contracts.as_deref())
                        .and_then(|schemas| schemas.iter().find(|schema| schema.id == *model))
                    {
                        if let Some(original) = schema
                            .fields
                            .iter()
                            .find(|field| field.id == *id && field.contributed.is_some())
                        {
                            match_stored_contract_schema(ir, schema, db?)?;
                            match_stored_contract_field(ir, original, db?)?;
                        }
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
    {
        return None;
    }
    super::scenario_create_sources::checked_created_schema(ir, owner, models, original, db)?;
    if facts.creates.as_deref()?.len() == 2 {
        let (first, second) = checked_created_pair(ir, owner, db)?;
        if proof.node != first.node && proof.node != second.node {
            return None;
        }
        ordered_created_model_effects(ir, owner, first.node, first.model, &first.binding, db)?;
    } else if checked_created_model_result(ir, owner) == Some(*model) {
        ordered_created_model_effects(ir, owner, proof.node, *model, binding, db)?;
    } else {
        ordered_intermediate_call_create(ir, owner, checked, proof.node, *model, binding, db)?;
    }
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
                && (matches!(
                    role.as_str(),
                    "members" | "owner" | "authenticated" | "public"
                ) && text.get(node.span.start as usize..node.span.end as usize)
                    == Some(role.as_str())
                    || facts.by_role.as_ref().is_some_and(|(at, id, canonical)| {
                        *at == NodeKey::of(node)
                            && canonical == role
                            && ir.items.get(id.0 as usize).is_some_and(|item| {
                                item.id == *id
                                    && item.canonical == *canonical
                                    && matches!(item.kind, IrItemKind::Role { .. })
                            })
                    })) => {}
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
    let result_original = if facts.creates.as_deref()?.len() == 2 {
        checked_created_pair(ir, owner, db)?.0
    } else {
        original
    };
    let guarded_created = effects
        .iter()
        .any(|statement| matches!(statement, IrStmt::Send { when: Some(_), .. }))
        && checked_created_model_result(ir, owner) == Some(result_original.model);
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
            IrStmt::Set {
                record,
                changes,
                when: None,
                span,
            } if guarded_created => {
                let mut paths = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Path);
                let receiver = paths.next()?;
                if paths.next().is_some()
                    || record.span != receiver.span
                    || original
                        .expression_types
                        .iter()
                        .find(|(node, _)| *node == NodeKey::of(receiver))
                        .is_none_or(|(_, ty)| ty != &record.ty)
                {
                    return None;
                }
                let binding = direct_source_path_name(receiver, text)?;
                if binding == result_original.binding {
                    created_record_name_matches(
                        record,
                        &ResolvedType::Record {
                            symbol: result_original.model,
                            stored: true,
                        },
                        &result_original.binding,
                        *span,
                        db,
                    )?;
                } else {
                    let selected = checked_first_query_row(ir, owner, record, db)?;
                    if record.ty
                        != (ResolvedType::Record {
                            symbol: selected.id,
                            stored: true,
                        })
                    {
                        return None;
                    }
                }
                checked_created_object_entries(ir, original, changes, authored, *span, db)?;
                (SyntaxKind::Set, *span, None)
            }
            IrStmt::Send {
                args,
                operation,
                when: Some(_),
                binding: Some(binding),
                span,
                ..
            } if guarded_created => {
                let names: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .collect();
                let [send, when, as_word, source_binding] = names.as_slice() else {
                    return None;
                };
                if !operation.starts_with("std.")
                    || send.token()?.text(text) != "send"
                    || when.token()?.text(text) != "when"
                    || as_word.token()?.text(text) != "as"
                    || source_binding.token()?.text(text) != binding
                {
                    return None;
                }
                // Existing effect/Sites joins require the exact original
                // prepared Rule. Its predicate is not a parent expression.
                checked_created_object_entries(ir, original, args, authored, *span, db)?;
                (SyntaxKind::Send, *span, None)
            }
            IrStmt::Call { inputs, span, .. } => {
                let source_calls =
                    super::scenario_calls::collect_scenario_source_calls(ir, owner, db)?;
                let mut sources = source_calls.iter().filter(|call| call.span == *span);
                let source = sources.next()?;
                let IrExpr::Object(entries) = &inputs.expr else {
                    return None;
                };
                let mut objects = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Object);
                let object = objects.next()?;
                let authored_entries: Vec<_> = object
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::ObjectEntry)
                    .collect();
                if sources.next().is_some()
                    || objects.next().is_some()
                    || inputs.span != *span
                    || entries.len() != source.inputs.len()
                    || entries.len() != authored_entries.len()
                {
                    return None;
                }
                for (((name, value), fact), entry) in
                    entries.iter().zip(&source.inputs).zip(authored_entries)
                {
                    let key = entry
                        .children
                        .iter()
                        .find(|node| node.kind == SyntaxKind::Name)?;
                    if key.token()?.text(text) != name || fact.name != *name {
                        return None;
                    }
                    let authored_value = entry
                        .children
                        .iter()
                        .find(|node| {
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
                        })
                        .unwrap_or(key);
                    if fact.source != authored_value.span {
                        return None;
                    }
                    super::scenario_create_sources::checked_create_expression(
                        ir,
                        original,
                        value,
                        NodeKey::of(authored_value),
                        db,
                    )?;
                }
                (SyntaxKind::Call, *span, None)
            }
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
                        | SyntaxKind::Construct
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

/// Effect containers are synthetic Unknown objects spanning the statement.
/// Seal each authored ordered entry through its original typed operand instead.
fn checked_created_object_entries(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    statement: &crate::syntax::SyntaxNode,
    at: Span,
    db: &SourceDb,
) -> Option<()> {
    use crate::analysis::NodeKey;
    if actual.span != at || actual.ty != ResolvedType::Unknown {
        return None;
    }
    let IrExpr::Object(entries) = &actual.expr else {
        return None;
    };
    let mut objects = statement
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Object);
    let object = objects.next()?;
    if objects.next().is_some() {
        return None;
    }
    let authored: Vec<_> = object
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::ObjectEntry)
        .collect();
    if entries.len() != authored.len() || entries.len() > 200 {
        return None;
    }
    let text = &db.get(at.file)?.text;
    let mut seen = HashSet::new();
    for ((name, value), entry) in entries.iter().zip(authored) {
        let key = entry
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        if !seen.insert(name) || key.token()?.text(text) != name {
            return None;
        }
        let operand = entry
            .children
            .iter()
            .find(|node| {
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
                        | SyntaxKind::Construct
                        | SyntaxKind::Object
                )
            })
            .unwrap_or(key);
        super::scenario_create_sources::checked_create_expression(
            ir,
            original,
            value,
            NodeKey::of(operand),
            db,
        )?;
    }
    Some(())
}

/// An original intermediate Create is consumed only by the immediately
/// following checked CALL, whose direct returned model owns the result.
fn ordered_intermediate_call_create(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let result_model = checked_created_model_result(ir, owner)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if effects.len() < 3
        || effects[..effects.len() - 3]
            .iter()
            .any(|effect| !matches!(effect, IrStmt::Let { .. } | IrStmt::Require { .. }))
    {
        return None;
    }
    let [
        IrStmt::Create { span: created, .. },
        IrStmt::Call {
            target: IrEffectCallTarget::Operation { operation, .. },
            inputs,
            binding: Some(call_binding),
            span: called,
            ..
        },
        IrStmt::Return {
            value: Some(value),
            span: returned,
        },
    ] = &effects[effects.len() - 3..]
    else {
        return None;
    };
    let child = ir.items.get(operation.0 as usize)?;
    if *created != node_span(create)
        || created.end > called.start
        || called.end > returned.start
        || created.file != called.file
        || called.file != returned.file
        || child.id != *operation
        || checked_created_model_result(ir, child)? != result_model
    {
        return None;
    }
    let IrExpr::Object(entries) = &inputs.expr else {
        return None;
    };
    let created_ty = ResolvedType::Record {
        symbol: model,
        stored: true,
    };
    if entries
        .iter()
        .filter(|(_, input)| {
            matches!(&input.expr, IrExpr::Name(name)
        if name == binding)
                && input.ty == created_ty
        })
        .count()
        != 1
    {
        return None;
    }
    let mut proofs = checked
        .effects
        .iter()
        .filter(|proof| node_span(proof.node) == *called);
    let proof = proofs.next()?;
    if proofs.next().is_some()
        || proof.source != checked.source
        || !matches!(&proof.kind, DisclosureEffectKind::Call { operation: actual, input_keys }
            if actual == operation && input_keys == &entries.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>())
        || checked.returns.is_empty()
        || checked.returns.iter().any(|returned| {
            !matches!(returned.model_result,
            Some(DisclosureModelResult::Call { model, node, operation: actual })
                if model == result_model && node_span(node) == *called && actual == *operation)
        })
    {
        return None;
    }
    created_record_name_matches(
        value,
        &ResolvedType::Record {
            symbol: result_model,
            stored: true,
        },
        call_binding,
        *returned,
        db,
    )
}

/// The original pair stores the first created row in the second row and
/// returns that same first binding. Every constructor remains individually
/// source/schema checked by the owning effect matcher.
fn checked_created_pair<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    &'a crate::analysis::scenario_disclosure::CheckedScenarioCreate,
)> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let [first, second] = facts.creates.as_deref()? else {
        return None;
    };
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario {
        params, effects, ..
    } = &owner.kind
    else {
        return None;
    };
    let crate::analysis::resolve::ModelOwner::ChildOf(parent_id) =
        first.definition.declaration.owner
    else {
        return None;
    };
    if first.source != checked.source
        || second.source != checked.source
        || first.model == second.model
        || first.binding == second.binding
        || !direct_field_name(&first.binding)
        || !direct_field_name(&second.binding)
        || first.node.file != second.node.file
        || first.node.end > second.node.start
        || second.definition.declaration.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(parent_id)
        || checked_created_model_result(ir, owner) != Some(first.model)
        || checked.returns.iter().any(|returned| {
            returned.model_result
                != Some(DisclosureModelResult::Create {
                    model: first.model,
                    node: first.node,
                })
        })
    {
        return None;
    }
    let mut creates = effects
        .iter()
        .enumerate()
        .filter(|(_, statement)| matches!(statement, IrStmt::Create { .. }));
    let (position, first_statement) = creates.next()?;
    let (second_position, second_statement) = creates.next()?;
    if creates.next().is_some()
        || second_position != position + 1
        || effects[..position]
            .iter()
            .any(|statement| !matches!(statement, IrStmt::Let { .. } | IrStmt::Require { .. }))
        || params.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|item| item.name == first.binding || item.name == second.binding)
        })
        || effects[..position].iter().any(|statement| {
            matches!(statement, IrStmt::Let { name, .. }
                if name == &first.binding || name == &second.binding)
        })
    {
        return None;
    }
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries)?;
    let mut selected = queries.iter().filter(|query| {
        query
            .count
            .as_ref()
            .is_some_and(|count| count.statement == second.node)
    });
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    let count = query.count.as_ref()?;
    let parameter = checked_count_query_parent(ir, owner, query, db)?;
    let parent_type = ResolvedType::Record {
        symbol: parent_id,
        stored: true,
    };
    if query.model != second.model
        || count.statement != second.node
        || !matches!(&parameter.kind, IrItemKind::Param {ty:IrType::Known(ty), ..}
            if ty == &parent_type)
    {
        return None;
    }
    let result_type = ResolvedType::Record {
        symbol: first.model,
        stored: true,
    };
    let mut reference_inputs = second.inputs.iter().filter(|input| input.ty == result_type);
    let reference = reference_inputs.next()?;
    if reference_inputs.next().is_some() || reference.field.is_none() {
        return None;
    }
    for (original, statement) in [(first, first_statement), (second, second_statement)] {
        let IrStmt::Create {
            model,
            input,
            binding: Some(binding),
            when: None,
            span,
        } = statement
        else {
            return None;
        };
        let IrExpr::Object(entries) = &input.expr else {
            return None;
        };
        let mut proofs = checked
            .effects
            .iter()
            .filter(|proof| proof.node == original.node);
        let proof = proofs.next()?;
        if proofs.next().is_some()
            || proof.source != checked.source
            || !matches!(&proof.kind, DisclosureEffectKind::Create {
                model, crud:None, binding, defaults, inputs
            } if *model == original.model && binding == &original.binding
                && defaults.is_empty() && inputs == &original.inputs)
            || model != &original.definition.canonical
            || binding != &original.binding
            || *span != node_span(original.node)
            || input.span != *span
            || entries.len() != original.inputs.len()
            || entries.is_empty()
        {
            return None;
        }
        let mut names = HashSet::new();
        let mut parent_found = false;
        for ((name, value), input) in entries.iter().zip(&original.inputs) {
            if !names.insert(name)
                || name != &input.name
                || value.ty != input.ty
                || value.span != node_span(input.value_node)
                || original
                    .expression_types
                    .iter()
                    .find(|(at, _)| *at == input.value_node)
                    .is_none_or(|(_, ty)| ty != &value.ty)
            {
                return None;
            }
            if input.field.is_none() {
                if parent_found || name != "parent" || input.ty != parent_type {
                    return None;
                }
                parent_found = true;
                created_record_name_matches(value, &parent_type, &parameter.name, *span, db)?;
                super::scenario_create_sources::checked_create_expression(
                    ir,
                    original,
                    value,
                    input.value_node,
                    db,
                )?;
            } else {
                let field = original
                    .definition
                    .fields
                    .iter()
                    .find(|field| Some(field.field) == input.field)?;
                let actual = ir.items.get(field.field.0 as usize)?;
                if field.name != *name
                    || field.ty != input.ty
                    || actual.id != field.field
                    || actual.canonical != field.canonical
                    || actual.name != field.name
                    || !matches!(&actual.kind, IrItemKind::Field {owner, ty:IrType::Known(ty), ..}
                        if *owner == original.model && ty == &field.ty)
                {
                    return None;
                }
                if original.node == second.node && input.value_node == reference.value_node {
                    created_record_name_matches(value, &result_type, &first.binding, *span, db)?;
                    super::scenario_create_sources::checked_create_expression(
                        ir,
                        original,
                        value,
                        input.value_node,
                        db,
                    )?;
                }
            }
        }
        if !parent_found {
            return None;
        }
    }
    let IrStmt::Create { input, .. } = second_statement else {
        return None;
    };
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let mut counted = entries.iter().filter(|(_, value)| {
        matches!(&value.expr, IrExpr::Binary {op:IrBinOp::Add,left,right}
            if left.span == node_span(count.call)
                && left.ty == ResolvedType::Scalar(Scalar::Int)
                && right.ty == ResolvedType::Scalar(Scalar::Int)
                && matches!(right.expr, IrExpr::Int(1)))
    });
    let (_, increment) = counted.next()?;
    if counted.next().is_some()
        || increment.ty != ResolvedType::Scalar(Scalar::Int)
        || !second.inputs.iter().any(|input| {
            input.field.is_some()
                && node_span(input.value_node) == increment.span
                && input.ty == ResolvedType::Scalar(Scalar::Int)
        })
    {
        return None;
    }
    Some((first, second))
}

/// A second constructor's first-model operand must still name the original
/// earlier CreateAs, never a same-type parameter or alias substituted in IR.
pub(super) fn checked_created_reference_operand(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<()> {
    if !matches!(actual.ty, ResolvedType::Record { stored: true, .. }) {
        return Some(());
    }
    let mut owners = ir.items.iter().filter(|owner| {
        ir.scenario_disclosures
            .get(&owner.id)
            .and_then(|disclosure| disclosure.source_facts())
            .and_then(|facts| facts.creates.as_deref())
            .is_some_and(|creates| {
                creates.len() == 2
                    && creates.iter().any(|created| {
                        created.node == original.node && created.source == original.source
                    })
            })
    });
    let Some(owner) = owners.next() else {
        return Some(());
    };
    if owners.next().is_some() {
        return None;
    }
    let (first, second) = checked_created_pair(ir, owner, db)?;
    if original.node == second.node
        && actual.ty
            == (ResolvedType::Record {
                symbol: first.model,
                stored: true,
            })
    {
        if !second
            .inputs
            .iter()
            .any(|input| input.field.is_some() && input.value_node == node && input.ty == actual.ty)
        {
            return None;
        }
        created_record_name_matches(
            actual,
            &actual.ty,
            &first.binding,
            node_span(second.node),
            db,
        )?;
    }
    Some(())
}

fn ordered_created_model_effects(
    ir: &IrProgram,
    owner: &IrItem,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if effects.len() < 2 {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let paired = if facts
        .creates
        .as_deref()
        .is_some_and(|creates| creates.len() == 2)
    {
        let (first, second) = checked_created_pair(ir, owner, db)?;
        if first.node != create || first.model != model || first.binding != binding {
            return None;
        }
        Some(second.node)
    } else {
        None
    };
    let last_create = paired.unwrap_or(create);
    let direct = matches!(effects.get(effects.len() - 2),
        Some(IrStmt::Create {span, ..}) if *span == node_span(create))
        && effects[..effects.len() - 2]
            .iter()
            .all(|effect| matches!(effect, IrStmt::Let { .. } | IrStmt::Require { .. }));
    let direct = direct
        || paired.is_some()
            && matches!(
        effects.get(effects.len() - 2), Some(IrStmt::Create {span, ..})
            if *span == node_span(last_create));
    if !direct {
        let mut creates = effects
            .iter()
            .enumerate()
            .filter(|(_, effect)| matches!(effect, IrStmt::Create { .. }));
        let (position, statement) = creates.next()?;
        let last_position = if let Some(second) = paired {
            let (second_position, second_statement) = creates.next()?;
            if second_position != position + 1
                || !matches!(second_statement, IrStmt::Create {span, ..}
                    if *span == node_span(second))
            {
                return None;
            }
            second_position
        } else {
            position
        };
        if creates.next().is_some()
            || effects[..position]
                .iter()
                .any(|effect| !matches!(effect, IrStmt::Let { .. } | IrStmt::Require { .. }))
            || !matches!(statement, IrStmt::Create {input, span, ..}
                if *span == node_span(create) && matches!(&input.expr,
                    IrExpr::Object(entries) if !entries.is_empty()))
        {
            return None;
        }
        let [
            _,
            IrStmt::Set {
                record: before,
                when: None,
                span: before_at,
                ..
            },
            IrStmt::Send {
                operation,
                when: Some(_),
                binding: Some(sent),
                span: send_at,
                ..
            },
            IrStmt::Set {
                record: after,
                changes,
                when: None,
                span: after_at,
            },
            tail @ ..,
        ] = &effects[last_position..]
        else {
            return None;
        };
        if !operation.starts_with("std.")
            || sent.is_empty()
            || tail.is_empty()
            || tail[..tail.len() - 1]
                .iter()
                .any(|effect| !matches!(effect, IrStmt::Require { .. }))
        {
            return None;
        }
        let record = ResolvedType::Record {
            symbol: model,
            stored: true,
        };
        if matches!(&before.expr, IrExpr::Name(name) if name == binding) {
            created_record_name_matches(before, &record, binding, *before_at, db)?;
        } else {
            checked_first_query_row(ir, owner, before, db)?;
        }
        created_record_name_matches(after, &record, binding, *after_at, db)?;
        let IrExpr::Object(entries) = &changes.expr else {
            return None;
        };
        let [(_, delivery)] = entries.as_slice() else {
            return None;
        };
        let ResolvedType::StdDelivery { capability, op } = &delivery.ty else {
            return None;
        };
        if !matches!(&delivery.expr, IrExpr::Name(name) if name == sent)
            || operation != &format!("{capability}.{}", op.name)
            || last_create.end > before_at.start
            || before_at.end > send_at.start
            || send_at.end > after_at.start
        {
            return None;
        }
        let mut previous = last_create.end;
        for effect in &effects[last_position + 1..] {
            let at = match effect {
                IrStmt::Set { span, .. }
                | IrStmt::Send { span, .. }
                | IrStmt::Require { span, .. }
                | IrStmt::Return { span, .. } => *span,
                _ => return None,
            };
            if at.file != create.file || at.start < previous {
                return None;
            }
            previous = at.end;
        }
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
        send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
        db: Option<&SourceDb>,
    ) -> Option<Self> {
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
                    IrExpr::Query(query) => {
                        let facts = super::scenario_calls::checked_source(ir, owner, db?)?;
                        if let Some(fact) = facts.inline_selections.as_deref().and_then(|facts| {
                            facts.iter().find(|fact| {
                                context.calls.is_empty()
                                    && expression.span == node_span(fact.query.node)
                            })
                        }) {
                            let actual = checked_inline_selection_ir(ir, owner, fact, db?)?;
                            if !std::ptr::eq(actual, query) {
                                return None;
                            }
                            push!(Visit::Expression(query.parent.as_ref()?));
                            push!(Visit::Expression(query.where_pred.as_ref()?));
                            push!(Visit::Expression(query.select.as_ref()?));
                            // IrQuery.order has no executable TypedExpr. Its
                            // exact query-control source/field is captured by State.
                            continue;
                        }
                        let fact = facts.transcripts.as_deref()?.iter().find(|fact| {
                            context.calls.as_slice() == [node_span(fact.call)]
                                && query
                                    .source
                                    .as_ref()
                                    .is_some_and(|source| source.node == fact.query.node)
                        })?;
                        let IrItemKind::DeriveFn {
                            expr: Some(body), ..
                        } = &ir.items.get(fact.derive.0 as usize)?.kind
                        else {
                            return None;
                        };
                        let original = facts.creates.as_deref()?.iter().find(|created| {
                            checked_created_model_result(ir, owner) == Some(created.model)
                        })?;
                        super::scenario_create_sources::checked_create_expression(
                            ir, original, body, fact.body, db?,
                        )?;
                        push!(Visit::Expression(query.parent.as_ref()?));
                        push!(Visit::Expression(query.select.as_ref()?));
                    }
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
                        if matches!(target,IrCallTarget::Builtin {id,awaited:false} if id=="any")
                            && ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|source| source.source_facts())
                                .is_some_and(|source| {
                                    source
                                        .transcripts
                                        .as_deref()
                                        .is_some_and(|facts| facts.len() == 2)
                                        && source
                                            .queries
                                            .as_deref()
                                            .is_some_and(|queries| queries.len() == 4)
                                })
                        {
                            checked_any_query_ir(ir, owner, expression, db?)?;
                            // The external unfinished predicate is evaluated in
                            // the genuine active candidate slot by its facade.
                            // Neither its leaf nor its Lambda is a root site.
                            continue;
                        }
                        if matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "count")
                            && let Some(facts) = ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|value| value.source_facts())
                            && let Some(query) = facts.queries.as_deref().and_then(|queries| {
                                queries.iter().find(|query| {
                                    query.count.as_ref().is_some_and(|count| {
                                        node_span(count.call) == expression.span
                                    })
                                })
                            })
                        {
                            if query.count.as_ref()?.contained_parent.is_none() {
                                let (call, candidate, supplied) =
                                    checked_ancestor_count_query_operands(ir, owner, query, db?)?;
                                if !std::ptr::eq(call, expression) {
                                    return None;
                                }
                                for actual in [candidate, supplied] {
                                    out.members
                                        .entry(context.site(actual.span))
                                        .or_default()
                                        .push(actual);
                                }
                                continue;
                            }
                            let original = facts.creates.as_deref()?.iter().find(|created| {
                                query
                                    .count
                                    .as_ref()
                                    .is_some_and(|count| count.statement == created.node)
                            })?;
                            let call = query.count.as_ref()?.call;
                            checked_count_query_ir(ir, original, expression, call, db?)?;
                            super::scenario_create_sources::checked_create_expression(
                                ir, original, expression, call, db?,
                            )?;
                            // This true contained domain is owned by its query
                            // producer, never ordinary parent field observations.
                            continue;
                        }
                        if matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "first")
                            && let Some(facts) = ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|value| value.source_facts())
                            && let Some(query) = facts.queries.as_deref().and_then(|queries| {
                                queries.iter().find(|query| {
                                    query.first.as_ref().is_some_and(|first| {
                                        node_span(first.call) == expression.span
                                    })
                                })
                            })
                        {
                            let original = facts.creates.as_deref()?.iter().find(|created| {
                                checked_created_model_result(ir, owner) == Some(created.model)
                            })?;
                            let query = checked_first_query_ir(
                                ir,
                                original,
                                expression,
                                query.first.as_ref()?.call,
                                db?,
                            )?;
                            super::scenario_create_sources::checked_create_expression(
                                ir,
                                original,
                                expression,
                                query.first.as_ref()?.call,
                                db?,
                            )?;
                            // Query candidate fields have their separate query
                            // observation path, not ordinary parent row reads.
                            continue;
                        }
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
        || query.value_order.is_some()
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

#[cfg(test)]
#[path = "scenario_text_request_tests.rs"]
mod text_request_tests;

#[cfg(test)]
#[path = "scenario_profile_pair_tests.rs"]
mod profile_pair_tests;

#[cfg(test)]
#[path = "scenario_transcript_selection_tests.rs"]
mod transcript_selection_tests;
