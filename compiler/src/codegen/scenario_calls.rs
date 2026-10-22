//! Internal source-bound static call facts. No artifact or execution transport.
use super::ir::{
    IrDefault, IrEffectCallTarget, IrExpr, IrItem, IrItemKind, IrJudgmentGenerated, IrProgram,
    IrQuery, IrStmt, IrType, TypedExpr,
};
use super::js::{JsFieldDefault, JsMcpField, JsOperation, JsOperationField, JsOperationKind};
use crate::analysis::resolve::SymbolId;
use crate::analysis::scenario_disclosure::{
    CheckedScenarioCallInput, CheckedScenarioParameter, CheckedScenarioSourceCall,
    DependencyRole, DisclosureEffectKind, DisclosureQuery, DisclosureReturn, ScenarioDisclosure,
};
use crate::analysis::types::CheckedQueryProjectionField;
use crate::analysis::{NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode, decode_json_string};
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub enum StaticScenarioCallFileInput {
    Stored {
        name: String,
        #[serde(rename = "dependencyId")]
        dependency_id: String,
    },
    Forwarded {
        name: String,
        #[serde(rename = "parentParameter")]
        parent_parameter: String,
    },
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
    /// Original stored File occurrences or exact parent File parameters.
    pub file_inputs: Vec<StaticScenarioCallFileInput>,
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
fn call_proof_mismatch(
    proof: &CheckedScenarioSourceCall,
    sites_len: usize,
    calls: &[CheckedScenarioSourceCall],
    target_source: &Span,
    operation: SymbolId,
    binding: &Option<String>,
    result: &Option<ResolvedType>,
) -> bool {
    calls.get(sites_len).map(|proof| proof.node) != Some(proof.node)
        || proof.operation != operation
        || proof.binding != *binding
        || proof.result != *result
        || proof.target_node.file != target_source.file
        || proof.target_node.start != target_source.start
        || proof.target_node.end != target_source.end
}

fn collect_call_inputs(
    entries: &[(String, TypedExpr)],
    facts: &[CheckedScenarioCallInput],
) -> Option<Vec<CallInput>> {
    let mut keys = HashSet::new();
    let mut authored = Vec::new();
    for ((name, value), fact) in entries.iter().zip(facts) {
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
    Some(authored)
}

fn collect_call_site(
    ir: &IrProgram,
    parent: &IrItem,
    db: &SourceDb,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    sites: &mut Vec<ScenarioSourceCall>,
    matched: &mut HashSet<NodeKey>,
    span: Span,
    target_source: &Span,
    operation: SymbolId,
    inputs: &TypedExpr,
    binding: &Option<String>,
    result: &Option<ResolvedType>,
) -> Option<()> {
    let mut proofs = source.calls.iter().filter(|proof| {
        proof.node.file == span.file
            && proof.node.start == span.start
            && proof.node.end == span.end
    });
    let proof = proofs.next()?;
    let node = proof.node;
    if proofs.next().is_some()
        || !matched.insert(node)
        || call_proof_mismatch(
            proof,
            sites.len(),
            &source.calls,
            target_source,
            operation,
            binding,
            result,
        )
    {
        return None;
    }
    let child = ir.items.get(operation.0 as usize)?;
    let child_source = checked_source(ir, child, db)?;
    if child.id != operation || child_source.result != *result {
        return None;
    }
    let IrExpr::Object(entries) = &inputs.expr else {
        return None;
    };
    if entries.len() != proof.inputs.len() || sites.len() >= 200 {
        return None;
    }
    let authored = collect_call_inputs(entries, &proof.inputs)?;
    sites.push(ScenarioSourceCall {
        source: CallSource {
            path: source.source.path.clone(),
            sha256: source.source.sha256.clone(),
            module: source.source.module.clone(),
        },
        span,
        parent: parent.canonical.clone(),
        target: child.canonical.clone(),
        operation,
        read: child_source.read,
        binding: binding.clone(),
        result: result.clone(),
        inputs: authored,
    });
    Some(())
}

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
                collect_call_site(
                    ir,
                    parent,
                    db,
                    source,
                    &mut sites,
                    &mut matched,
                    *span,
                    target_source,
                    *operation,
                    inputs,
                    binding,
                    result,
                )?;
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

fn source_identity_mismatch(
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    owner: &IrItem,
    db: &SourceDb,
    read: bool,
    result: &Option<ResolvedType>,
    file: &crate::source::Source,
    module: &super::ir::IrModule,
    params_len: usize,
) -> bool {
    source.scenario != owner.id
        || source.read != read
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
        || params_len != source.parameters.len()
}

fn check_source_params(
    ir: &IrProgram,
    owner: &IrItem,
    params: &[SymbolId],
    facts: &[CheckedScenarioParameter],
) -> Option<()> {
    for (id, fact) in params.iter().zip(facts) {
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
            || ir.value_constraints.get(&parameter.id) != fact.constraints.as_ref()
        {
            return None;
        }
    }
    Some(())
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
    if source_identity_mismatch(source, owner, db, *read, result, file, module, params.len()) {
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
    check_source_params(ir, owner, params, &source.parameters)?;
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
    collect_static_scenario_calls_with_feasibility(
        ir,
        parent,
        operations,
        db,
        entry_module,
        (None, None),
    )
}

pub(super) fn collect_static_scenario_calls_with_feasibility(
    ir: &IrProgram,
    parent: &IrItem,
    operations: &[JsOperation],
    db: &SourceDb,
    entry_module: &str,
    prepared: (
        Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
        Option<
            &std::collections::HashMap<SymbolId, super::scenario_receipts::NativeScenarioReceipt>,
        >,
    ),
) -> Option<Vec<StaticScenarioCall>> {
    let (feasibility, native_receipts) = prepared;
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
        let sites = collect_owner(
            ir,
            owner,
            operations,
            db,
            entry_module,
            id != parent.id,
            (feasibility, native_receipts),
        )?;
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
/// Join the child descriptor to the same immutable successful requirement paths
/// used by native emission, preserving the complete conservative source proof.
fn checked_child_return_subset(
    ir: &IrProgram,
    child: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    disclosure: &serde_json::Value,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
) -> Option<()> {
    let expected: Vec<_> = match feasibility
        .filter(|_| super::scenario_feasibility::requires_projection(checked, ir))
    {
        Some(prepared) => prepared.returns(ir, child.id)?,
        None => checked.returns.iter().collect(),
    };
    let actual = disclosure["returns"].as_array()?;
    let mut ids = HashSet::new();
    if expected.is_empty()
        || expected.len() > 200
        || actual.len() != expected.len()
        || actual.iter().zip(&expected).any(|(value, returned)| {
            value["id"]
                .as_str()
                .is_none_or(|id| !ids.insert(id) || returned.id != id)
        })
    {
        return None;
    }
    Some(())
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

fn scalar_identity_mismatch(
    owner: SymbolId,
    index: usize,
    position: usize,
    parameter: &IrItem,
    child: &IrItem,
    input: &JsOperationField,
    default: &Option<IrDefault>,
    param_text: &str,
) -> bool {
    owner != child.id
        || index != position
        || parameter.module != child.module
        || parameter.canonical != format!("{}.{}", child.canonical, parameter.name)
        || input.name != parameter.name
        || input.required != default.is_none()
        || input.nullable
        || input.array_required.is_some()
        || input.min.is_some()
        || input.max.is_some()
        || param_text != parameter.name
}

fn check_literal_default(
    value: &TypedExpr,
    node: NodeKey,
    ty: &ResolvedType,
    actual: &JsFieldDefault,
    default: &Option<IrDefault>,
    db: &SourceDb,
) -> Option<()> {
    if node.kind != SyntaxKind::Literal as u8
        || value.ty != *ty
        || value.span != Span::new(node.file, node.start, node.end)
        || !source_scalar_literal(value, db)
        || actual.to_json()
            != super::js::js_field_default(default.as_ref(), None)?.to_json()
    {
        return None;
    }
    Some(())
}

fn check_computed_default(
    ir: &IrProgram,
    child: &IrItem,
    parameter: &IrItem,
    ty: &ResolvedType,
    expr: &TypedExpr,
    node: NodeKey,
    db: &SourceDb,
) -> Option<()> {
    let IrExpr::Name(target) = &expr.expr else {
        return None;
    };
    if expr.ty != *ty
        || expr.span.file != node.file
        || expr.span.start < node.start
        || expr.span.end > node.end
        || db
            .get(node.file)?
            .text
            .get(node.start as usize..node.end as usize)?
            != target.as_str()
    {
        return None;
    }
    let IrItemKind::Scenario { params, .. } = &child.kind else {
        return None;
    };
    let Some(earlier) = params.iter().position(|id| id == &parameter.id) else {
        return None;
    };
    let mut referenced = params[..earlier].iter().filter_map(|id| ir.items.get(id.0 as usize)).filter(|item| item.name == *target);
    let source = referenced.next()?;
    if referenced.next().is_some() {
        return None;
    }
    let IrItemKind::Param {
        owner: source_owner,
        ty: IrType::Known(source_ty),
        default: None,
        default_node: None,
        array_bounds: None,
        ..
    } = &source.kind
    else {
        return None;
    };
    if source.id == parameter.id
        || *source_owner != child.id
        || source.module != child.module
        || source_ty != ty
    {
        return None;
    }
    Some(())
}

fn check_scalar_alias(
    ir: &IrProgram,
    alias: SymbolId,
    ty: &ResolvedType,
    input: &JsOperationField,
) -> Option<()> {
    let declared = ir.items.get(alias.0 as usize)?;
    let alias_ty = match &declared.kind {
        IrItemKind::Field {
            ty: IrType::Known(ty),
            required_array: false,
            ..
        }
        | IrItemKind::JudgmentGenerated(IrJudgmentGenerated::Field {
            ty: IrType::Known(ty),
            required_array: false,
            ..
        }) => ty,
        _ => return None,
    };
    if declared.id != alias
        || alias_ty != ty
        || ir.value_constraints.get(&alias)?.alias != Some(alias)
        || input.value_type.as_deref() != Some(declared.canonical.as_str())
        || !matches!(&input.field, JsMcpField::Nominal { name } if name == &declared.canonical)
    {
        return None;
    }
    Some(())
}

/// An explicit argument cuts default execution, but cannot alter the child's
/// declaration. Keep the literal default and checked scalar alias on the same
/// owning interface rather than synthesizing required/default-free inputs.
fn explicit_scalar_input(
    ir: &IrProgram,
    child: &IrItem,
    parameter: &IrItem,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<()> {
    let source = checked_source(ir, child, db)?;
    let (position, fact) = source
        .parameters
        .iter()
        .enumerate()
        .find(|(_, fact)| fact.parameter == parameter.id)?;
    let IrItemKind::Param {
        owner,
        index,
        ty: IrType::Known(ty),
        array_bounds: None,
        default,
        default_node,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let scalar = scalar_id(ty)?;
    let param_text = db
        .get(parameter.span.file)?
        .text
        .get(parameter.span.start as usize..parameter.span.end as usize)?;
    if scalar_identity_mismatch(
        *owner,
        *index,
        position,
        parameter,
        child,
        input,
        default,
        param_text,
    ) {
        return None;
    }
    match (default, default_node, &input.default) {
        (None, None, None) => {
            if input.computed_default {
                return None;
            }
        }
        (Some(IrDefault::Literal(value)), Some(node), Some(actual)) => {
            if input.computed_default {
                return None;
            }
            check_literal_default(value, *node, ty, actual, default, db)?;
        }
        // A genuine `=name` default names an earlier required same-type
        // parameter. Static CALL supplies every slot, so the default never
        // evaluates there; the descriptor preserves omission for direct
        // invocation while the join seals the exact reference.
        (Some(IrDefault::Computed { expr, .. }), Some(node), None) => {
            if !input.computed_default {
                return None;
            }
            check_computed_default(ir, child, parameter, ty, expr, *node, db)?;
        }
        _ => return None,
    }
    if let Some(alias) = fact.constraints.as_ref().and_then(|value| value.alias) {
        check_scalar_alias(ir, alias, ty, input)?;
    } else if input.value_type.as_deref() != Some(scalar)
        || !matches!(
            (&input.field, ty),
            (JsMcpField::Integer, ResolvedType::Scalar(Scalar::Int))
                | (
                    JsMcpField::String,
                    ResolvedType::Scalar(Scalar::Text | Scalar::Date)
                )
                | (JsMcpField::Boolean, ResolvedType::Scalar(Scalar::Bool))
                | (JsMcpField::Decimal, ResolvedType::Scalar(Scalar::Decimal))
                | (JsMcpField::Money, ResolvedType::Scalar(Scalar::Money))
                | (JsMcpField::Datetime, ResolvedType::Scalar(Scalar::Datetime))
                | (JsMcpField::Duration, ResolvedType::Scalar(Scalar::Duration))
                | (JsMcpField::User, ResolvedType::Scalar(Scalar::User))
        )
    {
        return None;
    }
    Some(())
}

/// Nullable value slots (`text?`, `file?`, …) widen from their exact inner
/// supply or carry their exact nullable value. The declaration keeps its
/// implicit absence or explicit literal-null default; nothing else becomes
/// a supplied-input admission.
fn nullable_identity_mismatch(
    owner: SymbolId,
    index: usize,
    position: usize,
    parameter: &IrItem,
    child: &IrItem,
    input: &JsOperationField,
    param_text: &str,
) -> bool {
    owner != child.id
        || index != position
        || parameter.module != child.module
        || parameter.canonical != format!("{}.{}", child.canonical, parameter.name)
        || input.name != parameter.name
        || input.required
        || !input.nullable
        || input.array_required.is_some()
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || param_text != parameter.name
}

fn check_null_default(
    value: &TypedExpr,
    node: NodeKey,
    actual: &JsFieldDefault,
    default: &Option<IrDefault>,
    db: &SourceDb,
) -> Option<()> {
    if node.kind != SyntaxKind::Literal as u8
        || value.ty != ResolvedType::Null
        || !matches!(value.expr, IrExpr::Null)
        || value.span != Span::new(node.file, node.start, node.end)
        || db
            .get(node.file)?
            .text
            .get(node.start as usize..node.end as usize)?
            != "null"
        || actual.to_json()
            != super::js::js_field_default(default.as_ref(), None)?.to_json()
    {
        return None;
    }
    Some(())
}

fn explicit_nullable_value_input(
    ir: &IrProgram,
    child: &IrItem,
    parameter: &IrItem,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<()> {
    let source = checked_source(ir, child, db)?;
    let (position, _) = source
        .parameters
        .iter()
        .enumerate()
        .find(|(_, fact)| fact.parameter == parameter.id)?;
    let IrItemKind::Param {
        owner,
        index,
        ty: IrType::Known(ty),
        array_bounds: None,
        default,
        default_node,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let ResolvedType::Nullable(inner) = ty else {
        return None;
    };
    let ResolvedType::Scalar(scalar) = inner.as_ref() else {
        return None;
    };
    let param_text = db
        .get(parameter.span.file)?
        .text
        .get(parameter.span.start as usize..parameter.span.end as usize)?;
    if nullable_identity_mismatch(
        *owner,
        *index,
        position,
        parameter,
        child,
        input,
        param_text,
    ) {
        return None;
    }
    match (default, default_node, &input.default) {
        (None, None, None) => {}
        (Some(IrDefault::Literal(value)), Some(node), Some(actual)) => {
            check_null_default(value, *node, actual, default, db)?;
        }
        _ => return None,
    }
    let expected_value_type = format!("{}?", scalar.as_str());
    if input.value_type.as_deref() != Some(expected_value_type.as_str()) {
        return None;
    }
    match (&input.field, scalar) {
        (JsMcpField::String, Scalar::Text) => {}
        (JsMcpField::File, Scalar::File) => {}
        _ => return None,
    }
    Some(())
}

/// Enum slots keep their exact checked domain: case order and spelling in
/// the descriptor match the declaration, and only required slots join here.
fn enum_identity_mismatch(
    cases_empty: bool,
    owner: SymbolId,
    index: usize,
    position: usize,
    parameter: &IrItem,
    child: &IrItem,
    input: &JsOperationField,
    param_text: &str,
) -> bool {
    cases_empty
        || owner != child.id
        || index != position
        || parameter.module != child.module
        || parameter.canonical != format!("{}.{}", child.canonical, parameter.name)
        || input.name != parameter.name
        || input.required != true
        || input.nullable
        || input.array_required.is_some()
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || input.default.is_some()
        || param_text != parameter.name
}

fn explicit_enum_input(
    ir: &IrProgram,
    child: &IrItem,
    parameter: &IrItem,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<()> {
    let source = checked_source(ir, child, db)?;
    let (position, _) = source
        .parameters
        .iter()
        .enumerate()
        .find(|(_, fact)| fact.parameter == parameter.id)?;
    let IrItemKind::Param {
        owner,
        index,
        ty: IrType::Known(ty),
        array_bounds: None,
        default: None,
        default_node: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let ResolvedType::Enum { cases, .. } = ty else {
        return None;
    };
    let param_text = db
        .get(parameter.span.file)?
        .text
        .get(parameter.span.start as usize..parameter.span.end as usize)?;
    if enum_identity_mismatch(
        cases.is_empty(),
        *owner,
        *index,
        position,
        parameter,
        child,
        input,
        param_text,
    ) {
        return None;
    }
    let expected_value_type = format!("enum({})", cases.join(","));
    if input.value_type.as_deref() != Some(expected_value_type.as_str()) {
        return None;
    }
    match &input.field {
        JsMcpField::Enum { values } if values == cases => {}
        _ => return None,
    }
    Some(())
}

/// Non-file array slots keep their exact element shape. Only required slots
/// or an empty-array literal default join; the supply is the owner's own
/// array parameter under its original spelling.
fn array_identity_mismatch(
    file_array: bool,
    owner: SymbolId,
    index: usize,
    position: usize,
    parameter: &IrItem,
    child: &IrItem,
    input: &JsOperationField,
    param_text: &str,
) -> bool {
    file_array
        || owner != child.id
        || index != position
        || parameter.module != child.module
        || parameter.canonical != format!("{}.{}", child.canonical, parameter.name)
        || input.name != parameter.name
        || input.required
        || input.nullable
        || input.array_required != Some(false)
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || param_text != parameter.name
}

fn check_empty_array_default(
    value: &TypedExpr,
    node: NodeKey,
    ty: &ResolvedType,
    actual: &JsFieldDefault,
    default: &Option<IrDefault>,
    db: &SourceDb,
) -> Option<()> {
    let IrExpr::Array(items) = &value.expr else {
        return None;
    };
    if node.kind != SyntaxKind::Array as u8
        || !items.is_empty()
        || value.ty != *ty
        || value.span != Span::new(node.file, node.start, node.end)
        || actual.to_json()
            != super::js::js_field_default(default.as_ref(), None)?.to_json()
    {
        return None;
    }
    Some(())
}

fn explicit_array_input(
    ir: &IrProgram,
    child: &IrItem,
    parameter: &IrItem,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<()> {
    let source = checked_source(ir, child, db)?;
    let (position, _) = source
        .parameters
        .iter()
        .enumerate()
        .find(|(_, fact)| fact.parameter == parameter.id)?;
    let IrItemKind::Param {
        owner,
        index,
        ty: IrType::Known(ty),
        array_bounds: None,
        default,
        default_node,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let ResolvedType::Array { .. } = ty else {
        return None;
    };
    let param_text = db
        .get(parameter.span.file)?
        .text
        .get(parameter.span.start as usize..parameter.span.end as usize)?;
    if array_identity_mismatch(
        ordinary_file_array(ty),
        *owner,
        *index,
        position,
        parameter,
        child,
        input,
        param_text,
    ) {
        return None;
    }
    match (default, default_node, &input.default) {
        (None, None, None) => {}
        (Some(IrDefault::Literal(value)), Some(node), Some(actual)) => {
            check_empty_array_default(value, *node, ty, actual, default, db)?;
        }
        _ => return None,
    }
    Some(())
}

fn source_scalar_literal(value: &TypedExpr, db: &SourceDb) -> bool {
    let Some(source) = db.get(value.span.file).and_then(|file| {
        file.text
            .get(value.span.start as usize..value.span.end as usize)
    }) else {
        return false;
    };
    match &value.expr {
        IrExpr::Int(actual) => source.parse::<i128>().ok().as_ref() == Some(actual),
        IrExpr::Text(actual) => {
            decode_json_string(source, value.span.start, value.span.file)
                .ok()
                .as_ref()
                == Some(actual)
        }
        IrExpr::Bool(actual) => source == if *actual { "true" } else { "false" },
        _ => false,
    }
}

fn ordinary_file_array(ty: &ResolvedType) -> bool {
    matches!(ty, ResolvedType::Array {element, ordered: true, nonempty: false}
        if element.as_ref() == &ResolvedType::Scalar(Scalar::File))
}

/// Rich inputs retain the original operand, including scalar siblings of a
/// Ref/File slot. Span/type equality alone cannot seal a renamed member.
fn checked_rich_call_operands(
    ir: &IrProgram,
    owner: &IrItem,
    entries: &[(String, TypedExpr)],
    at: Span,
    db: &SourceDb,
) -> Option<()> {
    let source = checked_source(ir, owner, db)?;
    let census = source.expression_types.as_deref()?;
    let text = &db.get(source.node.file)?.text;
    let (tree, diagnostics) = crate::syntax::parse_source(source.node.file, text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut pending = vec![&tree];
    let mut authored = None;
    let mut steps = 0;
    while let Some(node) = pending.pop() {
        steps += 1;
        if steps > 200000 {
            return None;
        }
        if node.kind == SyntaxKind::Call && node.span == at && authored.replace(node).is_some() {
            return None;
        }
        pending.extend(node.children.iter());
    }
    let authored = authored?;
    let mut objects = authored
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Object);
    let object = objects.next()?;
    if objects.next().is_some() {
        return None;
    }
    let originals: Vec<_> = object
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::ObjectEntry)
        .collect();
    if originals.len() != entries.len() {
        return None;
    }
    for ((name, value), entry) in entries.iter().zip(originals) {
        let key = entry
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        let original = entry
            .children
            .iter()
            .find(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::NameRef
                        | SyntaxKind::Literal
                        | SyntaxKind::Group
                        | SyntaxKind::Member
                        | SyntaxKind::Binary
                        | SyntaxKind::Unary
                        | SyntaxKind::Array
                        | SyntaxKind::Call
                )
            })
            .unwrap_or(key);
        if key.token()?.text(text) != name {
            return None;
        }
        checked_rich_operand(value, original, census, text, 0)?;
    }
    Some(())
}

/// Seal one original typed decision operand without rechecking a program.
pub(super) fn checked_original_expression(ir: &IrProgram, owner: &IrItem,
    value: &TypedExpr, db: &SourceDb) -> Option<()> {
    let source = checked_source(ir, owner, db)?;
    let text = &db.get(source.node.file)?.text;
    let (tree, diagnostics) = crate::syntax::parse_source(source.node.file, text);
    if diagnostics.iter().any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error) { return None; }
    let mut pending = vec![&tree];
    let mut steps = 0;
    while let Some(node) = pending.pop() {
        steps += 1;
        if steps > 200000 { return None; }
        if node.span == value.span && rich_operand_children(node).len() != 0 &&
            matches!(node.kind, SyntaxKind::Binary | SyntaxKind::Member | SyntaxKind::NameRef) {
            return checked_rich_operand(value, node, source.expression_types.as_deref()?, text, 0);
        }
        pending.extend(node.children.iter());
    }
    None
}

fn operand_token<'t>(
    original: &SyntaxNode,
    kind: SyntaxKind,
    text: &'t str,
) -> Option<&'t str> {
    original
        .children
        .iter()
        .find(|node| node.kind == kind)
        .and_then(|node| node.token())
        .map(|token| token.text(text))
}

fn operand_word<'t>(original: &SyntaxNode, text: &'t str) -> Option<&'t str> {
    if original.kind == SyntaxKind::Name {
        return original.token().map(|token| token.text(text));
    }
    let children: Vec<_> = original
        .children
        .iter()
        .filter(|node| !matches!(node.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect();
    let [name] = children.as_slice() else {
        return None;
    };
    (name.kind == SyntaxKind::Name)
        .then(|| name.token().map(|token| token.text(text)))
        .flatten()
}

fn unwrap_operand_group<'a>(
    actual: &TypedExpr,
    original: &'a crate::syntax::SyntaxNode,
    census: &[(NodeKey, ResolvedType)],
) -> Option<&'a crate::syntax::SyntaxNode> {
    use crate::analysis::NodeKey;
    let mut original = original;
    while original.kind == SyntaxKind::Group {
        let children = rich_operand_children(original);
        let [child] = children.as_slice() else {
            return None;
        };
        if census
            .iter()
            .find(|(node, _)| *node == NodeKey::of(child))
            .is_none_or(|(_, ty)| ty != &actual.ty)
        {
            return None;
        }
        original = child;
    }
    Some(original)
}

fn check_special_member(
    base: &TypedExpr,
    field: &str,
    actual_span: Span,
    first: &str,
    second: &str,
) -> bool {
    matches!(first, "actor" | "now" | "team" | "operation")
        && second == field
        && matches!(&base.expr, IrExpr::Name(name) if name == "c")
        && base.ty == ResolvedType::Unknown
        && base.span == actual_span
}

fn check_member_operand(
    base: &TypedExpr,
    field: &str,
    original: &SyntaxNode,
    census: &[(NodeKey, ResolvedType)],
    text: &str,
    depth: usize,
) -> Option<()> {
    let children = rich_operand_children(original);
    let [receiver] = children.as_slice() else {
        return None;
    };
    let member = original
        .children
        .iter()
        .rev()
        .find(|node| node.kind == SyntaxKind::Name)?;
    if member.token()?.text(text) != field {
        return None;
    }
    checked_rich_operand(base, receiver, census, text, depth + 1)?;
    Some(())
}

fn check_duration_operand(value: &i128, spelling: &str) -> Option<()> {
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
    if duration != Some(*value) {
        return None;
    }
    Some(())
}

fn match_scalar_operand(
    expr: &IrExpr,
    original: &SyntaxNode,
    text: &str,
) -> Option<bool> {
    let token = |kind| operand_token(original, kind, text);
    Some(match expr {
        IrExpr::Int(value) => token(SyntaxKind::Integer)?.parse::<i128>().ok()? == *value,
        IrExpr::Decimal(value) => token(SyntaxKind::Decimal)? == value,
        IrExpr::Text(value) => {
            original
                .children
                .iter()
                .find(|node| node.kind == SyntaxKind::String)?
                .token()?
                .string_value
                .as_ref()?
                == value
        }
        IrExpr::Bool(value) => {
            token(SyntaxKind::Name)? == if *value { "true" } else { "false" }
        }
        IrExpr::Null => token(SyntaxKind::Name)? == "null",
        IrExpr::DurationMs(value) => {
            check_duration_operand(value, token(SyntaxKind::Duration)?)?;
            true
        }
        _ => return None,
    })
}

fn check_binary_operand(
    op: &super::ir::IrBinOp,
    left: &TypedExpr,
    right: &TypedExpr,
    original: &SyntaxNode,
    census: &[(NodeKey, ResolvedType)],
    text: &str,
    depth: usize,
) -> Option<()> {
    let children = rich_operand_children(original);
    let [source_left, source_right] = children.as_slice() else {
        return None;
    };
    let operator = original
        .children
        .iter()
        .find(|node| matches!(node.kind, SyntaxKind::Name | SyntaxKind::Punct))?;
    use super::ir::IrBinOp;
    let spelling = match op {
        IrBinOp::Add => "+",
        IrBinOp::Sub => "-",
        IrBinOp::Mul => "*",
        IrBinOp::Div => "/",
        IrBinOp::Mod => "%",
        IrBinOp::Eq => "==",
        IrBinOp::Ne => "!=",
        IrBinOp::Lt => "<",
        IrBinOp::Le => "<=",
        IrBinOp::Gt => ">",
        IrBinOp::Ge => ">=",
        IrBinOp::And => "and",
        IrBinOp::Or => "or",
        IrBinOp::Coalesce => "??",
        IrBinOp::In => "in",
    };
    if operator.token()?.text(text) != spelling {
        return None;
    }
    checked_rich_operand(left, source_left, census, text, depth + 1)?;
    checked_rich_operand(right, source_right, census, text, depth + 1)?;
    Some(())
}

fn checked_rich_operand(
    actual: &TypedExpr,
    original: &crate::syntax::SyntaxNode,
    census: &[(crate::analysis::NodeKey, ResolvedType)],
    text: &str,
    depth: usize,
) -> Option<()> {
    use crate::analysis::NodeKey;
    if depth > 64
        || actual.span != original.span
        || census
            .iter()
            .find(|(node, _)| *node == NodeKey::of(original))
            .is_none_or(|(_, ty)| ty != &actual.ty)
    {
        return None;
    }
    let original = unwrap_operand_group(actual, original, census)?;
    let matched = match (&actual.expr, original.kind) {
        (IrExpr::Name(name), SyntaxKind::NameRef | SyntaxKind::Name) => {
            operand_word(original, text)? == name
        }
        (IrExpr::Member { base, field }, SyntaxKind::NameRef | SyntaxKind::Name) => {
            check_special_member(
                base,
                field,
                actual.span,
                operand_word(original, text)?,
                operand_word(original, text)?,
            )
        }
        (IrExpr::Member { base, field }, SyntaxKind::Member) => {
            check_member_operand(base, field, original, census, text, depth)?;
            true
        }
        (literal, SyntaxKind::Literal) => match_scalar_operand(literal, original, text)?,
        (IrExpr::Binary { op, left, right }, SyntaxKind::Binary) => {
            check_binary_operand(op, left, right, original, census, text, depth)?;
            true
        }
        _ => false,
    };
    matched.then_some(())
}

fn rich_operand_children(node: &crate::syntax::SyntaxNode) -> Vec<&crate::syntax::SyntaxNode> {
    node.children
        .iter()
        .filter(|child| {
            matches!(
                child.kind,
                SyntaxKind::NameRef
                    | SyntaxKind::Literal
                    | SyntaxKind::Group
                    | SyntaxKind::Member
                    | SyntaxKind::Binary
                    | SyntaxKind::Unary
                    | SyntaxKind::Array
                    | SyntaxKind::Call
            )
        })
        .collect()
}

/// Fully supplied child inputs retain their original literal-empty default.
/// Only the parent recipe's original whole stored File array supplies them;
/// this carrier does not create observations or admit arbitrary File values.
fn check_file_input_operand<'a, 'b>(
    ir: &'a IrProgram,
    owner: &IrItem,
    child: &IrItem,
    parameter: &IrItem,
    value: &TypedExpr,
    input: &JsOperationField,
    operations: &'b [JsOperation],
    db: &SourceDb,
) -> Option<(
    &'a IrItem,
    &'b JsOperationField,
    SymbolId,
    bool,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractField,
)> {
    explicit_file_array_declaration(ir, child, parameter, input, db)?;
    let original = super::scenario_receipts::stored_file_array_operand(ir, owner, value, db)?;
    if !ordinary_file_array(&value.ty)
        || value.ty != original.ty
        || original.required_array
        || original.reuse.is_some()
        || original.min.is_some()
        || original.max.as_ref()?.1 != 8
    {
        return None;
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    if field != &original.name {
        return None;
    }
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    let mut parents = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|parameter| parameter.name == *name);
    let parent = parents.next()?;
    let parent_descriptor = operations
        .iter()
        .find(|operation| operation.name == owner.canonical)?;
    if parent_descriptor.kind != JsOperationKind::Scenario {
        return None;
    }
    let mut descriptors = parent_descriptor
        .inputs
        .iter()
        .filter(|input| input.name == *name);
    let parent_input = descriptors.next()?;
    let (model, nullable) = explicit_reference_declaration(ir, owner, parent, parent_input, db)?;
    if parents.next().is_some()
        || descriptors.next().is_some()
        || nullable
        || model != original.owner
    {
        return None;
    }
    Some((parent, parent_input, model, nullable, original))
}

fn return_dependency_mismatch(
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    declaration: &IrItem,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    value: &TypedExpr,
    dependency_id: &Option<String>,
) -> bool {
    read.id.is_empty()
        || read.source != source.source
        || read.node.kind != SyntaxKind::Member as u8
        || read.role != DependencyRole::Data
        || read.model != original.owner
        || read.model_name != declaration.canonical
        || read.field != original.id
        || read.field_name != original.name
        || read.ty != value.ty
        || read.type_id != "file[]"
        || dependency_id.as_ref().is_some_and(|id| id != &read.id)
}

fn match_return_dependency(
    ir: &IrProgram,
    returned: &crate::analysis::scenario_disclosure::DisclosureReturn,
    returns: &[serde_json::Value],
    value: &TypedExpr,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    entry: &str,
    dependency_id: &mut Option<String>,
) -> Option<()> {
    let mut dependencies = returned.dependencies.iter().filter(|read| {
        read.node.file == value.span.file
            && read.node.start == value.span.start
            && read.node.end == value.span.end
            && read.calls.is_empty()
    });
    let Some(read) = dependencies.next() else {
        return Some(());
    };
    let declaration = ir.items.get(original.owner.0 as usize)?;
    if dependencies.next().is_some()
        || return_dependency_mismatch(read, declaration, source, original, value, dependency_id)
    {
        return None;
    }
    let mut published_returns = returns.iter().filter(|actual| actual["id"] == returned.id);
    let actual = published_returns.next()?;
    if published_returns.next().is_some() {
        return None;
    }
    let mut published_dependencies = actual["dependencies"]
        .as_array()?
        .iter()
        .filter(|dependency| dependency["id"] == read.id);
    let actual = published_dependencies.next()?;
    let expected = serde_json::json!({"id":read.id,"source":{
        "path":read.source.path,"sha256":read.source.sha256,"module":entry},
        "role":"data","model":read.model_name,"field":read.field_name,"type":"file[]"});
    if published_dependencies.next().is_some() || actual != &expected {
        return None;
    }
    *dependency_id = Some(read.id.clone());
    Some(())
}

fn explicit_stored_file_input(
    ir: &IrProgram,
    declarations: (&IrItem, &IrItem, &IrItem),
    value: &TypedExpr,
    input: &JsOperationField,
    operations: &[JsOperation],
    native: (
        &str,
        Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
    ),
    db: &SourceDb,
) -> Option<String> {
    let (owner, child, parameter) = declarations;
    let (entry, feasibility) = native;
    let (_parent, _parent_input, _model, _nullable, original) =
        check_file_input_operand(ir, owner, child, parameter, value, input, operations, db)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let source = checked_source(ir, owner, db)?;
    let parent_descriptor = operations.iter().find(|operation| operation.name == owner.canonical)?;
    let published = parent_descriptor.disclosure.as_ref()?;
    if published["version"] != 1
        || published["source"]["path"] != source.source.path
        || published["source"]["sha256"] != source.source.sha256
        || published["source"]["module"] != entry
    {
        return None;
    }
    checked_child_return_subset(ir, owner, checked, published, feasibility)?;
    let paths: Vec<_> = match feasibility
        .filter(|_| super::scenario_feasibility::requires_projection(checked, ir))
    {
        Some(prepared) => prepared.returns(ir, owner.id)?,
        None => checked.returns.iter().collect(),
    };
    let returns = published["returns"].as_array()?;
    let mut dependency_id = None;
    for returned in paths {
        match_return_dependency(
            ir,
            returned,
            returns,
            value,
            original,
            source,
            entry,
            &mut dependency_id,
        )?;
    }
    dependency_id
}

fn file_array_param_shape(
    parameter: &IrItem,
) -> Option<(SymbolId, usize, &ResolvedType, &TypedExpr, &NodeKey)> {
    let IrItemKind::Param {
        owner: parent,
        index,
        ty: IrType::Known(ty),
        array_bounds: None,
        default: Some(IrDefault::Literal(value)),
        default_node: Some(node),
        default_copy_source: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    Some((*parent, *index, ty, value, node))
}

fn file_array_param_mismatch(
    ir: &IrProgram,
    owner: &IrItem,
    parameter: &IrItem,
    fact: &CheckedScenarioParameter,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    parent: SymbolId,
    index: usize,
    position: usize,
    ty: &ResolvedType,
    value: &TypedExpr,
    node: &NodeKey,
) -> Option<bool> {
    let expression_ok = source
        .expression_types
        .as_deref()?
        .iter()
        .find(|(at, _)| at == node)
        .is_none_or(|(_, ty)| ty != &value.ty);
    Some(
        parent != owner.id
            || index != position
            || parameter.id != fact.parameter
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
            || !ordinary_file_array(ty)
            || value.ty != *ty
            || !matches!(&value.expr, IrExpr::Array(values) if values.is_empty())
            || node.kind != SyntaxKind::Array as u8
            || value.span != Span::new(node.file, node.start, node.end)
            || fact.constraints.is_some()
            || ir.value_constraints.contains_key(&parameter.id)
            || !expression_ok,
    )
}

fn file_array_input_mismatch(input: &JsOperationField, parameter: &IrItem) -> bool {
    input.name != parameter.name
        || input.required
        || input.nullable
        || input.array_required != Some(false)
        || !matches!(input.field, JsMcpField::File)
        || input.value_type.as_deref() != Some("file[]")
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
}

fn file_array_default_mismatch(parameter: &IrItem, input: &JsOperationField) -> Option<bool> {
    Some(
        input.default.as_ref()?.to_json()
            != super::js::js_field_default(
                match &parameter.kind {
                    IrItemKind::Param { default, .. } => default.as_ref(),
                    _ => None,
                },
                None,
            )?
            .to_json(),
    )
}

fn file_param_syntax_mismatch(
    declaration: &crate::syntax::SyntaxNode,
    name: &crate::syntax::SyntaxNode,
    array_type: &crate::syntax::SyntaxNode,
    scalar: &crate::syntax::SyntaxNode,
    open: &crate::syntax::SyntaxNode,
    close: &crate::syntax::SyntaxNode,
    parameter: &IrItem,
    fact: &CheckedScenarioParameter,
    text: &str,
) -> bool {
    declaration.kind != SyntaxKind::Parameter
        || name.span != parameter.span
        || name.token().is_none_or(|token| token.text(text) != parameter.name)
        || NodeKey::of(array_type) != fact.type_node
        || scalar.kind != SyntaxKind::Name
        || scalar.token().is_none_or(|token| token.text(text) != "file")
        || open.token().is_none_or(|token| token.text(text) != "[")
        || close.token().is_none_or(|token| token.text(text) != "]")
}

fn parse_scenario_tree<'d>(
    db: &'d SourceDb,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<(&'d str, crate::syntax::SyntaxNode)> {
    let text = &db.get(source.node.file)?.text;
    let (tree, diagnostics) = crate::syntax::parse_source(source.node.file, text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    Some((text, tree))
}

fn find_param_syntax_nodes<'t>(
    tree: &'t crate::syntax::SyntaxNode,
    fact_node: &NodeKey,
    default_node: &NodeKey,
) -> Option<(
    &'t crate::syntax::SyntaxNode,
    &'t crate::syntax::SyntaxNode,
)> {
    let mut pending = vec![tree];
    let mut declaration = None;
    let mut default = None;
    let mut steps = 0;
    while let Some(part) = pending.pop() {
        steps += 1;
        if steps > 200000 {
            return None;
        }
        if NodeKey::of(part) == *fact_node {
            declaration = Some(part);
        }
        if NodeKey::of(part) == *default_node {
            default = Some(part);
        }
        pending.extend(part.children.iter());
    }
    Some((declaration?, default?))
}

fn file_param_syntax_parts<'t>(
    declaration: &'t crate::syntax::SyntaxNode,
    default: &'t crate::syntax::SyntaxNode,
) -> Option<(
    &'t crate::syntax::SyntaxNode,
    &'t crate::syntax::SyntaxNode,
    &'t crate::syntax::SyntaxNode,
    &'t crate::syntax::SyntaxNode,
    &'t crate::syntax::SyntaxNode,
)> {
    let name = declaration
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::Name)?;
    let array_type = declaration
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::ArrayType)?;
    let named_type = array_type
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::NamedType)?;
    let path = named_type
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::Path)?;
    let parts: Vec<_> = path
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    let [scalar] = parts.as_slice() else {
        return None;
    };
    let parts: Vec<_> = default
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    let [open, close] = parts.as_slice() else {
        return None;
    };
    Some((name, array_type, scalar, open, close))
}

fn explicit_file_array_declaration(
    ir: &IrProgram,
    owner: &IrItem,
    parameter: &IrItem,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<()> {
    let source = checked_source(ir, owner, db)?;
    let (position, fact) = source
        .parameters
        .iter()
        .enumerate()
        .find(|(_, fact)| fact.parameter == parameter.id)?;
    let (parent, index, ty, value, node) = file_array_param_shape(parameter)?;
    if file_array_param_mismatch(
        ir, owner, parameter, fact, source, parent, index, position, ty, value, node,
    )? || file_array_input_mismatch(input, parameter)
    {
        return None;
    }
    if file_array_default_mismatch(parameter, input)? {
        return None;
    }
    let (text, tree) = parse_scenario_tree(db, source)?;
    let (declaration, default) = find_param_syntax_nodes(&tree, &fact.node, node)?;
    let (name, array_type, scalar, open, close) = file_param_syntax_parts(declaration, default)?;
    if file_param_syntax_mismatch(
        declaration,
        name,
        array_type,
        scalar,
        open,
        close,
        parameter,
        fact,
        text,
    ) {
        return None;
    }
    Some(())
}

/// Singular mutation inputs retain their owning Ref declaration. The supplied
/// value is still the original checked parameter, Create binding or parent
/// operand; this join never manufactures a reference wire or a default value.
fn explicit_reference_input(
    ir: &IrProgram,
    declarations: (&IrItem, &IrItem, &IrItem),
    value: &TypedExpr,
    input: &JsOperationField,
    operations: &[JsOperation],
    call: Span,
    db: &SourceDb,
) -> Option<Option<Span>> {
    let (owner, child, parameter) = declarations;
    let (model, nullable) = explicit_reference_declaration(ir, child, parameter, input, db)?;
    if value.ty
        != (ResolvedType::Record {
            symbol: model,
            stored: true,
        })
    {
        return None;
    }
    if matches!(value.expr, IrExpr::Member { .. }) {
        // The declaration consumes the exact original checked parent chain,
        // required or nullable alike. Its literal null default stays metadata
        // and is never visited.
        if let Some(original) = super::scenario_receipts::checked_narrowed_call_reference(ir, owner, value, db) {
            return (!nullable && original.ty == ResolvedType::Nullable(Box::new(value.ty.clone()))).then_some(None);
        }
        let (_, parent) = super::scenario_receipts::checked_parent_reference(ir, owner, value, db)?;
        return (parent.id == model).then_some(None);
    }
    if nullable {
        return None;
    }
    let IrExpr::Name(name) = &value.expr else {
        return None;
    };
    if db
        .get(value.span.file)?
        .text
        .get(value.span.start as usize..value.span.end as usize)?
        != name
    {
        return None;
    }
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    let mut parents = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|parent| parent.name == *name);
    if let Some(parent) = parents.next() {
        if parents.next().is_some() {
            return None;
        }
        let descriptor = operations.iter().find(|op| op.name == owner.canonical)?;
        if descriptor.kind != JsOperationKind::Scenario {
            return None;
        }
        let original = descriptor.inputs.iter().find(|field| field.name == *name)?;
        let (parent_model, parent_nullable) =
            explicit_reference_declaration(ir, owner, parent, original, db)?;
        return (parent_model == model && !parent_nullable).then_some(None);
    }
    preceding_created_reference(ir, owner, model, name, call, db).map(Some)
}

fn reference_param_shape(
    parameter: &IrItem,
) -> Option<(
    SymbolId,
    usize,
    SymbolId,
    bool,
    &Option<IrDefault>,
    &Option<NodeKey>,
)> {
    let IrItemKind::Param {
        owner: parent,
        index,
        ty: IrType::Known(ty),
        default,
        default_node,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
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
    Some((*parent, *index, *symbol, nullable, default, default_node))
}

fn reference_owner_mismatch(
    ir: &IrProgram,
    owner: &IrItem,
    parameter: &IrItem,
    model: &IrItem,
    fact: &CheckedScenarioParameter,
    parent: SymbolId,
    index: usize,
    position: usize,
    symbol: SymbolId,
) -> bool {
    parent != owner.id
        || index != position
        || parameter.id != fact.parameter
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
        || model.id != symbol
        || !matches!(model.kind, IrItemKind::Model { .. })
        || fact.constraints.is_some()
        || ir.value_constraints.contains_key(&parameter.id)
        || ir.modules.get(model.module.0 as usize).is_none_or(|module| {
            model.canonical != format!("{}.{}", module.name, model.name)
        })
}

fn reference_input_mismatch(
    input: &JsOperationField,
    parameter: &IrItem,
    model: &IrItem,
    nullable: bool,
    db: &SourceDb,
) -> bool {
    input.name != parameter.name
        || input.nullable != nullable
        || input.required == nullable
        || input.array_required.is_some()
        || input.value_type.is_some()
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || !matches!(&input.field, JsMcpField::Ref {model: name, require_version: true}
            if name == &model.canonical)
        || db.get(parameter.span.file).is_none_or(|file| {
            file.text
                .get(parameter.span.start as usize..parameter.span.end as usize)
                != Some(parameter.name.as_str())
        })
        || db.get(model.span.file).is_none_or(|file| {
            file.text
                .get(model.span.start as usize..model.span.end as usize)
                != Some(model.name.as_str())
        })
}

fn reference_import_ok(
    ir: &IrProgram,
    owner: &IrItem,
    model: &IrItem,
    module_name: &str,
    spelling: &str,
    db: &SourceDb,
) -> Option<()> {
    if model.module == owner.module {
        if spelling != model.name {
            return None;
        }
        return Some(());
    }
    let owner_module = ir.modules.get(owner.module.0 as usize)?;
    let mut imports = owner_module
        .imports
        .iter()
        .filter(|import| {
            import.provider == module_name
                && import.from.is_none()
                && db.get(import.provider_span.file).and_then(|file| {
                    file.text.get(
                        import.provider_span.start as usize..import.provider_span.end as usize,
                    )
                }) == Some(module_name)
        })
        .flat_map(|import| import.members.iter())
        .filter(|(name, alias, _)| name == &model.name && alias == name && alias == spelling);
    let (_, _, at) = imports.next()?;
    if imports.next().is_some()
        || db
            .get(at.file)?
            .text
            .get(at.start as usize..at.end as usize)?
            != spelling
    {
        return None;
    }
    Some(())
}

fn check_reference_default(
    nullable: bool,
    default: &Option<IrDefault>,
    default_node: &Option<NodeKey>,
    input_default: Option<&JsFieldDefault>,
    db: &SourceDb,
) -> Option<()> {
    match (nullable, default, default_node, input_default) {
        (false, None, None, None) => Some(()),
        (true, Some(IrDefault::Literal(value)), Some(node), Some(actual))
            if matches!(value.expr, IrExpr::Null)
                && value.ty == ResolvedType::Null
                && node.kind == SyntaxKind::Literal as u8
                && value.span == Span::new(node.file, node.start, node.end)
                && db
                    .get(node.file)?
                    .text
                    .get(node.start as usize..node.end as usize)?
                    == "null"
                && actual.to_json()
                    == super::js::js_field_default(default.as_ref(), None)?.to_json() => Some(()),
        _ => None,
    }
}

fn explicit_reference_declaration(
    ir: &IrProgram,
    owner: &IrItem,
    parameter: &IrItem,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<(SymbolId, bool)> {
    let source = checked_source(ir, owner, db)?;
    let (position, fact) = source
        .parameters
        .iter()
        .enumerate()
        .find(|(_, fact)| fact.parameter == parameter.id)?;
    let (parent, index, symbol, nullable, default, default_node) =
        reference_param_shape(parameter)?;
    let model = ir.items.get(symbol.0 as usize)?;
    if reference_owner_mismatch(
        ir, owner, parameter, model, fact, parent, index, position, symbol,
    ) || reference_input_mismatch(input, parameter, model, nullable, db)
    {
        return None;
    }
    let declared = db
        .get(fact.type_node.file)?
        .text
        .get(fact.type_node.start as usize..fact.type_node.end as usize)?;
    let spelling = if nullable {
        declared.strip_suffix('?')?
    } else {
        declared
    };
    let module_name = ir
        .modules
        .get(model.module.0 as usize)
        .map(|module| module.name.as_str())?;
    reference_import_ok(ir, owner, model, module_name, spelling, db)?;
    check_reference_default(nullable, default, default_node, input.default.as_ref(), db)?;
    Some((symbol, nullable))
}

/// The finite original caller uses the Create immediately before CALL. Seal
/// that actual statement and every input instead of admitting copied names or
/// a row-shaped value merely because its checked type names the same model.
fn preceding_create_statement(effects: &[IrStmt], call: Span) -> Option<&IrStmt> {
    let mut calls = effects
        .iter()
        .enumerate()
        .filter(|(_, statement)| matches!(statement, IrStmt::Call {span, ..} if *span == call));
    let (position, _) = calls.next()?;
    if calls.next().is_some() {
        return None;
    }
    let statement = effects.get(position.checked_sub(1)?)?;
    if !matches!(
        statement,
        IrStmt::Create {
            when: None,
            binding: Some(_),
            ..
        }
    ) {
        return None;
    }
    Some(statement)
}

fn find_create_origin<'a>(
    source: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
    span: Span,
    model: SymbolId,
    name: &str,
    target: &String,
    declaration: &IrItem,
    binding: &String,
    call: Span,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedScenarioCreate> {
    let mut originals = source.creates.as_deref()?.iter().filter(|original| {
        original.node.file == span.file
            && original.node.start == span.start
            && original.node.end == span.end
    });
    let original = originals.next()?;
    if originals.next().is_some()
        || binding != name
        || original.binding != name
        || original.model != model
        || declaration.id != model
        || target != &declaration.canonical
        || original.definition.canonical != *target
        || original.source != source.source
        || original.node.end > call.start
        || original.node.file != call.file
    {
        return None;
    }
    Some(original)
}

fn match_create_proof(
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    model: SymbolId,
    name: &str,
) -> Option<()> {
    let mut proofs = checked
        .effects
        .iter()
        .filter(|proof| proof.node == original.node);
    let proof = proofs.next()?;
    if proofs.next().is_some()
        || proof.source != checked.source
        || !matches!(&proof.kind, DisclosureEffectKind::Create {model: actual, binding, inputs, ..}
            if *actual == model && binding == name && inputs == &original.inputs)
    {
        return None;
    }
    Some(())
}

fn check_create_inputs(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    input: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    if entries.len() != original.inputs.len() {
        return None;
    }
    for ((name, value), fact) in entries.iter().zip(&original.inputs) {
        if name != &fact.name
            || value.ty != fact.ty
            || value.span
                != Span::new(
                    fact.value_node.file,
                    fact.value_node.start,
                    fact.value_node.end,
                )
        {
            return None;
        }
        super::scenario_create_sources::checked_create_operand(
            ir,
            original,
            value,
            fact.value_node,
            db,
        )?;
    }
    Some(())
}

fn preceding_created_reference(
    ir: &IrProgram,
    owner: &IrItem,
    model: SymbolId,
    name: &str,
    call: Span,
    db: &SourceDb,
) -> Option<Span> {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let statement = preceding_create_statement(effects, call)?;
    let IrStmt::Create {
        model: target,
        input,
        when: None,
        binding: Some(binding),
        span,
    } = statement
    else {
        return None;
    };
    let source = checked_source(ir, owner, db)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let declaration = ir.items.get(model.0 as usize)?;
    let original = find_create_origin(
        source,
        *span,
        model,
        name,
        target,
        declaration,
        binding,
        call,
    )?;
    match_create_proof(checked, original, model, name)?;
    check_create_inputs(ir, original, input, db)?;
    Some(*span)
}

fn lower_call_site(
    ir: &IrProgram,
    owner: &IrItem,
    operations: &[JsOperation],
    db: &SourceDb,
    entry: &str,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
    source_calls: &[ScenarioSourceCall],
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    origin: &CallSource,
    module: &super::ir::IrModule,
    text_len: usize,
    stmt: &IrStmt,
    sites: &mut Vec<StaticScenarioCall>,
    matched: &mut HashSet<NodeKey>,
    supplied: &mut HashSet<Span>,
) -> Option<()> {
    let IrStmt::Call {
        target:
            IrEffectCallTarget::Operation {
                source: target_source,
                operation,
            },
        inputs,
        binding,
        result,
        span,
    } = stmt
    else {
        return None;
    };
    check_call_span(sites.len(), module, text_len, span, target_source)?;
    let child = join_call_child(ir, operation, result)?;
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
    let (model_result, query, descriptor) =
        join_call_descriptor(ir, child, *child_read, binding, operations, db)?;
    let result_fact = check_call_result(ir, child, declared, model_result, binding, query, descriptor)?;
    check_call_disclosure(ir, child, operation, descriptor, query, feasibility, entry)?;
    let entries = match_call_proof(checked, inputs, span, operation, matched)?;
    let source_call = check_call_arity(
        ir,
        source_calls,
        sites.len(),
        span,
        operation,
        binding,
        result,
        entries,
        params,
        descriptor,
    )?;
    if query.is_none() {
        check_rich_operands(ir, owner, entries, *span, params, db)?;
    }
    let mut keys = HashSet::new();
    let mut authored = Vec::new();
    let mut file_inputs = Vec::new();
    for ((name, value), fact) in entries.iter().zip(&source_call.inputs) {
        let (param, ty, input) = join_input_param(
            ir, child, params, descriptor, &mut keys, name, value, fact, span, module,
        )?;
        dispatch_call_input(
            ir,
            owner,
            child,
            param,
            ty,
            value,
            name,
            input,
            operations,
            *span,
            entry,
            feasibility,
            db,
            query,
            &mut file_inputs,
            supplied,
        )?;
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
        file_inputs,
    });
    Some(())
}

fn push_branch_statements<'e>(
    stmt: &'e IrStmt,
    depth: usize,
    pending: &mut Vec<(&'e IrStmt, usize)>,
) -> Option<()> {
    match stmt {
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
        _ => return None,
    }
    Some(())
}

fn drive_proven_effect<'e>(
    ir: &IrProgram,
    owner: &IrItem,
    stmt: &'e IrStmt,
    depth: usize,
    pending: &mut Vec<(&'e IrStmt, usize)>,
) -> Option<()> {
    match stmt {
        IrStmt::Emit { span, .. }
        | IrStmt::Schedule { span, .. }
        | IrStmt::Cancel { span, .. } => {
            check_proven_effect(ir, owner, span)?;
        }
        IrStmt::For { body, span, .. } => {
            push_proven_for(ir, owner, span, body, depth, pending)?;
        }
        _ => return None,
    }
    Some(())
}

fn drive_owner_statement<'e>(
    ir: &IrProgram,
    owner: &IrItem,
    operations: &[JsOperation],
    db: &SourceDb,
    entry: &str,
    is_child: bool,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
    native_receipts: Option<
        &std::collections::HashMap<SymbolId, super::scenario_receipts::NativeScenarioReceipt>,
    >,
    source_calls: &[ScenarioSourceCall],
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    origin: &CallSource,
    module: &super::ir::IrModule,
    text_len: usize,
    stmt: &'e IrStmt,
    depth: usize,
    steps: &mut usize,
    pending: &mut Vec<(&'e IrStmt, usize)>,
    sites: &mut Vec<StaticScenarioCall>,
    matched: &mut HashSet<NodeKey>,
    intermediate: &mut HashSet<Span>,
    supplied: &mut HashSet<Span>,
) -> Option<()> {
    *steps += 1;
    if *steps > 16384 || depth > 64 {
        return None;
    }
    match stmt {
        IrStmt::Call { .. } => {
            lower_call_site(
                ir, owner, operations, db, entry, feasibility, source_calls, checked, origin,
                module, text_len, stmt, sites, matched, supplied,
            )?;
        }
        IrStmt::If { .. } | IrStmt::Match { .. } => {
            push_branch_statements(stmt, depth, pending)?;
        }
        IrStmt::Send { .. } if is_child => {
            admit_child_send(ir, owner, checked, operations, feasibility, native_receipts)?;
        }
        IrStmt::Create { .. }
            if super::scenario_receipts::checked_created_model_result(ir, owner).is_some() => {}
        // A child-walk create already proven in the child's own complete
        // disclosure executes in the joined transaction in source order;
        // only unproven top-level creates need M2/supplied accounting.
        IrStmt::Create { span, .. }
            if is_child && is_proven_child_create(checked, span) => {}
        IrStmt::Create { span, .. } if !is_child && native_receipts.is_some_and(|receipts|
            receipts.get(&owner.id).is_some_and(|receipt| operations.iter().any(|operation|
                operation.name == owner.canonical && operation.disclosure.as_ref() == serde_json::to_value(&receipt.plan).ok().as_ref())))
                && is_proven_child_create(checked, span)
                && checked.effects.iter().any(|effect| matches!(effect.kind, DisclosureEffectKind::Call { .. })
                    && effect.node.file == span.file && effect.node.end <= span.start) => {}
        IrStmt::Create { span, .. } if depth == 0 => {
            intermediate.insert(*span);
        }
        IrStmt::Let { .. }
        | IrStmt::Require { .. }
        | IrStmt::Return { .. }
        | IrStmt::Set { .. }
        | IrStmt::Send { .. }
        | IrStmt::Transition { .. } => {}
        // Proven owner effects traverse in source order without joining
        // sites of their own. Unproven statements keep the refusal below.
        IrStmt::Emit { .. } | IrStmt::Schedule { .. } | IrStmt::Cancel { .. } | IrStmt::For { .. } => {
            drive_proven_effect(ir, owner, stmt, depth, pending)?;
        }
        _ => return None,
    }
    Some(())
}

fn check_call_span(
    sites_len: usize,
    module: &super::ir::IrModule,
    text_len: usize,
    span: &Span,
    target_source: &Span,
) -> Option<()> {
    if sites_len >= 200
        || span.file != module.file
        || target_source.file != module.file
        || span.start >= span.end
        || span.end as usize > text_len
        || target_source.start < span.start
        || target_source.end > span.end
    {
        return None;
    }
    Some(())
}

fn join_call_child<'a>(
    ir: &'a IrProgram,
    operation: &SymbolId,
    result: &Option<ResolvedType>,
) -> Option<&'a IrItem> {
    let child = ir.items.get(operation.0 as usize)?;
    if child.id != *operation {
        return None;
    }
    let IrItemKind::Scenario {
        result: declared,
        trusted: false,
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
    Some(child)
}

fn join_call_descriptor<'a, 'b>(
    ir: &'a IrProgram,
    child: &IrItem,
    child_read: bool,
    binding: &Option<String>,
    operations: &'b [JsOperation],
    db: &SourceDb,
) -> Option<(
    Option<SymbolId>,
    Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery>,
    &'b JsOperation,
)> {
    let model_result = super::scenario_receipts::checked_created_model_result(ir, child);
    let query = if child_read {
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
    Some((model_result, query, descriptor))
}

fn check_call_result(
    ir: &IrProgram,
    child: &IrItem,
    declared: &Option<ResolvedType>,
    model_result: Option<SymbolId>,
    binding: &Option<String>,
    query: Option<&crate::analysis::scenario_disclosure::DisclosureQuery>,
    descriptor: &JsOperation,
) -> Option<CallResultFact> {
    match declared {
        Some(ty) if model_result.is_some() && binding.is_some() => {
            let model = ir.items.get(model_result?.0 as usize)?;
            if descriptor.result.as_deref() != Some(model.canonical.as_str()) {
                return None;
            }
            Some(CallResultFact::Model(ty.clone()))
        }
        Some(ty) if query.is_some() => {
            let query = query?;
            let contract = ir
                .items
                .get(query.projection.as_ref()?.contract.0 as usize)?;
            if descriptor.result.as_deref()
                != Some(format!("{}[]", contract.canonical).as_str())
            {
                return None;
            }
            Some(CallResultFact::Opaque(ty.clone()))
        }
        None if descriptor.result.as_deref() == Some("void") => Some(CallResultFact::Void),
        Some(ty)
            if scalar_id(ty) == descriptor.result.as_deref()
                && scalar_id(ty).is_some() =>
        {
            Some(CallResultFact::Scalar(ty.clone()))
        }
        _ => None,
    }
}

fn check_call_disclosure(
    ir: &IrProgram,
    child: &IrItem,
    operation: &SymbolId,
    descriptor: &JsOperation,
    query: Option<&crate::analysis::scenario_disclosure::DisclosureQuery>,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
    entry: &str,
) -> Option<()> {
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
    checked_child_return_subset(ir, child, child_checked, disclosure, feasibility)?;
    if let Some(query) = query {
        match_query_disclosure(ir, query, disclosure, entry)?;
    }
    Some(())
}

fn match_call_proof<'e>(
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    inputs: &'e TypedExpr,
    span: &Span,
    operation: &SymbolId,
    matched: &mut HashSet<NodeKey>,
) -> Option<&'e Vec<(String, TypedExpr)>> {
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
        || !matched.insert(proof.node)
        || proof.source != checked.source
        || !matches!(&proof.kind, DisclosureEffectKind::Call {operation:checked_operation,input_keys} if checked_operation==operation && input_keys==&entries.iter().map(|(name,_)|name.clone()).collect::<Vec<_>>())
    {
        return None;
    }
    Some(entries)
}

fn check_call_arity<'s>(
    ir: &IrProgram,
    source_calls: &'s [ScenarioSourceCall],
    sites_len: usize,
    span: &Span,
    operation: &SymbolId,
    binding: &Option<String>,
    result: &Option<ResolvedType>,
    entries: &[(String, TypedExpr)],
    params: &[SymbolId],
    descriptor: &JsOperation,
) -> Option<&'s ScenarioSourceCall> {
    // Preserve the indexed authored source inputs, including the
    // exact unused binding, rather than matching by name alone.
    let source_call = source_calls.get(sites_len)?;
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
    Some(source_call)
}

fn check_rich_operands(
    ir: &IrProgram,
    owner: &IrItem,
    entries: &Vec<(String, TypedExpr)>,
    span: Span,
    params: &[SymbolId],
    db: &SourceDb,
) -> Option<()> {
    if params.iter().any(|id| {
        let Some(IrItem { kind: IrItemKind::Param { ty: IrType::Known(ty), .. }, .. }) = ir.items.get(id.0 as usize) else {
            return false;
        };
        matches!(ty, ResolvedType::Record { stored: true, .. })
            || matches!(ty, ResolvedType::Nullable(inner) if matches!(inner.as_ref(), ResolvedType::Record { stored: true, .. }))
            || ordinary_file_array(ty)
    }) {
        checked_rich_call_operands(ir, owner, entries, span, db)?;
    }
    Some(())
}

fn join_input_param<'a, 'd, 'e>(
    ir: &'a IrProgram,
    child: &IrItem,
    params: &[SymbolId],
    descriptor: &'d JsOperation,
    keys: &mut HashSet<&'e String>,
    name: &'e String,
    value: &TypedExpr,
    fact: &CallInput,
    span: &Span,
    module: &super::ir::IrModule,
) -> Option<(&'a IrItem, &'a ResolvedType, &'d JsOperationField)> {
    if !keys.insert(name)
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
        ..
    } = &param.kind
    else {
        return None;
    };
    if *param_owner != child.id {
        return None;
    }
    let input = descriptor.inputs.iter().find(|input| input.name == *name)?;
    Some((param, ty, input))
}

fn dispatch_nullable_input(
    ir: &IrProgram,
    child: &IrItem,
    param: &IrItem,
    ty: &ResolvedType,
    value: &TypedExpr,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<bool> {
    let ResolvedType::Nullable(inner) = ty else {
        return Some(false);
    };
    if !matches!(inner.as_ref(), ResolvedType::Scalar(_))
        || (value.ty != *inner.as_ref() && value.ty != *ty)
        || (!simple_value(value)
            && !matches!(
                value.expr,
                IrExpr::Name(_) | IrExpr::Member { .. }
            ))
    {
        return Some(false);
    }
    explicit_nullable_value_input(ir, child, param, input, db)?;
    Some(true)
}

/// A singular File may cross a same-owner CALL only as the unchanged original
/// parent parameter. The child declaration is checked by
/// `explicit_nullable_value_input`; the active parent input and receiving
/// File assignment are checked again by State.
fn forwarded_nullable_file_parameter(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    operations: &[JsOperation],
    db: &SourceDb,
) -> Option<String> {
    let file_type = ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::File)));
    if value.ty != file_type {
        return None;
    }
    let IrExpr::Name(name) = &value.expr else {
        return None;
    };
    if db.get(value.span.file)?.text.get(value.span.start as usize..value.span.end as usize)? != name {
        return None;
    }
    let IrItemKind::Scenario { params, effects, .. } = &owner.kind else {
        return None;
    };
    let source = checked_source(ir, owner, db)?;
    let mut originals = params.iter().enumerate().filter_map(|(index, id)| {
        let parameter = ir.items.get(id.0 as usize)?;
        (parameter.name == *name).then_some((index, parameter))
    });
    let (index, parameter) = originals.next()?;
    if originals.next().is_some() || source.parameters.get(index)?.parameter != parameter.id ||
        source.parameters[index].ty != file_type ||
        !matches!(&parameter.kind, IrItemKind::Param {
            owner: actual, index: actual_index, ty: IrType::Known(actual_type),
            array_bounds: None, ..
        } if *actual == owner.id && *actual_index == index && *actual_type == file_type) ||
        // A same-spelled local binding would change what the CALL reads.
        effects_bind_name(effects, name)
    {
        return None;
    }
    let operation = operations.iter().find(|entry| entry.name == owner.canonical)?;
    let mut inputs = operation.inputs.iter().filter(|input| input.name == *name);
    let input = inputs.next()?;
    if inputs.next().is_some() || !matches!(input.field, JsMcpField::File) ||
        input.value_type.as_deref() != Some("file?") || !input.nullable || input.required ||
        input.array_required.is_some() || input.computed_default
    {
        return None;
    }
    Some(name.clone())
}

fn effects_bind_name(effects: &[IrStmt], name: &str) -> bool {
    let mut pending: Vec<_> = effects.iter().collect();
    let mut visited = 0usize;
    while let Some(effect) = pending.pop() {
        visited += 1;
        if visited > 16384 {
            return true;
        }
        match effect {
            IrStmt::Let { name: bound, .. } | IrStmt::For { item: bound, .. }
                if bound == name => return true,
            IrStmt::Create { binding: Some(bound), .. }
            | IrStmt::Call { binding: Some(bound), .. }
            | IrStmt::Send { binding: Some(bound), .. } if bound == name => return true,
            IrStmt::If { then_branch, else_branch, .. } => {
                pending.extend(then_branch.iter().chain(else_branch));
            }
            IrStmt::Match { arms, .. } => {
                pending.extend(arms.iter().flat_map(|arm| &arm.body));
            }
            IrStmt::For { body, .. } => pending.extend(body),
            _ => {}
        }
    }
    false
}

fn dispatch_value_input(
    ir: &IrProgram,
    child: &IrItem,
    param: &IrItem,
    ty: &ResolvedType,
    value: &TypedExpr,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<bool> {
    if scalar_id(ty).is_some() {
        if ty != &value.ty || !simple_value(value) {
            return None;
        }
        explicit_scalar_input(ir, child, param, input, db)?;
        return Some(true);
    }
    if dispatch_nullable_input(ir, child, param, ty, value, input, db)? {
        return Some(true);
    }
    if matches!(ty, ResolvedType::Enum { .. })
        && value.ty == *ty
        && matches!(value.expr, IrExpr::Name(_) | IrExpr::Member { .. })
    {
        explicit_enum_input(ir, child, param, input, db)?;
        return Some(true);
    }
    if matches!(ty, ResolvedType::Array { .. })
        && !ordinary_file_array(ty)
        && value.ty == *ty
        && matches!(value.expr, IrExpr::Name(_))
    {
        explicit_array_input(ir, child, param, input, db)?;
        return Some(true);
    }
    Some(false)
}

fn dispatch_call_input(
    ir: &IrProgram,
    owner: &IrItem,
    child: &IrItem,
    param: &IrItem,
    ty: &ResolvedType,
    value: &TypedExpr,
    name: &String,
    input: &JsOperationField,
    operations: &[JsOperation],
    span: Span,
    entry: &str,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
    db: &SourceDb,
    query: Option<&crate::analysis::scenario_disclosure::DisclosureQuery>,
    file_inputs: &mut Vec<StaticScenarioCallFileInput>,
    supplied: &mut HashSet<Span>,
) -> Option<()> {
    if query.is_some() {
        if ty != &value.ty {
            return None;
        }
        protected_query_input(ir, owner, param, value, input, operations, db)?;
    } else if dispatch_value_input(ir, child, param, ty, value, input, db)? {
        if *ty == ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::File))) {
            if !matches!(value.expr, IrExpr::Null) {
                let parent_parameter =
                    forwarded_nullable_file_parameter(ir, owner, value, operations, db)?;
                file_inputs.push(StaticScenarioCallFileInput::Forwarded {
                    name: name.clone(),
                    parent_parameter,
                });
            }
        }
    } else if ordinary_file_array(ty) {
        let dependency_id = explicit_stored_file_input(
            ir,
            (owner, child, param),
            value,
            input,
            operations,
            (entry, feasibility),
            db,
        )?;
        file_inputs.push(StaticScenarioCallFileInput::Stored {
            name: name.clone(),
            dependency_id,
        });
    } else if let Some(created) = explicit_reference_input(
        ir,
        (owner, child, param),
        value,
        input,
        operations,
        span,
        db,
    )? {
        supplied.insert(created);
    }
    Some(())
}

fn owner_identity_mismatch(
    owner: &IrItem,
    module: &super::ir::IrModule,
    source: &crate::source::Source,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    db: &SourceDb,
) -> bool {
    module.id != owner.module
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
}

fn seed_owner_walk<'e>(
    source: &crate::source::Source,
    entry: &str,
    guards: &'e [IrStmt],
    effects: &'e [IrStmt],
) -> (CallSource, Vec<(&'e IrStmt, usize)>) {
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
    (origin, pending)
}

fn check_call_coverage(
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    intermediate: &HashSet<Span>,
    supplied: &HashSet<Span>,
    matched: &HashSet<NodeKey>,
    sites: usize,
) -> Option<()> {
    if !intermediate.is_subset(supplied)
        || checked.effects.iter().any(|proof| {
            matches!(proof.kind, DisclosureEffectKind::Call { .. })
                && !matched.contains(&proof.node)
        })
        || checked
            .effects
            .iter()
            .filter(|proof| matches!(proof.kind, DisclosureEffectKind::Call { .. }))
            .count()
            != sites
    {
        return None;
    }
    Some(())
}

fn admit_child_send(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    operations: &[JsOperation],
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
    native_receipts: Option<
        &std::collections::HashMap<SymbolId, super::scenario_receipts::NativeScenarioReceipt>,
    >,
) -> Option<()> {
    // Only the private emitter's complete native producer can release
    // child SEND. Raw/source-only call collection remains refused.
    let receipt = native_receipts?.get(&owner.id)?;
    let descriptor = operations.iter().find(|op| op.name == owner.canonical)?;
    let plan = serde_json::to_value(&receipt.plan).ok()?;
    if descriptor.disclosure.as_ref()? != &plan {
        return None;
    }
    checked_child_return_subset(ir, owner, checked, &plan, feasibility)?;
    Some(())
}

fn check_proven_effect(ir: &IrProgram, owner: &IrItem, span: &Span) -> Option<()> {
    let ScenarioDisclosure::Complete(proven) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    if !proven.effects.iter().any(|proof| {
        proof.node.file == span.file
            && proof.node.start == span.start
            && proof.node.end == span.end
            && matches!(
                &proof.kind,
                DisclosureEffectKind::Emit { .. }
                    | DisclosureEffectKind::Schedule { .. }
                    | DisclosureEffectKind::Cancel { .. }
            )
    }) {
        return None;
    }
    Some(())
}

fn is_proven_child_create(
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    span: &Span,
) -> bool {
    checked.effects.iter().any(|proof| {
        matches!(&proof.kind, DisclosureEffectKind::Create { .. })
            && proof.node.file == span.file
            && proof.node.start == span.start
            && proof.node.end == span.end
    })
}

fn push_proven_for<'e>(
    ir: &IrProgram,
    owner: &IrItem,
    span: &Span,
    body: &'e [IrStmt],
    depth: usize,
    pending: &mut Vec<(&'e IrStmt, usize)>,
) -> Option<()> {
    let ScenarioDisclosure::Complete(proven) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    if !proven.effects.iter().any(|proof| {
        proof.node.file == span.file
            && proof.node.start == span.start
            && proof.node.end == span.end
            && matches!(
                &proof.kind,
                DisclosureEffectKind::For { .. } | DisclosureEffectKind::ForMember { .. }
            )
    }) {
        return None;
    }
    for next in body.iter().rev() {
        pending.push((next, depth + 1));
    }
    Some(())
}

fn collect_owner(
    ir: &IrProgram,
    owner: &IrItem,
    operations: &[JsOperation],
    db: &SourceDb,
    entry: &str,
    is_child: bool,
    prepared: (
        Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
        Option<
            &std::collections::HashMap<SymbolId, super::scenario_receipts::NativeScenarioReceipt>,
        >,
    ),
) -> Option<Vec<StaticScenarioCall>> {
    let (feasibility, native_receipts) = prepared;
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
    if owner_identity_mismatch(owner, module, source, checked, db) {
        return None;
    }
    let (origin, mut pending) = seed_owner_walk(source, entry, guards, effects);
    let text_len = source.text.len();
    let mut sites = Vec::new();
    let mut matched_calls = HashSet::new();
    let mut intermediate_creates = HashSet::new();
    let mut supplied_creates = HashSet::new();
    let source_calls = collect_scenario_source_calls(ir, owner, db)?;
    let mut steps = 0;
    while let Some((stmt, depth)) = pending.pop() {
        drive_owner_statement(
            ir, owner, operations, db, entry, is_child, feasibility, native_receipts,
            &source_calls, checked, &origin, module, text_len, stmt, depth, &mut steps,
            &mut pending, &mut sites, &mut matched_calls, &mut intermediate_creates,
            &mut supplied_creates,
        )?;
    }
    check_call_coverage(
        checked,
        &intermediate_creates,
        &supplied_creates,
        &matched_calls,
        sites.len(),
    )?;
    Some(sites)
}
/// Check the structural admitted query shape for parent recipe preparation.
/// Executable/source correspondence remains owned by the immutable prepared
/// query recipe; the operation producer must publish that real plan before any
/// call capture can be enabled.
fn check_query_source_identity(
    query: &DisclosureQuery,
    scan: &IrQuery,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    child: &IrItem,
    result: &Option<ResolvedType>,
) -> Option<()> {
    let scan_source = scan.source.as_deref()?;
    let source_projection = query.projection.as_ref()?;
    if checked.scenario != child.id
        || source.scenario != child.id
        || !source.read
        || source.result != *result
        || source.source != checked.source
        || source.node != checked.node
        || !source.calls.is_empty()
        || !checked.effects.is_empty()
        || query.source != source.source
        || query.model != source_projection.model
        || query.node != scan_source.node
        || query.domain != scan_source.domain
        || source_projection.source != source.source
    {
        return None;
    }
    Some(())
}

fn check_query_projection_identity(
    query: &DisclosureQuery,
    select: &IrQuery,
    contract: &IrItem,
    result: &Option<ResolvedType>,
) -> Option<()> {
    let select_source = select.source.as_deref()?;
    let projection = select_source.projection.as_deref()?;
    let source_projection = query.projection.as_ref()?;
    if source_projection.node != select_source.node
        || projection.contract != source_projection.contract
        || projection.model != query.model
        || projection.alias != source_projection.alias
        || projection.fields != source_projection.fields
        || contract.id != source_projection.contract
        || !matches!(contract.kind, IrItemKind::Contract { .. })
        || !matches!(result, Some(ResolvedType::Array { element, ordered: true, nonempty: false })
            if matches!(element.as_ref(), ResolvedType::Record {symbol, ..} if *symbol == contract.id))
    {
        return None;
    }
    Some(())
}

fn check_scan_shape(query: &DisclosureQuery, scan: &IrQuery) -> Option<()> {
    if query.first.is_some()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.value_order.is_some()
        || !scan.order.is_empty()
        || scan.parent.is_some()
        || scan.select.is_some()
        || scan.where_async
        || scan.collection_call.is_some()
        || scan.contract_collection_call.is_some()
        || !matches!(&scan.domain, super::ir::IrQueryDomain::Model(name) if name == &query.model_name)
    {
        return None;
    }
    Some(())
}

fn check_select_shape(select: &IrQuery) -> Option<()> {
    if select.parent.is_some()
        || select.where_pred.is_some()
        || select.where_async
        || select.value_order.is_some()
        || !select.order.is_empty()
        || select.limit.is_some()
        || select.archived.is_some()
        || select.collection_call.is_some()
        || select.contract_collection_call.is_some()
        || !matches!(&select.domain, super::ir::IrQueryDomain::Value { .. })
    {
        return None;
    }
    Some(())
}

fn check_return_shape(
    query: &DisclosureQuery,
    returned: &DisclosureReturn,
    guard: Span,
    returned_span: Span,
) -> Option<()> {
    let cardinality_guard = query.cardinality_guard?;
    if cardinality_guard.file != guard.file
        || cardinality_guard.start != guard.start
        || cardinality_guard.end != guard.end
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
    Some(())
}

fn check_projection_entry(
    ir: &IrProgram,
    contract: &IrItem,
    contract_fields: &[SymbolId],
    name: &str,
    value: &TypedExpr,
    fact: &CheckedQueryProjectionField,
    alias: &str,
) -> Option<()> {
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
    Some(())
}

fn check_projection_entries(
    ir: &IrProgram,
    contract: &IrItem,
    select: &IrQuery,
    projection_fields: &[CheckedQueryProjectionField],
) -> Option<()> {
    let selected = select.select.as_deref()?;
    let IrExpr::Object(entries) = &selected.expr else {
        return None;
    };
    let alias = select.select_param.as_ref()?;
    if entries.len() != projection_fields.len() {
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
    for ((name, value), fact) in entries.iter().zip(projection_fields) {
        check_projection_entry(ir, contract, contract_fields, name, value, fact, alias)?;
    }
    Some(())
}

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
    let source_projection = query.projection.as_ref()?;
    let contract = ir.items.get(source_projection.contract.0 as usize)?;
    check_query_source_identity(query, scan, source, checked, child, result)?;
    check_query_projection_identity(query, select, contract, result)?;
    check_scan_shape(query, scan)?;
    check_select_shape(select)?;
    check_return_shape(query, returned, *guard, *returned_span)?;
    // Join projection slots by their original index and authored expression,
    // so swapped/copied values cannot retain a nominal source plan.
    check_projection_entries(ir, contract, select, &source_projection.fields)?;
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
    for mapped in &query.projection.as_ref()?.fields {
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

fn check_record_ref(
    ir: &IrProgram,
    symbol: SymbolId,
    descriptor: &JsOperationField,
    bounds: &Option<super::ir::IrParameterArrayBounds>,
    require_version: bool,
) -> Option<()> {
    let model = ir.items.get(symbol.0 as usize)?;
    if model.id != symbol
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
    Some(())
}

fn check_array_ref(
    ir: &IrProgram,
    element: &Box<ResolvedType>,
    descriptor: &JsOperationField,
    bounds: &Option<super::ir::IrParameterArrayBounds>,
    require_version: bool,
) -> Option<()> {
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
    Some(())
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
                check_record_ref(ir, *symbol, descriptor, bounds, require_version)?;
            }
            ResolvedType::Array {
                element,
                ordered: true,
                nonempty: false,
            } if matches!(element.as_ref(), ResolvedType::Record { stored: true, .. }) => {
                check_array_ref(ir, element, descriptor, bounds, require_version)?;
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

fn check_stored_parent_input(
    original_input: &JsOperationField,
    model: &IrItem,
) -> Option<()> {
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
    Some(())
}

fn check_stored_array_target(
    element: &Box<ResolvedType>,
    bounds: &Option<super::ir::IrParameterArrayBounds>,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    input: &JsOperationField,
) -> Option<SymbolId> {
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
    Some(*symbol)
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
    check_stored_parent_input(original_input, model)?;
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
    let target = check_stored_target(ty, value, original, input, bounds)?;
    let model = ir.items.get(target.0 as usize)?;
    (model.id == target && matches!(model.kind, IrItemKind::Model { .. })
        && matches!(&input.field, JsMcpField::Ref { model: name, require_version: false } if name == &model.canonical))
        .then_some(())
}

fn check_stored_target(
    ty: &ResolvedType,
    value: &TypedExpr,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    input: &JsOperationField,
    bounds: &Option<super::ir::IrParameterArrayBounds>,
) -> Option<SymbolId> {
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
            *symbol
        }
        ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        } => {
            check_stored_array_target(element, bounds, original, input)?
        }
        _ => return None,
    };
    Some(target)
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

