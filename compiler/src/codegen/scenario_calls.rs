//! Internal source-bound static call facts. No artifact or execution transport.
use super::ir::{
    IrDefault, IrEffectCallTarget, IrExpr, IrItem, IrItemKind, IrJudgmentGenerated, IrProgram,
    IrStmt, IrType, TypedExpr,
};
use super::js::{JsMcpField, JsOperation, JsOperationField, JsOperationKind};
use crate::analysis::resolve::SymbolId;
use crate::analysis::scenario_disclosure::{
    DependencyRole, DisclosureEffectKind, ScenarioDisclosure,
};
use crate::analysis::{ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::{SyntaxKind, decode_json_string};
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
#[serde(rename_all = "camelCase")]
pub struct StaticScenarioCallFileInput {
    pub name: String,
    pub dependency_id: String,
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
    /// Original stored File occurrences are supplied by this parent dependency.
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
            || ir.value_constraints.get(&parameter.id) != fact.constraints.as_ref()
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
    if *owner != child.id
        || *index != position
        || parameter.module != child.module
        || parameter.canonical != format!("{}.{}", child.canonical, parameter.name)
        || input.name != parameter.name
        || input.required != default.is_none()
        || input.nullable
        || input.array_required.is_some()
        || input.min.is_some()
        || input.max.is_some()
        || db
            .get(parameter.span.file)?
            .text
            .get(parameter.span.start as usize..parameter.span.end as usize)?
            != parameter.name
    {
        return None;
    }
    match (default, default_node, &input.default) {
        (None, None, None) => {
            if input.computed_default {
                return None;
            }
        }
        (Some(IrDefault::Literal(value)), Some(node), Some(actual)) => {
            if input.computed_default
                || node.kind != SyntaxKind::Literal as u8
                || value.ty != *ty
                || value.span != Span::new(node.file, node.start, node.end)
                || !source_scalar_literal(value, db)
                || actual.to_json()
                    != super::js::js_field_default(default.as_ref(), None)?.to_json()
            {
                return None;
            }
        }
        // A genuine `=name` default names an earlier required same-type
        // parameter. Static CALL supplies every slot, so the default never
        // evaluates there; the descriptor preserves omission for direct
        // invocation while the join seals the exact reference.
        (Some(IrDefault::Computed { expr, .. }), Some(node), None) => {
            if !input.computed_default {
                return None;
            }
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
        }
        _ => return None,
    }
    if let Some(alias) = fact.constraints.as_ref().and_then(|value| value.alias) {
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
    if *owner != child.id
        || *index != position
        || parameter.module != child.module
        || parameter.canonical != format!("{}.{}", child.canonical, parameter.name)
        || input.name != parameter.name
        || input.required
        || !input.nullable
        || input.array_required.is_some()
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || db
            .get(parameter.span.file)?
            .text
            .get(parameter.span.start as usize..parameter.span.end as usize)?
            != parameter.name
    {
        return None;
    }
    match (default, default_node, &input.default) {
        (None, None, None) => {}
        (Some(IrDefault::Literal(value)), Some(node), Some(actual)) => {
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
    if cases.is_empty()
        || *owner != child.id
        || *index != position
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
        || db
            .get(parameter.span.file)?
            .text
            .get(parameter.span.start as usize..parameter.span.end as usize)?
            != parameter.name
    {
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
    if ordinary_file_array(ty)
        || *owner != child.id
        || *index != position
        || parameter.module != child.module
        || parameter.canonical != format!("{}.{}", child.canonical, parameter.name)
        || input.name != parameter.name
        || input.required
        || input.nullable
        || input.array_required != Some(false)
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || db
            .get(parameter.span.file)?
            .text
            .get(parameter.span.start as usize..parameter.span.end as usize)?
            != parameter.name
    {
        return None;
    }
    match (default, default_node, &input.default) {
        (None, None, None) => {}
        (Some(IrDefault::Literal(value)), Some(node), Some(actual)) => {
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
    let token = |kind| {
        original
            .children
            .iter()
            .find(|node| node.kind == kind)
            .and_then(|node| node.token())
            .map(|token| token.text(text))
    };
    let word = || {
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
    };
    let matched = match (&actual.expr, original.kind) {
        (IrExpr::Name(name), SyntaxKind::NameRef | SyntaxKind::Name) => word()? == name,
        (IrExpr::Member { base, field }, SyntaxKind::NameRef | SyntaxKind::Name) => {
            matches!(word()?, "actor" | "now" | "team" | "operation")
                && word()? == field
                && matches!(&base.expr, IrExpr::Name(name) if name == "c")
                && base.ty == ResolvedType::Unknown
                && base.span == actual.span
        }
        (IrExpr::Member { base, field }, SyntaxKind::Member) => {
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
            true
        }
        (IrExpr::Int(value), SyntaxKind::Literal) => {
            token(SyntaxKind::Integer)?.parse::<i128>().ok()? == *value
        }
        (IrExpr::Decimal(value), SyntaxKind::Literal) => token(SyntaxKind::Decimal)? == value,
        (IrExpr::Text(value), SyntaxKind::Literal) => {
            original
                .children
                .iter()
                .find(|node| node.kind == SyntaxKind::String)?
                .token()?
                .string_value
                .as_ref()?
                == value
        }
        (IrExpr::Bool(value), SyntaxKind::Literal) => {
            token(SyntaxKind::Name)? == if *value { "true" } else { "false" }
        }
        (IrExpr::Null, SyntaxKind::Literal) => token(SyntaxKind::Name)? == "null",
        (IrExpr::DurationMs(value), SyntaxKind::Literal) => {
            let spelling = token(SyntaxKind::Duration)?;
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
            duration == Some(*value)
        }
        (IrExpr::Binary { op, left, right }, SyntaxKind::Binary) => {
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
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let source = checked_source(ir, owner, db)?;
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
        let mut dependencies = returned.dependencies.iter().filter(|read| {
            read.node.file == value.span.file
                && read.node.start == value.span.start
                && read.node.end == value.span.end
                && read.calls.is_empty()
        });
        let Some(read) = dependencies.next() else {
            continue;
        };
        let declaration = ir.items.get(original.owner.0 as usize)?;
        if dependencies.next().is_some()
            || read.id.is_empty()
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
        dependency_id = Some(read.id.clone());
    }
    dependency_id
}

fn explicit_file_array_declaration(
    ir: &IrProgram,
    owner: &IrItem,
    parameter: &IrItem,
    input: &JsOperationField,
    db: &SourceDb,
) -> Option<()> {
    use crate::analysis::NodeKey;
    let source = checked_source(ir, owner, db)?;
    let (position, fact) = source
        .parameters
        .iter()
        .enumerate()
        .find(|(_, fact)| fact.parameter == parameter.id)?;
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
    if *parent != owner.id
        || *index != position
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
        || source
            .expression_types
            .as_deref()?
            .iter()
            .find(|(at, _)| at == node)
            .is_none_or(|(_, ty)| ty != &value.ty)
        || input.name != parameter.name
        || input.required
        || input.nullable
        || input.array_required != Some(false)
        || !matches!(input.field, JsMcpField::File)
        || input.value_type.as_deref() != Some("file[]")
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || input.default.as_ref()?.to_json()
            != super::js::js_field_default(
                match &parameter.kind {
                    IrItemKind::Param { default, .. } => default.as_ref(),
                    _ => None,
                },
                None,
            )?
            .to_json()
    {
        return None;
    }
    let text = &db.get(source.node.file)?.text;
    let (tree, diagnostics) = crate::syntax::parse_source(source.node.file, text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut pending = vec![&tree];
    let mut declaration = None;
    let mut default = None;
    let mut steps = 0;
    while let Some(part) = pending.pop() {
        steps += 1;
        if steps > 200000 {
            return None;
        }
        if NodeKey::of(part) == fact.node {
            declaration = Some(part);
        }
        if NodeKey::of(part) == *node {
            default = Some(part);
        }
        pending.extend(part.children.iter());
    }
    let declaration = declaration?;
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
    let default = default?;
    let parts: Vec<_> = default
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    let [open, close] = parts.as_slice() else {
        return None;
    };
    if declaration.kind != SyntaxKind::Parameter
        || name.span != parameter.span
        || name.token()?.text(text) != parameter.name
        || NodeKey::of(array_type) != fact.type_node
        || scalar.kind != SyntaxKind::Name
        || scalar.token()?.text(text) != "file"
        || open.token()?.text(text) != "["
        || close.token()?.text(text) != "]"
    {
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
    let model = ir.items.get(symbol.0 as usize)?;
    let module = ir.modules.get(model.module.0 as usize)?;
    if *parent != owner.id
        || *index != position
        || parameter.id != fact.parameter
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
        || model.id != *symbol
        || !matches!(model.kind, IrItemKind::Model { .. })
        || model.canonical != format!("{}.{}", module.name, model.name)
        || fact.constraints.is_some()
        || ir.value_constraints.contains_key(&parameter.id)
        || input.name != parameter.name
        || input.nullable != nullable
        || input.required == nullable
        || input.array_required.is_some()
        || input.value_type.is_some()
        || input.min.is_some()
        || input.max.is_some()
        || input.computed_default
        || !matches!(&input.field, JsMcpField::Ref {model: name, require_version: true}
            if name == &model.canonical)
        || db
            .get(parameter.span.file)?
            .text
            .get(parameter.span.start as usize..parameter.span.end as usize)?
            != parameter.name
        || db
            .get(model.span.file)?
            .text
            .get(model.span.start as usize..model.span.end as usize)?
            != model.name
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
    if model.module == owner.module {
        if spelling != model.name {
            return None;
        }
    } else {
        let owner_module = ir.modules.get(owner.module.0 as usize)?;
        let mut imports = owner_module
            .imports
            .iter()
            .filter(|import| {
                import.provider == module.name
                    && import.from.is_none()
                    && db.get(import.provider_span.file).and_then(|file| {
                        file.text.get(
                            import.provider_span.start as usize..import.provider_span.end as usize,
                        )
                    }) == Some(module.name.as_str())
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
    }
    match (nullable, default, default_node, &input.default) {
        (false, None, None, None) => {}
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
                    == super::js::js_field_default(default.as_ref(), None)?.to_json() => {}
        _ => return None,
    }
    Some((*symbol, nullable))
}

/// The finite original caller uses the Create immediately before CALL. Seal
/// that actual statement and every input instead of admitting copied names or
/// a row-shaped value merely because its checked type names the same model.
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
    let mut calls = effects
        .iter()
        .enumerate()
        .filter(|(_, statement)| matches!(statement, IrStmt::Call {span, ..} if *span == call));
    let (position, _) = calls.next()?;
    if calls.next().is_some() {
        return None;
    }
    let IrStmt::Create {
        model: target,
        input,
        when: None,
        binding: Some(binding),
        span,
    } = effects.get(position.checked_sub(1)?)?
    else {
        return None;
    };
    let source = checked_source(ir, owner, db)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let mut originals = source.creates.as_deref()?.iter().filter(|original| {
        original.node.file == span.file
            && original.node.start == span.start
            && original.node.end == span.end
    });
    let original = originals.next()?;
    let declaration = ir.items.get(model.0 as usize)?;
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
    Some(*span)
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
    let mut intermediate_creates = HashSet::new();
    let mut supplied_creates = HashSet::new();
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
                        let contract = ir
                            .items
                            .get(query.projection.as_ref()?.contract.0 as usize)?;
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
                checked_child_return_subset(ir, child, child_checked, disclosure, feasibility)?;
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
                if query.is_none() && params.iter().any(|id| {
                    let Some(IrItem { kind: IrItemKind::Param { ty: IrType::Known(ty), .. }, .. }) = ir.items.get(id.0 as usize) else {
                        return false;
                    };
                    matches!(ty, ResolvedType::Record { stored: true, .. })
                        || matches!(ty, ResolvedType::Nullable(inner) if matches!(inner.as_ref(), ResolvedType::Record { stored: true, .. }))
                        || ordinary_file_array(ty)
                }) {
                    checked_rich_call_operands(ir, owner, entries, *span, db)?;
                }
                let mut keys = HashSet::new();
                let mut authored = Vec::new();
                let mut file_inputs = Vec::new();
                for ((name, value), fact) in entries.iter().zip(&source_call.inputs) {
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
                    if query.is_some() {
                        if ty != &value.ty {
                            return None;
                        }
                        protected_query_input(ir, owner, param, value, input, operations, db)?;
                    } else if scalar_id(ty).is_some() {
                        if ty != &value.ty || !simple_value(value) {
                            return None;
                        }
                        explicit_scalar_input(ir, child, param, input, db)?;
                    } else if let ResolvedType::Nullable(inner) = ty
                        && matches!(inner.as_ref(), ResolvedType::Scalar(_))
                        && (value.ty == *inner.as_ref() || value.ty == *ty)
                        && (simple_value(value)
                            || matches!(
                                value.expr,
                                IrExpr::Name(_) | IrExpr::Member { .. }
                            ))
                    {
                        explicit_nullable_value_input(ir, child, param, input, db)?;
                    } else if matches!(ty, ResolvedType::Enum { .. })
                        && value.ty == *ty
                        && matches!(value.expr, IrExpr::Name(_) | IrExpr::Member { .. })
                    {
                        explicit_enum_input(ir, child, param, input, db)?;
                    } else if matches!(ty, ResolvedType::Array { .. })
                        && !ordinary_file_array(ty)
                        && value.ty == *ty
                        && matches!(value.expr, IrExpr::Name(_))
                    {
                        explicit_array_input(ir, child, param, input, db)?;
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
                        file_inputs.push(StaticScenarioCallFileInput {
                            name: name.clone(),
                            dependency_id,
                        });
                    } else if let Some(created) = explicit_reference_input(
                        ir,
                        (owner, child, param),
                        value,
                        input,
                        operations,
                        *span,
                        db,
                    )? {
                        supplied_creates.insert(created);
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
                    file_inputs,
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
            IrStmt::Send { .. } if is_child => {
                // Only the private emitter's complete native producer can release
                // child SEND. Raw/source-only call collection remains refused.
                let receipt = native_receipts?.get(&owner.id)?;
                let descriptor = operations.iter().find(|op| op.name == owner.canonical)?;
                let plan = serde_json::to_value(&receipt.plan).ok()?;
                if descriptor.disclosure.as_ref()? != &plan {
                    return None;
                }
                checked_child_return_subset(ir, owner, checked, &plan, feasibility)?;
            }
            IrStmt::Create { .. }
                if super::scenario_receipts::checked_created_model_result(ir, owner).is_some() => {}
            // A child-walk create already proven in the child's own complete
            // disclosure executes in the joined transaction in source order;
            // only unproven top-level creates need M2/supplied accounting.
            IrStmt::Create { span, .. }
                if is_child
                    && checked.effects.iter().any(|proof| {
                        matches!(&proof.kind, DisclosureEffectKind::Create { .. })
                            && proof.node.file == span.file
                            && proof.node.start == span.start
                            && proof.node.end == span.end
                    }) => {}
            IrStmt::Create { span, .. } if depth == 0 => {
                intermediate_creates.insert(*span);
            }
            IrStmt::Let { .. }
            | IrStmt::Require { .. }
            | IrStmt::Return { .. }
            | IrStmt::Set { .. }
            | IrStmt::Send { .. }
            | IrStmt::Transition { .. } => {}
            // Proven owner effects traverse in source order without joining
            // sites of their own. Unproven statements keep the refusal below.
            IrStmt::Emit { span, .. }
            | IrStmt::Schedule { span, .. }
            | IrStmt::Cancel { span, .. } => {
                let ScenarioDisclosure::Complete(proven) =
                    ir.scenario_disclosures.get(&owner.id)?
                else {
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
            }
            IrStmt::For { body, span, .. } => {
                let ScenarioDisclosure::Complete(proven) =
                    ir.scenario_disclosures.get(&owner.id)?
                else {
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
            }
            _ => return None,
        }
    }
    if !intermediate_creates.is_subset(&supplied_creates)
        || checked.effects.iter().any(|proof| {
            matches!(proof.kind, DisclosureEffectKind::Call { .. })
                && !matched_calls.contains(&proof.node)
        })
        || checked
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
    let source_projection = query.projection.as_ref()?;
    let cardinality_guard = query.cardinality_guard?;
    if query.first.is_some() {
        return None;
    }
    let contract = ir.items.get(source_projection.contract.0 as usize)?;
    if checked.scenario != child.id
        || source.scenario != child.id
        || !source.read
        || source.result != *result
        || source.source != checked.source
        || source.node != checked.node
        || !source.calls.is_empty()
        || !checked.effects.is_empty()
        || query.source != source.source
        || source_projection.source != source.source
        || query.model != source_projection.model
        || query.node != scan_source.node
        || query.domain != scan_source.domain
        || source_projection.node != select_source.node
        || projection.contract != source_projection.contract
        || projection.model != query.model
        || projection.alias != source_projection.alias
        || projection.fields != source_projection.fields
        || contract.id != source_projection.contract
        || !matches!(contract.kind, IrItemKind::Contract { .. })
        || !matches!(result, Some(ResolvedType::Array { element, ordered: true, nonempty: false })
            if matches!(element.as_ref(), ResolvedType::Record {symbol, ..} if *symbol == contract.id))
        || query.limit.is_some()
        || query.archived
        || !query.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.value_order.is_some()
        || !scan.order.is_empty()
        || scan.parent.is_some()
        || scan.select.is_some()
        || scan.where_async
        || scan.collection_call.is_some()
        || scan.contract_collection_call.is_some()
        || select.parent.is_some()
        || select.where_pred.is_some()
        || select.where_async
        || select.value_order.is_some()
        || !select.order.is_empty()
        || select.limit.is_some()
        || select.archived.is_some()
        || select.collection_call.is_some()
        || select.contract_collection_call.is_some()
        || !matches!(&scan.domain, super::ir::IrQueryDomain::Model(name) if name == &query.model_name)
        || !matches!(&select.domain, super::ir::IrQueryDomain::Value { .. })
        || cardinality_guard.file != guard.file
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

#[cfg(test)]
mod prepared_child_tests {
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    use crate::analysis::check_program;
    use crate::source::SourceDb;
    use std::path::Path;

    #[test]
    fn original_ask_child_joins_only_the_same_authenticated_successful_return_subset() {
        let mut db = SourceDb::new();
        let file = db.add(
            "CanChat.can".into(),
            include_str!("../../tests/fixtures/original-a850/CanChat.can").into(),
        );
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let path = root
            .parent()
            .unwrap()
            .join("packages/cloudflare/dist/native-catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = super::super::ir::build(&program, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let child = ir
            .items
            .iter()
            .find(|item| item.canonical == "chat.ask")
            .unwrap();
        let ScenarioDisclosure::Complete(checked) = &ir.scenario_disclosures[&child.id] else {
            panic!("original proof");
        };
        assert_eq!(checked.returns.len(), 256);
        let prepared =
            super::super::scenario_feasibility::prepare(&program, &ir, &db, catalog.as_ref())
                .unwrap();
        let selected = prepared.returns(&ir, child.id).unwrap();
        assert_eq!(selected.len(), 1);
        let ScenarioDisclosure::Complete(original) = &program.scenario_disclosures()[&child.id]
        else {
            panic!("original immutable source proof");
        };
        assert!(
            original
                .returns
                .iter()
                .any(|row| std::ptr::eq(row, selected[0]))
        );
        let descriptor = serde_json::json!({"returns":[{"id":selected[0].id}]});
        assert!(
            checked_child_return_subset(&ir, child, checked, &descriptor, Some(&prepared))
                .is_some()
        );
        assert!(checked_child_return_subset(&ir, child, checked, &descriptor, None).is_none());
        let copied = ir.clone();
        assert!(
            checked_child_return_subset(&copied, child, checked, &descriptor, Some(&prepared))
                .is_none()
        );
        for rows in [
            serde_json::json!([]),
            serde_json::json!([{"id":"copied"}]),
            serde_json::json!([{"id":selected[0].id},{"id":selected[0].id}]),
        ] {
            assert!(
                checked_child_return_subset(
                    &ir,
                    child,
                    checked,
                    &serde_json::json!({"returns":rows}),
                    Some(&prepared)
                )
                .is_none()
            );
        }
        let conservative = serde_json::json!({"returns":checked.returns.iter().map(|row|serde_json::json!({"id":row.id})).collect::<Vec<_>>()});
        assert!(
            checked_child_return_subset(&ir, child, checked, &conservative, Some(&prepared))
                .is_none()
        );
        assert_eq!(
            checked.returns.len(),
            256,
            "complete original proof remains unchanged"
        );
    }
}
