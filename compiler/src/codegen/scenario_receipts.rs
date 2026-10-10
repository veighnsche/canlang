//! Match complete checked disclosure paths to actual executable native IR sites.
//! This helper never activates capture or publishes a plan on its own.
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::analysis::scenario_disclosure::{
    DependencyRole, DisclosureChoice, DisclosureEffectKind, DisclosureIntrinsicKind,
    DisclosureSource, ScenarioDisclosure,
};
use crate::analysis::{ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrEffectCallTarget, IrExpr, IrGuard, IrItem, IrItemKind,
    IrProgram, IrStmt, IrType, TypedExpr,
};
use super::js::{JsModel, JsModelField, JsModelFieldType, JsValueTypes};

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
    if !result.as_ref().is_none_or(native_result_type) || entry_module.is_empty() {
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
    let sites = Sites::collect(ir, item, params, by, guards, effects)?;
    match_effect_proofs(ir, item, models, checked, &sites, db)?;
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
                || !matches!(base.expr, IrExpr::Name(_))
                || base.ty
                    != (ResolvedType::Record {
                        symbol: dependency.model,
                        stored: true,
                    })
            {
                return None;
            }
            let owner = ir.items.get(dependency.model.0 as usize)?;
            let stored = ir.items.get(dependency.field.0 as usize)?;
            let IrItemKind::Model { fields, .. } = &owner.kind else {
                return None;
            };
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
                || *required_array
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
            let transport_type = if let ResolvedType::Enum {
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
                            edge.from == *from && edge.to == *to && edge.operation == item.canonical
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
        IrItemKind::Model { fields, .. } if schema.model => fields,
        IrItemKind::Contract { fields, .. } if !schema.model => fields,
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
                            || binding.is_some()
                            || !declared_result.as_ref().is_none_or(native_result_type)))
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
            (
                DisclosureEffectKind::Send {
                    operation,
                    deployment_binding,
                },
                IrStmt::Send {
                    operation: actual,
                    deployment_binding: binding,
                    when: None,
                    ..
                },
            ) => {
                if proof.node.kind != SyntaxKind::Send as u8
                    || operation != actual
                    || deployment_binding != binding
                    || binding.as_ref().is_none_or(|b| b.is_empty())
                {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(())
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
                        args,
                        when: None,
                        span,
                        ..
                    } => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
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
