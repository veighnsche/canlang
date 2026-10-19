//! Original nullable current Revision sites, without reference promotion.
//! The native consumer chooses the released receiver at the actual leaf; the
//! initial presence read must still perform its ordinary null comparison.
use std::collections::{HashMap, HashSet};

use crate::analysis::NodeKey;
use crate::analysis::resolve::{ModuleId, SymbolId};
use crate::analysis::scenario_disclosure::{
    CheckedScenarioSource, CheckedStoredContractField, CheckedStoredContractSchema, DependencyRole,
    DisclosureDependency, DisclosureSource, ScenarioDisclosure,
};
use crate::analysis::types::{ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{
    IrBinOp, IrDefault, IrExpr, IrItem, IrItemKind, IrOwner, IrProgram, IrServer, IrStmt, IrType,
    TypedExpr,
};

/// An actual source getter and its original observations. DATA reuse of the
/// Let is a separate observation, not another getter or a promotion recipe.
pub(super) struct CurrentRevisionRead<'a> {
    pub value: &'a TypedExpr,
    pub control: &'a DisclosureDependency,
    pub data: Option<&'a DisclosureDependency>,
}

pub(super) struct CurrentRevisionLeaf<'a> {
    pub value: &'a TypedExpr,
    pub dependency: &'a DisclosureDependency,
}

pub(super) struct CurrentRevisionSites<'a> {
    pub parameter: &'a IrItem,
    pub template: &'a CheckedStoredContractSchema,
    pub revision: &'a CheckedStoredContractSchema,
    pub active: Option<CurrentRevisionLeaf<'a>>,
    pub presence: &'a TypedExpr,
    pub presence_read: CurrentRevisionRead<'a>,
    pub published_read: CurrentRevisionRead<'a>,
    pub published: CurrentRevisionLeaf<'a>,
    pub revision_statement: &'a IrStmt,
    pub revision_read: CurrentRevisionRead<'a>,
    pub digest_presence: &'a TypedExpr,
    pub digest_control: CurrentRevisionLeaf<'a>,
    /// This is the first DATA use of the original Let, after its digest guard.
    pub digest_data: CurrentRevisionLeaf<'a>,
    pub outputs: CurrentRevisionLeaf<'a>,
    pub duration: CurrentRevisionLeaf<'a>,
}

/// Borrow only the checked current/published/once-Let lineage. Conservative
/// disclosure paths remain intact; this join selects no Return or native plan.
fn census_nodes(tree: &SyntaxNode) -> Option<HashMap<NodeKey, &SyntaxNode>> {
    let mut nodes = HashMap::new();
    let mut pending = vec![tree];
    while let Some(node) = pending.pop() {
        if nodes.len() >= 200000 {
            return None;
        }
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter());
    }
    Some(nodes)
}

fn do_effects(scenario: &SyntaxNode) -> Option<(&SyntaxNode, Vec<&SyntaxNode>)> {
    let mut bodies = scenario
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::DoBlock);
    let body = bodies.next()?;
    if bodies.next().is_some() {
        return None;
    }
    let authored_effects: Vec<_> = body
        .children
        .iter()
        .filter(|node| {
            matches!(
                node.kind,
                SyntaxKind::Let
                    | SyntaxKind::Require
                    | SyntaxKind::Create
                    | SyntaxKind::Set
                    | SyntaxKind::Send
                    | SyntaxKind::Return
                    | SyntaxKind::Call
            )
        })
        .collect();
    Some((body, authored_effects))
}

fn select_revision_let(effects: &[IrStmt]) -> Option<(usize, &IrStmt, &TypedExpr)> {
    let mut lets = effects
        .iter()
        .enumerate()
        .filter_map(|(index, statement)| match statement {
            IrStmt::Let { value, .. }
                if matches!(&value.expr, IrExpr::Member { field, .. } if field == "current") =>
            {
                Some((index, statement, value))
            }
            _ => None,
        });
    let (let_index, revision_statement, revision_value) = lets.next()?;
    if lets.next().is_some()
        || effects[..let_index]
            .iter()
            .any(|statement| !matches!(statement, IrStmt::Let { .. } | IrStmt::Require { .. }))
    {
        return None;
    }
    Some((let_index, revision_statement, revision_value))
}

fn select_contract_schema(
    inventory: &[CheckedStoredContractSchema],
    id: SymbolId,
) -> Option<&CheckedStoredContractSchema> {
    let mut candidates = inventory
        .iter()
        .filter(|schema| schema.model && schema.id == id);
    let found = candidates.next()?;
    candidates.next().is_none().then_some(found)
}

fn check_template_revision(
    ir: &IrProgram,
    owner_module: ModuleId,
    template: &CheckedStoredContractSchema,
    revision: &CheckedStoredContractSchema,
    template_id: SymbolId,
    revision_id: SymbolId,
    source: &DisclosureSource,
) -> Option<()> {
    if template.module != owner_module
        || revision.module != owner_module
        || template.source != *source
        || revision.source != *source
        || revision.parent != Some(template_id)
        || !matches!(&ir.items.get(revision_id.0 as usize)?.kind,
            IrItemKind::Model { owner: IrOwner::ChildOf(id), .. } if *id == template_id)
    {
        return None;
    }
    Some(())
}

fn check_current_field(
    ir: &IrProgram,
    current: &CheckedStoredContractField,
    revision_canonical: &str,
    nullable_revision: &ResolvedType,
) -> Option<()> {
    if current.ty != *nullable_revision
        || current.declared != format!("{revision_canonical}?")
        || current.required_array
        || current.reuse.is_some()
        || !matches!(
            &ir.items.get(current.id.0 as usize)?.kind,
            IrItemKind::Field {
                default: None,
                server: None,
                ..
            }
        )
    {
        return None;
    }
    Some(())
}

fn collect_leading_guard<'a>(
    guards: &'a [IrStmt],
    authored_guards: &[&SyntaxNode],
    revision_statement: &IrStmt,
    parameter_name: &str,
    template_receiver_ty: &ResolvedType,
    nullable_revision: &ResolvedType,
    revision_value: &TypedExpr,
    syntax: &SourceSites<'_>,
) -> Option<(
    Option<&'a TypedExpr>,
    &'a TypedExpr,
    &'a TypedExpr,
    &'a TypedExpr,
    &'a TypedExpr,
)> {
    if authored_guards.len() != guards.len() {
        return None;
    }
    let mut leading = None;
    for (guard, authored) in guards.iter().zip(authored_guards) {
        let IrStmt::Require { cond, span } = guard else {
            return None;
        };
        if *span != authored.span || span.end > statement_span(revision_statement)?.start {
            return None;
        }
        let parts = expressions(authored);
        // Only the source expression anchor is compared here; wider guard
        // semantics remain owned by the existing scenario correspondence.
        if parts.len() != 1 || parts[0].span != cond.span {
            return None;
        }
        let mut operands = Vec::new();
        flatten_and(cond, &mut operands, 0)?;
        for (position, pair) in operands.windows(2).enumerate() {
            let Some(read) = null_presence(pair[0]) else {
                continue;
            };
            let IrExpr::Member {
                base: published_reference,
                field,
            } = &pair[1].expr
            else {
                continue;
            };
            if field != "published"
                || !current_value(
                    read,
                    parameter_name,
                    template_receiver_ty,
                    nullable_revision,
                )
                || !current_value(
                    published_reference,
                    parameter_name,
                    template_receiver_ty,
                    nullable_revision,
                )
            {
                continue;
            }
            syntax.expression(pair[0], 0)?;
            syntax.expression_at(
                pair[1],
                0,
                Some((
                    key(published_reference, SyntaxKind::Member),
                    &revision_value.ty,
                )),
            )?;
            if leading.is_some() {
                return None;
            }
            let active = operands
                .get(position.wrapping_sub(1))
                .copied()
                .filter(|value| {
                    matches!(&value.expr, IrExpr::Member {base, field} if field == "active"
                    && matches!(&base.expr, IrExpr::Name(name) if name == parameter_name)
                    && base.ty == *template_receiver_ty)
                        && value.ty == ResolvedType::Scalar(Scalar::Bool)
                });
            if let Some(active) = active {
                syntax.expression(active, 0)?;
            }
            leading = Some((active, pair[0], read, pair[1], published_reference.as_ref()));
        }
    }
    leading
}

fn collect_digest_data<'a>(
    effects: &'a [IrStmt],
    let_index: usize,
    authored_effects: &[&SyntaxNode],
    digest_field: &CheckedStoredContractField,
    revision_binding: &str,
    revision_ty: &ResolvedType,
    syntax: &SourceSites<'_>,
) -> Option<(usize, &'a TypedExpr, &'a TypedExpr, Vec<&'a TypedExpr>)> {
    let mut digest_guard = None;
    let mut data_leaves = Vec::new();
    for (index, (statement, authored)) in effects.iter().zip(authored_effects).enumerate() {
        if index <= let_index {
            continue;
        }
        syntax.statement(statement, authored)?;
        match statement {
            IrStmt::Require { cond, .. } if digest_guard.is_none() => {
                if let Some(read) = null_presence(cond)
                    && revision_leaf(
                        read,
                        revision_binding,
                        "digest",
                        &digest_field.ty,
                        revision_ty,
                    )
                {
                    syntax.expression(cond, 0)?;
                    digest_guard = Some((index, cond, read));
                }
            }
            IrStmt::Let { value, .. }
            | IrStmt::Create { input: value, .. }
            | IrStmt::Send { args: value, .. }
            | IrStmt::Set { changes: value, .. } => {
                collect_leaves(value, &mut data_leaves, 0)?;
            }
            _ => {}
        }
    }
    let (digest_index, digest_presence, digest_control_value) = digest_guard?;
    Some((digest_index, digest_presence, digest_control_value, data_leaves))
}

fn resolve_data_leaves<'a>(
    digest_presence: &'a TypedExpr,
    digest_control_value: &'a TypedExpr,
    data_leaves: &[&'a TypedExpr],
    outputs_field: &CheckedStoredContractField,
    duration_field: &CheckedStoredContractField,
    revision_binding: &str,
    revision_ty: &ResolvedType,
    syntax: &SourceSites<'_>,
    effects: &[IrStmt],
    digest_index: usize,
) -> Option<(&'a TypedExpr, &'a TypedExpr, &'a TypedExpr)> {
    let data_leaf = |name: &str, ty: ResolvedType| {
        let mut candidates = data_leaves
            .iter()
            .copied()
            .filter(|value| revision_leaf(value, revision_binding, name, &ty, revision_ty));
        let value = candidates.next()?;
        (candidates.next().is_none() && digest_presence.span.end <= value.span.start)
            .then_some(value)
    };
    let digest_data_value = data_leaf("digest", ResolvedType::Scalar(Scalar::Text))?;
    let outputs_value = data_leaf("outputs", outputs_field.ty.clone())?;
    let duration_value = data_leaf("duration", duration_field.ty.clone())?;
    // The first later use is the original narrowed digest capture, not a
    // recreated current getter or another required-reference promotion.
    if digest_data_value.span.start > outputs_value.span.start
        || outputs_value.span.start >= duration_value.span.start
        || !matches!(effects.get(digest_index + 1)?,
            IrStmt::Let { value, .. } if std::ptr::eq(value, digest_data_value))
    {
        return None;
    }
    for value in [
        digest_control_value,
        digest_data_value,
        outputs_value,
        duration_value,
    ] {
        syntax.expression(value, 0)?;
    }
    Some((digest_data_value, outputs_value, duration_value))
}

fn check_revision_fields<'a>(
    ir: &IrProgram,
    revision: &'a CheckedStoredContractSchema,
) -> Option<(
    &'a CheckedStoredContractField,
    &'a CheckedStoredContractField,
    &'a CheckedStoredContractField,
    &'a CheckedStoredContractField,
)> {
    let published_field = unique_field(revision, "published")?;
    let digest_field = unique_field(revision, "digest")?;
    let outputs_field = unique_field(revision, "outputs")?;
    let duration_field = unique_field(revision, "duration")?;
    for (field, ty, spelling) in [
        (published_field, ResolvedType::Scalar(Scalar::Bool), "bool"),
        (
            digest_field,
            ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text))),
            "text?",
        ),
        (outputs_field, ResolvedType::Scalar(Scalar::Int), "int"),
        (
            duration_field,
            ResolvedType::Scalar(Scalar::Duration),
            "duration",
        ),
    ] {
        if field.ty != ty
            || field.declared != spelling
            || field.reuse.is_some()
            || !matches!(
                &ir.items.get(field.id.0 as usize)?.kind,
                IrItemKind::Field { server: None, .. }
            )
        {
            return None;
        }
    }
    Some((published_field, digest_field, outputs_field, duration_field))
}

fn check_return_order(
    proof: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    presence_control: &DisclosureDependency,
    published_source: &DisclosureDependency,
    published: &DisclosureDependency,
    let_control: &DisclosureDependency,
    let_data: &DisclosureDependency,
    digest_control: &DisclosureDependency,
    digest_data: &DisclosureDependency,
    outputs: &DisclosureDependency,
    duration: &DisclosureDependency,
) -> Option<()> {
    let mut fully_evaluated = false;
    for returned in &proof.returns {
        let position = |read: &DisclosureDependency| {
            returned
                .dependencies
                .iter()
                .position(|actual| actual.id == read.id)
        };
        for (before, after) in [
            (let_control, digest_control),
            (let_data, digest_data),
            (digest_data, outputs),
            (outputs, duration),
        ] {
            if position(before)? >= position(after)? {
                return None;
            }
        }
        if let Some(at) = position(published) {
            if position(published_source)? >= at {
                return None;
            }
            if let Some(presence_at) = position(presence_control) {
                if presence_at >= position(published_source)? {
                    return None;
                }
                fully_evaluated = true;
            }
        }
    }
    if !fully_evaluated {
        return None;
    }
    Some(())
}

fn assemble_revision_reads<'a>(
    proof: &'a crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    source: &CheckedScenarioSource,
    parameter: &'a IrItem,
    template: &'a CheckedStoredContractSchema,
    revision: &'a CheckedStoredContractSchema,
    presence_value: &'a TypedExpr,
    presence: &'a TypedExpr,
    published_reference: &'a TypedExpr,
    published_value: &'a TypedExpr,
    revision_statement: &'a IrStmt,
    revision_value: &'a TypedExpr,
    digest_presence: &'a TypedExpr,
    digest_control_value: &'a TypedExpr,
    digest_data_value: &'a TypedExpr,
    outputs_value: &'a TypedExpr,
    duration_value: &'a TypedExpr,
    active_value: Option<&'a TypedExpr>,
    current: &CheckedStoredContractField,
    published_field: &CheckedStoredContractField,
    digest_field: &CheckedStoredContractField,
    outputs_field: &CheckedStoredContractField,
    duration_field: &CheckedStoredContractField,
) -> Option<CurrentRevisionSites<'a>> {
    let read = |value: &'a TypedExpr, field: &CheckedStoredContractField, role, type_id: &str| {
        original_dependency(proof, source, value, field, role, type_id)
    };
    let active = if let Some(value) = active_value {
        let field = unique_field(template, "active")?;
        if field.ty != ResolvedType::Scalar(Scalar::Bool)
            || field.declared != "bool"
            || field.reuse.is_some()
        {
            return None;
        }
        Some(CurrentRevisionLeaf {
            value,
            dependency: read(value, field, DependencyRole::Control, "bool")?,
        })
    } else {
        None
    };
    let presence_control = read(
        presence_value,
        current,
        DependencyRole::Control,
        &format!("{}?", revision.canonical),
    )?;
    let published_source = read(
        published_reference,
        current,
        DependencyRole::Control,
        &revision.canonical,
    )?;
    let published = read(
        published_value,
        published_field,
        DependencyRole::Control,
        "bool",
    )?;
    let let_control = read(
        revision_value,
        current,
        DependencyRole::Control,
        &revision.canonical,
    )?;
    let let_data = read(
        revision_value,
        current,
        DependencyRole::Data,
        &revision.canonical,
    )?;
    let digest_control = read(
        digest_control_value,
        digest_field,
        DependencyRole::Control,
        "text?",
    )?;
    let digest_data = read(
        digest_data_value,
        digest_field,
        DependencyRole::Data,
        "text",
    )?;
    let outputs = read(outputs_value, outputs_field, DependencyRole::Data, "int")?;
    let duration = read(
        duration_value,
        duration_field,
        DependencyRole::Data,
        "duration",
    )?;
    let reads = [
        presence_control,
        published_source,
        published,
        let_control,
        let_data,
        digest_control,
        digest_data,
        outputs,
        duration,
    ];
    if reads
        .iter()
        .map(|read| &read.id)
        .collect::<HashSet<_>>()
        .len()
        != reads.len()
    {
        return None;
    }
    check_return_order(
        proof,
        presence_control,
        published_source,
        published,
        let_control,
        let_data,
        digest_control,
        digest_data,
        outputs,
        duration,
    )?;
    Some(CurrentRevisionSites {
        active,
        parameter,
        template,
        revision,
        presence,
        presence_read: CurrentRevisionRead {
            value: presence_value,
            control: presence_control,
            data: None,
        },
        published_read: CurrentRevisionRead {
            value: published_reference,
            control: published_source,
            data: None,
        },
        published: CurrentRevisionLeaf {
            value: published_value,
            dependency: published,
        },
        revision_statement,
        revision_read: CurrentRevisionRead {
            value: revision_value,
            control: let_control,
            data: Some(let_data),
        },
        digest_presence,
        digest_control: CurrentRevisionLeaf {
            value: digest_control_value,
            dependency: digest_control,
        },
        digest_data: CurrentRevisionLeaf {
            value: digest_data_value,
            dependency: digest_data,
        },
        outputs: CurrentRevisionLeaf {
            value: outputs_value,
            dependency: outputs,
        },
        duration: CurrentRevisionLeaf {
            value: duration_value,
            dependency: duration,
        },
    })
}

fn open_revision_proof<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    &'a CheckedScenarioSource,
)> {
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let disclosure = ir.scenario_disclosures.get(&owner.id)?;
    let IrItemKind::Scenario {
        guards,
        effects,
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
    let proof = match disclosure {
        ScenarioDisclosure::Complete(proof) => proof,
        _ => return None,
    };
    if proof.scenario != owner.id
        || proof.node != source.node
        || proof.source != source.source
        || proof.returns.is_empty()
        || effects.len() > 200
        || guards.len() > 200
    {
        return None;
    }
    Some((proof, source))
}

fn resolve_revision_receiver<'a>(
    revision_statement: &'a IrStmt,
    revision_value: &'a TypedExpr,
) -> Option<(&'a str, &'a str, &'a TypedExpr, SymbolId, SymbolId)> {
    let IrStmt::Let {
        name: revision_binding,
        ..
    } = revision_statement
    else {
        return None;
    };
    let IrExpr::Member {
        base: template_receiver,
        field,
    } = &revision_value.expr
    else {
        return None;
    };
    let IrExpr::Name(parameter_name) = &template_receiver.expr else {
        return None;
    };
    let ResolvedType::Record {
        symbol: template_id,
        stored: true,
    } = template_receiver.ty
    else {
        return None;
    };
    let ResolvedType::Record {
        symbol: revision_id,
        stored: true,
    } = revision_value.ty
    else {
        return None;
    };
    if field != "current" {
        return None;
    }
    Some((
        revision_binding.as_str(),
        parameter_name.as_str(),
        template_receiver.as_ref(),
        template_id,
        revision_id,
    ))
}

fn resolve_revision_contract<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    source: &'a CheckedScenarioSource,
    revision_value: &'a TypedExpr,
    template_id: SymbolId,
    revision_id: SymbolId,
    params: &[SymbolId],
    parameter_name: &str,
    template_receiver: &'a TypedExpr,
    syntax: &SourceSites<'_>,
) -> Option<(
    &'a CheckedStoredContractSchema,
    &'a CheckedStoredContractSchema,
    &'a CheckedStoredContractField,
    ResolvedType,
    &'a IrItem,
)> {
    let inventory = source.stored_contracts.as_deref()?;
    let template = select_contract_schema(inventory, template_id)?;
    let revision = select_contract_schema(inventory, revision_id)?;
    check_template_revision(
        ir,
        owner.module,
        template,
        revision,
        template_id,
        revision_id,
        &source.source,
    )?;
    syntax.schema(ir, template, db)?;
    syntax.schema(ir, revision, db)?;
    let current = unique_field(template, "current")?;
    let nullable_revision = ResolvedType::Nullable(Box::new(revision_value.ty.clone()));
    check_current_field(ir, current, &revision.canonical, &nullable_revision)?;
    let parameter = checked_parameter(
        ir,
        owner,
        params,
        parameter_name,
        template_receiver,
        source,
        syntax,
    )?;
    syntax.expression(revision_value, 0)?;
    Some((template, revision, current, nullable_revision, parameter))
}

pub(super) fn checked_current_revision<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    db: &SourceDb,
) -> Option<CurrentRevisionSites<'a>> {
    if !std::ptr::eq(ir.items.get(owner.id.0 as usize)?, owner) {
        return None;
    }
    let (proof, source) = open_revision_proof(ir, owner, db)?;
    let IrItemKind::Scenario {
        params,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };

    let (tree, diagnostics) = crate::syntax::parse(db, source.node.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let text = &db.get(source.node.file)?.text;
    let nodes = census_nodes(&tree)?;
    let syntax = SourceSites {
        nodes: &nodes,
        text,
        source,
    };
    let scenario = *nodes.get(&source.node)?;
    if scenario.kind != SyntaxKind::Scenario {
        return None;
    }
    let (_body, authored_effects) = do_effects(scenario)?;
    // Unsupported/nested statements cannot silently shift a checked binding.
    if authored_effects.len() != effects.len() {
        return None;
    }

    // The native receiver's current/published/digest field roles stay fixed;
    // model, parameter and capture names come from this checked declaration.
    let (let_index, revision_statement, revision_value) = select_revision_let(effects)?;
    syntax.statement(revision_statement, authored_effects[let_index])?;
    let (revision_binding, parameter_name, template_receiver, template_id, revision_id) =
        resolve_revision_receiver(revision_statement, revision_value)?;
    let (template, revision, current, nullable_revision, parameter) = resolve_revision_contract(
        ir,
        owner,
        db,
        source,
        revision_value,
        template_id,
        revision_id,
        params,
        parameter_name,
        template_receiver,
        &syntax,
    )?;

    let authored_guards: Vec<_> = scenario
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Require)
        .collect();
    let (active_value, presence, presence_value, published_value, published_reference) =
        collect_leading_guard(
            guards,
            &authored_guards,
            revision_statement,
            parameter_name,
            &template_receiver.ty,
            &nullable_revision,
            revision_value,
            &syntax,
        )?;
    let (published_field, digest_field, outputs_field, duration_field) =
        check_revision_fields(ir, revision)?;
    let (digest_index, digest_presence, digest_control_value, data_leaves) = collect_digest_data(
        effects,
        let_index,
        &authored_effects,
        digest_field,
        revision_binding,
        &revision_value.ty,
        &syntax,
    )?;
    if effects[let_index + 1..digest_index]
        .iter()
        .any(|statement| !matches!(statement, IrStmt::Let { .. } | IrStmt::Require { .. }))
    {
        return None;
    }
    let (digest_data_value, outputs_value, duration_value) = resolve_data_leaves(
        digest_presence,
        digest_control_value,
        &data_leaves,
        outputs_field,
        duration_field,
        revision_binding,
        &revision_value.ty,
        &syntax,
        effects,
        digest_index,
    )?;

    assemble_revision_reads(
        proof,
        source,
        parameter,
        template,
        revision,
        presence_value,
        presence,
        published_reference,
        published_value,
        revision_statement,
        revision_value,
        digest_presence,
        digest_control_value,
        digest_data_value,
        outputs_value,
        duration_value,
        active_value,
        current,
        published_field,
        digest_field,
        outputs_field,
        duration_field,
    )
}

fn original_dependency<'a>(
    proof: &'a crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    source: &CheckedScenarioSource,
    value: &TypedExpr,
    field: &CheckedStoredContractField,
    role: DependencyRole,
    type_id: &str,
) -> Option<&'a DisclosureDependency> {
    let node = key(value, SyntaxKind::Member);
    let mut typed = source
        .expression_types
        .as_deref()?
        .iter()
        .filter(|(at, _)| *at == node);
    let original_ty = &typed.next()?.1;
    if typed.next().is_some() {
        return None;
    }
    let kind = if role == DependencyRole::Control {
        "read-control"
    } else {
        "read-data"
    };
    let expected_id = sha256_hex(
        format!(
            "scenario-disclosure/v1:{kind}:{}:{}:{}:{}:{}:",
            source.source.path, source.source.sha256, source.source.module, node.start, node.end
        )
        .as_bytes(),
    );
    let mut selected = None;
    for returned in &proof.returns {
        if returned.source != source.source {
            return None;
        }
        let mut candidates = returned
            .dependencies
            .iter()
            .filter(|read| read.node == node && read.role == role);
        let Some(read) = candidates.next() else {
            continue;
        };
        if candidates.next().is_some()
            || read.id != expected_id
            || read.source != source.source
            || !read.calls.is_empty()
            || read.query_id.is_some()
            || read.model != field.owner
            || read.field != field.id
            || read.field_name != field.name
            || &read.ty != original_ty
            || read.type_id != type_id
            || read.model_name != field.canonical.strip_suffix(&format!(".{}", field.name))?
            || selected.is_some_and(|previous| previous != read)
        {
            return None;
        }
        selected = Some(read);
    }
    selected
}

fn parameter_mismatch(
    parameter: &IrItem,
    position: usize,
    owner_id: SymbolId,
    owner_module: ModuleId,
    owner_canonical: &str,
    name: &str,
    authored: &SyntaxNode,
    authored_name: &SyntaxNode,
    text: &str,
    receiver_ty: &ResolvedType,
    original_parameter: SymbolId,
    original_ty: &ResolvedType,
    original_default_present: bool,
    original_constraints_present: bool,
    original_type_node: NodeKey,
    parent: SymbolId,
    index: usize,
    ty: &ResolvedType,
) -> Option<bool> {
    Some(parameter.id != original_parameter
        || parent != owner_id
        || index != position
        || parameter.module != owner_module
        || parameter.canonical != format!("{owner_canonical}.{name}")
        || parameter.span != authored_name.span
        || authored_name.token()?.text(text) != name
        || ty != receiver_ty
        || original_ty != receiver_ty
        || original_default_present
        || original_constraints_present
        || authored.kind != SyntaxKind::Parameter
        || !authored
            .children
            .iter()
            .any(|node| NodeKey::of(node) == original_type_node))
}

fn checked_parameter<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    params: &[SymbolId],
    name: &str,
    receiver: &TypedExpr,
    source: &CheckedScenarioSource,
    syntax: &SourceSites<'_>,
) -> Option<&'a IrItem> {
    let mut candidates = params.iter().enumerate().filter_map(|(index, id)| {
        let item = ir.items.get(id.0 as usize)?;
        (item.name == name).then_some((index, item))
    });
    let (position, parameter) = candidates.next()?;
    let original = source.parameters.get(position)?;
    let IrItemKind::Param {
        owner: parent,
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
    let authored = *syntax.nodes.get(&original.node)?;
    let authored_name = authored
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    if candidates.next().is_some()
        || parameter_mismatch(
            parameter,
            position,
            owner.id,
            owner.module,
            &owner.canonical,
            name,
            authored,
            authored_name,
            syntax.text,
            &receiver.ty,
            original.parameter,
            &original.ty,
            original.default.is_some(),
            original.constraints.is_some(),
            original.type_node,
            *parent,
            *index,
            ty,
        )?
    {
        return None;
    }
    syntax.expression(receiver, 0)?;
    Some(parameter)
}

struct SourceSites<'a> {
    nodes: &'a HashMap<NodeKey, &'a SyntaxNode>,
    text: &'a str,
    source: &'a CheckedScenarioSource,
}

impl SourceSites<'_> {
    fn check_let_statement(
        &self,
        name: &str,
        value: &TypedExpr,
        authored: &SyntaxNode,
    ) -> Option<()> {
        let names: Vec<_> = authored
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::Name)
            .collect();
        if authored.kind != SyntaxKind::Let
            || names.len() != 2
            || names[0].token()?.text(self.text) != "let"
            || names[1].token()?.text(self.text) != name
            || expressions(authored).as_slice().first()?.span != value.span
        {
            return None;
        }
        Some(())
    }

    fn statement(&self, actual: &IrStmt, authored: &SyntaxNode) -> Option<()> {
        if statement_span(actual)? != authored.span {
            return None;
        }
        match actual {
            IrStmt::Let { name, value, .. } => {
                self.check_let_statement(name, value, authored)?;
            }
            IrStmt::Require { cond, .. } if authored.kind == SyntaxKind::Require => {
                if expressions(authored).as_slice().first()?.span != cond.span {
                    return None;
                }
            }
            IrStmt::Create { .. } if authored.kind == SyntaxKind::Create => {}
            IrStmt::Set { .. } if authored.kind == SyntaxKind::Set => {}
            IrStmt::Send { .. } if authored.kind == SyntaxKind::Send => {}
            IrStmt::Return { .. } if authored.kind == SyntaxKind::Return => {}
            IrStmt::Call { .. } if authored.kind == SyntaxKind::Call => {}
            _ => return None,
        }
        Some(())
    }

    fn expression(&self, actual: &TypedExpr, depth: usize) -> Option<()> {
        self.expression_at(actual, depth, None)
    }

    fn check_name_expression(&self, name: &str, authored: &SyntaxNode) -> Option<()> {
        let names: Vec<_> = authored
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::Name)
            .collect();
        if names.len() != 1 || names[0].token()?.text(self.text) != name {
            return None;
        }
        Some(())
    }

    fn check_member_expression(
        &self,
        base: &TypedExpr,
        field: &str,
        authored: &SyntaxNode,
        children: &[&SyntaxNode],
        depth: usize,
        published_current: Option<(NodeKey, &ResolvedType)>,
    ) -> Option<()> {
        if children.len() != 1
            || children[0].span != base.span
            || authored
                .children
                .iter()
                .rev()
                .find(|node| node.kind == SyntaxKind::Name)?
                .token()?
                .text(self.text)
                != field
        {
            return None;
        }
        self.expression_at(base, depth + 1, published_current)?;
        Some(())
    }

    fn check_binary_expression(
        &self,
        op: &IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        authored: &SyntaxNode,
        children: &[&SyntaxNode],
        depth: usize,
        published_current: Option<(NodeKey, &ResolvedType)>,
    ) -> Option<()> {
        let spelling = match op {
            IrBinOp::Ne => "!=",
            IrBinOp::And => "and",
            _ => return None,
        };
        if children.len() != 2
            || children[0].span != left.span
            || children[1].span != right.span
            || !authored.children.iter().any(|node| {
                node.token()
                    .is_some_and(|token| token.text(self.text) == spelling)
            })
        {
            return None;
        }
        self.expression_at(left, depth + 1, published_current)?;
        self.expression_at(right, depth + 1, published_current)?;
        Some(())
    }

    fn check_null_expression(&self, actual: &TypedExpr, authored: &SyntaxNode) -> Option<()> {
        if actual.ty != ResolvedType::Null
            || !authored.children.iter().any(|node| {
                node.token()
                    .is_some_and(|token| token.text(self.text) == "null")
            })
        {
            return None;
        }
        Some(())
    }

    fn expression_at(
        &self,
        actual: &TypedExpr,
        depth: usize,
        published_current: Option<(NodeKey, &ResolvedType)>,
    ) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let kind = match &actual.expr {
            IrExpr::Name(_) => SyntaxKind::NameRef,
            IrExpr::Member { .. } => SyntaxKind::Member,
            IrExpr::Binary { .. } => SyntaxKind::Binary,
            IrExpr::Null => SyntaxKind::Literal,
            _ => return None,
        };
        let key = key(actual, kind);
        let authored = *self.nodes.get(&key)?;
        let mut typed = self
            .source
            .expression_types
            .as_deref()?
            .iter()
            .filter(|(at, _)| *at == key);
        let original_ty = &typed.next()?.1;
        // Member-chain lowering reconstructs this raw current getter with its
        // declared nullable type. The checked published occurrence and its
        // CONTROL observation remain narrowed; no other site borrows this
        // representation exception.
        let raw_current = published_current.is_some_and(|(at, narrowed)| {
            at == key
                && original_ty == narrowed
                && actual.ty == ResolvedType::Nullable(Box::new(narrowed.clone()))
                && matches!(&actual.expr, IrExpr::Member { field, .. } if field == "current")
        });
        if (original_ty != &actual.ty && !raw_current) || typed.next().is_some() {
            return None;
        }
        let children = expressions(authored);
        match &actual.expr {
            IrExpr::Name(name) => {
                self.check_name_expression(name, authored)?;
            }
            IrExpr::Member { base, field } => {
                self.check_member_expression(
                    base,
                    field,
                    authored,
                    &children,
                    depth,
                    published_current,
                )?;
            }
            IrExpr::Binary { op, left, right } => {
                self.check_binary_expression(
                    op,
                    left,
                    right,
                    authored,
                    &children,
                    depth,
                    published_current,
                )?;
            }
            IrExpr::Null => {
                self.check_null_expression(actual, authored)?;
            }
            _ => return None,
        }
        Some(())
    }

    fn check_schema_field(
        &self,
        ir: &IrProgram,
        schema: &CheckedStoredContractSchema,
        field: &CheckedStoredContractField,
        db: &SourceDb,
    ) -> Option<()> {
        super::scenario_receipts::match_stored_contract_field(ir, field, db)?;
        if field.source != schema.source
            || field.owner != schema.id
            || !schema.field_order.contains(&field.id)
        {
            return None;
        }
        Some(())
    }

    fn check_field_identity(
        &self,
        schema: &CheckedStoredContractSchema,
        field: &IrItem,
        id: SymbolId,
        owner: SymbolId,
        required_array: bool,
        authored_name: &SyntaxNode,
    ) -> Option<()> {
        if field.id != id
            || owner != schema.id
            || field.module != schema.module
            || field.canonical != format!("{}.{}", schema.canonical, field.name)
            || field.span != authored_name.span
            || authored_name.token()?.text(self.text) != field.name
            || required_array
        {
            return None;
        }
        Some(())
    }

    fn field_type_position(authored: &SyntaxNode) -> Option<(usize, Vec<&SyntaxNode>)> {
        let parts: Vec<_> = authored
            .children
            .iter()
            .filter(|node| !matches!(node.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
            .collect();
        let type_position = parts.iter().position(|node| {
            matches!(
                node.kind,
                SyntaxKind::NamedType
                    | SyntaxKind::NullableType
                    | SyntaxKind::ArrayType
                    | SyntaxKind::DeliveryType
            )
        })?;
        Some((type_position, parts))
    }

    fn check_field_types(
        &self,
        ir: &IrProgram,
        schema: &CheckedStoredContractSchema,
        ty: &ResolvedType,
        parts: &[&SyntaxNode],
        type_position: usize,
        db: &SourceDb,
        default: &Option<IrDefault>,
        server: &Option<IrServer>,
        unique_modifier: bool,
        machine_modifier: bool,
    ) -> Option<()> {
        field_type_matches(ir, schema, ty, parts[type_position], self.text, db, 0)?;
        let next = parts
            .get(type_position + 1)
            .and_then(|node| node.token())
            .map(|token| token.text(self.text));
        match (next, default, server) {
            (Some("="), Some(IrDefault::Literal(value)), None) => {
                literal_matches(value, parts.get(type_position + 2)?, self.text)?;
                if value.ty != *ty
                    && ty.nullable_inner() != Some(&value.ty)
                    && !(value.ty == ResolvedType::Null && ty.nullable_inner().is_some())
                {
                    return None;
                }
            }
            (Some("server"), None, Some(IrServer::Actor))
                if *ty == ResolvedType::Scalar(Scalar::User)
                    && self
                        .text
                        .get(
                            parts.get(type_position + 3)?.span.start as usize
                                ..parts.get(type_position + 3)?.span.end as usize,
                        )?
                        .trim()
                        == "actor" => {}
            (Some("=") | Some("server"), _, _) => return None,
            (_, None, None) => {}
            _ => return None,
        }
        let has = |word| {
            parts.iter().any(|node| {
                node.token()
                    .is_some_and(|token| token.text(self.text) == word)
            })
        };
        if unique_modifier != has("unique") || machine_modifier != has("machine") {
            return None;
        }
        Some(())
    }

    fn schema(
        &self,
        ir: &IrProgram,
        schema: &CheckedStoredContractSchema,
        db: &SourceDb,
    ) -> Option<()> {
        super::scenario_receipts::match_stored_contract_schema(ir, schema, db)?;
        // These declarations genuinely contain WorkflowDefinition and Images
        // delivery fields. Reuse their immutable checked declaration census.
        ir.committed_sources
            .standard_value_inventory_roots(ir, db)?;
        let model = ir.items.get(schema.id.0 as usize)?;
        let mut declarations = self.nodes.values().filter(|node| {
            node.kind == SyntaxKind::Model
                && node.span.file == schema.span.file
                && node.span.start <= schema.span.start
                && node.span.end >= schema.span.end
        });
        let declaration = *declarations.next()?;
        if declarations.next().is_some()
            || self
                .text
                .get(model.span.start as usize..model.span.end as usize)?
                != model.name
        {
            return None;
        }
        let authored_fields: Vec<_> = declaration
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::Field)
            .collect();
        let declared_fields: Vec<_> = schema
            .field_order
            .iter()
            .filter(|id| {
                ir.items
                    .get(id.0 as usize)
                    .is_some_and(|item| matches!(item.kind, IrItemKind::Field { .. }))
            })
            .collect();
        if authored_fields.len() != declared_fields.len() {
            return None;
        }
        for field in &schema.fields {
            self.check_schema_field(ir, schema, field, db)?;
        }
        // The stored-field census deliberately omits unsupported nominal and
        // delivery values. Still seal every original declaration field here.
        for (id, authored) in declared_fields.into_iter().zip(authored_fields) {
            let field = ir.items.get(id.0 as usize)?;
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(ty),
                default,
                server,
                modifiers,
                required_array,
                ..
            } = &field.kind
            else {
                return None;
            };
            let authored_name = authored
                .children
                .iter()
                .find(|node| node.kind == SyntaxKind::Name)?;
            self.check_field_identity(
                schema,
                field,
                *id,
                *owner,
                *required_array,
                authored_name,
            )?;
            let (type_position, parts) = Self::field_type_position(authored)?;
            self.check_field_types(
                ir,
                schema,
                ty,
                &parts,
                type_position,
                db,
                default,
                server,
                modifiers.unique,
                modifiers.machine,
            )?;
        }
        Some(())
    }
}

fn match_std_nominal(
    ir: &IrProgram,
    schema: &CheckedStoredContractSchema,
    db: &SourceDb,
    ty: &ResolvedType,
    spelling: &str,
    node: &SyntaxNode,
) -> Option<()> {
    let name = crate::analysis::types::checked_standard_nominal_name(ty)?;
    let roots = ir
        .committed_sources
        .standard_value_inventory_roots(ir, db)?;
    let module = ir.modules.get(schema.module.0 as usize)?;
    let imports: Vec<_> = module
        .imports
        .iter()
        .flat_map(|import| {
            import.members.iter().filter_map(move |member| {
                (member.1 == spelling).then_some((import, member))
            })
        })
        .collect();
    let [(import, member)] = imports.as_slice() else {
        return None;
    };
    if node.kind != SyntaxKind::NamedType
        || import.provider != "std"
        || import.from.is_some()
        || member.0 != name
        || !roots
            .iter()
            .any(|(root, at)| root == name && *at == member.2)
    {
        return None;
    }
    Some(())
}

fn match_std_delivery(
    ir: &IrProgram,
    schema: &CheckedStoredContractSchema,
    spelling: &str,
    node: &SyntaxNode,
    capability: &'static str,
    op: &'static crate::analysis::catalog::StdOperation,
) -> Option<()> {
    let original = crate::analysis::catalog::std_operation(capability, op.name)?;
    if !std::ptr::eq(original, op) || node.kind != SyntaxKind::DeliveryType {
        return None;
    }
    let target = spelling.strip_prefix("delivery(")?.strip_suffix(')')?;
    let (alias, operation) = target.rsplit_once('.')?;
    let module = ir.modules.get(schema.module.0 as usize)?;
    let imports: Vec<_> = module
        .imports
        .iter()
        .flat_map(|import| {
            import
                .members
                .iter()
                .filter_map(move |member| (member.1 == alias).then_some((import, member)))
        })
        .collect();
    let [(import, member)] = imports.as_slice() else {
        return None;
    };
    if import.provider != "std"
        || import.from.is_none()
        || operation != op.name
        || crate::analysis::catalog::std_capability(&member.0)?.name != capability
    {
        return None;
    }
    Some(())
}

fn field_type_matches(
    ir: &IrProgram,
    schema: &CheckedStoredContractSchema,
    ty: &ResolvedType,
    node: &SyntaxNode,
    text: &str,
    db: &SourceDb,
    depth: usize,
) -> Option<()> {
    if depth > 64 {
        return None;
    }
    let spelling = text
        .get(node.span.start as usize..node.span.end as usize)?
        .trim();
    if let ResolvedType::Nullable(inner) = ty {
        if node.kind != SyntaxKind::NullableType || !spelling.ends_with('?') {
            return None;
        }
        let base = node
            .children
            .iter()
            .find(|node| matches!(node.kind, SyntaxKind::NamedType | SyntaxKind::DeliveryType))?;
        return field_type_matches(ir, schema, inner, base, text, db, depth + 1);
    }
    let matches = match ty {
        ResolvedType::Scalar(scalar) => {
            node.kind == SyntaxKind::NamedType && spelling == scalar.as_str()
        }
        ResolvedType::Record {
            symbol,
            stored: true,
        } => {
            let target = ir.items.get(symbol.0 as usize)?;
            node.kind == SyntaxKind::NamedType
                && target.module == schema.module
                && (spelling == target.name || spelling == target.canonical)
                && matches!(target.kind, IrItemKind::Model { .. })
        }
        ResolvedType::StdNominal { .. } => {
            match_std_nominal(ir, schema, db, ty, spelling, node)?;
            true
        }
        ResolvedType::StdDelivery { capability, op } => {
            match_std_delivery(ir, schema, spelling, node, capability, op)?;
            true
        }
        _ => false,
    };
    matches.then_some(())
}

fn duration_literal_value(source: &str) -> Option<i128> {
    let split = source.find(|ch: char| !ch.is_ascii_digit())?;
    let amount = source[..split].parse::<i128>().ok()?;
    let unit = match &source[split..] {
        "ms" => 1,
        "s" => 1000,
        "m" => 60000,
        "h" => 3600000,
        "d" => 86400000,
        _ => return None,
    };
    amount.checked_mul(unit)
}

fn check_duration_literal(
    actual: &TypedExpr,
    node: &SyntaxNode,
    text: &str,
    value: &i128,
) -> Option<()> {
    let source = node
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Duration)?
        .token()?
        .text(text);
    if actual.ty != ResolvedType::Scalar(Scalar::Duration)
        || duration_literal_value(source)? != *value
    {
        return None;
    }
    Some(())
}

fn literal_matches(actual: &TypedExpr, node: &SyntaxNode, text: &str) -> Option<()> {
    if node.kind != SyntaxKind::Literal || actual.span != node.span {
        return None;
    }
    let token = |kind| node.children.iter().find(|node| node.kind == kind)?.token();
    let valid = match &actual.expr {
        IrExpr::Int(value) => {
            actual.ty == ResolvedType::Scalar(Scalar::Int)
                && token(SyntaxKind::Integer)?
                    .text(text)
                    .parse::<i128>()
                    .ok()?
                    == *value
        }
        IrExpr::Text(value) => {
            actual.ty == ResolvedType::Scalar(Scalar::Text)
                && token(SyntaxKind::String)?.string_value.as_ref()? == value
        }
        IrExpr::Bool(value) => {
            actual.ty == ResolvedType::Scalar(Scalar::Bool)
                && token(SyntaxKind::Name)?.text(text) == if *value { "true" } else { "false" }
        }
        IrExpr::Null => {
            actual.ty == ResolvedType::Null && token(SyntaxKind::Name)?.text(text) == "null"
        }
        IrExpr::DurationMs(value) => {
            check_duration_literal(actual, node, text, value)?;
            true
        }
        _ => false,
    };
    valid.then_some(())
}

fn unique_field<'a>(
    schema: &'a CheckedStoredContractSchema,
    name: &str,
) -> Option<&'a CheckedStoredContractField> {
    let mut fields = schema.fields.iter().filter(|field| field.name == name);
    let field = fields.next()?;
    fields.next().is_none().then_some(field)
}
fn key(value: &TypedExpr, kind: SyntaxKind) -> NodeKey {
    NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: kind as u8,
    }
}
fn expressions(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|node| {
            matches!(
                node.kind,
                SyntaxKind::Literal
                    | SyntaxKind::NameRef
                    | SyntaxKind::Group
                    | SyntaxKind::Array
                    | SyntaxKind::Object
                    | SyntaxKind::Construct
                    | SyntaxKind::Member
                    | SyntaxKind::Unary
                    | SyntaxKind::Binary
                    | SyntaxKind::Call
                    | SyntaxKind::Query
            )
        })
        .collect()
}
fn current_value(
    value: &TypedExpr,
    name: &str,
    template: &ResolvedType,
    revision: &ResolvedType,
) -> bool {
    value.ty == *revision
        && matches!(&value.expr, IrExpr::Member { base, field }
        if field == "current" && base.ty == *template
            && matches!(&base.expr, IrExpr::Name(actual) if actual == name))
}
fn null_presence(value: &TypedExpr) -> Option<&TypedExpr> {
    let IrExpr::Binary {
        op: IrBinOp::Ne,
        left,
        right,
    } = &value.expr
    else {
        return None;
    };
    (value.ty == ResolvedType::Scalar(Scalar::Bool)
        && right.ty == ResolvedType::Null
        && matches!(right.expr, IrExpr::Null))
    .then_some(left)
}
fn revision_leaf(
    value: &TypedExpr,
    binding: &str,
    name: &str,
    ty: &ResolvedType,
    revision: &ResolvedType,
) -> bool {
    value.ty == *ty
        && matches!(&value.expr, IrExpr::Member { base, field }
        if field == name && base.ty == *revision
            && matches!(&base.expr, IrExpr::Name(name) if name == binding))
}
fn flatten_and<'a>(value: &'a TypedExpr, out: &mut Vec<&'a TypedExpr>, depth: usize) -> Option<()> {
    if depth > 64 || out.len() > 200 {
        return None;
    }
    match &value.expr {
        IrExpr::Binary {
            op: IrBinOp::And,
            left,
            right,
        } => {
            flatten_and(left, out, depth + 1)?;
            flatten_and(right, out, depth + 1)?;
        }
        _ => out.push(value),
    }
    Some(())
}
fn collect_leaves<'a>(
    value: &'a TypedExpr,
    out: &mut Vec<&'a TypedExpr>,
    depth: usize,
) -> Option<()> {
    if depth > 64 || out.len() > 200 {
        return None;
    }
    match &value.expr {
        IrExpr::Member { base, .. } => {
            out.push(value);
            collect_leaves(base, out, depth + 1)?;
        }
        IrExpr::Object(values) => {
            for (_, value) in values {
                collect_leaves(value, out, depth + 1)?;
            }
        }
        IrExpr::Array(values)
        | IrExpr::Call { args: values, .. }
        | IrExpr::BoundCall { args: values, .. } => {
            for value in values {
                collect_leaves(value, out, depth + 1)?;
            }
        }
        IrExpr::Binary { left, right, .. } => {
            collect_leaves(left, out, depth + 1)?;
            collect_leaves(right, out, depth + 1)?;
        }
        IrExpr::Unary { operand, .. } => collect_leaves(operand, out, depth + 1)?,
        _ => {}
    }
    Some(())
}
fn statement_span(statement: &IrStmt) -> Option<Span> {
    match statement {
        IrStmt::Let { span, .. }
        | IrStmt::Require { span, .. }
        | IrStmt::Create { span, .. }
        | IrStmt::Set { span, .. }
        | IrStmt::Send { span, .. }
        | IrStmt::Return { span, .. }
        | IrStmt::Call { span, .. } => Some(*span),
        _ => None,
    }
}
