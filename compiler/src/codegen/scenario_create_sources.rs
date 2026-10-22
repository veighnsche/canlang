//! Nongrant correspondence for the original schema of a scenario-created row.
//! Defaults stay in the owning model descriptor; this join never evaluates them.
use std::collections::{HashMap, HashSet};

use crate::analysis::NodeKey;
use crate::analysis::resolve::{ModelOwner, ModuleKind, SymbolId};
use crate::analysis::effects::{
    FieldData, InvariantRule, LockRule, ModelData, RetainRule, UniqueRule,
};
use crate::analysis::scenario_disclosure::{
    CheckedDecisionCall, CheckedDecisionCallFrame, CheckedDecisionCallTarget, CheckedDecisionSite,
    CheckedInlineSelectionSource, CheckedScenarioCreate, CheckedScenarioCreatedField,
    CheckedScenarioCreatedModel, CheckedScenarioParameter, CheckedScenarioSource,
    CheckedStoredContractSchema, CheckedTranscriptSource, DependencyRole, DisclosureQuery,
    DisclosureSource, ScenarioDisclosure,
};
use crate::analysis::types::{
    CheckedCollectionCall, CheckedQuery, CheckedQueryClause, ResolvedType, Scalar,
};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrExpr, IrItem, IrItemKind, IrLockFn, IrModelRuleKind,
    IrNamedFn, IrOwner, IrProgram, IrQuery, IrQueryDomain, IrRetain, IrRuleFn, IrServer, IrStmt,
    IrType, IrUnOp, IrUnique, TypedExpr, ir_model_rule_prefix,
};
use super::js::{Emitter, JsModel, js_field_default, literal_json};

/// Borrow the existing independently checked source cohort. Both the owning
/// Model schema and complete non-stored member stay identical to fresh IR.
/// Only a refusal that touches the borrowed owning Model or member vetoes the
/// correspondence: unrelated IR refusals elsewhere (e.g. presentation-page
/// E6007/E6008 gaps) must not orphan exactly-bound derives, while an affected
/// model/member stays refused with its exact codes. This mirrors the
/// membership bridge and query-diagnostic seals.
fn checked_fresh_derived_member(context: &super::scenario_decisions::FreshSourceContext<'_>,
    ir: &IrProgram, model: &IrItem, member: &IrItem, db: &SourceDb) -> Option<()> {
    if !std::ptr::eq(context.ir(), ir) || !std::ptr::eq(context.db(), db) {
        return None;
    }
    let expected_model = context.fresh().items.get(model.id.0 as usize)?;
    let expected_member = context.fresh().items.get(member.id.0 as usize)?;
    if format!("{model:?}") != format!("{expected_model:?}")
        || format!("{member:?}") != format!("{expected_member:?}") {
        return None;
    }
    let overlaps = |a: crate::source::Span, b: crate::source::Span| {
        a.file == b.file && a.start <= b.end && b.start <= a.end
    };
    // IrItem.span covers only the declaration name, so a backend gap inside
    // the consumed derived body would escape a name-only veto. The full
    // declaration/body nodes below are the existing original source ranges:
    // the derive declaration node, its body node, and the lowered body span.
    // Diagnostics overlapping any of them veto, while unrelated refusals
    // elsewhere (e.g. presentation-page gaps) still do not.
    let mut veto = vec![model.span, member.span];
    if let super::ir::IrItemKind::DeriveField { expr, .. } = &member.kind {
        if let Some(body) = expr {
            veto.push(body.span);
        }
    }
    if let Some(derive) = context.program().effects.derives.get(&member.id) {
        veto.push(crate::source::Span {
            file: derive.node.file,
            start: derive.node.start,
            end: derive.node.end,
        });
        if let Some(body) = derive.expr {
            veto.push(crate::source::Span {
                file: body.file,
                start: body.start,
                end: body.end,
            });
        }
    }
    if context.ir_diagnostics().iter().any(|diagnostic| {
        diagnostic.severity == crate::diagnostic::Severity::Error
            && veto.iter().any(|span| {
                overlaps(*span, diagnostic.primary)
                    || diagnostic.related.iter().any(|related| overlaps(*span, related.span))
            })
    }) {
        return None;
    }
    Some(())
}

fn check_derived_member(
    ir: &IrProgram,
    owner: &IrItem,
    model: &IrItem,
    member: &IrItem,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
    db: &SourceDb,
) -> Option<()> {
    // Derived members are excluded from stored constructor inputs.
    // Their complete declaration/body must be the fresh owning
    // member, never an operation-shape or conservative-path count.
    let context = match source_context {
        Some(context) => context,
        None => {
            return None;
        }
    };
    if checked_fresh_derived_member(context, ir, model, member, db).is_none() {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let schema = facts
        .stored_contracts
        .as_deref()
        .and_then(|schemas| schemas.iter().find(|schema| schema.model && schema.id == model.id));
    if schema.is_none() {
        return None;
    }
    super::scenario_receipts::match_stored_contract_schema(ir, schema.unwrap(), db)?;
    if member.canonical != format!("{}.{}", model.canonical, member.name) {
        return None;
    }
    Some(())
}

fn collect_stored_fields(
    ir: &IrProgram,
    owner: &IrItem,
    model: &IrItem,
    fields: &[SymbolId],
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
    db: &SourceDb,
) -> Option<Vec<SymbolId>> {
    let mut stored_fields = Vec::new();
    for id in fields {
        let member = ir.items.get(id.0 as usize)?;
        if member.id != *id || member.module != model.module {
            return None;
        }
        match &member.kind {
            IrItemKind::Field {
                owner: field_owner, ..
            } if *field_owner == model.id => stored_fields.push(*id),
            IrItemKind::DeriveField {
                model: field_owner, ..
            } if *field_owner == model.id => {
                check_derived_member(ir, owner, model, member, source_context, db)?;
            }
            _ => return None,
        }
    }
    Some(stored_fields)
}

fn match_authored_fields(
    definition: &CheckedScenarioCreatedModel,
    stored_fields: &[SymbolId],
    declaration: &ModelData,
) -> Option<Vec<SymbolId>> {
    let authored_fields: Vec<_> = stored_fields
        .iter()
        .copied()
        .filter(|id| {
            !definition
                .contributed
                .iter()
                .any(|field| field.field == *id)
        })
        .collect();
    if authored_fields.len() != definition.fields.len()
        || !authored_fields
            .iter()
            .copied()
            .eq(declaration.fields.iter().map(|field| field.field))
        || !authored_fields
            .iter()
            .copied()
            .eq(definition.fields.iter().map(|field| field.field))
    {
        return None;
    }
    Some(authored_fields)
}

fn check_schema_identity(
    model: &IrItem,
    owner: &IrItem,
    original: &CheckedScenarioCreate,
    definition: &CheckedScenarioCreatedModel,
    declaration: &ModelData,
    actual_owner: &IrOwner,
    expected_owner: IrOwner,
    fields: &[SymbolId],
    stored_fields: &[SymbolId],
) -> Option<()> {
    if model.id != original.model
        || declaration.model != original.model
        || model.module != owner.module
        || model.module != declaration.module
        || model.canonical != definition.canonical
        || model.span != definition.span
        || *actual_owner != expected_owner
        || fields.len() > 200
        || stored_fields.len() != declaration.fields.len() + definition.contributed.len()
        || !stored_fields.iter().copied().eq(declaration
            .fields
            .iter()
            .map(|field| field.field)
            .chain(definition.contributed.iter().map(|field| field.field)))
        || original.source != definition.source
    {
        return None;
    }
    Some(())
}

fn load_declaration_tree<'a>(
    ir: &IrProgram,
    db: &'a SourceDb,
    definition: &CheckedScenarioCreatedModel,
    declaration: &ModelData,
    model: &IrItem,
) -> Option<(SyntaxNode, &'a str)> {
    source(ir, &definition.source, model.span, db)?;
    source(ir, &definition.source, span(declaration.node), db)?;
    let (tree, diagnostics) = crate::syntax::parse(db, declaration.node.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let text = &db.get(declaration.node.file)?.text;
    Some((tree, text))
}

fn check_child_parent(
    ir: &IrProgram,
    model: &IrItem,
    declaration: &ModelData,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    text: &str,
    db: &SourceDb,
) -> Option<()> {
    if let ModelOwner::ChildOf(parent) = declaration.owner {
        let node = nodes.get(&declaration.node)?;
        let parts: Vec<_> = node
            .children
            .iter()
            .filter(|part| !matches!(part.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
            .collect();
        let parent_node = parts
            .windows(2)
            .find_map(|pair| (pair[0].token()?.text(text) == "in").then_some(pair[1]))?;
        let parent_name = single_name(parent_node, text)?;
        reference_name(ir, model, parent, parent_name, db)?;
    }
    Some(())
}

fn check_field_naming(
    field: &IrItem,
    model: &IrItem,
    data: &FieldData,
    original_field: &CheckedScenarioCreatedField,
    field_owner: &SymbolId,
    text: &str,
) -> Option<()> {
    if field.id != original_field.field
        || *field_owner != model.id
        || field.module != model.module
        || field.name != original_field.name
        || field.canonical != original_field.canonical
        || text.get(field.span.start as usize..field.span.end as usize)
            != Some(field.name.as_str())
        || field.span.file != data.node.file
        || field.span.start < data.node.start
        || field.span.end > data.node.end
    {
        return None;
    }
    Some(())
}

fn check_field_typing(
    ir: &IrProgram,
    field_id: SymbolId,
    data: &FieldData,
    definition: &CheckedScenarioCreatedModel,
    original_field: &CheckedScenarioCreatedField,
    ty: &ResolvedType,
    required_array: &bool,
    description: &Option<String>,
) -> Option<()> {
    if ty != &original_field.ty
        || *required_array != data.required_array
        || description != &data.description
        || ir.value_constraints.get(&field_id) != original_field.constraints.as_ref()
        || original_field.source != definition.source
    {
        return None;
    }
    Some(())
}

fn check_field_syntax(
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    data: &FieldData,
    field: &IrItem,
) -> Option<()> {
    let authored_field = nodes.get(&data.node)?;
    if authored_field.kind != SyntaxKind::Field
        || authored_field
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Name)?
            .span
            != field.span
    {
        return None;
    }
    Some(())
}

fn check_field_reference(
    ir: &IrProgram,
    owner: &IrItem,
    model: &IrItem,
    data: &FieldData,
    original_field: &CheckedScenarioCreatedField,
    ty: &ResolvedType,
    text: &str,
    db: &SourceDb,
) -> Option<()> {
    let mut referenced = ty;
    while let ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } =
        referenced
    {
        referenced = inner;
    }
    if let ResolvedType::Record {
        symbol,
        stored: true,
    } = referenced
    {
        nominal_identity(ir, owner, *symbol, db)?;
        if original_field.reuse.is_none() {
            let type_source =
                text.get(data.type_node.start as usize..data.type_node.end as usize)?;
            reference_name(
                ir,
                model,
                *symbol,
                type_source
                    .trim()
                    .trim_end_matches('?')
                    .trim_end_matches("[]"),
                db,
            )?;
        }
    }
    Some(())
}

fn check_field_default(
    matcher: &SourceExpressions<'_>,
    default: &Option<IrDefault>,
    data_default: Option<NodeKey>,
    original_field: &CheckedScenarioCreatedField,
    ty: &ResolvedType,
    field_span: Span,
) -> Option<()> {
    match (default, data_default) {
        (None, None)
            if original_field.modifier_sources.first().is_none_or(
                |(_, _, _, _, values)| values.iter().all(|value| value.default.is_none()),
            ) => {}
        (Some(IrDefault::Literal(actual)), None) => {
            check_bare_literal_default(original_field, ty, field_span, actual, default)?;
        }
        (Some(IrDefault::Literal(actual)), Some(node)) => {
            check_named_literal_default(matcher, actual, node, default, ty)?;
        }
        (Some(default), Some(node)) => {
            // Other computed defaults require their own checked native join.
            check_actor_default(matcher, default, node, ty)?;
        }
        _ => return None,
    }
    Some(())
}

fn check_field_server(
    matcher: &SourceExpressions<'_>,
    server: &Option<IrServer>,
    data_server: Option<NodeKey>,
    ty: &ResolvedType,
) -> Option<()> {
    match (server, data_server) {
        (None, None) => {}
        (Some(IrServer::Actor), Some(node))
            if matcher.word(node)? == "actor" && *ty == ResolvedType::Scalar(Scalar::User) => {}
        (Some(IrServer::Now), Some(node))
            if matcher.word(node)? == "now"
                && *ty == ResolvedType::Scalar(Scalar::Datetime) => {}
        _ => return None,
    }
    Some(())
}

fn check_field_modifiers(
    ir: &IrProgram,
    matcher: &SourceExpressions<'_>,
    original: &CheckedScenarioCreate,
    original_field: &CheckedScenarioCreatedField,
    data: &FieldData,
    modifiers: &super::ir::IrModifiers,
    db: &SourceDb,
) -> Option<()> {
    let (trim, unique, machine, minimum, maximum) = collect_field_flags(data)?;
    if original_field.modifier_sources.len() > 1 || original_field
        .modifier_sources
        .iter()
        .any(|(_, _, _, _, given)| !given.is_empty())
    {
        checked_field_trait_modifiers(ir, original, original_field, modifiers, db)?;
        if modifiers.unique != unique || modifiers.machine != machine {
            return None;
        }
    } else {
        if modifiers.trim != trim || modifiers.unique != unique || modifiers.machine != machine
        {
            return None;
        }
        matcher.optional(modifiers.min.as_ref(), minimum)?;
        matcher.optional(modifiers.max.as_ref(), maximum)?;
    }
    Some(())
}

fn check_declared_field(
    matcher: &SourceExpressions<'_>,
    ir: &IrProgram,
    owner: &IrItem,
    model: &IrItem,
    original: &CheckedScenarioCreate,
    definition: &CheckedScenarioCreatedModel,
    data: &FieldData,
    original_field: &CheckedScenarioCreatedField,
    text: &str,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    db: &SourceDb,
) -> Option<()> {
    let field = ir.items.get(data.field.0 as usize)?;
    let IrItemKind::Field {
        owner: field_owner,
        ty: IrType::Known(ty),
        required_array,
        default,
        server,
        modifiers,
        description,
        ..
    } = &field.kind
    else {
        return None;
    };
    check_field_naming(field, model, data, original_field, field_owner, text)?;
    check_field_typing(
        ir,
        field.id,
        data,
        definition,
        original_field,
        ty,
        required_array,
        description,
    )?;
    source(ir, &original_field.source, field.span, db)?;
    source(ir, &original_field.source, span(data.node), db)?;
    check_field_syntax(nodes, data, field)?;
    check_field_reference(ir, owner, model, data, original_field, ty, text, db)?;
    check_field_default(matcher, default, data.default, original_field, ty, field.span)?;
    check_field_server(matcher, server, data.server, ty)?;
    check_field_modifiers(ir, matcher, original, original_field, data, modifiers, db)?;
    Some(())
}

fn check_schema_invariant(
    matcher: &SourceExpressions<'_>,
    ir: &IrProgram,
    model: &IrItem,
    original_rule: &InvariantRule,
    actual: &IrRuleFn,
    invariants: &[String],
    index: usize,
    prefix: &str,
) -> Option<()> {
    let id = format!("{prefix}.require.{}", index + 1);
    let origin = actual.origin.as_ref()?;
    if invariants[index] != id
        || actual.id != id
        || ir.invariants.iter().filter(|rule| rule.id == id).count() != 1
        || actual.span != span(original_rule.node)
        || origin.model != model.id
        || origin.module != model.module
        || origin.ordinal != original_rule.id
        || origin.node != original_rule.node
        || origin.span != actual.span
        || origin.kind != IrModelRuleKind::Invariant
        || origin.registry_id != id
        || actual.pred.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    matcher
        .expression(&actual.pred, original_rule.predicate?, 0)
        .or_else(|| {
            matcher.schema_rule_expression(
                &actual.pred,
                original_rule.predicate?,
                &[("row".into(), model.id)],
                0,
            )
        })?;
    Some(())
}

fn check_schema_lock(
    matcher: &SourceExpressions<'_>,
    ir: &IrProgram,
    model: &IrItem,
    original_rule: &LockRule,
    actual: &IrLockFn,
    locks: &[String],
    index: usize,
    prefix: &str,
) -> Option<()> {
    let id = format!("{prefix}.lock.{}", index + 1);
    if locks[index] != id
        || actual.id != id
        || ir.locks.iter().filter(|rule| rule.id == id).count() != 1
        || actual.fields != original_rule.fields
        || actual.span != span(original_rule.node)
        || actual.origin.model != model.id
        || actual.origin.module != model.module
        || actual.origin.ordinal != original_rule.id
        || actual.origin.node != original_rule.node
        || actual.origin.span != actual.span
        || actual.origin.kind != IrModelRuleKind::Lock
        || actual.origin.registry_id != id
    {
        return None;
    }
    matcher.optional(actual.when.as_ref(), original_rule.when)?;
    Some(())
}

fn check_schema_unique(
    matcher: &SourceExpressions<'_>,
    ir: &IrProgram,
    actual: &IrUnique,
    original_rule: &UniqueRule,
    prefix: &str,
    index: usize,
) -> Option<()> {
    if actual.fields != original_rule.fields || actual.span != span(original_rule.node) {
        return None;
    }
    matcher.optional(
        actual.where_predicate.as_ref(),
        original_rule.where_predicate,
    )?;
    let id = format!("{prefix}.unique.{}", index + 1);
    let rules: Vec<_> = ir.invariants.iter().filter(|rule| rule.id == id).collect();
    match (original_rule.where_predicate, rules.as_slice()) {
        (None, []) => {}
        (Some(node), [rule]) if rule.origin.is_none() && rule.span == actual.span => {
            matcher.expression(&rule.pred, node, 0)?;
        }
        _ => return None,
    }
    Some(())
}

fn check_schema_retention(
    matcher: &SourceExpressions<'_>,
    retains: &[RetainRule],
    retain: &Option<IrRetain>,
    retention: &[&IrNamedFn],
) -> Option<()> {
    match (retains, retain, retention) {
        ([], None, []) => {}
        ([original_rule], Some(actual), [rule])
            if actual.span == span(original_rule.node) && rule.span == actual.span =>
        {
            matcher.expression(&actual.until, original_rule.until?, 0)?;
            matcher.expression(&rule.body, original_rule.until?, 0)?;
        }
        _ => return None,
    }
    Some(())
}

fn check_schema_rules(
    matcher: &SourceExpressions<'_>,
    ir: &IrProgram,
    model: &IrItem,
    declaration: &ModelData,
    invariants: &[String],
    locks: &[String],
    uniques: &[IrUnique],
    retain: &Option<IrRetain>,
    prefix: &str,
) -> Option<()> {
    if invariants.len() != declaration.invariants.len()
        || locks.len() != declaration.locks.len()
        || uniques.len() != declaration.uniques.len()
        || declaration.retains.len() > 1
    {
        return None;
    }
    let actual_invariants: Vec<_> = ir
        .invariants
        .iter()
        .filter(|rule| {
            rule.origin
                .as_ref()
                .is_some_and(|origin| origin.model == model.id)
        })
        .collect();
    if actual_invariants.len() != invariants.len() {
        return None;
    }
    for (index, (original_rule, actual)) in declaration
        .invariants
        .iter()
        .zip(actual_invariants)
        .enumerate()
    {
        check_schema_invariant(
            matcher,
            ir,
            model,
            original_rule,
            actual,
            invariants,
            index,
            prefix,
        )?;
    }
    let actual_locks: Vec<_> = ir
        .locks
        .iter()
        .filter(|rule| rule.origin.model == model.id)
        .collect();
    if actual_locks.len() != locks.len() {
        return None;
    }
    for (index, (original_rule, actual)) in declaration.locks.iter().zip(actual_locks).enumerate() {
        check_schema_lock(matcher, ir, model, original_rule, actual, locks, index, prefix)?;
    }
    for (index, (original_rule, actual)) in declaration.uniques.iter().zip(uniques).enumerate() {
        check_schema_unique(matcher, ir, actual, original_rule, prefix, index)?;
    }
    let retention: Vec<_> = ir
        .retention
        .iter()
        .filter(|rule| rule.name == prefix)
        .collect();
    check_schema_retention(matcher, &declaration.retains, retain, &retention)?;
    Some(())
}

/// Authenticate complex owning rules against independent source lowering.
/// The normal runtime invariant/lock/unique/retention evaluators still run.
fn checked_fresh_model_rules(context: &super::scenario_decisions::FreshSourceContext<'_>,
    ir: &IrProgram, model: &IrItem, db: &SourceDb) -> Option<()> {
    if !std::ptr::eq(context.ir(), ir) || !std::ptr::eq(context.db(), db)
        || format!("{model:?}") != format!("{:?}",context.fresh().items.get(model.id.0 as usize)?)
    { return None; }
    let declaration = context.original().effects.models.get(&model.id)?;
    let mut scopes = vec![span(declaration.node)];
    scopes.extend(declaration.invariants.iter().map(|rule| span(rule.node)));
    scopes.extend(declaration.locks.iter().map(|rule| span(rule.node)));
    scopes.extend(declaration.uniques.iter().map(|rule| span(rule.node)));
    scopes.extend(declaration.retains.iter().map(|rule| span(rule.node)));
    if context.ir_diagnostics().iter().any(|diagnostic|
        diagnostic.severity == crate::diagnostic::Severity::Error && scopes.iter().any(|scope| {
            let overlaps = |candidate: crate::source::Span| scope.file == candidate.file
                && scope.start <= candidate.end && candidate.start <= scope.end;
            overlaps(diagnostic.primary) || diagnostic.related.iter().any(|related| overlaps(related.span))
        })) { return None; }
    let prefix = ir_model_rule_prefix(ir, model);
    let owned = |rule: &&IrRuleFn| rule.origin.as_ref().is_some_and(|origin| origin.model == model.id)
        || rule.id.starts_with(&format!("{prefix}.unique."));
    let actual: Vec<_> = ir.invariants.iter().filter(owned).collect();
    let expected: Vec<_> = context.fresh().invariants.iter().filter(owned).collect();
    if format!("{actual:?}") != format!("{expected:?}") { return None; }
    for (actual, expected) in actual.iter().zip(expected) {
        context.same_expression(&actual.pred, &expected.pred)?;
    }
    let actual: Vec<_> = ir.locks.iter().filter(|rule| rule.origin.model == model.id).collect();
    let expected: Vec<_> = context.fresh().locks.iter().filter(|rule| rule.origin.model == model.id).collect();
    if format!("{actual:?}") != format!("{expected:?}") { return None; }
    for (actual, expected) in actual.iter().zip(expected) {
        match (&actual.when, &expected.when) {
            (Some(actual), Some(expected)) => context.same_expression(actual, expected)?,
            (None, None) => {}, _ => return None,
        }
    }
    let actual: Vec<_> = ir.retention.iter().filter(|rule| rule.name == prefix).collect();
    let expected: Vec<_> = context.fresh().retention.iter().filter(|rule| rule.name == prefix).collect();
    if format!("{actual:?}") != format!("{expected:?}") { return None; }
    for (actual, expected) in actual.iter().zip(expected) {
        context.same_expression(&actual.body, &expected.body)?;
    }
    Some(())
}

fn check_emitted_descriptor(
    ir: &IrProgram,
    db: &SourceDb,
    models: &[JsModel],
    model: &IrItem,
) -> Option<()> {
    // Use the actual descriptor producer. Matching source and executable IR
    // first prevents an edited initializer from agreeing with its own emit.
    let generated = Emitter::source_models(ir, db)?;
    let expected: Vec<_> = generated
        .iter()
        .filter(|descriptor| descriptor.name == model.canonical)
        .collect();
    let supplied: Vec<_> = models
        .iter()
        .filter(|descriptor| descriptor.name == model.canonical)
        .collect();
    match (expected.as_slice(), supplied.as_slice()) {
        ([expected], [supplied])
            if serde_json::to_value(expected).ok()? == serde_json::to_value(supplied).ok()? =>
        {
            Some(())
        }
        _ => None,
    }
}

fn load_created_model<'i, 'o>(
    ir: &'i IrProgram,
    owner: &IrItem,
    original: &'o CheckedScenarioCreate,
    db: &SourceDb,
) -> Option<(
    &'i IrItem,
    &'o CheckedScenarioCreatedModel,
    &'o ModelData,
    &'i Vec<SymbolId>,
    &'i Vec<String>,
    &'i Vec<String>,
    &'i Vec<IrUnique>,
    &'i Option<IrRetain>,
    &'i IrOwner,
    IrOwner,
)> {
    let definition = &original.definition;
    let declaration = &definition.declaration;
    let model = ir.items.get(original.model.0 as usize)?;
    let module = ir.modules.get(model.module.0 as usize)?;
    if module.id != model.module
        || module.name != definition.source.module
        || module.file != declaration.node.file
    {
        return None;
    }
    let IrItemKind::Model {
        fields,
        owner: actual_owner,
        invariants,
        locks,
        uniques,
        retain,
        ..
    } = &model.kind
    else {
        return None;
    };
    let expected_owner = match declaration.owner {
        ModelOwner::Team => IrOwner::Team,
        ModelOwner::App => IrOwner::App,
        ModelOwner::ChildOf(parent) => {
            model_identity(ir, owner, parent, db)?;
            IrOwner::ChildOf(parent)
        }
    };
    Some((
        model,
        definition,
        declaration,
        fields,
        invariants,
        locks,
        uniques,
        retain,
        actual_owner,
        expected_owner,
    ))
}

fn check_bare_literal_default(
    original_field: &CheckedScenarioCreatedField,
    ty: &ResolvedType,
    field_span: Span,
    actual: &TypedExpr,
    default: &Option<IrDefault>,
) -> Option<()> {
    let value = original_field
        .modifier_sources
        .first()?
        .4
        .iter()
        .find_map(|value| value.default.as_deref())?;
    let expected = super::ir::given_constant_expr(value, ty, field_span);
    if actual.ty != expected.ty
        || actual.span != expected.span
        || literal_json(actual)? != literal_json(&expected)?
        || js_field_default(default.as_ref(), None).is_none()
    {
        return None;
    }
    Some(())
}

fn check_named_literal_default(
    matcher: &SourceExpressions<'_>,
    actual: &TypedExpr,
    node: NodeKey,
    default: &Option<IrDefault>,
    ty: &ResolvedType,
) -> Option<()> {
    matcher.expression(actual, node, 0)?;
    if literal_json(actual).is_none() || js_field_default(default.as_ref(), None).is_none() {
        return None;
    }
    if actual.ty != *ty
        && ty.nullable_inner() != Some(&actual.ty)
        && !(actual.ty == ResolvedType::Null && ty.nullable_inner().is_some())
    {
        return None;
    }
    Some(())
}

fn check_actor_default(
    matcher: &SourceExpressions<'_>,
    default: &IrDefault,
    node: NodeKey,
    ty: &ResolvedType,
) -> Option<()> {
    let IrDefault::Computed {
        expr,
        has_parent: false,
    } = default
    else {
        return None;
    };
    if !matches!(
        js_field_default(Some(default), None),
        Some(super::js::JsFieldDefault::ContextActor)
    ) || matcher.word(node)? != "actor"
        || expr.span != span(node)
        || (*ty != ResolvedType::Scalar(Scalar::User)
            && ty.nullable_inner() != Some(&ResolvedType::Scalar(Scalar::User)))
    {
        return None;
    }
    Some(())
}

fn collect_field_flags(
    data: &FieldData,
) -> Option<(
    bool,
    bool,
    bool,
    Option<NodeKey>,
    Option<NodeKey>,
)> {
    let mut trim = false;
    let mut unique = false;
    let mut machine = false;
    let mut minimum = None;
    let mut maximum = None;
    for modifier in &data.modifiers {
        match (modifier.name.as_str(), modifier.value) {
            ("trim", None) if !trim => trim = true,
            ("unique", None) if !unique => unique = true,
            ("machine", None) if !machine => machine = true,
            ("min", Some(node)) if minimum.is_none() => minimum = Some(node),
            ("max", Some(node)) if maximum.is_none() => maximum = Some(node),
            _ => return None,
        }
    }
    Some((trim, unique, machine, minimum, maximum))
}

pub(super) fn checked_created_schema(
    ir: &IrProgram,
    owner: &IrItem,
    models: &[JsModel],
    original: &CheckedScenarioCreate,
    db: &SourceDb,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<()> {
    let (
        model,
        definition,
        declaration,
        fields,
        invariants,
        locks,
        uniques,
        retain,
        actual_owner,
        expected_owner,
    ) = load_created_model(ir, owner, original, db)?;
    let stored_fields = collect_stored_fields(ir, owner, model, fields, source_context, db)?;
    let _authored = match_authored_fields(definition, &stored_fields, declaration)?;
    check_schema_identity(model, owner, original, definition, declaration, actual_owner, expected_owner, fields, &stored_fields)?;
    let (tree, text) = load_declaration_tree(ir, db, definition, declaration, model)?;
    let mut nodes = HashMap::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter());
    }
    if nodes.get(&declaration.node)?.kind != SyntaxKind::Model
        || text.get(model.span.start as usize..model.span.end as usize) != Some(model.name.as_str())
    {
        return None;
    }
    check_child_parent(ir, model, declaration, &nodes, text, db)?;
    let matcher = SourceExpressions {
        ir,
        db,
        original,
        owner: None,
        nodes: &nodes,
        text,
        operands: false,
        membership_call: None,
        query_alias: None,
    };
    for (data, original_field) in declaration.fields.iter().zip(&definition.fields) {
        check_declared_field(&matcher, ir, owner, model, original, definition, data, original_field, text, &nodes, db)?;
    }
    for original_field in &definition.contributed {
        checked_contributed_field(ir, model, original_field, db)?;
    }
    let prefix = ir_model_rule_prefix(ir, model);
    check_schema_rules(&matcher, ir, model, declaration, invariants, locks, uniques, retain, prefix)
        .or_else(|| checked_fresh_model_rules(source_context?, ir, model, db))?;
    // A local declared delivery can be retained as an untouched null slot.
    // Its complete operation/version/result schema must still agree with the
    // independent original lowering; this issues no non-null receipt value.
    if stored_fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|field| matches!(&field.kind,
        IrItemKind::Field {ty:IrType::Known(ResolvedType::Nullable(inner)),..}
            if matches!(inner.as_ref(),ResolvedType::Delivery {..}))) {
        let context = source_context?;
        for id in &stored_fields {
            let field = ir.items.get(id.0 as usize)?;
            if let IrItemKind::Field {ty:IrType::Known(ResolvedType::Nullable(inner)),default,..} = &field.kind
                && let ResolvedType::Delivery {op} = inner.as_ref() {
                super::scenario_decisions::same_capability_operation(context,*op)?;
                if original.inputs.iter().any(|input| input.field == Some(field.id))
                    || !(default.is_none() || matches!(default,Some(IrDefault::Literal(value)) if value.ty == ResolvedType::Null && matches!(value.expr,IrExpr::Null))) {
                    return None;
                }
            }
        }
        let expected = Emitter::source_models(context.fresh(),db)?;
        let mut generated = expected.iter().filter(|descriptor| descriptor.name == model.canonical);
        let mut supplied = models.iter().filter(|descriptor| descriptor.name == model.canonical);
        if serde_json::to_value(generated.next()?).ok()? != serde_json::to_value(supplied.next()?).ok()?
            || generated.next().is_some() || supplied.next().is_some() { return None; }
    }
    check_emitted_descriptor(ir, db, models, model)
}

fn span(node: NodeKey) -> Span {
    Span::new(node.file, node.start, node.end)
}

fn check_identity_contract(
    ir: &IrProgram,
    owner: &IrItem,
    id: SymbolId,
    item: &IrItem,
    db: &SourceDb,
) -> Option<()> {
    if let Some(original) = ir
        .scenario_disclosures
        .get(&owner.id)?
        .source_facts()?
        .stored_contracts
        .as_ref()
        .and_then(|schemas| {
            schemas
                .iter()
                .find(|schema| schema.id == id && schema.model)
        })
    {
        if original.canonical != item.canonical
            || original.module != item.module
            || original.span != item.span
        {
            return None;
        }
        source(ir, &original.source, item.span, db)?;
    }
    Some(())
}

fn classify_module_declaration(declaration: &SyntaxNode, text: &str) -> Option<ModuleKind> {
    let declaration_kind = match declaration.kind {
        SyntaxKind::Package => ModuleKind::Package,
        SyntaxKind::App
            if !declaration.children.iter().any(|part| {
                part.kind == SyntaxKind::Attribute
                    && part
                        .children
                        .iter()
                        .find(|child| child.kind == SyntaxKind::Name)
                        .is_some_and(|name| {
                            name.token().is_some_and(|token| token.text(text) == "uses")
                        })
            }) =>
        {
            ModuleKind::ImplicitApp
        }
        _ => return None,
    };
    Some(declaration_kind)
}

fn check_model_declaration(
    declaration: &SyntaxNode,
    text: &str,
    item: &IrItem,
) -> Option<()> {
    let mut pending = vec![declaration];
    let mut matching = 0;
    while let Some(node) = pending.pop() {
        if node.kind == SyntaxKind::Model {
            let name = node.children.iter().find(|part| {
                part.kind == SyntaxKind::Name
                    && part
                        .token()
                        .is_some_and(|token| token.text(text) != "export")
            })?;
            if name.token()?.text(text) == item.name {
                if name.span != item.span {
                    return None;
                }
                matching += 1;
            }
        }
        pending.extend(node.children.iter());
    }
    (matching == 1).then_some(())
}

fn model_identity(
    ir: &IrProgram,
    owner: &IrItem,
    id: crate::analysis::SymbolId,
    db: &SourceDb,
) -> Option<()> {
    let item = ir.items.get(id.0 as usize)?;
    let module = ir.modules.get(item.module.0 as usize)?;
    if item.id != id
        || module.id != item.module
        || !matches!(item.kind, IrItemKind::Model { .. })
        || item.canonical != format!("{}.{}", module.name, item.name)
        || item.span.file != module.file
    {
        return None;
    }
    check_identity_contract(ir, owner, id, item, db)?;
    // When the finite stored-reference census does not reach this model,
    // its actual package/model declarations still seal the identity. The
    // referencing original type/header is joined separately to that scope.
    let (tree, diagnostics) = crate::syntax::parse(db, module.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let text = &db.get(module.file)?.text;
    let declaration = tree.children.iter().find(|node| {
        matches!(node.kind, SyntaxKind::App | SyntaxKind::Package) && node.span == module.span
    })?;
    let declaration_kind = classify_module_declaration(declaration, text)?;
    let declaration_name = declaration
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .nth(1)?;
    if declaration_name.token()?.text(text) != module.name || module.kind != declaration_kind {
        return None;
    }
    check_model_declaration(declaration, text, item)
}

/// Contracts retain their owning checked field closure. Model leaves keep the
/// separate row-identity proof; a Contract never becomes a Model reference.
fn nominal_identity(
    ir: &IrProgram,
    owner: &IrItem,
    id: crate::analysis::SymbolId,
    db: &SourceDb,
) -> Option<()> {
    if matches!(ir.items.get(id.0 as usize)?.kind, IrItemKind::Model { .. }) {
        return model_identity(ir, owner, id, db);
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut pending = vec![id];
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > 200 {
            return None;
        }
        if matches!(ir.items.get(id.0 as usize)?.kind, IrItemKind::Model { .. }) {
            model_identity(ir, owner, id, db)?;
            continue;
        }
        let mut schemas = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.id == id && !schema.model);
        let schema = schemas.next()?;
        if schemas.next().is_some() {
            return None;
        }
        super::scenario_receipts::match_stored_contract_schema(ir, schema, db)?;
        for field in &schema.fields {
            super::scenario_receipts::match_stored_contract_field(ir, field, db)?;
            let mut ty = &field.ty;
            while let ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } =
                ty
            {
                ty = inner;
            }
            if let ResolvedType::Record { symbol, .. } = ty {
                pending.push(*symbol);
            }
        }
    }
    Some(())
}

fn find_import_candidate(
    module: &super::ir::IrModule,
    provider: &str,
    item_name: &str,
    spelling: &str,
) -> Option<(Span, Span, Span, Option<String>)> {
    let candidates: Vec<_> = module
        .imports
        .iter()
        .filter(|import| import.provider == *provider)
        .flat_map(|import| import.members.iter().map(move |member| (import, member)))
        .filter(|(_, (name, alias, _))| *name == item_name && alias == spelling)
        .collect();
    let [(import, (_, _, member_span))] = candidates.as_slice() else {
        return None;
    };
    Some((import.span, import.provider_span, *member_span, import.from.clone()))
}

fn check_import_from(
    import_from: Option<&str>,
    source_import: &SyntaxNode,
    text: &str,
) -> Option<()> {
    // Deployment-qualified imports (`from=deployment.<binding>`) carry the
    // same member identity as plain imports; the qualifier itself is part
    // of the checked correspondence. Absence must match absence, and a
    // present qualifier must be the exact recorded deployment path (first
    // segment `deployment`, full trimmed text equal to the checked
    // binding). This mirrors the existing deployment-import verification
    // used for capability routes: no spelling-only bypass.
    match (
        import_from,
        crate::analysis::attribute_value(source_import, "from", text),
    ) {
        (None, None) => {}
        (Some(expected), Some(from_node)) => {
            if from_node.kind != SyntaxKind::Path
                || crate::analysis::path_segments(from_node, text)
                    .first()
                    .copied()
                    != Some("deployment")
                || text
                    .get(from_node.span.start as usize..from_node.span.end as usize)?
                    .trim()
                    != expected
            {
                return None;
            }
        }
        _ => return None,
    }
    Some(())
}

fn check_import_member(
    source_import: &SyntaxNode,
    member_span: Span,
    item_name: &str,
    spelling: &str,
    text: &str,
) -> Option<()> {
    let member = source_import
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::ImportMember && node.span == member_span)?;
    let names: Vec<_> = member
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .collect();
    let original_name = names.first()?.token()?.text(text);
    let original_alias = match names.as_slice() {
        [_] => original_name,
        [_, as_name, alias] if as_name.token()?.text(text) == "as" => alias.token()?.text(text),
        _ => return None,
    };
    (original_name == item_name && original_alias == spelling).then_some(())
}

pub(super) fn reference_name(
    ir: &IrProgram,
    receiving: &IrItem,
    target: crate::analysis::SymbolId,
    spelling: &str,
    db: &SourceDb,
) -> Option<()> {
    let item = ir.items.get(target.0 as usize)?;
    if item.module == receiving.module {
        return (spelling == item.name).then_some(());
    }
    let module = ir.modules.get(receiving.module.0 as usize)?;
    let provider = &ir.modules.get(item.module.0 as usize)?.name;
    let (import_span, provider_span, member_span, import_from) =
        find_import_candidate(module, provider, &item.name, spelling)?;
    let (tree, diagnostics) = crate::syntax::parse(db, module.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let text = &db.get(module.file)?.text;
    let declaration = tree.children.iter().find(|node| {
        matches!(node.kind, SyntaxKind::App | SyntaxKind::Package) && node.span == module.span
    })?;
    let source_import = declaration
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Import && node.span == import_span)?;
    if text.get(provider_span.start as usize..provider_span.end as usize)
        != Some(provider.as_str())
    {
        return None;
    }
    check_import_from(import_from.as_deref(), source_import, text)?;
    let path = source_import
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Path)?;
    let provider_name = path
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    if provider_name.span != provider_span {
        return None;
    }
    check_import_member(source_import, member_span, &item.name, spelling, text)
}

/// Seal the semantic value at an original Create input. The receipt collector
/// separately joins its checked type, target, argument order and effect site.
pub(super) fn checked_create_operand(
    ir: &IrProgram,
    original: &CheckedScenarioCreate,
    actual: &TypedExpr,
    node: NodeKey,
    db: &SourceDb,
) -> Option<()> {
    if !original
        .inputs
        .iter()
        .any(|input| input.value_node == node && input.ty == actual.ty)
    {
        return None;
    }
    super::scenario_receipts::checked_created_reference_operand(ir, original, actual, node, db)?;
    let mut ty = &actual.ty;
    while let ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } = ty {
        ty = inner;
    }
    if let ResolvedType::Record { symbol, .. } = ty
        && matches!(
            ir.items.get(symbol.0 as usize)?.kind,
            IrItemKind::Contract { .. }
        )
    {
        checked_contract_parameter_operand(ir, original, actual, node, db)?;
    }
    checked_create_expression(ir, original, actual, node, db)
}

/// Current native producer bound: a whole Contract value is the original
/// required parameter occurrence. Other Contract expressions remain language
/// values, but need their own source correspondence before native admission.
fn checked_contract_parameter_operand(
    ir: &IrProgram,
    original: &CheckedScenarioCreate,
    actual: &TypedExpr,
    node: NodeKey,
    db: &SourceDb,
) -> Option<()> {
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = &actual.ty
    else {
        return None;
    };
    let IrExpr::Name(name) = &actual.expr else {
        return None;
    };
    let mut owners = ir.items.iter().filter(|owner| {
        ir.scenario_disclosures
            .get(&owner.id)
            .and_then(|disclosure| disclosure.source_facts())
            .and_then(|facts| facts.creates.as_deref())
            .is_some_and(|creates| {
                creates.iter().any(|created| {
                    created.node == original.node && created.source == original.source
                })
            })
    });
    let owner = owners.next()?;
    if owners.next().is_some() {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        params, effects, ..
    } = &owner.kind
    else {
        return None;
    };
    let (parameter, path) = super::scenario_receipts::checked_contract_parameter_source_path(
        ir,
        owner,
        actual,
        Some(db),
    )?;
    if path != *name || !params.contains(&parameter) {
        return None;
    }
    let (tree, diagnostics) = crate::syntax::parse(db, node.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let text = &db.get(node.file)?.text;
    let mut pending = vec![&tree];
    while let Some(at) = pending.pop() {
        // A preceding source binding cannot stand in for the parameter.
        if at.kind == SyntaxKind::Let
            && at.span.start < node.start
            && at.span.start >= facts.node.start
            && at.span.end <= facts.node.end
            && at
                .children
                .iter()
                .find(|part| part.kind == SyntaxKind::Name)
                .is_some_and(|part| part.token().is_some_and(|token| token.text(text) == name))
        {
            return None;
        }
        pending.extend(at.children.iter());
    }
    let mut statements: Vec<_> = effects.iter().collect();
    while let Some(statement) = statements.pop() {
        match statement {
            IrStmt::Let {
                name: binding,
                span,
                ..
            } if binding == name && span.start < node.start => return None,
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => {
                statements.extend(then_branch);
                statements.extend(else_branch);
            }
            _ => {}
        }
    }
    nominal_identity(ir, owner, *symbol, db)
}

/// Original leaf-prefix expressions use the same semantic source join as its
/// authored Create inputs. Their statement/type/effect order remains caller-owned.
pub(super) fn checked_create_expression(
    ir: &IrProgram,
    original: &CheckedScenarioCreate,
    actual: &TypedExpr,
    node: NodeKey,
    db: &SourceDb,
) -> Option<()> {
    source(ir, &original.source, span(node), db)?;
    let (tree, diagnostics) = crate::syntax::parse(db, node.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let text = &db.get(node.file)?.text;
    let mut nodes = HashMap::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter());
    }
    SourceExpressions {
        ir,
        db,
        original,
        owner: None,
        nodes: &nodes,
        text,
        operands: true,
        membership_call: None,
        query_alias: None,
    }
    .expression(actual, node, 0)
}

/// Join an original conditional prefix without admitting effects inside it.
/// The caller retains responsibility for its position before the original Create.
pub(super) fn checked_create_prefix_if(
    ir: &IrProgram,
    owner: &IrItem,
    original: &CheckedScenarioCreate,
    actual: &IrStmt,
    node: NodeKey,
    db: &SourceDb,
) -> Option<()> {
    if !matches!(actual, IrStmt::If { .. }) {
        return None;
    }
    source(ir, &original.source, span(node), db)?;
    let (tree, diagnostics) = crate::syntax::parse(db, node.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let mut nodes = HashMap::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        nodes.insert(NodeKey::of(node), node);
        pending.extend(node.children.iter());
    }
    let expressions = SourceExpressions {
        ir,
        db,
        original,
        owner: Some(owner),
        nodes: &nodes,
        text: &db.get(node.file)?.text,
        operands: true,
        membership_call: None,
        query_alias: None,
    };
    expressions.prefix_statement(actual, nodes.get(&node)?, 0)
}

/// Reuse the owning construction field's checked Given provenance when the
/// same declared field also participates in a stored-reference source census.
/// No mutable IR bound or receiver spelling supplies the missing provenance.
pub(super) fn checked_stored_field_trait_modifiers(
    ir: &IrProgram,
    field: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    actual: &super::ir::IrModifiers,
    db: &SourceDb,
) -> Option<bool> {
    let mut matched = false;
    for owner in &ir.items {
        let Some(facts) = ir
            .scenario_disclosures
            .get(&owner.id)
            .and_then(|value| value.source_facts())
        else {
            continue;
        };
        for original in facts.creates.as_deref().unwrap_or_default() {
            if original.model != field.owner {
                continue;
            }
            let Some(created) = original
                .definition
                .fields
                .iter()
                .find(|created| created.field == field.id)
            else {
                continue;
            };
            if !created
                .modifier_sources
                .iter()
                .any(|source| !source.4.is_empty())
            {
                continue;
            }
            super::scenario_calls::checked_source(ir, owner, db)?;
            if created.canonical != field.canonical
                || created.name != field.name
                || created.ty != field.ty
                || created.source != field.source
                || created.reuse != field.reuse
                || created.constraints != field.constraints
            {
                return None;
            }
            checked_field_trait_modifiers(ir, original, created, actual, db)?;
            matched = true;
        }
    }
    Some(matched)
}

/// Match source-owned field-trait constraints through the original reuse chain.
/// The shared lowering helper owns Given intersection; this join only supplies
/// authenticated declarations/constants and checks its exact emitted result.
fn trait_literal_value(
    matcher: &SourceExpressions<'_>,
    node: &SyntaxNode,
    ty: &ResolvedType,
) -> Option<TypedExpr> {
    let value = match node.kind {
        SyntaxKind::Group => return trait_literal_value(matcher, expressions(node).first()?, ty),
        SyntaxKind::Literal => {
            let token = node
                .children
                .iter()
                .find_map(|part| part.token().map(|token| (part.kind, token)))?;
            match token.0 {
                SyntaxKind::Integer => {
                    IrExpr::Int(token.1.text(matcher.text).parse().ok()?)
                }
                SyntaxKind::Decimal => IrExpr::Decimal(token.1.text(matcher.text).into()),
                _ => return None,
            }
        }
        SyntaxKind::Unary => {
            if !node.children.iter().any(|part| {
                part.token()
                    .is_some_and(|token| token.text(matcher.text) == "-")
            }) {
                return None;
            }
            IrExpr::Unary {
                op: IrUnOp::Neg,
                operand: Box::new(trait_literal_value(matcher, expressions(node).first()?, ty)?),
            }
        }
        _ => return None,
    };
    Some(TypedExpr::new(value, ty.clone(), node.span))
}

fn match_trait_bound(
    matcher: &SourceExpressions<'_>,
    node: NodeKey,
    ty: &ResolvedType,
    candidates: &[Option<&TypedExpr>],
) -> Option<TypedExpr> {
    for candidate in candidates.iter().flatten() {
        if matcher.expression(candidate, node, 0).is_some() {
            return Some((*candidate).clone());
        }
    }
    let value = trait_literal_value(matcher, matcher.nodes.get(&node)?, ty)?;
    matcher.expression(&value, node, 0)?;
    Some(value)
}

fn load_trait_item<'x>(
    ir: &'x IrProgram,
    data: &FieldData,
    ty: &ResolvedType,
) -> Option<(&'x IrItem, &'x IrItem, &'x ResolvedType, &'x super::ir::IrModifiers)> {
    let item = ir.items.get(data.field.0 as usize)?;
    let IrItemKind::Field {
        owner,
        ty: IrType::Known(actual_ty),
        modifiers,
        ..
    } = &item.kind
    else {
        return None;
    };
    let owner = ir.items.get(owner.0 as usize)?;
    if item.id != data.field
        || item.module != owner.module
        || item.canonical != format!("{}.{}", owner.canonical, item.name)
        || actual_ty != ty
    {
        return None;
    }
    Some((item, owner, actual_ty, modifiers))
}

fn check_trait_authored(
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    data: &FieldData,
    item: &IrItem,
) -> Option<()> {
    let authored = nodes.get(&data.node)?;
    if authored.kind != SyntaxKind::Field
        || authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?
            .span
            != item.span
    {
        return None;
    }
    Some(())
}

fn check_trait_reuse(
    ir: &IrProgram,
    db: &SourceDb,
    matcher: &SourceExpressions<'_>,
    nodes: &HashMap<NodeKey, &SyntaxNode>,
    text: &str,
    data: &FieldData,
    owner: &IrItem,
    target: &IrItem,
    target_owner: &SymbolId,
) -> Option<()> {
    let path = nodes
        .get(&data.type_node)?
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Path)?;
    let spelling = path
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Name)
        .map(|part| Some(part.token()?.text(text)))
        .collect::<Option<Vec<_>>>()?
        .join(".");
    let (provider, name) = spelling.rsplit_once('.')?;
    if name != target.name {
        return None;
    }
    let scenario = ir
        .items
        .get(matcher.transcript_source()?.scenario.0 as usize)?;
    nominal_identity(ir, scenario, *target_owner, db)?;
    reference_name(ir, owner, *target_owner, provider, db)?;
    Some(())
}

fn apply_trait_bound(
    matcher: &SourceExpressions<'_>,
    bound_ty: &ResolvedType,
    actual: &super::ir::IrModifiers,
    modifiers: &super::ir::IrModifiers,
    minimum: bool,
    node: NodeKey,
    expected: &mut super::ir::IrModifiers,
) -> Option<()> {
    let candidates = if minimum {
        [actual.min.as_ref(), modifiers.min.as_ref()]
    } else {
        [actual.max.as_ref(), modifiers.max.as_ref()]
    };
    let value = match_trait_bound(matcher, node, bound_ty, &candidates)?;
    let slot = if minimum {
        &mut expected.min
    } else {
        &mut expected.max
    };
    if let Some(old) = slot.as_ref() {
        let order = super::ir::compare_literal_bounds(&value, old)?;
        if (minimum && order == std::cmp::Ordering::Less)
            || (!minimum && order == std::cmp::Ordering::Greater)
        {
            return None;
        }
    }
    *slot = Some(value);
    Some(())
}

fn apply_trait_modifier(
    matcher: &SourceExpressions<'_>,
    bound_ty: &ResolvedType,
    actual: &super::ir::IrModifiers,
    modifiers: &super::ir::IrModifiers,
    modifier: &crate::analysis::effects::ModifierData,
    expected: &mut super::ir::IrModifiers,
) -> Option<()> {
    match (modifier.name.as_str(), modifier.value) {
        ("trim", None) => expected.trim = true,
        ("min" | "max", Some(node)) => {
            apply_trait_bound(
                matcher,
                bound_ty,
                actual,
                modifiers,
                modifier.name == "min",
                node,
                expected,
            )?;
        }
        ("unique" | "machine", None) => {}
        _ => return None,
    }
    Some(())
}

fn join_trait_source(
    ir: &IrProgram,
    db: &SourceDb,
    original: &CheckedScenarioCreate,
    data: &FieldData,
    origin: &DisclosureSource,
    ty: &ResolvedType,
    reuse: &Option<SymbolId>,
    given: &[crate::analysis::types::GivenContributedField],
    actual: &super::ir::IrModifiers,
    expected: &mut super::ir::IrModifiers,
) -> Option<()> {
    let (item, owner, _actual_ty, modifiers) = load_trait_item(ir, data, ty)?;
    source(ir, origin, item.span, db)?;
    source(ir, origin, span(data.node), db)?;
    let (tree, diagnostics) = crate::syntax::parse(db, data.node.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let mut nodes = HashMap::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        nodes.insert(NodeKey::of(node), node);
        pending.extend(&node.children);
    }
    let text = &db.get(data.node.file)?.text;
    check_trait_authored(&nodes, data, item)?;
    let matcher = SourceExpressions {
        ir,
        db,
        original,
        owner: None,
        nodes: &nodes,
        text,
        operands: false,
        membership_call: None,
        query_alias: None,
    };
    if let Some(target_id) = reuse {
        let target = ir.items.get(target_id.0 as usize)?;
        let IrItemKind::Field {
            owner: target_owner,
            ..
        } = &target.kind
        else {
            return None;
        };
        check_trait_reuse(ir, db, &matcher, &nodes, text, data, owner, target, target_owner)?;
    }
    let bound_ty = super::ir::given_bound_type(ty);
    for modifier in &data.modifiers {
        apply_trait_modifier(&matcher, &bound_ty, actual, modifiers, modifier, expected)?;
    }
    if given.iter().any(|value| value.name != item.name) {
        return None;
    }
    super::ir::apply_given_field_constraints_to(expected, &bound_ty, item.span, given);
    Some(())
}

fn check_trait_bounds(
    actual: &super::ir::IrModifiers,
    expected: &super::ir::IrModifiers,
) -> Option<()> {
    if actual.trim != expected.trim {
        return None;
    }
    for (actual, expected) in [(&actual.min, &expected.min), (&actual.max, &expected.max)] {
        match (actual, expected) {
            (None, None) => {}
            (Some(actual), Some(expected))
                if actual.ty == expected.ty && actual.span == expected.span =>
            {
                match (literal_json(actual), literal_json(expected)) {
                    (Some(actual), Some(expected)) if actual == expected => {}
                    (None, None)
                        if format!("{:?}", actual.expr) == format!("{:?}", expected.expr) => {}
                    _ => return None,
                }
            }
            _ => return None,
        }
    }
    Some(())
}

fn checked_field_trait_modifiers(
    ir: &IrProgram,
    original: &CheckedScenarioCreate,
    field: &crate::analysis::scenario_disclosure::CheckedScenarioCreatedField,
    actual: &super::ir::IrModifiers,
    db: &SourceDb,
) -> Option<()> {
    let sources = &field.modifier_sources;
    if sources.is_empty()
        || sources.len() > 128
        || sources[0].0.field != field.field
        || sources[0].3 != field.reuse
    {
        return None;
    }
    let mut seen = HashSet::new();
    let mut expected = super::ir::IrModifiers::default();
    for (index, (data, origin, ty, reuse, given)) in sources.iter().enumerate().rev() {
        if !seen.insert(data.field) || *reuse != sources.get(index + 1).map(|value| value.0.field) {
            return None;
        }
        join_trait_source(ir, db, original, data, origin, ty, reuse, given, actual, &mut expected)?;
    }
    check_trait_bounds(actual, &expected)
}

/// Match the same original Given field for construction and stored disclosure.
/// Its span names the checked attachment, never an invented Field syntax node.
fn check_contributed_identity(
    ir: &IrProgram,
    field: &IrItem,
    model: &IrItem,
    original_field: &crate::analysis::scenario_disclosure::CheckedScenarioContributedField,
    expected: &crate::analysis::types::GivenContributedField,
    ty: &ResolvedType,
    field_owner: &SymbolId,
    required_array: &bool,
    server: &Option<IrServer>,
    modifiers: &super::ir::IrModifiers,
    description: &Option<String>,
) -> Option<()> {
    if field.id != original_field.field
        || *field_owner != model.id
        || field.module != model.module
        || field.canonical != original_field.canonical
        || field.name != expected.name
        || field.canonical != format!("{}.{}", model.canonical, expected.name)
        || field.span != original_field.span
        || ty != &original_field.ty
        || ir.value_constraints.get(&field.id) != original_field.constraints.as_ref()
        || *required_array
        || server.is_some()
        || description.is_some()
        || modifiers.trim != expected.trim
        || modifiers.unique
        || modifiers.machine
    {
        return None;
    }
    Some(())
}

fn check_contributed_default(
    expected: &crate::analysis::types::GivenContributedField,
    ty: &ResolvedType,
    field_span: Span,
    default: &Option<IrDefault>,
) -> Option<()> {
    let value = expected.default.as_deref()?;
    let IrDefault::Literal(actual) = default.as_ref()? else {
        return None;
    };
    let expected_default = super::ir::given_constant_expr(value, ty, field_span);
    if actual.ty != expected_default.ty
        || actual.span != field_span
        || literal_json(actual)? != literal_json(&expected_default)?
    {
        return None;
    }
    Some(())
}

fn check_contributed_bound(
    actual: &Option<TypedExpr>,
    expected: &Option<String>,
    bound_type: &ResolvedType,
    field_span: Span,
) -> Option<()> {
    match (actual, expected) {
        (None, None) => {}
        (Some(actual), Some(expected)) => {
            let expected = super::ir::given_constant_expr(expected, bound_type, field_span);
            if actual.ty != expected.ty
                || actual.span != field_span
                || literal_json(actual)? != literal_json(&expected)?
            {
                return None;
            }
        }
        _ => return None,
    }
    Some(())
}

pub(super) fn checked_contributed_field(
    ir: &IrProgram,
    model: &IrItem,
    original_field: &crate::analysis::scenario_disclosure::CheckedScenarioContributedField,
    db: &SourceDb,
) -> Option<()> {
    let field = ir.items.get(original_field.field.0 as usize)?;
    let expected = &original_field.value;
    let IrItemKind::Field {
        owner: field_owner,
        ty: IrType::Known(ty),
        required_array,
        default,
        server,
        modifiers,
        description,
        ..
    } = &field.kind
    else {
        return None;
    };
    check_contributed_identity(
        ir,
        field,
        model,
        original_field,
        expected,
        ty,
        field_owner,
        required_array,
        server,
        modifiers,
        description,
    )?;
    source(ir, &original_field.source, field.span, db)?;
    check_contributed_default(expected, ty, field.span, default)?;
    let bound_type = super::ir::given_bound_type(ty);
    for (actual, expected) in [
        (&modifiers.min, &expected.min),
        (&modifiers.max, &expected.max),
    ] {
        check_contributed_bound(actual, expected, &bound_type, field.span)?;
    }
    Some(())
}

fn source(ir: &IrProgram, original: &DisclosureSource, at: Span, db: &SourceDb) -> Option<()> {
    let modules: Vec<_> = ir
        .modules
        .iter()
        .filter(|module| module.file == at.file && module.name == original.module)
        .collect();
    let [module] = modules.as_slice() else {
        return None;
    };
    let file = db.get(module.file)?;
    (file.path == original.path
        && file.sha256 == original.sha256
        && file.sha256 == sha256_hex(file.text.as_bytes())
        && at.end as usize <= file.text.len()
        && db
            .iter()
            .filter(|(_, file)| file.path == original.path)
            .count()
            == 1)
        .then_some(())
}

struct SourceExpressions<'a> {
    ir: &'a IrProgram,
    db: &'a SourceDb,
    original: &'a CheckedScenarioCreate,
    /// Owning scenario item, borrowed only for the conditional branch-arm
    /// prefix matcher (nested-set receiver classification). Unset matchers
    /// refuse nested sets.
    owner: Option<&'a IrItem>,
    nodes: &'a HashMap<NodeKey, &'a SyntaxNode>,
    text: &'a str,
    operands: bool,
    /// Borrow the existing exact transitive membership proof only while
    /// matching the admitted authorization body; ordinary StateRead stays refused.
    membership_call: Option<&'a crate::analysis::scenario_disclosure::CheckedDecisionCall>,
    /// The checked query's authored alias may normalize to the IR row name.
    /// This mapping is borrowed only while matching that query's predicate.
    query_alias: Option<(&'a str, &'a str)>,
}

impl<'a> SourceExpressions<'a> {
    fn match_require_statement(
        &self,
        cond: &TypedExpr,
        values: &[&SyntaxNode],
        depth: usize,
    ) -> Option<()> {
        let [value] = values else {
            return None;
        };
        if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        self.expression(cond, NodeKey::of(value), depth + 1)
    }

    fn match_return_statement(
        &self,
        value: &Option<TypedExpr>,
        values: &[&SyntaxNode],
        depth: usize,
    ) -> Option<()> {
        match (value, values) {
            (Some(value), [authored]) => {
                self.expression(value, NodeKey::of(authored), depth + 1)
            }
            (None, []) => Some(()),
            _ => None,
        }
    }

    fn split_branch_nodes<'x>(
        &self,
        node: &'x SyntaxNode,
        condition: &SyntaxNode,
    ) -> Option<(Vec<&'x SyntaxNode>, Vec<&'x SyntaxNode>)> {
        let mut then_nodes = Vec::new();
        let mut else_nodes = Vec::new();
        let mut in_else = false;
        for child in &node.children {
            if child.span == condition.span
                || matches!(child.kind, SyntaxKind::Trivia | SyntaxKind::Comment)
            {
                continue;
            }
            if child.kind == SyntaxKind::Name {
                match child.token()?.text(self.text) {
                    "if" if !in_else && then_nodes.is_empty() => continue,
                    "else" if !in_else => {
                        in_else = true;
                        continue;
                    }
                    _ => return None,
                }
            }
            if in_else {
                else_nodes.push(child);
            } else {
                then_nodes.push(child);
            }
        }
        Some((then_nodes, else_nodes))
    }

    fn match_if_statement(
        &self,
        cond: &TypedExpr,
        then_branch: &[IrStmt],
        else_branch: &[IrStmt],
        node: &SyntaxNode,
        values: &[&SyntaxNode],
        depth: usize,
    ) -> Option<()> {
        let [condition] = values else {
            return None;
        };
        if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        self.expression(cond, NodeKey::of(condition), depth + 1)?;
        let (then_nodes, else_nodes) = self.split_branch_nodes(node, condition)?;
        if then_branch.len() != then_nodes.len() || else_branch.len() != else_nodes.len() {
            return None;
        }
        for (actual, authored) in then_branch
            .iter()
            .zip(then_nodes)
            .chain(else_branch.iter().zip(else_nodes))
        {
            self.prefix_statement(actual, authored, depth + 1)?;
        }
        Some(())
    }

    fn match_set_receiver<'x>(
        &'x self,
        record: &TypedExpr,
        node: &SyntaxNode,
    ) -> Option<(&'x IrItem, String)> {
        let owner = self.owner?;
        let IrExpr::Name(actual) = &record.expr else {
            return None;
        };
        let mut paths = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Path);
        let receiver = paths.next()?;
        if paths.next().is_some()
            || record.span != receiver.span
            || self
                .original
                .expression_types
                .iter()
                .find(|(at, _)| *at == NodeKey::of(receiver))
                .is_none_or(|(_, ty)| ty != &record.ty)
        {
            return None;
        }
        let receiver_name =
            super::scenario_receipts::direct_source_path_name(receiver, self.text)?;
        // 0551: the actual receiver name must be the authored one in
        // every class. Class membership alone (pre-bound param/let)
        // would otherwise admit a same-span/type row swap.
        if actual.as_str() != receiver_name {
            return None;
        }
        Some((owner, receiver_name.to_string()))
    }

    fn check_set_receiver_class(
        &self,
        owner: &IrItem,
        record: &TypedExpr,
        receiver_name: &str,
        span: Span,
    ) -> Option<()> {
        if receiver_name == self.original.binding.as_str() {
            super::scenario_receipts::created_record_name_matches(
                record,
                &ResolvedType::Record {
                    symbol: self.original.model,
                    stored: true,
                },
                &self.original.binding,
                span,
                self.db,
            )?;
        } else {
            let IrItemKind::Scenario {
                effects: owner_effects,
                params: owner_params,
                ..
            } = &owner.kind
            else {
                return None;
            };
            let mut prebound = false;
            for id in owner_params.iter() {
                if self
                    .ir
                    .items
                    .get(id.0 as usize)
                    .is_some_and(|item| item.name == receiver_name)
                {
                    prebound = true;
                }
            }
            for effect in owner_effects.iter() {
                if matches!(effect, IrStmt::Let { name, .. } if name == receiver_name) {
                    prebound = true;
                }
            }
            if !prebound || !matches!(&record.ty, ResolvedType::Record { stored: true, .. })
            {
                let selected = super::scenario_receipts::checked_first_query_row(
                    self.ir, owner, record, self.db,
                )?;
                if record.ty
                    != (ResolvedType::Record {
                        symbol: selected.id,
                        stored: true,
                    })
                {
                    return None;
                }
            }
        }
        Some(())
    }

    fn prefix_statement(&self, actual: &IrStmt, node: &SyntaxNode, depth: usize) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let values = expressions(node);
        match actual {
            IrStmt::Require { cond, span }
                if node.kind == SyntaxKind::Require && node.span == *span =>
            {
                self.match_require_statement(cond, &values, depth)
            }
            IrStmt::Return { value, span }
                if node.kind == SyntaxKind::Return && node.span == *span =>
            {
                self.match_return_statement(value, &values, depth)
            }
            IrStmt::If {
                cond,
                then_branch,
                else_branch,
                span,
            } if node.kind == SyntaxKind::If && node.span == *span => {
                self.match_if_statement(cond, then_branch, else_branch, node, &values, depth)
            }
            // Arm-nested creates need only kind+span correspondence here:
            // their entry correspondence is proven by the owning create
            // check (which runs for nested creates too), and arm admission
            // itself is owned by the conditional branch rule.
            IrStmt::Create { span, .. }
                if node.kind == SyntaxKind::Create && node.span == *span =>
            {
                Some(())
            }
            // Arm-nested sets carry the same source correspondence as
            // top-level sets: the receiver span and sealed type must match
            // the authored `set` path, the receiver must be the conditional
            // binding, a pre-bound row, or the checked first-query row, and
            // every changed entry must match the authored object. Kind+span
            // alone would admit IR whose operands no longer match the .can.
            IrStmt::Set {
                record,
                changes,
                when: None,
                span,
            } if node.kind == SyntaxKind::Set && node.span == *span => {
                let (owner, receiver_name) = self.match_set_receiver(record, node)?;
                self.check_set_receiver_class(owner, record, &receiver_name, *span)?;
                super::scenario_receipts::checked_created_object_entries(
                    self.ir,
                    self.original,
                    changes,
                    node,
                    *span,
                    self.db,
                )?;
                Some(())
            }
            _ => None,
        }
    }

    fn transcript_source(
        &self,
    ) -> Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource> {
        let mut owners = self.ir.items.iter().filter(|owner| {
            self.ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|source| {
                    source.source == self.original.source
                        && source.creates.as_deref().is_some_and(|creates| {
                            creates
                                .iter()
                                .any(|created| created.node == self.original.node)
                        })
                })
        });
        let owner = owners.next()?;
        if owners.next().is_some() {
            return None;
        }
        super::scenario_calls::checked_source(self.ir, owner, self.db)
    }

    /// Unique scenario owner holding this exact checked create. The
    /// direct leading-any composition has no transcript source, so the
    /// legacy transcript lookup above cannot supply its owner.
    fn create_owner(&self) -> Option<&'a IrItem> {
        let mut owners = self.ir.items.iter().filter(|owner| {
            self.ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|source| {
                    source.source == self.original.source
                        && source.creates.as_deref().is_some_and(|creates| {
                            creates
                                .iter()
                                .any(|created| created.node == self.original.node)
                        })
                })
        });
        let owner = owners.next()?;
        if owners.next().is_some() {
            return None;
        }
        Some(owner)
    }

    fn check_transcript_callee(
        target: &IrCallTarget,
        callee: &IrItem,
        params: &[SymbolId],
        fact: &CheckedTranscriptSource,
        result: &ResolvedType,
        actual: &TypedExpr,
        body: &TypedExpr,
    ) -> Option<()> {
        if !matches!(target, IrCallTarget::DeriveFn(name) if name == &callee.canonical)
            || params != [fact.formal]
            || result != &fact.ty
            || actual.ty != fact.ty
            || body.span != span(fact.body)
            || body.ty != fact.ty
        {
            return None;
        }
        Some(())
    }

    fn check_transcript_call_args(
        &self,
        source: &CheckedScenarioSource,
        fact: &CheckedTranscriptSource,
        argument: &TypedExpr,
        parameter: &IrItem,
        formal: &IrItem,
        slots: Option<&Vec<Option<usize>>>,
        key: NodeKey,
        callee: &IrItem,
    ) -> Option<()> {
        if !matches!(&argument.expr, IrExpr::Name(name) if name == &parameter.name)
            || argument.span != span(fact.argument)
            || !matches!(&parameter.kind, IrItemKind::Param { owner, ty: IrType::Known(ty), default: None, .. }
                if *owner == source.scenario && ty == &argument.ty && *ty == ResolvedType::Record { symbol: fact.branch, stored: true })
            || !matches!(&formal.kind, IrItemKind::Param { owner, index: 0, ty: IrType::Known(ty), default: None, .. }
                if *owner == fact.derive && ty == &argument.ty)
            || slots.is_some_and(|slots| slots.as_slice() != [Some(0)])
            || source_path(expressions(self.nodes.get(&key)?).first()?, self.text)? != callee.name
        {
            return None;
        }
        Some(())
    }

    fn check_transcript_query_shape(
        actual: &TypedExpr,
        query: &IrQuery,
        fact: &CheckedTranscriptSource,
        model: &IrItem,
        formal: &IrItem,
        selected: &TypedExpr,
    ) -> Option<()> {
        if actual.ty != fact.ty
            || query.source.as_deref() != Some(&fact.query)
            || !matches!(&query.domain, super::ir::IrQueryDomain::Model(name) if name == &model.canonical)
            || !matches!(&query.parent.as_ref()?.expr, IrExpr::Name(name) if name == &formal.name)
            || query.select_param.as_deref() != Some("turn")
            || query.where_pred.is_some()
            || query.where_async
            || query.limit.is_some()
            || query.archived.is_some()
            || query.collection_call.is_some()
            || query.contract_collection_call.is_some()
            || query.value_order.is_some()
            || query.order.len() != 1
            || query.order[0].field != "position"
            || query.order[0].descending
            || selected.span != span(fact.select)
        {
            return None;
        }
        Some(())
    }

    fn transcript_call(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        let source = self.transcript_source()?;
        let fact = source
            .transcripts
            .as_deref()?
            .iter()
            .find(|fact| fact.call == key)?;
        let (target, args, slots) = match &actual.expr {
            IrExpr::Call { target, args } => (target, args, None),
            IrExpr::BoundCall {
                target,
                args,
                slots,
            } => (target, args, Some(slots)),
            _ => return None,
        };
        let callee = self.ir.items.get(fact.derive.0 as usize)?;
        let IrItemKind::DeriveFn {
            params,
            result: IrType::Known(result),
            expr: Some(body),
        } = &callee.kind
        else {
            return None;
        };
        let [argument] = args.as_slice() else {
            return None;
        };
        let parameter = self.ir.items.get(fact.parameter.0 as usize)?;
        let formal = self.ir.items.get(fact.formal.0 as usize)?;
        Self::check_transcript_callee(target, callee, params, fact, result, actual, body)?;
        self.check_transcript_call_args(
            source, fact, argument, parameter, formal, slots, key, callee,
        )?;
        self.expression(argument, fact.argument, depth + 1)?;
        self.expression(body, fact.body, depth + 1)
    }

    /// Match the original inline, WHERE-bound standard message selection.
    /// The source query has no local Contract identity or helper invocation.
    fn load_inline_fact<'x>(
        &'x self,
        key: NodeKey,
    ) -> Option<&'x CheckedInlineSelectionSource> {
        let source = self.transcript_source()?;
        let mut facts = source
            .inline_selections
            .as_deref()?
            .iter()
            .filter(|fact| fact.query.node == key);
        let fact = facts.next()?;
        if facts.next().is_some() {
            return None;
        }
        Some(fact)
    }

    fn check_inline_query_shape(
        actual: &TypedExpr,
        key: NodeKey,
        query: &IrQuery,
        fact: &CheckedInlineSelectionSource,
        model: &IrItem,
        parent: &TypedExpr,
        predicate: &TypedExpr,
        select: &TypedExpr,
        predicate_node: NodeKey,
        alias_name: &String,
    ) -> Option<()> {
        if actual.ty != fact.ty
            || actual.span != span(key)
            || query.source.as_deref() != Some(&fact.checked)
            || !matches!(&query.domain, super::ir::IrQueryDomain::Model(name) if name == &model.canonical)
            || parent.span != span(fact.parent.node)
            || predicate.span != span(predicate_node)
            || select.span != span(fact.select)
            || query.select_param.as_deref() != Some(alias_name.as_str())
            || query.where_async
            || query.limit.is_some()
            || query.archived.is_some()
            || query.collection_call.is_some()
            || query.contract_collection_call.is_some()
            || query.value_order.is_some()
        {
            return None;
        }
        Some(())
    }

    fn check_inline_query_order(
        query: &IrQuery,
        fact: &CheckedInlineSelectionSource,
    ) -> Option<()> {
        if query.order.len() != 1
            || query.order[0].field != "position"
            || query.order[0].descending
            || fact.query.first.is_some()
            || fact.query.count.is_some()
            || fact.query.projection.is_some()
        {
            return None;
        }
        Some(())
    }

    fn check_inline_predicate(
        &self,
        predicate: &TypedExpr,
        fact: &CheckedInlineSelectionSource,
        model: &IrItem,
        predicate_node: NodeKey,
        alias_name: &String,
        depth: usize,
    ) -> Option<()> {
        let IrExpr::Binary {
            op: IrBinOp::Lt,
            left,
            right,
        } = &predicate.expr
        else {
            return None;
        };
        let IrExpr::Member { base, field } = &left.expr else {
            return None;
        };
        let original_predicate = self.nodes.get(&predicate_node)?;
        let original_operands = expressions(original_predicate);
        let [original_left, original_right] = original_operands.as_slice() else {
            return None;
        };
        let left_children = expressions(original_left);
        let [original_alias] = left_children.as_slice() else {
            return None;
        };
        if field != "position"
            || !matches!(&base.expr,IrExpr::Name(name) if name=="row")
            || base.span != original_alias.span
            || left.span != original_left.span
            || left.span != span(fact.predicate_dependency.node)
            || self.word(NodeKey::of(original_alias))? != alias_name
            || base.ty
                != (ResolvedType::Record {
                    symbol: model.id,
                    stored: true,
                })
            || left.ty != ResolvedType::Scalar(Scalar::Int)
            || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        {
            return None;
        }
        self.expression(right, NodeKey::of(original_right), depth + 1)
    }

    fn inline_selection_query(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        let fact = self.load_inline_fact(key)?;
        let IrExpr::Query(query) = &actual.expr else {
            return None;
        };
        let model = self.ir.items.get(fact.query.model.0 as usize)?;
        let parent = query.parent.as_ref()?;
        let predicate = query.where_pred.as_ref()?;
        let select = query.select.as_ref()?;
        let predicate_node = fact.query.predicate?;
        let alias = fact
            .checked
            .clauses
            .iter()
            .find(|clause| Some(clause.node) == fact.query.alias)?;
        let crate::analysis::types::CheckedQueryClauseKind::As { name: alias_name } = &alias.kind
        else {
            return None;
        };
        Self::check_inline_query_shape(
            actual, key, query, fact, model, parent, predicate, select, predicate_node,
            alias_name,
        )?;
        Self::check_inline_query_order(query, fact)?;
        self.expression(parent, fact.parent.node, depth + 1)?;
        // Ordinary query predicates lower their authored alias to `row`; the
        // select expression keeps `prior`. Authenticate that existing rewrite
        // at this exact checked predicate instead of changing source or IR.
        self.check_inline_predicate(
            predicate,
            fact,
            model,
            predicate_node,
            alias_name,
            depth,
        )?;
        self.expression(select, fact.select, depth + 1)
    }

    fn transcript_query(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        let source = self.transcript_source()?;
        let fact = source
            .transcripts
            .as_deref()?
            .iter()
            .find(|fact| fact.query.node == key)?;
        let IrExpr::Query(query) = &actual.expr else {
            return None;
        };
        let parent = query.parent.as_ref()?;
        let selected = query.select.as_ref()?;
        let model = self.ir.items.get(fact.model.0 as usize)?;
        let formal = self.ir.items.get(fact.formal.0 as usize)?;
        let domain = self.nodes.get(&fact.query.domain)?;
        let receivers = expressions(domain);
        let [receiver] = receivers.as_slice() else {
            return None;
        };
        Self::check_transcript_query_shape(actual, query, fact, model, formal, selected)?;
        self.expression(parent, NodeKey::of(receiver), depth + 1)?;
        self.expression(selected, fact.select, depth + 1)
    }

    fn word(&self, key: NodeKey) -> Option<&str> {
        let node = self.nodes.get(&key)?;
        (node.kind == SyntaxKind::NameRef)
            .then(|| single_name(node, self.text))
            .flatten()
    }

    fn optional(&self, actual: Option<&TypedExpr>, original: Option<NodeKey>) -> Option<()> {
        match (actual, original) {
            (None, None) => Some(()),
            (Some(actual), Some(original)) => self.expression(actual, original, 0),
            _ => None,
        }
    }

    fn find_text_import<'x>(
        &'x self,
        node: &SyntaxNode,
        alias: &str,
    ) -> Option<(
        &'x super::ir::IrModule,
        &'x super::ir::IrImport,
        &'x (String, String, Span),
    )> {
        let mut modules = self.ir.modules.iter().filter(|module| {
            module.name == self.original.source.module && module.file == node.span.file
        });
        let module = modules.next()?;
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
        if modules.next().is_some() {
            return None;
        }
        Some((module, import, member))
    }

    fn check_text_shape(
        &self,
        roots: &[(String, Span)],
        name: &str,
        node: &SyntaxNode,
        module: &super::ir::IrModule,
        target: &SyntaxNode,
        object: &SyntaxNode,
        import: &super::ir::IrImport,
        member: &(String, String, Span),
        field_count: usize,
        entry_count: usize,
    ) -> Option<()> {
        if module.id.0 as usize >= self.ir.modules.len()
            || self.ir.modules[module.id.0 as usize].id != module.id
            || node.span.start < module.span.start
            || node.span.end > module.span.end
            || target.kind != SyntaxKind::NameRef
            || object.kind != SyntaxKind::Object
            || import.provider != "std"
            || import.from.is_some()
            || member.0 != name
            || !roots
                .iter()
                .any(|(root, at)| root == name && *at == member.2)
            || field_count > 200
            || entry_count > 200
            || field_count != entry_count
        {
            return None;
        }
        Some(())
    }

    fn check_text_entry<'e>(
        &self,
        fields: &[(String, ResolvedType)],
        name: &'e String,
        value: &TypedExpr,
        entry: &SyntaxNode,
        seen: &mut HashSet<&'e String>,
        depth: usize,
    ) -> Option<()> {
        let key = entry
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Name)?;
        let (_, expected) = fields.iter().find(|(field, _)| field == name)?;
        // Literal arrays may retain the checker's stronger nonempty fact;
        // their actual element identity and order still match exactly.
        let compatible = match (&value.ty, expected) {
            (
                ResolvedType::Array {
                    element,
                    ordered,
                    nonempty,
                },
                ResolvedType::Array {
                    element: declared,
                    ordered: declared_order,
                    nonempty: declared_nonempty,
                },
            ) => {
                element == declared
                    && ordered == declared_order
                    && (!declared_nonempty || *nonempty)
            }
            _ => &value.ty == expected,
        };
        if key.token()?.text(self.text) != name || !seen.insert(name) || !compatible {
            return None;
        }
        match expressions(entry).as_slice() {
            [] => self.expression(value, NodeKey::of(key), depth + 1)?,
            [original] => self.expression(value, NodeKey::of(original), depth + 1)?,
            _ => return None,
        }
        Some(())
    }

    fn text_constructor(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        entries: &[(String, TypedExpr)],
        depth: usize,
    ) -> Option<()> {
        let name = crate::analysis::types::checked_standard_nominal_name(&actual.ty)?;
        if !matches!(name, "TextRequest" | "TextMessage") || !self.operands {
            return None;
        }
        let roots = self
            .ir
            .committed_sources
            .standard_value_inventory_roots(self.ir, self.db)?;
        let parts = expressions(node);
        let [target, object] = parts.as_slice() else {
            return None;
        };
        let alias = single_name(target, self.text)?;
        let (module, import, member) = self.find_text_import(node, alias)?;
        let ResolvedType::StdNominal { fields, .. } = &actual.ty else {
            return None;
        };
        self.check_text_shape(
            roots,
            name,
            node,
            module,
            target,
            object,
            import,
            member,
            fields.len(),
            entries.len(),
        )?;
        let authored: Vec<_> = object
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::ObjectEntry)
            .collect();
        if authored.len() != entries.len() {
            return None;
        }
        let mut seen = HashSet::new();
        for ((name, value), entry) in entries.iter().zip(authored) {
            self.check_text_entry(fields, name, value, entry, &mut seen, depth)?;
        }
        Some(())
    }

    /// Match an original derive-fn call in an ordinary scenario expression:
    /// the checked IR callee identity plus each authored argument, in order.
    /// The derive definition is the single shared IR item on both sides;
    /// its body is checked by analysis, so correspondence here is the call
    /// occurrence itself, never a reconstructed helper.
    fn derive_call(&self, actual: &TypedExpr, node: &SyntaxNode, depth: usize) -> Option<()> {
        let (target, args, slots) = match &actual.expr {
            IrExpr::Call {
                target: IrCallTarget::DeriveFn(target),
                args,
            } => (target, args.as_slice(), None),
            IrExpr::BoundCall {
                target: IrCallTarget::DeriveFn(target),
                args,
                slots,
            } => (target, args.as_slice(), Some(slots.as_slice())),
            _ => return None,
        };
        let item = self
            .ir
            .items
            .iter()
            .find(|item| &item.canonical == target)?;
        let IrItemKind::DeriveFn {
            result: IrType::Known(result),
            expr: Some(_),
            ..
        } = &item.kind
        else {
            return None;
        };
        // The ordinary lane admits only an authenticated original derive
        // whose authored body performs no membership read; sealed or
        // unauthenticated derives refuse here and keep their strict path.
        if self.authenticated_derive(target, 0, &mut std::collections::HashSet::new())
            != Some(false)
        {
            return None;
        }
        if actual.ty != *result {
            return None;
        }
        if let Some(slots) = slots
            && (slots.len() != args.len()
                || slots
                    .iter()
                    .enumerate()
                    .any(|(index, slot)| *slot != Some(index)))
        {
            return None;
        }
        let children = expressions(node);
        if source_path(children.first()?, self.text)? != item.name {
            return None;
        }
        let arguments: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        if arguments.len() != args.len() {
            return None;
        }
        for (argument, value) in arguments.iter().zip(args.iter()) {
            let values = expressions(argument);
            let [source_value] = values.as_slice() else {
                return None;
            };
            self.expression(value, NodeKey::of(source_value), depth + 1)?;
        }
        Some(())
    }

    /// The sealed authorization shape: a derive whose body performs the
    /// catalog membership read. Such derives are the authorization machinery
    /// itself; their calls keep the strict authorization correspondence and
    /// never fall back to ordinary derive matching.
    /// Authenticate the original derive declaration in its defining source:
    /// declaration span/name, ordered formal identities, and the actual
    /// authored body structure must correspond to the supplied IR callee.
    /// Returns whether the authenticated body performs the catalog
    /// membership read or a stored query, directly or transitively.
    /// Lane selection consumes only this original evidence; a supplied IR
    /// body or formal list is never trusted, so deleting membership (or any
    /// other body/formal content) from mutable IR cannot reclassify a
    /// sealed derive as ordinary. `None` means the original declaration
    /// could not be authenticated at all.
    /// A checked occurrence type is the declared type or that type with
    /// outer nullable layers removed by flow narrowing (for example a
    /// formal read after a `!= null` guard in the same body).
    fn type_narrows(occurrence: &ResolvedType, declared: &ResolvedType) -> bool {
        occurrence == declared
            || matches!(declared, ResolvedType::Nullable(inner)
                if Self::type_narrows(occurrence, inner))
    }

    /// Canonical authored spelling of a checked type over the bounded
    /// grammar derive formals use (scalars, stored models, nullable and
    /// arrays). `None` leaves exotic shapes to their existing seals.
    fn authored_type_text(&self, ty: &ResolvedType) -> Option<String> {
        match ty {
            ResolvedType::Scalar(scalar) => Some(scalar.as_str().to_string()),
            ResolvedType::Record { symbol, .. } => {
                Some(self.ir.items.get(symbol.0 as usize)?.name.clone())
            }
            ResolvedType::Nullable(inner) => Some(format!("{}?", self.authored_type_text(inner)?)),
            ResolvedType::Array { element, .. } => {
                Some(format!("{}[]", self.authored_type_text(element)?))
            }
            _ => None,
        }
    }

    fn authenticated_derive(
        &self,
        target: &str,
        depth: usize,
        seen: &mut std::collections::HashSet<String>,
    ) -> Option<bool> {
        if depth > 32 || !seen.insert(target.to_string()) {
            // Cycles and excessive chains stay sealed; recursive derives are
            // refused by analysis, so this is only a fail-closed bound.
            return Some(true);
        }
        let result = self.authenticated_derive_inner(target, depth, seen);
        seen.remove(target);
        result
    }

    fn load_derive_item<'x>(
        &'x self,
        target: &str,
    ) -> Option<(
        &'x IrItem,
        &'x [SymbolId],
        &'x TypedExpr,
        &'x super::ir::IrModule,
    )> {
        let item = self.ir.items.iter().find(|item| item.canonical == target)?;
        let IrItemKind::DeriveFn {
            params,
            expr: Some(body),
            ..
        } = &item.kind
        else {
            return None;
        };
        let defining = self.ir.modules.get(item.module.0 as usize)?;
        if defining.id != item.module
            || item.canonical != format!("{}.{}", defining.name, item.name)
        {
            return None;
        }
        Some((item, params.as_slice(), body, defining))
    }

    fn check_derive_formal(
        &self,
        item: &IrItem,
        authored: &SyntaxNode,
        formal: &SymbolId,
        position: usize,
        defining_text: &str,
        formal_types: &mut Vec<(String, ResolvedType)>,
    ) -> Option<()> {
        let name = authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        let param = self.ir.items.get(formal.0 as usize)?;
        let IrItemKind::Param {
            owner,
            index,
            ty: param_ty,
            ..
        } = &param.kind
        else {
            return None;
        };
        if *owner != item.id
            || *index != position
            || name.token()?.text(defining_text) != param.name
        {
            return None;
        }
        // Formal type identity against the authored type declaration,
        // over the bounded type grammar derive formals use.
        if let IrType::Known(known) = param_ty {
            let type_node = authored.children.iter().find(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::NamedType
                        | SyntaxKind::UnionType
                        | SyntaxKind::ArrayType
                        | SyntaxKind::NullableType
                        | SyntaxKind::EnumType
                        | SyntaxKind::ActionType
                        | SyntaxKind::DeliveryType
                        | SyntaxKind::InvocationType
                )
            })?;
            if let Some(expected) = self.authored_type_text(known) {
                let authored_text: String = defining_text
                    .get(type_node.span.start as usize..type_node.span.end as usize)?
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                if authored_text != expected {
                    let mut base = known;
                    while let ResolvedType::Nullable(inner)
                    | ResolvedType::Array { element: inner, .. } = base
                    {
                        base = inner;
                    }
                    let ResolvedType::Record { symbol, .. } = base else {
                        return None;
                    };
                    let name = &self.ir.items.get(symbol.0 as usize)?.name;
                    let suffix = expected.strip_prefix(name)?;
                    reference_name(
                        self.ir,
                        item,
                        *symbol,
                        authored_text.strip_suffix(suffix)?,
                        self.db,
                    )?;
                }
            }
            formal_types.push((param.name.clone(), known.clone()));
        }
        Some(())
    }

    fn run_derive_body(
        &self,
        item: &IrItem,
        body: &TypedExpr,
        declaration: &SyntaxNode,
        defining_text: &str,
        formal_types: &[(String, ResolvedType)],
        depth: usize,
        seen: &mut std::collections::HashSet<String>,
    ) -> Option<bool> {
        let authored_bodies = expressions(declaration);
        let [authored_body] = authored_bodies.as_slice() else {
            return None;
        };
        let facts = self.transcript_source();
        let mut reached = Vec::new();
        let mut membership = false;
        self.derive_body_corresponds(
            item,
            body,
            authored_body,
            defining_text,
            0,
            formal_types,
            facts,
            &mut reached,
            &mut membership,
        )?;
        if membership {
            return Some(true);
        }
        for reached_target in reached {
            if self.authenticated_derive(&reached_target, depth + 1, seen)? {
                return Some(true);
            }
        }
        Some(false)
    }

    fn authenticated_derive_inner(
        &self,
        target: &str,
        depth: usize,
        seen: &mut std::collections::HashSet<String>,
    ) -> Option<bool> {
        let (item, params, body, defining) = self.load_derive_item(target)?;
        let defining_file = self.db.get(defining.file)?;
        let defining_text = defining_file.text.as_str();
        let defining_tree;
        let mut defining_nodes: HashMap<NodeKey, &SyntaxNode> =
            self.nodes.iter().map(|(key, node)| (*key, *node)).collect();
        if defining.file != self.original.node.file {
            let (tree, diagnostics) = crate::syntax::parse(self.db, defining.file);
            if !diagnostics.is_empty() {
                return None;
            }
            defining_tree = tree;
            let mut pending = vec![&defining_tree];
            while let Some(node) = pending.pop() {
                defining_nodes.insert(NodeKey::of(node), node);
                pending.extend(node.children.iter());
            }
        }
        let declarations: Vec<_> = defining_nodes
            .values()
            .filter(|node| {
                node.kind == SyntaxKind::Derive
                    && node.span.file == item.span.file
                    && node.span.start <= item.span.start
                    && node.span.end >= item.span.end
            })
            .collect();
        let [declaration] = declarations.as_slice() else {
            return None;
        };
        let declaration_path = declaration
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)?;
        if declaration_path.span != item.span
            || single_name(declaration_path, defining_text)? != item.name
        {
            return None;
        }
        // Formal identities: authored names in declaration order must equal
        // the supplied formal items at the same positions.
        let authored_formals: Vec<_> = declaration
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::Parameter)
            .collect();
        if authored_formals.len() != params.len() {
            return None;
        }
        let mut formal_types: Vec<(String, ResolvedType)> = Vec::new();
        for (position, (authored, formal)) in authored_formals.iter().zip(params.iter()).enumerate()
        {
            self.check_derive_formal(
                item,
                authored,
                formal,
                position,
                defining_text,
                &mut formal_types,
            )?;
        }
        self.run_derive_body(
            item,
            body,
            declaration,
            defining_text,
            &formal_types,
            depth,
            seen,
        )
    }

    /// Authenticate the existing stored-query/collection producer without
    /// admitting its execution. The query and its external predicate share one
    /// original alias scope; ordinary derive fallback must keep this sealed.
    #[allow(clippy::too_many_arguments)]
    fn load_query_domain<'q>(
        args: &'q [TypedExpr],
    ) -> Option<(
        &'q TypedExpr,
        &'q TypedExpr,
        &'q IrQuery,
        &'q CheckedQuery,
        &'q CheckedCollectionCall,
        &'q CheckedQueryClause,
        &'q String,
    )> {
        use crate::analysis::types::CheckedQueryClauseKind;
        let [domain, predicate] = args else {
            return None;
        };
        let IrExpr::Query(query) = &domain.expr else {
            return None;
        };
        let checked = query.source.as_deref()?;
        let call = query.collection_call.as_deref()?;
        let [alias] = checked.clauses.as_slice() else {
            return None;
        };
        let CheckedQueryClauseKind::As { name } = &alias.kind else {
            return None;
        };
        Some((domain, predicate, query, checked, call, alias, name))
    }

    fn load_query_lambda<'q, 's>(
        &'s self,
        predicate: &'q TypedExpr,
        call: &'q CheckedCollectionCall,
    ) -> Option<(
        &'q TypedExpr,
        &'q String,
        &'q crate::analysis::types::CheckedCollectionPredicate,
        &'s IrItem,
    )> {
        let IrExpr::Lambda { param, body } = &predicate.expr else {
            return None;
        };
        let retained_predicate = call.predicate.as_ref()?;
        let model = self.ir.items.get(call.model.0 as usize)?;
        Some((body, param, retained_predicate, model))
    }

    fn load_query_call_nodes<'n, 't>(
        node: &'n SyntaxNode,
        text: &'t str,
    ) -> Option<(
        &'n SyntaxNode,
        &'n SyntaxNode,
        &'n SyntaxNode,
        &'n SyntaxNode,
        &'n SyntaxNode,
        Vec<&'t str>,
    )> {
        let arguments: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        let [domain_argument, predicate_argument] = arguments.as_slice() else {
            return None;
        };
        let domain_values = expressions(domain_argument);
        let predicate_values = expressions(predicate_argument);
        let ([domain_node], [predicate_node]) =
            (domain_values.as_slice(), predicate_values.as_slice())
        else {
            return None;
        };
        let mut ungrouped_predicate = *predicate_node;
        for _ in 0..64 {
            if ungrouped_predicate.kind != SyntaxKind::Group {
                break;
            }
            ungrouped_predicate = expressions(ungrouped_predicate).first()?;
        }
        let domains = expressions(domain_node);
        let [authored_domain] = domains.as_slice() else {
            return None;
        };
        let clauses: Vec<_> = domain_node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::QueryClause)
            .collect();
        let [authored_alias] = clauses.as_slice() else {
            return None;
        };
        let alias_words: Vec<_> = authored_alias
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Name)
            .map(|child| child.token().map(|token| token.text(text)))
            .collect::<Option<Vec<_>>>()?;
        Some((
            *domain_node,
            *predicate_node,
            ungrouped_predicate,
            *authored_domain,
            *authored_alias,
            alias_words,
        ))
    }

    fn check_query_call_identity(
        id: &str,
        node: &SyntaxNode,
        call: &CheckedCollectionCall,
        domain_node: &SyntaxNode,
        checked: &CheckedQuery,
        authored_domain: &SyntaxNode,
        authored_alias: &SyntaxNode,
        alias: &CheckedQueryClause,
        alias_words: &[&str],
        name: &String,
        model: &IrItem,
        query: &IrQuery,
    ) -> Option<()> {
        if !matches!(id, "any" | "all")
            || node.kind != SyntaxKind::Call
            || call.node != NodeKey::of(node)
            || call.builtin != id
            || domain_node.kind != SyntaxKind::Query
            || checked.node != NodeKey::of(domain_node)
            || call.query != checked.node
            || checked.domain != NodeKey::of(authored_domain)
            || alias.node != NodeKey::of(authored_alias)
            || call.alias != alias.node
            || !alias.expressions.is_empty()
            || alias_words != ["as", name.as_str()]
            || !matches!(model.kind, IrItemKind::Model { .. })
            || !matches!(&query.domain, super::ir::IrQueryDomain::Model(canonical) if canonical == &model.canonical)
        {
            return None;
        }
        Some(())
    }

    fn build_query_call_types(model: &IrItem) -> (ResolvedType, ResolvedType, ResolvedType) {
        let row = ResolvedType::Record {
            symbol: model.id,
            stored: true,
        };
        let array = ResolvedType::Array {
            element: Box::new(row.clone()),
            ordered: true,
            nonempty: false,
        };
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        (row, array, boolean)
    }

    fn check_query_call_types(
        query: &IrQuery,
        checked: &CheckedQuery,
        domain: &TypedExpr,
        predicate: &TypedExpr,
        array: &ResolvedType,
        boolean: &ResolvedType,
    ) -> Option<()> {
        if domain.ty != *array
            || checked.domain_type != *array
            || checked.result != *array
            || checked.projection.is_some()
            || query.parent.is_some()
            || query.where_pred.is_some()
            || query.where_param != "row"
            || query.where_async
            || !query.order.is_empty()
            || query.value_order.is_some()
            || query.limit.is_some()
            || query.archived.is_some()
            || query.select.is_some()
            || query.select_param.is_some()
            || query.contract_collection_call.is_some()
            || predicate.ty != *boolean
        {
            return None;
        }
        Some(())
    }

    fn check_query_call_params(
        domain: &TypedExpr,
        predicate: &TypedExpr,
        body: &TypedExpr,
        retained_predicate: &crate::analysis::types::CheckedCollectionPredicate,
        param: &String,
        name: &String,
        boolean: &ResolvedType,
        domain_node: &SyntaxNode,
        predicate_node: &SyntaxNode,
        ungrouped_predicate: &SyntaxNode,
    ) -> Option<()> {
        if domain.span != domain_node.span
            || predicate.span != predicate_node.span
            || body.ty != *boolean
            || body.span != ungrouped_predicate.span
            || retained_predicate.node != NodeKey::of(predicate_node)
            || retained_predicate.ty != *boolean
            || param != name
        {
            return None;
        }
        Some(())
    }

    fn check_query_call_original(
        &self,
        owner: &IrItem,
        node: &SyntaxNode,
        id: &str,
        call: &CheckedCollectionCall,
        checked: &CheckedQuery,
        retained_predicate: &crate::analysis::types::CheckedCollectionPredicate,
        array: &ResolvedType,
        boolean: &ResolvedType,
        model: &IrItem,
        facts: Option<&CheckedScenarioSource>,
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        let facts = facts?;
        let mut selected = facts
            .decision_sites
            .as_deref()?
            .iter()
            .flat_map(|site| &site.calls)
            .filter(|selected| selected.node == call.node);
        let original = selected.next()?;
        if original.module != owner.module
            || original.target
                != (CheckedDecisionCallTarget::Builtin {
                    id: id.into(),
                    overload: call.overload,
                })
            || original.arguments != vec![(checked.node, array.clone()), (retained_predicate.node, boolean.clone())]
            || original.slots.as_slice() != [Some(0), Some(1)]
            || !original.defaults.is_empty()
            || selected.any(|other| {
                other.module != original.module
                    || other.source != original.source
                    || other.target != original.target
                    || other.arguments != original.arguments
                    || other.slots != original.slots
                    || other.defaults != original.defaults
            })
        {
            return None;
        }
        source(self.ir, &original.source, node.span, self.db)?;
        let schema = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.id == model.id && schema.model)?;
        super::scenario_receipts::match_stored_contract_schema(self.ir, schema, self.db)?;
        Some(())
    }

    fn derive_query_call_corresponds(
        &self,
        owner: &IrItem,
        node: &SyntaxNode,
        id: &str,
        args: &[TypedExpr],
        text: &str,
        depth: usize,
        formals: &[(String, ResolvedType)],
        facts: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
        reached: &mut Vec<String>,
        membership: &mut bool,
    ) -> Option<()> {
        let (domain, predicate, query, checked, call, alias, name) =
            Self::load_query_domain(args)?;
        let (body, param, retained_predicate, model) = self.load_query_lambda(predicate, call)?;
        let (row, array, boolean) = Self::build_query_call_types(model);
        let (domain_node, predicate_node, ungrouped_predicate, authored_domain, authored_alias, alias_words) =
            Self::load_query_call_nodes(node, text)?;
        Self::check_query_call_identity(
            id, node, call, domain_node, checked, authored_domain, authored_alias, alias,
            &alias_words, name, model, query,
        )?;
        Self::check_query_call_types(query, checked, domain, predicate, &array, &boolean)?;
        Self::check_query_call_params(
            domain, predicate, body, retained_predicate, param, name, &boolean, domain_node,
            predicate_node, ungrouped_predicate,
        )?;
        reference_name(
            self.ir,
            owner,
            model.id,
            &source_path(authored_domain, text)?,
            self.db,
        )?;
        self.check_query_call_original(
            owner, node, id, call, checked, retained_predicate, &array, &boolean, model, facts,
        )?;
        let facts = facts?;
        let mut scoped = formals.to_vec();
        scoped.push((name.clone(), row));
        self.derive_body_corresponds(
            owner,
            body,
            ungrouped_predicate,
            text,
            depth + 1,
            &scoped,
            Some(facts),
            reached,
            membership,
        )?;
        // Source authentication cannot grant the ordinary lane authority to
        // execute a stored query, even when its predicate has no membership.
        *membership = true;
        Some(())
    }

    /// Structural correspondence between a supplied IR derive body and its
    /// authored CST body: literals, lexical names, member fields, operators
    /// and call occurrences (callee identity plus in-order arguments) must
    /// agree exactly. Anything outside this scalar body grammar refuses.
    #[allow(clippy::too_many_arguments)]
    fn match_body_literal(&self, expr: &TypedExpr, node: &SyntaxNode, text: &str) -> Option<()> {
        let token = |kind: SyntaxKind| {
            node.children
                .iter()
                .find(|child| child.kind == kind)
                .and_then(|child| child.token())
        };
        match (&expr.expr, node.kind) {
            (IrExpr::Bool(value), SyntaxKind::Literal) => {
                if token(SyntaxKind::Name)?.text(text) != if *value { "true" } else { "false" } {
                    return None;
                }
            }
            (IrExpr::Null, SyntaxKind::Literal) => {
                if token(SyntaxKind::Name)?.text(text) != "null" {
                    return None;
                }
            }
            (IrExpr::Int(value), SyntaxKind::Literal) => {
                if token(SyntaxKind::Integer)?
                    .text(text)
                    .parse::<i128>()
                    .ok()?
                    != *value
                {
                    return None;
                }
            }
            (IrExpr::Decimal(value), SyntaxKind::Literal) => {
                if token(SyntaxKind::Decimal)?.text(text) != value.as_str() {
                    return None;
                }
            }
            (IrExpr::Text(value), SyntaxKind::Literal) => {
                let string = node
                    .children
                    .iter()
                    .find(|child| child.kind == SyntaxKind::String)?;
                if string.token()?.string_value.as_ref()? != value {
                    return None;
                }
            }
            _ => return None,
        }
        Some(())
    }

    fn match_body_name(
        &self,
        expr: &TypedExpr,
        node: &SyntaxNode,
        text: &str,
        formals: &[(String, ResolvedType)],
        name: &String,
    ) -> Option<()> {
        if single_name(node, text)? != *name {
            return None;
        }
        let formal_ty = formals
            .iter()
            .rev()
            .find(|(formal, _)| formal == name)
            .map(|(_, ty)| ty)?;
        if !Self::type_narrows(&expr.ty, formal_ty) {
            return None;
        }
        Some(())
    }

    fn match_body_member(
        &self,
        defining_owner: &IrItem,
        expr: &TypedExpr,
        node: &SyntaxNode,
        text: &str,
        depth: usize,
        formals: &[(String, ResolvedType)],
        facts: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
        reached: &mut Vec<String>,
        membership: &mut bool,
        base: &TypedExpr,
        field: &String,
    ) -> Option<()> {
        let field_name = node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        if field_name.token()?.text(text) != field.as_str() {
            return None;
        }
        if let ResolvedType::Record { symbol: model, .. } = &base.ty {
            let facts = facts?;
            let contracts = facts.stored_contracts.as_deref()?;
            let schema = contracts.iter().find(|schema| schema.id == *model)?;
            super::scenario_receipts::match_stored_contract_schema(
                self.ir, schema, self.db,
            )?;
            let field_fact = schema
                .fields
                .iter()
                .find(|candidate| candidate.owner == *model && candidate.name == *field)?;
            super::scenario_receipts::match_stored_contract_field(
                self.ir, field_fact, self.db,
            )?;
            if !Self::type_narrows(&expr.ty, &field_fact.ty) {
                return None;
            }
        }
        let base_nodes = expressions(node);
        let [base_node] = base_nodes.as_slice() else {
            return None;
        };
        self.derive_body_corresponds(
            defining_owner,
            base,
            base_node,
            text,
            depth + 1,
            formals,
            facts,
            reached,
            membership,
        )
    }

    fn match_body_binary(
        &self,
        defining_owner: &IrItem,
        node: &SyntaxNode,
        text: &str,
        depth: usize,
        formals: &[(String, ResolvedType)],
        facts: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
        reached: &mut Vec<String>,
        membership: &mut bool,
        op: &IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
    ) -> Option<()> {
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
        let operator = node
            .children
            .iter()
            .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?;
        if operator.token()?.text(text) != spelling {
            return None;
        }
        let operand_nodes = expressions(node);
        let [left_node, right_node] = operand_nodes.as_slice() else {
            return None;
        };
        self.derive_body_corresponds(
            defining_owner,
            left,
            left_node,
            text,
            depth + 1,
            formals,
            facts,
            reached,
            membership,
        )?;
        self.derive_body_corresponds(
            defining_owner,
            right,
            right_node,
            text,
            depth + 1,
            formals,
            facts,
            reached,
            membership,
        )
    }

    fn match_body_unary(
        &self,
        defining_owner: &IrItem,
        node: &SyntaxNode,
        text: &str,
        depth: usize,
        formals: &[(String, ResolvedType)],
        facts: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
        reached: &mut Vec<String>,
        membership: &mut bool,
        op: &IrUnOp,
        operand: &TypedExpr,
    ) -> Option<()> {
        let spelling = match op {
            IrUnOp::Not => "not",
            IrUnOp::Neg => "-",
        };
        let operator = node
            .children
            .iter()
            .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?;
        if operator.token()?.text(text) != spelling {
            return None;
        }
        let operand_nodes = expressions(node);
        let [operand_node] = operand_nodes.as_slice() else {
            return None;
        };
        self.derive_body_corresponds(
            defining_owner,
            operand,
            operand_node,
            text,
            depth + 1,
            formals,
            facts,
            reached,
            membership,
        )
    }

    fn check_call_slots(expr: &TypedExpr, args: &[TypedExpr]) -> Option<()> {
        if let IrExpr::BoundCall { slots, .. } = &expr.expr
            && (slots.len() != args.len()
                || slots
                    .iter()
                    .enumerate()
                    .any(|(index, slot)| *slot != Some(index)))
        {
            return None;
        }
        Some(())
    }

    fn match_body_call_target(
        &self,
        defining_owner: &IrItem,
        expr: &TypedExpr,
        target: &IrCallTarget,
        callee: String,
        reached: &mut Vec<String>,
        membership: &mut bool,
    ) -> Option<()> {
        match target {
            IrCallTarget::Builtin { id, .. } => {
                if callee != *id {
                    return None;
                }
                if id == "active_member" {
                    *membership = true;
                }
            }
            IrCallTarget::DeriveFn(canonical) => {
                let item = self
                    .ir
                    .items
                    .iter()
                    .find(|item| &item.canonical == canonical)?;
                reference_name(self.ir, defining_owner, item.id, &callee, self.db)?;
                if item.module != defining_owner.module && !item.exported {
                    return None;
                }
                let IrItemKind::DeriveFn {
                    result: IrType::Known(result),
                    ..
                } = &item.kind
                else {
                    return None;
                };
                if !Self::type_narrows(&expr.ty, result) {
                    return None;
                }
                reached.push(canonical.clone());
            }
            IrCallTarget::CapabilityOp(_) => return None,
        }
        Some(())
    }

    fn match_body_call_args(
        &self,
        defining_owner: &IrItem,
        node: &SyntaxNode,
        args: &[TypedExpr],
        text: &str,
        depth: usize,
        formals: &[(String, ResolvedType)],
        facts: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
        reached: &mut Vec<String>,
        membership: &mut bool,
    ) -> Option<()> {
        let arguments: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        if arguments.len() != args.len() {
            return None;
        }
        for (argument, value) in arguments.iter().zip(args.iter()) {
            let values = expressions(argument);
            let [source_value] = values.as_slice() else {
                return None;
            };
            self.derive_body_corresponds(
                defining_owner,
                value,
                source_value,
                text,
                depth + 1,
                formals,
                facts,
                reached,
                membership,
            )?;
        }
        Some(())
    }

    fn match_body_compound(
        &self,
        defining_owner: &IrItem,
        expr: &TypedExpr,
        node: &SyntaxNode,
        text: &str,
        depth: usize,
        formals: &[(String, ResolvedType)],
        facts: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
        reached: &mut Vec<String>,
        membership: &mut bool,
    ) -> Option<()> {
        match (&expr.expr, node.kind) {
            (IrExpr::Binary { op, left, right }, SyntaxKind::Binary) => {
                self.match_body_binary(
                    defining_owner, node, text, depth, formals, facts, reached, membership,
                    op, left, right,
                )?;
            }
            (IrExpr::Unary { op, operand }, SyntaxKind::Unary) => {
                self.match_body_unary(
                    defining_owner, node, text, depth, formals, facts, reached, membership,
                    op, operand,
                )?;
            }
            (
                IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. },
                SyntaxKind::Call,
            ) => {
                Self::check_call_slots(expr, args)?;
                let callee = source_path(expressions(node).first()?, text)?;
                self.match_body_call_target(
                    defining_owner, expr, target, callee, reached, membership,
                )?;
                if args.iter().any(|argument| {
                    matches!(argument.expr, IrExpr::Query(_) | IrExpr::Lambda { .. })
                }) {
                    let IrCallTarget::Builtin { id, .. } = target else {
                        return None;
                    };
                    return self.derive_query_call_corresponds(
                        defining_owner,
                        node,
                        id,
                        args,
                        text,
                        depth,
                        formals,
                        facts,
                        reached,
                        membership,
                    );
                }
                self.match_body_call_args(
                    defining_owner, node, args, text, depth, formals, facts, reached,
                    membership,
                )?;
            }
            _ => return None,
        }
        Some(())
    }

    fn derive_body_corresponds(
        &self,
        defining_owner: &IrItem,
        expr: &TypedExpr,
        node: &SyntaxNode,
        text: &str,
        depth: usize,
        formals: &[(String, ResolvedType)],
        facts: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
        reached: &mut Vec<String>,
        membership: &mut bool,
    ) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let mut node = node;
        while node.kind == SyntaxKind::Group {
            node = expressions(node).first()?;
        }
        if expr.span != node.span {
            return None;
        }
        let token = |kind: SyntaxKind| {
            node.children
                .iter()
                .find(|child| child.kind == kind)
                .and_then(|child| child.token())
        };
        match (&expr.expr, node.kind) {
            (
                IrExpr::Bool(_)
                | IrExpr::Null
                | IrExpr::Int(_)
                | IrExpr::Decimal(_)
                | IrExpr::Text(_),
                SyntaxKind::Literal,
            ) => {
                self.match_body_literal(expr, node, text)?;
            }
            (IrExpr::Name(name), SyntaxKind::NameRef) | (IrExpr::Name(name), SyntaxKind::Name) => {
                self.match_body_name(expr, node, text, formals, name)?;
            }
            (IrExpr::Member { base, field }, SyntaxKind::NameRef)
                if expr.ty == ResolvedType::Team
                    && field == "team"
                    && matches!(&base.expr, IrExpr::Name(name) if name == "c")
                    && single_name(node, text)? == "team"
                    && !formals.iter().any(|(name, _)| name == "team") => {}
            (IrExpr::Member { base, field }, SyntaxKind::Member) => {
                self.match_body_member(
                    defining_owner, expr, node, text, depth, formals, facts, reached,
                    membership, base, field,
                )?;
            }
            _ => self.match_body_compound(
                defining_owner, expr, node, text, depth, formals, facts, reached,
                membership,
            )?,
            _ => return None,
        }
        Some(())
    }

    /// The sealed authorization shape: the authenticated original derive
    /// performs the catalog membership read, directly or transitively.
    /// Such derives are the authorization machinery itself; their calls
    /// keep the strict authorization correspondence and never fall back
    /// to ordinary derive matching. Unauthenticated declarations are
    /// treated as sealed, so a missing original proof refuses rather
    /// than falling back.
    fn authorization_shaped(&self, actual: &TypedExpr) -> bool {
        let target = match &actual.expr {
            IrExpr::Call {
                target: IrCallTarget::DeriveFn(target),
                ..
            }
            | IrExpr::BoundCall {
                target: IrCallTarget::DeriveFn(target),
                ..
            } => target,
            _ => return true,
        };
        self.authenticated_derive(target, 0, &mut std::collections::HashSet::new())
            .unwrap_or(true)
    }

    /// Keep the original boolean path to a helper call and authenticate every
    /// preceding/sibling expression without evaluating the query a second time.
    fn query_require_call(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        call: NodeKey,
        depth: usize,
    ) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let mut node = node;
        while node.kind == SyntaxKind::Group {
            node = expressions(node).first()?;
        }
        if actual.span != node.span {
            return None;
        }
        if NodeKey::of(node) == call {
            return Some(());
        }
        let IrExpr::Binary { op, left, right } = &actual.expr else {
            return None;
        };
        if node.kind != SyntaxKind::Binary || !matches!(op, IrBinOp::And | IrBinOp::Or) {
            return None;
        }
        let operator = node
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Name)?;
        if operator.token()?.text(self.text) != if *op == IrBinOp::And { "and" } else { "or" } {
            return None;
        }
        let children = expressions(node);
        let [source_left, source_right] = children.as_slice() else {
            return None;
        };
        let contains = |node: &SyntaxNode| {
            node.span.file == call.file
                && node.span.start <= call.start
                && call.end <= node.span.end
        };
        if contains(source_left) {
            self.query_require_call(left, source_left, call, depth + 1)?;
            self.expression(right, NodeKey::of(source_right), depth + 1)
        } else if contains(source_right) {
            self.expression(left, NodeKey::of(source_left), depth + 1)?;
            self.query_require_call(right, source_right, call, depth + 1)
        } else {
            None
        }
    }

    /// A body helper may consume the original first-query row only under its
    /// actual successful non-null branch, through required declared Model edges.
    fn walk_required_path<'x>(
        &self,
        facts: &CheckedScenarioSource,
        argument: &'x TypedExpr,
    ) -> Option<(&'x TypedExpr, usize)> {
        let mut root = argument;
        let mut edges = 0;
        while let IrExpr::Member { base, field } = &root.expr {
            edges += 1;
            if edges > 16 {
                return None;
            }
            let ResolvedType::Record {
                symbol,
                stored: true,
            } = base.ty
            else {
                return None;
            };
            let schema = facts
                .stored_contracts
                .as_deref()?
                .iter()
                .find(|schema| schema.model && schema.id == symbol)?;
            super::scenario_receipts::match_stored_contract_schema(self.ir, schema, self.db)?;
            if field == "parent" {
                let parent = schema.parent?;
                if root.ty != (ResolvedType::Record { symbol: parent, stored: true }) { return None; }
                let parent_schema = facts.stored_contracts.as_deref()?.iter()
                    .find(|candidate| candidate.model && candidate.id == parent)?;
                super::scenario_receipts::match_stored_contract_schema(self.ir, parent_schema, self.db)?;
                root = base;
                continue;
            }
            let field = schema
                .fields
                .iter()
                .find(|declared| declared.name == *field)?;
            super::scenario_receipts::match_stored_contract_field(self.ir, field, self.db)?;
            if field.required_array
                || field.ty != root.ty
                || !matches!(field.ty, ResolvedType::Record { stored: true, .. })
            {
                return None;
            }
            root = base;
        }
        Some((root, edges))
    }

    fn find_effect_binding<'x>(
        effects: &'x [IrStmt],
        name: &str,
    ) -> Option<(usize, &'x TypedExpr, &'x Span)> {
        let mut bindings = effects
            .iter()
            .enumerate()
            .filter_map(|(index, value)| match value {
                IrStmt::Let {
                    name: actual,
                    value,
                    span,
                } if actual == name => Some((index, value, span)),
                _ => None,
            });
        let found = bindings.next()?;
        if bindings.next().is_some() {
            return None;
        }
        Some(found)
    }

    fn load_first_binding<'x>(
        &'x self,
        initializer: &TypedExpr,
        binding_span: &Span,
        root: &TypedExpr,
    ) -> Option<&'x DisclosureQuery> {
        let call = NodeKey::of(
            self.nodes
                .values()
                .find(|node| node.kind == SyntaxKind::Call && node.span == initializer.span)?,
        );
        let first = super::scenario_receipts::checked_first_query_ir(
            self.ir,
            self.original,
            initializer,
            call,
            self.db,
        )?;
        if first.first.as_ref()?.binding
            != NodeKey::of(
                self.nodes
                    .values()
                    .find(|node| node.kind == SyntaxKind::Let && node.span == *binding_span)?,
            )
            || root.ty
                != (ResolvedType::Record {
                    symbol: first.model,
                    stored: true,
                })
        {
            return None;
        }
        Some(first)
    }

    fn find_require_branch<'x>(
        effects: &'x [IrStmt],
        name: &str,
        statement: NodeKey,
        binding_index: usize,
        binding_span: &Span,
    ) -> Option<(usize, &'x TypedExpr, &'x Span)> {
        let mut branches = effects.iter().enumerate().filter_map(|(index, value)| {
            let IrStmt::If {
                cond,
                then_branch,
                span: branch_at,
                ..
            } = value
            else {
                return None;
            };
            let mut pending = then_branch.iter().collect::<Vec<_>>();
            while let Some(value) = pending.pop() {
                match value {
                    IrStmt::Require { span: at, .. } if *at == span(statement) => {
                        return Some((index, cond, branch_at));
                    }
                    IrStmt::If {
                        then_branch,
                        else_branch,
                        ..
                    } => {
                        pending.extend(then_branch);
                        pending.extend(else_branch);
                    }
                    IrStmt::Let { name: actual, .. } if actual == name => return None,
                    _ => {}
                }
            }
            None
        });
        let (branch_index, cond, branch_span) = branches.next()?;
        if branches.next().is_some()
            || binding_index >= branch_index
            || binding_span.end > branch_span.start
        {
            return None;
        }
        Some((branch_index, cond, branch_span))
    }

    fn query_required_argument(
        &self,
        owner: &IrItem,
        argument: &TypedExpr,
        statement: NodeKey,
        depth: usize,
    ) -> Option<()> {
        let facts = self.transcript_source()?;
        let IrItemKind::Scenario { effects, .. } = &owner.kind else {
            return None;
        };
        let (root, edges) = self.walk_required_path(facts, argument)?;
        let IrExpr::Name(name) = &root.expr else {
            return None;
        };
        if edges == 0 {
            return None;
        }
        let (binding_index, initializer, binding_span) =
            Self::find_effect_binding(effects, name)?;
        self.load_first_binding(initializer, binding_span, root)?;
        let (_branch_index, cond, branch_span) = Self::find_require_branch(
            effects,
            name,
            statement,
            binding_index,
            binding_span,
        )?;
        let IrExpr::Binary {
            op: IrBinOp::Ne,
            left,
            right,
        } = &cond.expr
        else {
            return None;
        };
        let (value, null) = if matches!(left.expr, IrExpr::Null) {
            (right, left)
        } else {
            (left, right)
        };
        if !matches!(&value.expr, IrExpr::Name(actual) if actual == name)
            || !matches!(null.expr, IrExpr::Null)
            || value.ty != ResolvedType::Nullable(Box::new(root.ty.clone()))
        {
            return None;
        }
        let branch = self
            .nodes
            .values()
            .find(|node| node.kind == SyntaxKind::If && node.span == *branch_span)?;
        if branch.kind != SyntaxKind::If {
            return None;
        }
        let source_cond = expressions(branch).into_iter().next()?;
        self.expression(cond, NodeKey::of(source_cond), depth + 1)
    }

    /// Consume only the exact helper Require query already described by the
    /// checked source census. Its predicate remains a query-owned callback.
    fn load_query_site<'s>(
        &'s self,
        facts: &'s CheckedScenarioSource,
        owner: &IrItem,
        key: NodeKey,
    ) -> Option<(&'s CheckedDecisionSite, &'s CheckedDecisionCall)> {
        use crate::analysis::scenario_disclosure::CheckedDecisionStage;
        let mut sites = facts.decision_sites.as_deref()?.iter().filter(|site| {
            site.owner == owner.id
                && matches!(
                    site.stage,
                    CheckedDecisionStage::LeadingRequire | CheckedDecisionStage::BodyRequire
                )
                && site.source == facts.source
                && site
                    .calls
                    .iter()
                    .any(|call| call.node == key && call.chain.is_empty())
        });
        let site = sites.next()?;
        let mut calls = site
            .calls
            .iter()
            .filter(|call| call.node == key && call.chain.is_empty());
        let outer = calls.next()?;
        if sites.next().is_some() || calls.next().is_some() {
            return None;
        }
        Some((site, outer))
    }

    fn load_query_derive<'s>(
        &'s self,
        outer: &CheckedDecisionCall,
    ) -> Option<(
        &'s IrItem,
        SymbolId,
        SymbolId,
        &'s ResolvedType,
        &'s ResolvedType,
        &'s TypedExpr,
    )> {
        let CheckedDecisionCallTarget::DeriveFn(derive) = outer.target else {
            return None;
        };
        let item = self.ir.items.get(derive.0 as usize)?;
        let IrItemKind::DeriveFn {
            params,
            result: IrType::Known(result),
            expr: Some(body),
        } = &item.kind
        else {
            return None;
        };
        let [person, location] = params.as_slice() else {
            return None;
        };
        let IrItemKind::Param {
            ty: IrType::Known(location_type),
            default: None,
            ..
        } = &self.ir.items.get(location.0 as usize)?.kind
        else {
            return None;
        };
        let ResolvedType::Record { stored: true, .. } = location_type else {
            return None;
        };
        Some((item, *person, *location, location_type, result, body))
    }

    fn check_query_outer(
        &self,
        owner: &IrItem,
        facts: &CheckedScenarioSource,
        target: &String,
        actual: &TypedExpr,
        args: &[TypedExpr],
        slots: &[Option<usize>],
        outer: &CheckedDecisionCall,
        item: &IrItem,
        person: SymbolId,
        person_slot: usize,
        location_slot: usize,
        result: &ResolvedType,
        body: &TypedExpr,
        location_type: &ResolvedType,
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        if person_slot == location_slot
            || args.len() != 2
            || outer.arguments.len() != 2
            || outer.module != owner.module
            || outer.source != facts.source
            || outer.slots.as_slice() != slots
            || !outer.defaults.is_empty()
            || target != &item.canonical
            || actual.ty != ResolvedType::Scalar(Scalar::Bool)
            || result != &actual.ty
            || body.ty != actual.ty
            || !matches!(
                &self.ir.items.get(person.0 as usize)?.kind,
                IrItemKind::Param {
                    ty: IrType::Known(ResolvedType::Scalar(Scalar::User)),
                    default: None,
                    ..
                }
            )
            || args.get(person_slot)?.ty != ResolvedType::Scalar(Scalar::User)
            || args.get(location_slot)?.ty != *location_type
            || !matches!(&args[person_slot].expr, IrExpr::Member { base, field } if field == "actor" && matches!(&base.expr, IrExpr::Name(name) if name == "c"))
            || self.authenticated_derive(target, 0, &mut HashSet::new()) != Some(true)
        {
            return None;
        }
        Some(())
    }

    fn check_query_require(
        &self,
        site: &CheckedDecisionSite,
        owner: &IrItem,
        key: NodeKey,
        depth: usize,
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionStage;
        let IrItemKind::Scenario {
            guards, effects, ..
        } = &owner.kind
        else {
            return None;
        };
        let mut statements = if site.stage == CheckedDecisionStage::LeadingRequire {
            guards.iter().collect::<Vec<_>>()
        } else {
            effects.iter().collect::<Vec<_>>()
        };
        let mut require = None;
        while let Some(statement) = statements.pop() {
            match statement {
                IrStmt::Require { cond, span: at } if *at == span(site.statement) => {
                    if require.replace(cond).is_some() {
                        return None;
                    }
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    statements.extend(then_branch);
                    statements.extend(else_branch);
                }
                _ => {}
            }
        }
        let require_node = self.nodes.get(&site.statement)?;
        if require_node.kind != SyntaxKind::Require {
            return None;
        }
        let source_cond = expressions(require_node).into_iter().next()?;
        self.query_require_call(require?, source_cond, key, depth + 1)
    }

    fn load_authorized_query<'x>(
        &self,
        facts: &'x CheckedScenarioSource,
        owner: &IrItem,
        site: &CheckedDecisionSite,
        key: NodeKey,
        args: &[TypedExpr],
        location_slot: usize,
        outer: &CheckedDecisionCall,
        depth: usize,
    ) -> Option<&'x DisclosureQuery> {
        use crate::analysis::scenario_disclosure::CheckedDecisionStage;
        let mut queries = facts.queries.as_deref()?.iter().filter(|query| {
            query
                .dependencies
                .first()
                .is_some_and(|read| read.calls.as_slice() == [key])
        });
        let query = queries.next()?;
        match query.inputs.as_slice() {
            [(argument, parameter)] => {
                let (actual_parameter, _) =
                    super::scenario_receipts::checked_contract_parameter_source_path(
                        self.ir,
                        owner,
                        &args[location_slot],
                        Some(self.db),
                    )?;
                if actual_parameter != *parameter || *argument != outer.arguments[location_slot].0
                {
                    return None;
                }
            }
            [] if site.stage == CheckedDecisionStage::LeadingRequire
                && super::scenario_receipts::checked_purchase_helper_query_influences(facts).is_some() => {
                let (root, edges) = self.walk_required_path(facts, &args[location_slot])?;
                let IrExpr::Name(name) = &root.expr else { return None; };
                let IrItemKind::Scenario { params, .. } = &owner.kind else { return None; };
                let mut parameters = params.iter().filter_map(|id| self.ir.items.get(id.0 as usize))
                    .filter(|parameter| parameter.name == *name);
                let parameter = parameters.next()?;
                let IrItemKind::Param { owner: declared, index, ty: IrType::Known(ty),
                    default: None, default_node: None, array_bounds: None, .. } = &parameter.kind else { return None; };
                let original = facts.parameters.get(*index)?;
                if edges == 0 || parameters.next().is_some() || *declared != owner.id
                    || params.get(*index) != Some(&parameter.id) || original.parameter != parameter.id
                    || original.ty != *ty || root.ty != *ty || original.default.is_some()
                    || parameter.module != owner.module || parameter.canonical != format!("{}.{}",owner.canonical,name)
                    || self.db.get(root.span.file)?.text.get(root.span.start as usize..root.span.end as usize) != Some(name.as_str())
                    || original.constraints.is_some() || !matches!(ty, ResolvedType::Record {stored: true, ..})
                { return None; }
            }
            [] if site.stage == CheckedDecisionStage::BodyRequire => {
                self.query_required_argument(
                    owner,
                    &args[location_slot],
                    site.statement,
                    depth + 1,
                )?;
            }
            _ => return None,
        }
        if queries.next().is_some()
            || query.first.is_some()
            || query.count.is_some()
            || query.projection.is_some()
            || query.cardinality_guard.is_some()
            || query.archived
            || query.limit.is_some()
            || !query.order.is_empty()
        {
            return None;
        }
        Some(query)
    }

    fn check_query_arg_shapes(
        &self,
        args: &[TypedExpr],
        outer: &CheckedDecisionCall,
        depth: usize,
    ) -> Option<()> {
        for (value, (node, ty)) in args.iter().zip(&outer.arguments) {
            if value.ty != *ty {
                return None;
            }
            self.expression(value, *node, depth + 1)?;
        }
        Some(())
    }

    fn load_query_scan<'x>(
        ir: &IrProgram,
        db: &SourceDb,
        body: &'x TypedExpr,
        query: &DisclosureQuery,
    ) -> Option<(
        &'x IrQuery,
        &'x CheckedQuery,
        &'x CheckedCollectionCall,
        &'x TypedExpr,
        &'x TypedExpr,
        &'x TypedExpr,
    )> {
        let (collection, arguments) = match &body.expr {
            IrExpr::Call {
                target: IrCallTarget::Builtin { id, .. },
                args,
            } if id == "any" => (id, args),
            IrExpr::BoundCall {
                target: IrCallTarget::Builtin { id, .. },
                args,
                slots,
            } if id == "any" && slots.as_slice() == [Some(0), Some(1)] => (id, args),
            _ => return None,
        };
        let [domain, predicate] = arguments.as_slice() else {
            return None;
        };
        let IrExpr::Query(scan) = &domain.expr else {
            return None;
        };
        let checked = scan.source.as_deref()?;
        let selected = scan.collection_call.as_deref()?;
        let IrExpr::Lambda {
            body: predicate_body,
            ..
        } = &predicate.expr
        else {
            return None;
        };
        if selected.builtin != *collection
            || selected.model != query.model
            || selected.query != query.node
            || checked.domain != query.domain
            || selected.predicate.as_ref()?.node != query.predicate?
            || query.alias != Some(selected.alias)
            || domain.span != span(query.node)
        {
            return None;
        }
        source(ir, &query.source, body.span, db)?;
        Some((scan, checked, selected, domain, predicate, predicate_body))
    }

    fn collect_query_members<'x>(
        &self,
        site: &CheckedDecisionSite,
        query: &DisclosureQuery,
        item: &IrItem,
        owner: &IrItem,
        facts: &CheckedScenarioSource,
        key: NodeKey,
        outer: &CheckedDecisionCall,
        predicate_body: &'x TypedExpr,
    ) -> Option<Vec<(&'x TypedExpr, &'x TypedExpr, &'x String)>> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        let CheckedDecisionCallTarget::DeriveFn(derive) = outer.target else {
            return None;
        };
        let mut fields = Vec::new();
        let mut pending = vec![predicate_body];
        while let Some(value) = pending.pop() {
            match &value.expr {
                IrExpr::Member { base, field } => {
                    fields.push((value, base.as_ref(), field));
                }
                IrExpr::Binary { left, right, .. } => {
                    pending.push(right);
                    pending.push(left);
                }
                IrExpr::Unary { operand, .. } => pending.push(operand),
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, .. },
                    args,
                }
                | IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, .. },
                    args,
                    ..
                } => {
                    if id != "active_member" {
                        return None;
                    }
                    // The checked current-membership source stays in its
                    // original StateRead lane; it is never evaluated here.
                    self.check_query_member_call(
                        site, query, item, owner, facts, key, derive, value, args,
                    )?;
                }
                IrExpr::Name(_) | IrExpr::Bool(_) => {}
                _ => return None,
            }
            if fields.len() > 200 || pending.len() > 16384 {
                return None;
            }
        }
        Some(fields)
    }

    fn check_query_member_call(
        &self,
        site: &CheckedDecisionSite,
        query: &DisclosureQuery,
        item: &IrItem,
        owner: &IrItem,
        facts: &CheckedScenarioSource,
        key: NodeKey,
        derive: SymbolId,
        value: &TypedExpr,
        args: &[TypedExpr],
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        let member = site.calls.iter().find(|call| {
            span(call.node) == value.span
                && call
                    .chain
                    .last()
                    .is_some_and(|frame| frame.node == key && frame.derive == derive)
        })?;
        if !matches!(&member.target, CheckedDecisionCallTarget::Builtin { id, overload: 0 } if id == "active_member")
            || member.arguments.len() != 2
            || args.len() != 2
            || member.module != item.module
            || member.source != query.source
            || member.slots.as_slice() != [Some(0), Some(1)]
            || !member.defaults.is_empty()
            || member.chain.len() != 1
            || member.chain[0].module != owner.module
            || member.chain[0].source != facts.source
            || args[0].ty != ResolvedType::Scalar(Scalar::User)
            || args[1].ty != ResolvedType::Team
            || member.arguments.iter().zip(args).any(|((node, ty), arg)| {
                *ty != arg.ty
                    || node.file != arg.span.file
                    || arg.span.start < node.start
                    || arg.span.end > node.end
            })
        {
            return None;
        }
        Some(())
    }

    fn check_query_identity(
        query: &DisclosureQuery,
        facts: &CheckedScenarioSource,
        key: NodeKey,
    ) -> Option<String> {
        let stamp = |source: &DisclosureSource, node: NodeKey| {
            format!(
                "{}:{}:{}:{}:{}",
                source.path, source.sha256, source.module, node.start, node.end
            )
        };
        let identity =
            |kind: &str, source: &DisclosureSource, node: NodeKey, discriminator: &str| {
                sha256_hex(
                    format!(
                        "scenario-disclosure/v1:{kind}:{}:{discriminator}",
                        stamp(source, node)
                    )
                    .as_bytes(),
                )
            };
        let id = identity(
            "query",
            &query.source,
            query.node,
            &stamp(&facts.source, key),
        );
        if query.id != id {
            return None;
        }
        Some(id)
    }

    fn check_query_dependencies(
        &self,
        facts: &CheckedScenarioSource,
        fields: &[(&TypedExpr, &TypedExpr, &String)],
        query: &DisclosureQuery,
        key: NodeKey,
        id: &str,
    ) -> Option<()> {
        let stamp = |source: &DisclosureSource, node: NodeKey| {
            format!(
                "{}:{}:{}:{}:{}",
                source.path, source.sha256, source.module, node.start, node.end
            )
        };
        let identity =
            |kind: &str, source: &DisclosureSource, node: NodeKey, discriminator: &str| {
                sha256_hex(
                    format!(
                        "scenario-disclosure/v1:{kind}:{}:{discriminator}",
                        stamp(source, node)
                    )
                    .as_bytes(),
                )
            };
        for ((value, base, field), read) in fields.iter().zip(&query.dependencies) {
            let schema = facts
                .stored_contracts
                .as_deref()?
                .iter()
                .find(|schema| schema.model && schema.id == query.model)?;
            let declared = schema
                .fields
                .iter()
                .find(|declared| declared.name == **field)?;
            super::scenario_receipts::match_stored_contract_field(self.ir, declared, self.db)?;
            if base.ty
                != (ResolvedType::Record {
                    symbol: query.model,
                    stored: true,
                })
                || read.model != query.model
                || read.model_name != schema.canonical
                || read.field != declared.id
                || read.field_name != **field
                || read.ty != value.ty
                || read.ty != declared.ty
                || read.type_id != declared.declared
                || read.source != query.source
                || span(read.node) != value.span
                || read.calls.as_slice() != [key]
                || read.role != DependencyRole::Control
                || read.query_id.is_some()
                || read.id != identity("query-control", &query.source, read.node, id)
            {
                return None;
            }
        }
        Some(())
    }

    fn check_query_tail(
        &self,
        query: &DisclosureQuery,
        person: SymbolId,
        predicate_body: &TypedExpr,
        id: &str,
    ) -> Option<()> {
        let kinds = [
            crate::analysis::scenario_disclosure::InfluenceKind::QueryExistence,
            crate::analysis::scenario_disclosure::InfluenceKind::QueryCardinality,
            crate::analysis::scenario_disclosure::InfluenceKind::QueryMembership,
            crate::analysis::scenario_disclosure::InfluenceKind::QueryOrder,
        ];
        if query.influences.len() != kinds.len()
            || query.influences.iter().zip(kinds).any(|(influence, kind)| {
                influence.kind != kind
                    || influence.source != query.source
                    || influence.node != query.node
                    || influence.query_id.as_deref() != Some(id)
                    || influence.id
                        != sha256_hex(
                            format!(
                                "scenario-disclosure/v1:query-influence:{}:{id}:{kind:?}",
                                format!(
                                    "{}:{}:{}:{}:{}",
                                    query.source.path,
                                    query.source.sha256,
                                    query.source.module,
                                    query.node.start,
                                    query.node.end
                                )
                            )
                            .as_bytes(),
                        )
            })
        {
            return None;
        }
        let first = query.dependencies.first()?;
        let mut eager = predicate_body;
        while let IrExpr::Binary {
            op: IrBinOp::And | IrBinOp::Or,
            left,
            ..
        } = &eager.expr
        {
            eager = left;
        }
        let IrExpr::Binary {
            op: IrBinOp::Eq,
            left,
            right,
        } = &eager.expr
        else {
            return None;
        };
        let (read, compared) = if left.span == span(first.node) {
            (left, right)
        } else {
            (right, left)
        };
        if read.span != span(first.node)
            || first.ty != ResolvedType::Scalar(Scalar::User)
            || !matches!(&compared.expr, IrExpr::Name(name) if name == &self.ir.items.get(person.0 as usize)?.name)
        {
            return None;
        }
        Some(())
    }

    fn query_authorization(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        let (target, args, slots) = match &actual.expr {
            IrExpr::Call {
                target: IrCallTarget::DeriveFn(target),
                args,
            } => (target, args, (0..args.len()).map(Some).collect::<Vec<_>>()),
            IrExpr::BoundCall {
                target: IrCallTarget::DeriveFn(target),
                args,
                slots,
            } => (target, args, slots.clone()),
            _ => return None,
        };
        let facts = self.transcript_source()?;
        let owner = self.ir.items.get(facts.scenario.0 as usize)?;
        let (site, outer) = self.load_query_site(facts, owner, key)?;
        let (item, person, _location, location_type, result, body) =
            self.load_query_derive(outer)?;
        let [Some(person_slot), Some(location_slot)] = slots.as_slice() else {
            return None;
        };
        self.check_query_outer(
            owner, facts, target, actual, args, &slots, outer, item, person, *person_slot,
            *location_slot, result, body, location_type,
        )?;
        self.check_query_require(site, owner, key, depth)?;
        let query = self.load_authorized_query(
            facts, owner, site, key, args, *location_slot, outer, depth,
        )?;
        self.check_query_arg_shapes(args, outer, depth)?;
        let (_scan, _checked, _selected, _domain, _predicate, predicate_body) =
            Self::load_query_scan(self.ir, self.db, body, query)?;
        let fields = self.collect_query_members(
            site, query, item, owner, facts, key, outer, predicate_body,
        )?;
        if fields.len() != query.dependencies.len() {
            return None;
        }
        let id = Self::check_query_identity(query, facts, key)?;
        self.check_query_dependencies(facts, &fields, query, key, &id)?;
        self.check_query_tail(query, person, predicate_body, &id)
    }

    fn load_authorization_owner<'s>(
        &'s self,
    ) -> Option<(&'s IrItem, &'s CheckedScenarioSource)> {
        let mut owners = self.ir.items.iter().filter(|owner| {
            self.ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|facts| {
                    facts.source == self.original.source
                        && facts.creates.as_deref().is_some_and(|creates| {
                            creates
                                .iter()
                                .any(|created| created.node == self.original.node)
                        })
                })
        });
        let owner = owners.next()?;
        if owners.next().is_some() {
            return None;
        }
        let facts = super::scenario_calls::checked_source(self.ir, owner, self.db)?;
        Some((owner, facts))
    }

    fn load_authorization_site<'s>(
        facts: &'s CheckedScenarioSource,
        owner: &IrItem,
        original_source: &DisclosureSource,
        key: NodeKey,
    ) -> Option<(&'s CheckedDecisionSite, &'s CheckedDecisionCall)> {
        use crate::analysis::scenario_disclosure::CheckedDecisionStage;
        let mut sites = facts.decision_sites.as_deref()?.iter().filter(|site| {
            site.owner == owner.id
                && site.stage == CheckedDecisionStage::LeadingRequire
                && site.source == *original_source
                && site
                    .calls
                    .iter()
                    .any(|call| call.node == key && call.chain.is_empty())
        });
        let site = sites.next()?;
        let mut outer_calls = site
            .calls
            .iter()
            .filter(|call| call.node == key && call.chain.is_empty());
        let outer = outer_calls.next()?;
        if sites.next().is_some() || outer_calls.next().is_some() {
            return None;
        }
        Some((site, outer))
    }

    fn load_authorization_derive<'s>(
        &'s self,
        outer: &CheckedDecisionCall,
    ) -> Option<(
        SymbolId,
        &'s IrItem,
        &'s [SymbolId],
        &'s ResolvedType,
        &'s TypedExpr,
    )> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        let CheckedDecisionCallTarget::DeriveFn(derive) = &outer.target else {
            return None;
        };
        let derive = *derive;
        let item = self.ir.items.get(derive.0 as usize)?;
        let IrItemKind::DeriveFn {
            params,
            result: IrType::Known(result),
            expr: Some(body),
        } = &item.kind
        else {
            return None;
        };
        Some((derive, item, params.as_slice(), result, body))
    }

    fn load_defining_source<'s>(
        &'s self,
        item: &IrItem,
        owner: &IrItem,
    ) -> Option<(
        &'s super::ir::IrModule,
        &'s str,
        DisclosureSource,
    )> {
        let defining = self.ir.modules.get(item.module.0 as usize)?;
        let defining_file = self.db.get(defining.file)?;
        let defining_text = defining_file.text.as_str();
        let defining_source = DisclosureSource {
            path: defining_file.path.clone(),
            sha256: defining_file.sha256.clone(),
            module: defining.name.clone(),
        };
        source(self.ir, &defining_source, item.span, self.db)?;
        let imported = item.module != owner.module;
        if defining.id != item.module
            || item.canonical != format!("{}.{}", defining.name, item.name)
            || imported && !item.exported
        {
            return None;
        }
        Some((defining, defining_text, defining_source))
    }

    fn load_defining_tree(&self, defining: &super::ir::IrModule) -> Option<Option<SyntaxNode>> {
        if defining.file != self.original.node.file {
            let (tree, diagnostics) = crate::syntax::parse(self.db, defining.file);
            if !diagnostics.is_empty() {
                return None;
            }
            return Some(Some(tree));
        }
        Some(None)
    }

    fn collect_defining_nodes<'x>(
        nodes: &HashMap<NodeKey, &'x SyntaxNode>,
        tree: Option<&'x SyntaxNode>,
    ) -> HashMap<NodeKey, &'x SyntaxNode> {
        let mut defining_nodes: HashMap<_, _> =
            nodes.iter().map(|(key, node)| (*key, *node)).collect();
        if let Some(tree) = tree {
            let mut pending = vec![tree];
            while let Some(node) = pending.pop() {
                defining_nodes.insert(NodeKey::of(node), node);
                pending.extend(node.children.iter());
            }
        }
        defining_nodes
    }

    fn seal_imported_conversation<'x>(
        &'x self,
        facts: &'x CheckedScenarioSource,
        model: SymbolId,
        item: &IrItem,
        defining_source: &DisclosureSource,
        authored_type: &SyntaxNode,
        owner: &IrItem,
    ) -> Option<&'x CheckedStoredContractSchema> {
        let mut schemas = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.model && schema.id == model);
        let conversation = schemas.next()?;
        let model_item = self.ir.items.get(model.0 as usize)?;
        if schemas.next().is_some()
            || conversation.module != item.module
            || conversation.source != *defining_source
            || !model_item.exported
        {
            return None;
        }
        let named_type = authored_type
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::NamedType)?;
        let type_path = named_type
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)?;
        reference_name(
            self.ir,
            owner,
            model,
            single_name(type_path, self.text)?,
            self.db,
        )?;
        super::scenario_receipts::match_stored_contract_schema(self.ir, conversation, self.db)?;
        Some(conversation)
    }

    fn check_authorization_shape(
        site: &CheckedDecisionSite,
        outer: &CheckedDecisionCall,
        guards: &[IrStmt],
        item: &IrItem,
        derive: SymbolId,
        target: &String,
        owner: &IrItem,
        original_source: &DisclosureSource,
        slots: Option<&[Option<usize>]>,
        params: &[SymbolId],
        result: &ResolvedType,
        actual: &TypedExpr,
        body: &TypedExpr,
    ) -> Option<()> {
        if !guards.iter().any(|statement|
            matches!(statement, super::ir::IrStmt::Require {span:at, ..} if *at == span(site.statement)))
            || item.id != derive || item.canonical != *target
            || outer.module != owner.module
            || outer.source != *original_source || !outer.defaults.is_empty()
            || outer.slots.as_slice() != [Some(0),Some(1)]
            || slots.is_some_and(|slots| slots != outer.slots.as_slice())
            || outer.arguments.len() != 2 || params.len() != 2
            || *result != ResolvedType::Scalar(Scalar::Bool)
            || actual.ty != *result || body.ty != *result
        {
            return None;
        }
        Some(())
    }

    fn load_authorization_call<'x>(
        actual: &'x TypedExpr,
    ) -> Option<(
        &'x String,
        &'x [TypedExpr],
        Option<&'x [Option<usize>]>,
    )> {
        match &actual.expr {
            IrExpr::Call {
                target: IrCallTarget::DeriveFn(target),
                args,
            } => Some((target, args.as_slice(), None)),
            IrExpr::BoundCall {
                target: IrCallTarget::DeriveFn(target),
                args,
                slots,
            } => Some((target, args.as_slice(), Some(slots.as_slice()))),
            _ => None,
        }
    }

    fn check_authorization_call(
        &self,
        owner: &IrItem,
        key: NodeKey,
        derive: SymbolId,
        outer: &CheckedDecisionCall,
        actor: &TypedExpr,
    ) -> Option<()> {
        let call_node = self.nodes.get(&key)?;
        let call_head = expressions(call_node).first().copied()?;
        reference_name(
            self.ir,
            owner,
            derive,
            &source_path(call_head, self.text)?,
            self.db,
        )?;
        if source_path(self.nodes.get(&outer.arguments[0].0)?, self.text)? != "actor" {
            return None;
        }
        if !matches!(&actor.expr,IrExpr::Member {base,field}
            if field == "actor" && matches!(&base.expr,IrExpr::Name(name) if name == "c"))
        {
            return None;
        }
        Some(())
    }

    fn check_conversation_identity(
        params_unique: bool,
        owner: &IrItem,
        caller_params: &[SymbolId],
        binding: &str,
        parameter_fact: &CheckedScenarioParameter,
        position: usize,
        parameter: &IrItem,
        parameter_owner: &SymbolId,
        index: &usize,
        expected: &ResolvedType,
        declared: &ResolvedType,
    ) -> Option<()> {
        if params_unique
            || *parameter_owner != owner.id
            || *index != position
            || caller_params.get(position) != Some(&parameter.id)
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, binding)
            || parameter_fact.parameter != parameter.id
            || parameter_fact.ty != *expected
            || declared != expected
        {
            return None;
        }
        Some(())
    }

    fn check_conversation_syntax(
        &self,
        authored: &SyntaxNode,
        authored_name: &SyntaxNode,
        authored_type: &SyntaxNode,
        parameter_fact: &CheckedScenarioParameter,
        parameter: &IrItem,
        default: &NodeKey,
        argument: &SyntaxNode,
        binding: &str,
        parent: &TypedExpr,
        outer_location: &(NodeKey, ResolvedType),
        literal: &TypedExpr,
    ) -> Option<()> {
        if NodeKey::of(authored_type) != parameter_fact.type_node
            || parameter_fact.default != Some(*default)
            || parameter_fact.constraints.is_some()
            || authored.kind != SyntaxKind::Parameter
            || parameter.span != authored_name.span
            || authored_name.token()?.text(self.text) != binding
            || argument.kind != SyntaxKind::NameRef
            || single_name(argument, self.text)? != binding
            || parent.span != argument.span
            || parent.ty != outer_location.1
            || literal.ty != ResolvedType::Null
            || !matches!(literal.expr, IrExpr::Null)
        {
            return None;
        }
        Some(())
    }

    fn load_imported_conversation<'s>(
        &'s self,
        owner: &IrItem,
        facts: &'s CheckedScenarioSource,
        parent: &TypedExpr,
        outer_location: &(NodeKey, ResolvedType),
        defining_source: &DisclosureSource,
        item: &IrItem,
        depth: usize,
    ) -> Option<&'s CheckedStoredContractSchema> {
        let IrItemKind::Scenario {
            params: caller_params,
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
        let IrExpr::Name(binding) = &parent.expr else {
            return None;
        };
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = &parent.ty
        else {
            return None;
        };
        let mut parameters = facts.parameters.iter().enumerate().filter(|(_, fact)| {
            self.ir
                .items
                .get(fact.parameter.0 as usize)
                .is_some_and(|item| item.name == *binding)
        });
        let (position, parameter_fact) = parameters.next()?;
        let parameter = self.ir.items.get(parameter_fact.parameter.0 as usize)?;
        let IrItemKind::Param {
            owner: parameter_owner,
            index,
            ty: IrType::Known(declared),
            default: Some(IrDefault::Literal(literal)),
            default_node: Some(default),
            default_copy_source: None,
            array_bounds: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let expected = ResolvedType::Nullable(Box::new(parent.ty.clone()));
        let authored = self.nodes.get(&parameter_fact.node)?;
        let authored_name = authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        let authored_type = authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::NullableType)?;
        let argument = self.nodes.get(&outer_location.0)?;
        Self::check_conversation_identity(
            parameters.next().is_some(),
            owner,
            caller_params,
            binding,
            parameter_fact,
            position,
            parameter,
            parameter_owner,
            index,
            &expected,
            declared,
        )?;
        self.check_conversation_syntax(
            authored,
            authored_name,
            authored_type,
            parameter_fact,
            parameter,
            default,
            argument,
            binding,
            parent,
            outer_location,
            literal,
        )?;
        self.expression(literal, *default, depth + 1)?;
        self.seal_imported_conversation(
            facts,
            *model,
            item,
            defining_source,
            authored_type,
            owner,
        )
    }

    fn load_authorization_conversation<'s>(
        &'s self,
        owner: &IrItem,
        facts: &'s CheckedScenarioSource,
        item: &IrItem,
        parent: &TypedExpr,
        imported: bool,
        defining_source: &DisclosureSource,
        outer: &CheckedDecisionCall,
        depth: usize,
    ) -> Option<&'s CheckedStoredContractSchema> {
        if imported {
            return self.load_imported_conversation(
                owner,
                facts,
                parent,
                &outer.arguments[1],
                defining_source,
                item,
                depth,
            );
        }
        let (branch, conversation) = super::scenario_receipts::checked_parent_reference(
            self.ir, owner, parent, self.db,
        )?;
        let IrExpr::Member { base, field } = &parent.expr else {
            return None;
        };
        if field != "parent"
            || !(matches!(base.expr, IrExpr::Name(_))
                || matches!(&base.expr, IrExpr::Member { base: required, field }
                    if field == "parent" && matches!(required.expr, IrExpr::Name(_))))
            || branch.parent != Some(conversation.id)
        {
            return None;
        }
        Some(conversation)
    }

    fn check_conversation_fields(
        &self,
        conversation: &CheckedStoredContractSchema,
        defining_source: &DisclosureSource,
    ) -> Option<()> {
        // Require prunes scalar authorization reads from the result recipe;
        // the helper still consumes these exact original field declarations.
        for (name, ty) in [("account", Scalar::User), ("active", Scalar::Bool)] {
            let mut fields = conversation
                .fields
                .iter()
                .filter(|field| field.name == name);
            let field = fields.next()?;
            if fields.next().is_some()
                || field.owner != conversation.id
                || field.ty != ResolvedType::Scalar(ty)
                || field.source != *defining_source
                || !conversation.field_order.contains(&field.id)
            {
                return None;
            }
            super::scenario_receipts::match_stored_contract_field(self.ir, field, self.db)?;
        }
        Some(())
    }

    fn check_derive_declaration<'x>(
        &self,
        defining_nodes: &'x HashMap<NodeKey, &SyntaxNode>,
        item: &IrItem,
        defining_text: &'x str,
    ) -> Option<&'x SyntaxNode> {
        let declarations: Vec<_> = defining_nodes
            .values()
            .filter(|node| {
                node.kind == SyntaxKind::Derive
                    && node.span.file == item.span.file
                    && node.span.start <= item.span.start
                    && node.span.end >= item.span.end
            })
            .collect();
        let [declaration] = declarations.as_slice() else {
            return None;
        };
        let declaration_path = declaration
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Path)?;
        let names: Vec<_> = declaration_path
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::Name)
            .collect();
        let [name] = names.as_slice() else {
            return None;
        };
        // Resolver owns the complete Path span, including its attached trivia;
        // the single Name token independently retains the declared spelling.
        if declaration_path.span != item.span
            || single_name(declaration_path, defining_text)? != item.name
            || name.token()?.text(defining_text) != item.name
        {
            return None;
        }
        Some(declaration)
    }

    fn check_authorization_formals(
        &self,
        params: &[SymbolId],
        declaration: &SyntaxNode,
        item: &IrItem,
        derive: SymbolId,
        conversation: &CheckedStoredContractSchema,
        defining_text: &str,
    ) -> Option<()> {
        let authored_params: Vec<_> = declaration
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::Parameter)
            .collect();
        if authored_params.len() != 2 {
            return None;
        }
        for (index, (parameter, authored)) in params.iter().zip(&authored_params).enumerate() {
            self.check_authorization_formal(
                *parameter,
                authored,
                index,
                item,
                derive,
                conversation,
                defining_text,
            )?;
        }
        Some(())
    }

    fn check_authorization_formal(
        &self,
        parameter: SymbolId,
        authored: &SyntaxNode,
        index: usize,
        item: &IrItem,
        derive: SymbolId,
        conversation: &CheckedStoredContractSchema,
        defining_text: &str,
    ) -> Option<()> {
        let parameter = self.ir.items.get(parameter.0 as usize)?;
        let IrItemKind::Param {
            owner: parameter_owner,
            index: position,
            ty: IrType::Known(ty),
            default: None,
            default_node: None,
            array_bounds: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let name = authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        let type_node = authored.children.iter().find(|node| {
            matches!(node.kind, SyntaxKind::NamedType | SyntaxKind::NullableType)
        })?;
        let expected = if index == 0 {
            ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::User)))
        } else {
            ResolvedType::Record {
                symbol: conversation.id,
                stored: true,
            }
        };
        let spelling = parameter.name.as_str();
        let type_spelling = if index == 0 {
            "user?"
        } else {
            self.ir.items.get(conversation.id.0 as usize)?.name.as_str()
        };
        if *parameter_owner != derive
            || *position != index
            || parameter.module != item.module
            || parameter.canonical != format!("{}.{}", item.canonical, spelling)
            || parameter.name != spelling
            || parameter.span != name.span
            || ty != &expected
            || name.token()?.text(defining_text) != spelling
            || defining_text.get(type_node.span.start as usize..type_node.span.end as usize)?
                != type_spelling
        {
            return None;
        }
        Some(())
    }

    fn load_membership_call<'s>(
        site: &'s CheckedDecisionSite,
        key: NodeKey,
        derive: SymbolId,
    ) -> Option<(&'s CheckedDecisionCall, &'s CheckedDecisionCallFrame)> {
        let mut membership_calls = site.calls.iter().filter(|call|
            matches!(&call.target,CheckedDecisionCallTarget::Builtin {id,overload:0} if id == "active_member")
                && matches!(call.chain.as_slice(),[frame] if frame.node == key && frame.derive == derive));
        let membership = membership_calls.next()?;
        let [frame] = membership.chain.as_slice() else {
            return None;
        };
        if membership_calls.next().is_some() {
            return None;
        }
        Some((membership, frame))
    }

    fn check_authorization_body(
        &self,
        body: &TypedExpr,
        params: &[SymbolId],
        conversation: &CheckedStoredContractSchema,
        membership: &CheckedDecisionCall,
        args: &[TypedExpr],
        outer: &CheckedDecisionCall,
        defining_nodes: &HashMap<NodeKey, &SyntaxNode>,
        defining_text: &str,
        depth: usize,
    ) -> Option<()> {
        // Only the original ordered nullable-person authorization body owns
        // this transitive State membership call and Conversation formal reads.
        let IrExpr::Binary {
            op: IrBinOp::And,
            left: three,
            right: active,
        } = &body.expr
        else {
            return None;
        };
        let IrExpr::Binary {
            op: IrBinOp::And,
            left: two,
            right: account,
        } = &three.expr
        else {
            return None;
        };
        let IrExpr::Binary {
            op: IrBinOp::And,
            left: nonnull,
            right: member,
        } = &two.expr
        else {
            return None;
        };
        let IrExpr::Binary {
            op: IrBinOp::Ne,
            left: person,
            right: null,
        } = &nonnull.expr
        else {
            return None;
        };
        let IrExpr::Binary {
            op: IrBinOp::Eq,
            left: account_member,
            right: account_person,
        } = &account.expr
        else {
            return None;
        };
        let person_name = &self.ir.items.get(params[0].0 as usize)?.name;
        let model_name = &self.ir.items.get(params[1].0 as usize)?.name;
        let formal_member = |value: &TypedExpr, expected: &str| {
            matches!(&value.expr,
            IrExpr::Member {base,field} if field == expected
                && matches!(&base.expr,IrExpr::Name(name) if name == model_name)
                && base.ty == (ResolvedType::Record {symbol:conversation.id,stored:true}))
        };
        if !matches!(&person.expr,IrExpr::Name(name) if name == person_name)
            || !matches!(null.expr, IrExpr::Null)
            || member.span != span(membership.node)
            || !formal_member(account_member, "account")
            || !matches!(&account_person.expr,IrExpr::Name(name) if name == person_name)
            || !formal_member(active, "active")
        {
            return None;
        }
        for (arg, (original, ty)) in args.iter().zip(&outer.arguments) {
            if arg.ty != *ty {
                return None;
            }
            self.expression(arg, *original, depth + 1)?;
        }
        SourceExpressions {
            ir: self.ir,
            db: self.db,
            original: self.original,
            owner: None,
            nodes: defining_nodes,
            text: defining_text,
            operands: true,
            membership_call: Some(membership),
            query_alias: None,
        }
        .expression(
            body,
            NodeKey::of(
                defining_nodes
                    .values()
                    .find(|node| node.span == body.span && node.kind == SyntaxKind::Binary)?,
            ),
            depth + 1,
        )
    }

    fn authorization(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        if self.membership_call.is_some() {
            return None;
        }
        let (target, args, slots) = Self::load_authorization_call(actual)?;
        if self.authenticated_derive(target, 0, &mut HashSet::new()) != Some(true) {
            return None;
        }
        let [actor, parent] = args else {
            return None;
        };
        let (owner, facts) = self.load_authorization_owner()?;
        let (site, outer) = Self::load_authorization_site(
            facts,
            owner,
            &self.original.source,
            key,
        )?;
        let (derive, item, params, result, body) = self.load_authorization_derive(outer)?;
        let IrItemKind::Scenario { guards, .. } = &owner.kind else {
            return None;
        };
        let (defining, defining_text, defining_source) = self.load_defining_source(item, owner)?;
        let imported = item.module != owner.module;
        // A separate source owns imported formals/body. Keep the caller nodes
        // for real argument occurrences and parse the defining file when needed.
        let defining_tree = self.load_defining_tree(defining)?;
        let defining_nodes = Self::collect_defining_nodes(self.nodes, defining_tree.as_ref());
        Self::check_authorization_shape(
            site, outer, guards, item, derive, target, owner, &self.original.source, slots,
            params, result, actual, body,
        )?;
        self.check_authorization_call(owner, key, derive, outer, actor)?;
        let conversation = self.load_authorization_conversation(
            owner,
            facts,
            item,
            parent,
            imported,
            &defining_source,
            outer,
            depth,
        )?;
        // Require prunes scalar authorization reads from the result recipe;
        // the helper still consumes these exact original field declarations.
        self.check_conversation_fields(conversation, &defining_source)?;
        let declaration =
            self.check_derive_declaration(&defining_nodes, item, defining_text)?;
        self.check_authorization_formals(
            params,
            declaration,
            item,
            derive,
            conversation,
            defining_text,
        )?;
        let (membership, frame) = Self::load_membership_call(site, key, derive)?;
        if frame.module != owner.module
            || frame.source != self.original.source
            || membership.module != item.module
            || membership.source != defining_source
        {
            return None;
        }
        // Only the original ordered nullable-person authorization body owns
        // this transitive State membership call and Conversation formal reads.
        self.check_authorization_body(
            body,
            params,
            conversation,
            membership,
            args,
            outer,
            &defining_nodes,
            defining_text,
            depth,
        )
    }

    fn check_membership_call(
        &self,
        node: &SyntaxNode,
        original: &CheckedDecisionCall,
        actual: &TypedExpr,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        if original.node != NodeKey::of(node)
            || !original.defaults.is_empty()
            || original.slots.as_slice() != [Some(0), Some(1)]
            || slots.is_some_and(|slots| slots != original.slots.as_slice())
            || !matches!(&original.target,CheckedDecisionCallTarget::Builtin {id,overload:0} if id == "active_member")
            || original.arguments.len() != 2
            || args.len() != 2
            || original.arguments[0].1 != ResolvedType::Scalar(Scalar::User)
            || original.arguments[1].1 != ResolvedType::Team
            || actual.ty != ResolvedType::Scalar(Scalar::Bool)
            || !matches!(&args[0].expr,IrExpr::Name(name)
                if source_path(self.nodes.get(&original.arguments[0].0)?, self.text)?.as_str() == name)
            || !matches!(&args[1].expr,IrExpr::Member {base,field}
                if field == "team" && matches!(&base.expr,IrExpr::Name(name) if name == "c"))
            || source_path(self.nodes.get(&original.arguments[1].0)?, self.text)? != "team"
            || source_path(expressions(node).first()?, self.text)? != "active_member"
        {
            return None;
        }
        Some(())
    }

    fn find_guard_call<'s>(
        &self,
        source: &'s CheckedScenarioSource,
        key: NodeKey,
    ) -> Option<&'s CheckedDecisionCall> {
        use crate::analysis::scenario_disclosure::CheckedDecisionStage;
        let mut calls = source
            .decision_sites
            .as_deref()?
            .iter()
            .filter(|site| {
                site.owner == source.scenario
                    && matches!(
                        site.stage,
                        CheckedDecisionStage::LeadingRequire | CheckedDecisionStage::BodyRequire
                    )
            })
            .flat_map(|site| &site.calls)
            .filter(|call| call.node == key);
        let original = calls.next()?;
        if calls.next().is_some() {
            return None;
        }
        Some(original)
    }

    fn check_guard_call_shape(
        &self,
        node: &SyntaxNode,
        original: &CheckedDecisionCall,
        actual: &TypedExpr,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        if original.source != self.original.source
            || !matches!(&original.target, CheckedDecisionCallTarget::Builtin {id,overload:0} if id == "starts_with")
            || !original.chain.is_empty()
            || !original.defaults.is_empty()
            || original.slots.as_slice() != [Some(0), Some(1)]
            || slots.is_some_and(|actual| actual != original.slots.as_slice())
            || original.arguments.len() != 2
            || args.len() != 2
            || actual.ty != ResolvedType::Scalar(Scalar::Bool)
            || source_path(expressions(node).first()?, self.text)? != "starts_with"
        {
            return None;
        }
        Some(())
    }

    fn check_guard_argument(
        &self,
        argument: &SyntaxNode,
        value: &TypedExpr,
        key: NodeKey,
        ty: &ResolvedType,
        depth: usize,
    ) -> Option<()> {
        let values = expressions(argument);
        let [source_value] = values.as_slice() else {
            return None;
        };
        if NodeKey::of(source_value) != key
            || *ty != ResolvedType::Scalar(Scalar::Text)
            || value.ty != *ty
        {
            return None;
        }
        self.expression(value, key, depth + 1)
    }

    fn membership(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        depth: usize,
    ) -> Option<()> {
        let original = self.membership_call?;
        self.check_membership_call(node, original, actual, args, slots)?;
        for (actual, (key, ty)) in args.iter().zip(&original.arguments) {
            if actual.ty != *ty {
                return None;
            }
            self.expression(actual, *key, depth + 1)?;
        }
        Some(())
    }

    /// Pure prefix decisions retain the selected original builtin and operand
    /// occurrences; a same-spelled derive cannot substitute for this call.
    fn prefix_guard(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        depth: usize,
    ) -> Option<()> {
        let source = self.transcript_source()?;
        let key = NodeKey::of(node);
        let original = self.find_guard_call(source, key)?;
        self.check_guard_call_shape(node, original, actual, args, slots)?;
        let authored: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        if authored.len() != args.len() {
            return None;
        }
        for ((argument, value), (key, ty)) in authored.iter().zip(args).zip(&original.arguments) {
            self.check_guard_argument(argument, value, *key, ty, depth)?;
        }
        Some(())
    }

    fn find_leading_guard_call<'s>(
        &self,
        source: &'s CheckedScenarioSource,
        key: NodeKey,
    ) -> Option<&'s CheckedDecisionCall> {
        use crate::analysis::scenario_disclosure::CheckedDecisionStage;
        let mut calls = source
            .decision_sites
            .as_deref()?
            .iter()
            .filter(|site| {
                site.owner == source.scenario && site.stage == CheckedDecisionStage::LeadingRequire
            })
            .flat_map(|site| &site.calls)
            .filter(|call| call.node == key);
        let original = calls.next()?;
        if calls.next().is_some() {
            return None;
        }
        Some(original)
    }

    fn check_trim_call_shape(
        &self,
        node: &SyntaxNode,
        original: &CheckedDecisionCall,
        actual: &TypedExpr,
        argument: &TypedExpr,
        argument_type: &ResolvedType,
        slots: Option<&[Option<usize>]>,
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        if original.source != self.original.source
            || !matches!(&original.target,CheckedDecisionCallTarget::Builtin {id,overload:0} if id == "trim")
            || !original.chain.is_empty()
            || !original.defaults.is_empty()
            || original.slots.as_slice() != [Some(0)]
            || slots.is_some_and(|slots| slots != [Some(0)])
            || actual.ty != ResolvedType::Scalar(Scalar::Text)
            || *argument_type != ResolvedType::Scalar(Scalar::Text)
            || argument.ty != *argument_type
            || source_path(expressions(node).first()?, self.text)? != "trim"
        {
            return None;
        }
        Some(())
    }

    fn trim_value_name<'x>(
        node: &SyntaxNode,
        argument_node: &NodeKey,
        text: &'x str,
    ) -> Option<&'x str> {
        let mut authored = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument);
        let value = expressions(authored.next()?);
        let [value] = value.as_slice() else {
            return None;
        };
        if authored.next().is_some()
            || NodeKey::of(value) != *argument_node
            || value.kind != SyntaxKind::NameRef
        {
            return None;
        }
        single_name(value, text)
    }

    fn check_trim_parameter(
        &self,
        source: &CheckedScenarioSource,
        name: &str,
        argument_type: &ResolvedType,
    ) -> Option<()> {
        let owner = self.ir.items.get(source.scenario.0 as usize)?;
        let mut parameters = source
            .parameters
            .iter()
            .enumerate()
            .filter(|(_, parameter)| {
                self.ir
                    .items
                    .get(parameter.parameter.0 as usize)
                    .is_some_and(|item| item.name == name)
            });
        let (index, original_parameter) = parameters.next()?;
        let parameter = self.ir.items.get(original_parameter.parameter.0 as usize)?;
        if parameters.next().is_some()
            || parameter.id != original_parameter.parameter
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, name)
            || original_parameter.ty != *argument_type
            || original_parameter.default.is_some()
            || !matches!(&parameter.kind,IrItemKind::Param {owner: actual_owner,index: actual_index,ty:IrType::Known(ty),default:None,default_node:None,default_copy_source:None,..}
                if *actual_owner == source.scenario && *actual_index == index && ty == argument_type)
        {
            return None;
        }
        Some(())
    }

    fn trim_guard(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        depth: usize,
    ) -> Option<()> {
        let source = self.transcript_source()?;
        let key = NodeKey::of(node);
        let original = self.find_leading_guard_call(source, key)?;
        let [argument] = args else {
            return None;
        };
        let [(argument_node, argument_type)] = original.arguments.as_slice() else {
            return None;
        };
        self.check_trim_call_shape(node, original, actual, argument, argument_type, slots)?;
        let name = Self::trim_value_name(node, argument_node, self.text)?;
        self.check_trim_parameter(source, name, argument_type)?;
        self.expression(argument, *argument_node, depth + 1)
    }

    fn operand_type_matches(&self, actual: &TypedExpr, key: NodeKey) -> bool {
        let Some((_, original)) = self
            .original
            .expression_types
            .iter()
            .find(|(at, _)| *at == key)
        else {
            return false;
        };
        if original == &actual.ty {
            return true;
        }
        let Some(source) = self.transcript_source() else {
            return false;
        };
        let Some(owner) = self.ir.items.get(source.scenario.0 as usize) else {
            return false;
        };
        super::scenario_current_revision::checked_current_revision(self.ir, owner, self.db)
            .is_some_and(|current| {
                std::ptr::eq(current.published_read.value, actual)
                    && current.published_read.control.node == key
                    && &current.published_read.control.ty == original
            })
    }

    /// Source-only seal for scalar uniqueness invariants with an authored ANY
    /// model scan. This does not admit query execution or create stored fields.
    fn match_schema_name(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        bindings: &[(String, crate::analysis::SymbolId)],
        name: &String,
    ) -> Option<()> {
        let authored = single_name(node, self.text)?;
        let model = bindings
            .iter()
            .rev()
            .find(|(binding, _)| binding == authored)?
            .1;
        (name == authored
            && actual.ty
                == ResolvedType::Record {
                    symbol: model,
                    stored: true,
                })
        .then_some(())
    }

    fn match_schema_money(actual: &TypedExpr, field: &String) -> Option<()> {
        let expected = match field.as_str() {
            "currency" => Scalar::Currency,
            "minor" => Scalar::Int,
            _ => return None,
        };
        (actual.ty == ResolvedType::Scalar(expected)).then_some(())
    }

    fn match_schema_parent(
        &self,
        actual: &TypedExpr,
        model: crate::analysis::SymbolId,
    ) -> Option<()> {
        let child = self.ir.items.get(model.0 as usize)?;
        let IrItemKind::Model {
            owner: IrOwner::ChildOf(parent),
            fields,
            ..
        } = &child.kind
        else {
            return None;
        };
        if fields.iter().any(|id| {
            self.ir
                .items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "parent")
        }) {
            return None;
        }
        let owner = self.create_owner()?;
        let facts = super::scenario_calls::checked_source(self.ir, owner, self.db)?;
        let inventory = facts.stored_contracts.as_deref()?;
        let child_schema = inventory
            .iter()
            .find(|schema| schema.model && schema.id == model)?;
        let parent_schema = inventory
            .iter()
            .find(|schema| schema.model && schema.id == *parent)?;
        super::scenario_receipts::match_stored_contract_schema(
            self.ir,
            child_schema,
            self.db,
        )?;
        super::scenario_receipts::match_stored_contract_schema(
            self.ir,
            parent_schema,
            self.db,
        )?;
        (actual.ty
            == ResolvedType::Record {
                symbol: *parent,
                stored: true,
            })
        .then_some(())
    }

    fn load_schema_field_ty(&self, field: &String, model: crate::analysis::SymbolId) -> Option<ResolvedType> {
        if model == self.original.model {
            return Some(
                self.original
                    .definition
                    .fields
                    .iter()
                    .find(|declared| declared.name == *field)?
                    .ty
                    .clone(),
            );
        }
        let owner = self.create_owner()?;
        let facts = super::scenario_calls::checked_source(self.ir, owner, self.db)?;
        let schema = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.model && schema.id == model)?;
        super::scenario_receipts::match_stored_contract_schema(
            self.ir, schema, self.db,
        )?;
        let declared = schema
            .fields
            .iter()
            .find(|declared| declared.name == *field)?;
        super::scenario_receipts::match_stored_contract_field(
            self.ir, declared, self.db,
        )?;
        Some(declared.ty.clone())
    }

    fn match_schema_member(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        base: &TypedExpr,
        field: &String,
        bindings: &[(String, crate::analysis::SymbolId)],
        depth: usize,
    ) -> Option<()> {
        let [source_base] = children else {
            return None;
        };
        let name = node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        if name.token()?.text(self.text) != field {
            return None;
        }
        self.schema_rule_expression(base, NodeKey::of(source_base), bindings, depth + 1)?;
        if base.ty == ResolvedType::Scalar(Scalar::Money) {
            return Self::match_schema_money(actual, field);
        }
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = base.ty
        else {
            return None;
        };
        if field == "parent" {
            return self.match_schema_parent(actual, model);
        }
        let expected = self.load_schema_field_ty(field, model)?;
        (actual.ty == expected
            && matches!(
                expected,
                ResolvedType::Scalar(_) | ResolvedType::Enum { .. }
            ))
        .then_some(())
    }

    fn match_schema_binary(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        bindings: &[(String, crate::analysis::SymbolId)],
        depth: usize,
        op: &IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
    ) -> Option<()> {
        let [source_left, source_right] = children else {
            return None;
        };
        let spelling = match op {
            IrBinOp::And => "and",
            IrBinOp::Or => "or",
            IrBinOp::Eq => "==",
            IrBinOp::Ne => "!=",
            IrBinOp::Lt => "<",
            IrBinOp::Le => "<=",
            IrBinOp::Gt => ">",
            IrBinOp::Ge => ">=",
            _ => return None,
        };
        let operator = node
            .children
            .iter()
            .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?;
        if operator.token()?.text(self.text) != spelling
            || actual.ty != ResolvedType::Scalar(Scalar::Bool)
            || left.ty != right.ty
        {
            return None;
        }
        self.schema_rule_expression(left, NodeKey::of(source_left), bindings, depth + 1)?;
        self.schema_rule_expression(right, NodeKey::of(source_right), bindings, depth + 1)
    }

    fn match_schema_unary(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        bindings: &[(String, crate::analysis::SymbolId)],
        depth: usize,
        operand: &TypedExpr,
    ) -> Option<()> {
        let [source_operand] = children else {
            return None;
        };
        let keyword = node
            .children
            .iter()
            .find(|child| child.kind == SyntaxKind::Name)?;
        if keyword.token()?.text(self.text) != "not"
            || actual.ty != ResolvedType::Scalar(Scalar::Bool)
            || operand.ty != actual.ty
        {
            return None;
        }
        self.schema_rule_expression(
            operand,
            NodeKey::of(source_operand),
            bindings,
            depth + 1,
        )
    }

    fn match_schema_trim(
        &self,
        actual: &TypedExpr,
        arguments: &[&SyntaxNode],
        args: &[TypedExpr],
        bindings: &[(String, crate::analysis::SymbolId)],
        depth: usize,
    ) -> Option<()> {
        let ([argument], [value]) = (arguments, args) else {
            return None;
        };
        if actual.ty != ResolvedType::Scalar(Scalar::Text) || value.ty != actual.ty {
            return None;
        }
        let source = expressions(argument);
        let [source] = source.as_slice() else {
            return None;
        };
        self.schema_rule_expression(
            value,
            NodeKey::of(source),
            bindings,
            depth + 1,
        )
    }

    fn check_schema_any_identity(
        &self,
        source_query: &SyntaxNode,
        source_domain: &SyntaxNode,
        domain: &TypedExpr,
        array: &ResolvedType,
        checked: &CheckedQuery,
        alias: &CheckedQueryClause,
        alias_name: &SyntaxNode,
        name: &String,
        param: &String,
        predicate: &TypedExpr,
        body: &TypedExpr,
        source_predicate: &SyntaxNode,
    ) -> Option<()> {
        if source_query.span != source_domain.span
            || source_query.kind != SyntaxKind::Query
            || domain.span != source_domain.span
            || domain.ty != *array
            || checked.domain_type != *array
            || checked.result != *array
            || !source_query
                .children
                .iter()
                .any(|node| NodeKey::of(node) == checked.domain)
            || !source_query
                .children
                .iter()
                .any(|node| NodeKey::of(node) == alias.node)
            || !alias.expressions.is_empty()
            || alias_name.token()?.text(self.text) != name
            || param != name
            || predicate.span != source_predicate.span
            || body.span != source_predicate.span
            || body.ty != ResolvedType::Scalar(Scalar::Bool)
        {
            return None;
        }
        Some(())
    }

    fn check_schema_any_query(
        collection: &CheckedCollectionCall,
        checked: &CheckedQuery,
        query: &IrQuery,
        source_predicate: &SyntaxNode,
        node: &SyntaxNode,
        alias_node: NodeKey,
        candidate_id: crate::analysis::SymbolId,
    ) -> Option<()> {
        if collection.node != NodeKey::of(node)
            || collection.builtin != "any"
            || collection.overload != 0
            || collection.query != checked.node
            || collection.alias != alias_node
            || collection.model != candidate_id
            || collection.predicate.as_ref().is_none_or(|predicate| {
                predicate.node != NodeKey::of(source_predicate)
                    || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
            })
            || query.parent.is_some()
            || query.where_pred.is_some()
            || query.where_async
            || !query.order.is_empty()
            || query.value_order.is_some()
            || query.limit.is_some()
            || query.archived.is_some()
            || query.select.is_some()
            || query.select_param.is_some()
            || query.contract_collection_call.is_some()
            || checked.projection.is_some()
        {
            return None;
        }
        Some(())
    }

    fn seal_schema_any_source(
        &self,
        candidate: &IrItem,
        checked: &CheckedQuery,
        name: &String,
        bindings: &[(String, crate::analysis::SymbolId)],
    ) -> Option<Vec<(String, crate::analysis::SymbolId)>> {
        reference_name(
            self.ir,
            self.ir.items.get(self.original.model.0 as usize)?,
            candidate.id,
            single_name(self.nodes.get(&checked.domain)?, self.text)?,
            self.db,
        )?;
        model_identity(self.ir, self.create_owner()?, candidate.id, self.db)?;
        let mut nested = bindings.to_vec();
        nested.push((name.clone(), candidate.id));
        Some(nested)
    }

    fn match_schema_any_query(
        &self,
        node: &SyntaxNode,
        arguments: &[&SyntaxNode],
        args: &[TypedExpr],
        bindings: &[(String, crate::analysis::SymbolId)],
        depth: usize,
    ) -> Option<()> {
        let ([source_domain, source_predicate], [domain, predicate]) =
            (arguments, args)
        else {
            return None;
        };
        let IrExpr::Query(query) = &domain.expr else {
            return None;
        };
        let IrExpr::Lambda { param, body } = &predicate.expr else {
            return None;
        };
        let source_domain = expressions(source_domain);
        let [source_domain] = source_domain.as_slice() else {
            return None;
        };
        let source_predicate = expressions(source_predicate);
        let [source_predicate] = source_predicate.as_slice() else {
            return None;
        };
        let checked = query.source.as_deref()?;
        let [alias] = checked.clauses.as_slice() else {
            return None;
        };
        let crate::analysis::types::CheckedQueryClauseKind::As { name } = &alias.kind
        else {
            return None;
        };
        let source_query = self.nodes.get(&checked.node)?;
        let source_alias = self.nodes.get(&alias.node)?;
        let alias_name = source_alias
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        let IrQueryDomain::Model(canonical) = &query.domain else {
            return None;
        };
        let candidate = self
            .ir
            .items
            .iter()
            .find(|item| item.canonical == *canonical)?;
        let array = ResolvedType::Array {
            element: Box::new(ResolvedType::Record {
                symbol: candidate.id,
                stored: true,
            }),
            ordered: true,
            nonempty: false,
        };
        let collection = query.collection_call.as_deref()?;
        self.check_schema_any_identity(
            source_query, source_domain, domain, &array, checked, alias, alias_name,
            name, param, predicate, body, source_predicate,
        )?;
        Self::check_schema_any_query(
            collection, checked, query, source_predicate, node, alias.node, candidate.id,
        )?;
        let nested = self.seal_schema_any_source(candidate, checked, name, bindings)?;
        self.schema_rule_expression(body, NodeKey::of(source_predicate), &nested, depth + 1)
    }

    fn schema_rule_expression(
        &self,
        actual: &TypedExpr,
        key: NodeKey,
        bindings: &[(String, crate::analysis::SymbolId)],
        depth: usize,
    ) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let mut node = *self.nodes.get(&key)?;
        while node.kind == SyntaxKind::Group {
            node = expressions(node).first().copied()?;
        }
        if actual.span != node.span {
            return None;
        }
        let children = expressions(node);
        match (&actual.expr, node.kind) {
            (IrExpr::Name(name), SyntaxKind::NameRef) => {
                self.match_schema_name(actual, node, bindings, name)
            }
            (IrExpr::Member { base, field }, SyntaxKind::Member) => {
                self.match_schema_member(actual, node, &children, base, field, bindings, depth)
            }
            (IrExpr::Binary { op, left, right }, SyntaxKind::Binary) => {
                self.match_schema_binary(actual, node, &children, bindings, depth, op, left, right)
            }
            (
                IrExpr::Unary {
                    op: IrUnOp::Not,
                    operand,
                },
                SyntaxKind::Unary,
            ) => {
                self.match_schema_unary(actual, node, &children, bindings, depth, operand)
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                },
                SyntaxKind::Call,
            )
            | (
                IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                    ..
                },
                SyntaxKind::Call,
            ) => {
                if source_path(children.first()?, self.text)? != *id {
                    return None;
                }
                if let IrExpr::BoundCall { slots, .. } = &actual.expr {
                    if slots
                        .iter()
                        .enumerate()
                        .any(|(index, slot)| *slot != Some(index))
                        || slots.len() != args.len()
                    {
                        return None;
                    }
                }
                let arguments = node
                    .children
                    .iter()
                    .filter(|child| child.kind == SyntaxKind::Argument)
                    .collect::<Vec<_>>();
                if args.len() != arguments.len() {
                    return None;
                }
                if id == "trim" {
                    return self.match_schema_trim(actual, &arguments, args, bindings, depth);
                }
                return self.match_schema_any_query(node, &arguments, args, bindings, depth);
            }
            (_, SyntaxKind::Literal) => self.expression(actual, NodeKey::of(node), depth + 1),
            _ => None,
        }
    }

    fn literal_text_type(&self, actual: &TypedExpr) -> bool {
        actual.ty == ResolvedType::Scalar(Scalar::Text)
            || self.operands && actual.ty == ResolvedType::Scalar(Scalar::Email)
    }

    /// Exact authored scalar literals are shared by schema/default and operand
    /// correspondence; contextual Email remains operand-only.
    fn scalar_literal(&self, actual: &TypedExpr, node: &SyntaxNode) -> Option<bool> {
        let token = |kind| node.children.iter().find(|child| child.kind == kind)
            .and_then(|child| self.text.get(child.span.start as usize..child.span.end as usize));
        let primitive = |scalar| actual.ty == ResolvedType::Scalar(scalar);
        Some(match &actual.expr {
            IrExpr::Int(value) => {
                primitive(Scalar::Int)
                    && token(SyntaxKind::Integer)?.parse::<i128>().ok()? == *value
            }
            IrExpr::Decimal(value) => {
                primitive(Scalar::Decimal) && token(SyntaxKind::Decimal)? == value
            }
            IrExpr::Bool(value) => {
                primitive(Scalar::Bool)
                    && token(SyntaxKind::Name)? == if *value { "true" } else { "false" }
            }
            IrExpr::Null => {
                actual.ty == ResolvedType::Null && token(SyntaxKind::Name)? == "null"
            }
            IrExpr::Text(value) => {
                // Checked operand literals retain contextual Email identity.
                // Schema/default matching keeps its existing Text-only path.
                self.literal_text_type(actual)
                    && node
                        .children
                        .iter()
                        .find(|child| child.kind == SyntaxKind::String)?
                        .token()?
                        .string_value
                        .as_ref()?
                        == value
            }
            _ => return None,
        })
    }

    fn literal_message(&self, actual: &TypedExpr, node: &SyntaxNode) -> Option<()> {
        let IrExpr::Message(message) = &actual.expr else { return None; };
        let source = node.children.iter().find(|child| child.kind == SyntaxKind::Literal)?;
        let text = source.children.iter().find(|child| child.kind == SyntaxKind::String)?.token()?.string_value.as_ref()?;
        let module = self.ir.modules.iter().find(|module| module.name == self.original.source.module)?;
        let declaration = self.nodes.values().find(|node| matches!(node.kind, SyntaxKind::App | SyntaxKind::Package) && node.span == module.span)?;
        let source_lang = crate::analysis::attribute_value(declaration, "source", self.text)
            .and_then(|value| value.children.iter().find(|child| child.kind == SyntaxKind::String))
            .and_then(|string| string.token()?.string_value.as_ref()).map(String::as_str).unwrap_or("en");
        let variants = node.children.iter().filter(|child| child.kind == SyntaxKind::MessageVariant)
            .map(|variant| {
                let locale = variant.children.iter().find(|child| child.kind == SyntaxKind::Name)?.token()?.text(self.text).to_string();
                let literal = variant.children.iter().find(|child| child.kind == SyntaxKind::Literal)?;
                let value = match literal.children.iter().find(|child| child.kind == SyntaxKind::String) {
                    Some(string) => Some(string.token()?.string_value.clone()?),
                    None if self.text.get(literal.span.start as usize..literal.span.end as usize) == Some("null") => None,
                    _ => return None,
                };
                Some((locale, value))
            }).collect::<Option<Vec<_>>>()?;
        (actual.ty == ResolvedType::InlineMessage && message.params.is_empty()
            && message.source == *text && message.source_lang == source_lang && message.variants == variants).then_some(())
    }

    /// Localized formatting keeps written argument order and the two checked
    /// descriptor/locale formal bindings; no absent catalog default is invented.
    fn literal_format(&self, actual: &TypedExpr, node: &SyntaxNode, depth: usize) -> Option<()> {
        let IrExpr::Format { args, descriptor_index, locale_index, schemas } = &actual.expr else { return None; };
        let children = expressions(node);
        if actual.ty != ResolvedType::Scalar(Scalar::Text) || source_path(children.first()?, self.text)? != "format" || args.len() != 2 {
            return None;
        }
        let arguments: Vec<_> = node.children.iter().filter(|child| child.kind == SyntaxKind::Argument).collect();
        if arguments.len() != 2 { return None; }
        let mut slots = [None, None];
        for (index, (argument, value)) in arguments.iter().zip(args).enumerate() {
            let named = argument.children.iter().find(|child| child.kind == SyntaxKind::Name).and_then(|name| name.token()).map(|token| token.text(self.text));
            let formal = match named { None => index, Some("descriptor") => 0, Some("locale") => 1, _ => return None };
            if slots[formal].replace(index).is_some() { return None; }
            let values = expressions(argument);
            let [source] = values.as_slice() else { return None; };
            self.expression(value, NodeKey::of(source), depth + 1)?;
        }
        if slots != [Some(*descriptor_index), Some(*locale_index)] { return None; }
        let IrExpr::Message(descriptor) = &args.get(*descriptor_index)?.expr else { return None; };
        let [schema] = schemas.as_slice() else { return None; };
        let locale = &args.get(*locale_index)?.ty;
        (schema.source_lang == descriptor.source_lang && schema.param_types.is_empty()
            && matches!(locale, ResolvedType::Null | ResolvedType::Scalar(Scalar::Locale))
            && descriptor.params.is_empty()).then_some(())
    }

    fn ungroup_expression_node<'x>(
        &'x self,
        actual: &TypedExpr,
        key: NodeKey,
        depth: usize,
    ) -> Option<&'x SyntaxNode> {
        let mut node = *self.nodes.get(&key)?;
        if self.operands && !self.operand_type_matches(actual, key) {
            return None;
        }
        let mut groups = 0usize;
        while node.kind == SyntaxKind::Group {
            groups += 1;
            if depth + groups > 64 {
                return None;
            }
            let children = expressions(node);
            let [child] = children.as_slice() else {
                return None;
            };
            if self.operands && !self.operand_type_matches(actual, NodeKey::of(child)) {
                return None;
            }
            node = child;
        }
        // Group lowering retains the inner expression's source span. Every
        // original wrapper and its inner node still have the same checked type.
        if actual.span != node.span {
            return None;
        }
        Some(node)
    }

    fn child_token<'x>(&'x self, node: &SyntaxNode, kind: SyntaxKind) -> Option<&'x str> {
        let child = node.children.iter().find(|child| child.kind == kind)?;
        self.text
            .get(child.span.start as usize..child.span.end as usize)
    }

    fn match_operand_name(&self, node: &SyntaxNode, name: &str) -> bool {
        let Some(authored) = single_name(node, self.text) else {
            return false;
        };
        if let Some((source, lowered)) = self.query_alias
            && authored == source
        {
            name == lowered
        } else {
            authored == name
        }
    }
    fn match_actor_member(
        &self,
        node: &SyntaxNode,
        base: &TypedExpr,
        field: &str,
        actual: &TypedExpr,
    ) -> bool {
        let Some(name) = single_name(node, self.text) else {
            return false;
        };
        matches!(name, "actor" | "now" | "team" | "operation")
            && field == name
            && matches!(&base.expr, IrExpr::Name(name) if name == "c")
            && base.ty == ResolvedType::Unknown
            && base.span == actual.span
    }
    fn match_enum_member(&self, node: &SyntaxNode, value: &str, actual: &TypedExpr) -> bool {
        // Qualified closed-case spelling (`C.role.administrator`,
        // `Kinds.role.administrator`): the lowered case is the third
        // significant child (mirrors `decode_member`). Closed-case
        // identity comes from the retained checked set alone.
        let mut parts = node
            .children
            .iter()
            .filter(|part| !matches!(part.kind, SyntaxKind::Trivia | SyntaxKind::Comment));
        if parts.next().is_none() {
            return false;
        }
        let Some(case) = parts.nth(1) else {
            return false;
        };
        let Some(token) = case.token() else {
            return false;
        };
        self.ir.resolved_cases.contains(&NodeKey::of(node))
            && case.kind == SyntaxKind::Name
            && token.text(self.text) == value
            && matches!(&actual.ty, ResolvedType::Enum {cases, ..} if cases.iter().any(|case| case == value))
            && self
                .original
                .expression_types
                .iter()
                .any(|(at, ty)| *at == NodeKey::of(node) && ty == &actual.ty)
    }
    fn match_duration(&self, node: &SyntaxNode, value: &i128, actual: &TypedExpr) -> bool {
        let Some(token) = node
            .children
            .iter()
            .find(|child| child.kind == SyntaxKind::Duration)
            .and_then(|child| {
                self.text
                    .get(child.span.start as usize..child.span.end as usize)
            })
        else {
            return false;
        };
        actual.ty == ResolvedType::Scalar(Scalar::Duration)
            && matches!(duration(token), Some(parsed) if parsed == *value)
    }
    fn descend_group_node(&self, source: &SyntaxNode) -> Option<NodeKey> {
        let mut base_key = NodeKey::of(source);
        for _ in 0..64 {
            let base_node = self.nodes.get(&base_key)?;
            if base_node.kind != SyntaxKind::Group {
                break;
            }
            let grouped = expressions(base_node);
            let [child] = grouped.as_slice() else {
                return None;
            };
            base_key = NodeKey::of(child);
        }
        Some(base_key)
    }
    fn check_actor_facts_seal(
        &self,
        actual: &TypedExpr,
        base: &TypedExpr,
        facts_base: &TypedExpr,
        base_node: &SyntaxNode,
        base_key: NodeKey,
        source_base: &SyntaxNode,
    ) -> Option<()> {
        if single_name(base_node, self.text)? != "actor" {
            return None;
        }
        if !self
            .original
            .expression_types
            .iter()
            .any(|(at, ty)| *at == base_key && ty == &ResolvedType::Scalar(Scalar::User))
        {
            return None;
        }
        // Pin every introduced decoded receiver against its honest
        // decoder shape (parallel to the query receiver seal): the
        // middle `actorFacts` member keeps the caller-row User type
        // over the exact authored actor occurrence, and the inner
        // synthetic context root is the Unknown `c` over the exact
        // pre-unwrap wrapper occurrence.
        if base.ty != ResolvedType::Scalar(Scalar::User)
            || base.span != base_node.span
            || facts_base.ty != ResolvedType::Unknown
            || facts_base.span != source_base.span
        {
            return None;
        }
        Some(())
    }
    fn match_actor_facts_member(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        source_base: &SyntaxNode,
        field: &str,
        base: &TypedExpr,
    ) -> Option<()> {
        // Checked contextual actor facts (CAN18-v1 actor guard slice):
        // the IR decoder rewrites literal `actor.email` /
        // `actor.email_verified` to `c.actorFacts.<field>`. Admit
        // exactly that sealed shape against the authored
        // `actor.<field>` occurrence.
        let IrExpr::Member {
            base: facts_base,
            field: facts,
        } = &base.expr
        else {
            return None;
        };
        if facts != "actorFacts" {
            return None;
        }
        let IrExpr::Name(context) = &facts_base.expr else {
            return None;
        };
        if context != "c" {
            return None;
        }
        let name = node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        if name.token()?.text(self.text) != field {
            return None;
        }
        // Grouping is transparent (mirrors the query receiver
        // normalization): descend through authored groups to the
        // literal actor occurrence before checking its spelling
        // and checked type.
        let base_key = self.descend_group_node(source_base)?;
        let base_node = self.nodes.get(&base_key)?;
        self.check_actor_facts_seal(actual, base, facts_base, base_node, base_key, source_base)?;
        Some(())
    }
    fn find_profile_pair_owner(&self) -> Option<&IrItem> {
        let mut owners = self.ir.items.iter().filter(|owner| {
            self.ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|disclosure| disclosure.source_facts())
                .is_some_and(|facts| {
                    facts.source == self.original.source
                        && facts.creates.as_deref().is_some_and(|creates| {
                            creates
                                .iter()
                                .any(|created| created.node == self.original.node)
                        })
                })
        });
        let owner = owners.next()?;
        if owners.next().is_some() {
            return None;
        }
        Some(owner)
    }
    fn match_profile_member(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        source_base: &SyntaxNode,
        base: &TypedExpr,
        field: &str,
        depth: usize,
    ) -> Option<()> {
        let name = node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        if name.token()?.text(self.text) != field {
            return None;
        }
        // Only the original checked profile or leading run scalar pair joins
        // its actual reads here; this issues no native row view.
        if matches!(&base.expr, IrExpr::Member { field, .. } if field == "profile" || field == "run")
            && self.original.expression_types.iter().any(|(at, ty)| {
                *at == NodeKey::of(source_base)
                    && matches!(ty, ResolvedType::Record { symbol, stored: true }
                        if self.ir.items.get(symbol.0 as usize).is_some_and(|item| item.id == *symbol && matches!(item.kind, IrItemKind::Model { .. })))
            })
        {
            let owner = self.find_profile_pair_owner()?;
            super::scenario_receipts::checked_profile_scalar_pairs(self.ir, owner, actual, self.db)?;
        }
        self.expression(base, NodeKey::of(source_base), depth + 1)?;
        Some(())
    }
    fn find_declared_field_ty(&self, field: &str) -> Option<&ResolvedType> {
        self.original
            .definition
            .fields
            .iter()
            .find(|item| item.name == *field)
            .map(|field| &field.ty)
            .or_else(|| {
                self.original
                    .definition
                    .contributed
                    .iter()
                    .find(|item| item.value.name == *field)
                    .map(|field| &field.ty)
            })
    }
    fn match_generic_member(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        source_base: &SyntaxNode,
        base: &TypedExpr,
        field: &str,
        depth: usize,
    ) -> Option<()> {
        let name = node
            .children
            .iter()
            .rev()
            .find(|child| child.kind == SyntaxKind::Name)?;
        if self
            .text
            .get(name.span.start as usize..name.span.end as usize)?
            != field
        {
            return None;
        }
        if super::model_policy_profile::required_model_rule_path(
            self.ir,
            self.original.model,
            actual,
        )
        .is_some()
        {
            self.expression(base, NodeKey::of(source_base), depth + 1)?;
            return Some(());
        }
        if !matches!(&base.expr, IrExpr::Name(name) if name == "row") {
            return None;
        }
        let declared = self.find_declared_field_ty(field)?;
        if &actual.ty != declared && declared.nullable_inner() != Some(&actual.ty) {
            return None;
        }
        self.expression(base, NodeKey::of(source_base), depth + 1)?;
        Some(())
    }
    fn match_binary(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        op: &IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        depth: usize,
    ) -> Option<()> {
        let [source_left, source_right] = children else {
            return None;
        };
        let operator = node
            .children
            .iter()
            .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?;
        if self
            .text
            .get(operator.span.start as usize..operator.span.end as usize)?
            != binary(*op)
        {
            return None;
        }
        self.expression(left, NodeKey::of(source_left), depth + 1)?;
        self.expression(right, NodeKey::of(source_right), depth + 1)?;
        let matched = match op {
            IrBinOp::Eq
            | IrBinOp::Ne
            | IrBinOp::Lt
            | IrBinOp::Le
            | IrBinOp::Gt
            | IrBinOp::Ge
            | IrBinOp::And
            | IrBinOp::Or
            | IrBinOp::In => actual.ty == ResolvedType::Scalar(Scalar::Bool),
            IrBinOp::Add => {
                // The checked concat result drops the literal's
                // nonempty refinement. Both actual source operands
                // still retain their sealed TextMessage identity.
                actual.ty == left.ty
                    || self.operands
                        && self
                            .transcript_source()
                            .and_then(|source| {
                                super::scenario_receipts::checked_scenario_query_influences(
                                    source,
                                )
                            })
                            .is_some_and(|influences| influences.len() == 24)
                        && matches!((&actual.ty, &left.ty, &right.ty), (
                            ResolvedType::Array { element, ordered: true, nonempty: false },
                            ResolvedType::Array { element: left_element, ordered: true, .. },
                            ResolvedType::Array { element: right_element, ordered: true, .. },
                        ) if element == left_element && element == right_element
                            && crate::analysis::types::checked_standard_nominal_name(element) == Some("TextMessage"))
            }
            IrBinOp::Mod | IrBinOp::Sub | IrBinOp::Mul | IrBinOp::Div => {
                actual.ty == left.ty
            }
            IrBinOp::Coalesce => false,
        };
        matched.then_some(())
    }
    fn match_unary(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        op: &IrUnOp,
        operand: &TypedExpr,
        depth: usize,
    ) -> Option<()> {
        let [child] = children else {
            return None;
        };
        let operator = node
            .children
            .iter()
            .find(|child| matches!(child.kind, SyntaxKind::Name | SyntaxKind::Punct))?;
        let word = match op {
            IrUnOp::Neg => "-",
            IrUnOp::Not => "not",
        };
        if self
            .text
            .get(operator.span.start as usize..operator.span.end as usize)?
            != word
        {
            return None;
        }
        self.expression(operand, NodeKey::of(child), depth + 1)?;
        let matched = match op {
            IrUnOp::Neg => actual.ty == operand.ty,
            IrUnOp::Not => actual.ty == ResolvedType::Scalar(Scalar::Bool),
        };
        matched.then_some(())
    }
    fn match_array(
        &self,
        actual: &TypedExpr,
        children: &[&SyntaxNode],
        values: &[TypedExpr],
        depth: usize,
    ) -> Option<()> {
        let ResolvedType::Array { element, .. } = &actual.ty else {
            return None;
        };
        if values.len() != children.len() || values.len() > 200 {
            return None;
        }
        for (value, child) in values.iter().zip(children) {
            if value.ty != **element {
                return None;
            }
            self.expression(value, NodeKey::of(child), depth + 1)?;
        }
        Some(())
    }
    fn match_object(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        entries: &[(String, TypedExpr)],
        depth: usize,
    ) -> Option<()> {
        match &actual.ty {
            ResolvedType::Object(_) => {}
            ResolvedType::Record { symbol, .. }
                if matches!(
                    self.ir.items.get(symbol.0 as usize)?.kind,
                    IrItemKind::Contract { .. }
                ) =>
            {
                nominal_identity(self.ir, self.create_owner()?, *symbol, self.db)?;
            }
            _ => return None,
        }
        let authored = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::ObjectEntry)
            .collect::<Vec<_>>();
        if entries.len() != authored.len() || entries.len() > 200 {
            return None;
        }
        let mut seen = HashSet::new();
        for ((name, value), entry) in entries.iter().zip(authored) {
            let key = entry
                .children
                .iter()
                .find(|child| child.kind == SyntaxKind::Name)?;
            if key.token()?.text(self.text) != name || !seen.insert(name) {
                return None;
            }
            let values = expressions(entry);
            let value_node = match values.as_slice() {
                [] => key,
                [value] => value,
                _ => return None,
            };
            self.expression(value, NodeKey::of(value_node), depth + 1)?;
        }
        Some(())
    }
    fn match_any_call(&self, actual: &TypedExpr, children: &[&SyntaxNode]) -> Option<()> {
        if source_path(children.first()?, self.text)? != "any" {
            return None;
        }
        let legacy = self.transcript_source().and_then(|source| {
            let owner = self.ir.items.get(source.scenario.0 as usize)?;
            super::scenario_receipts::checked_any_query_ir(
                self.ir, owner, actual, self.db,
            )?;
            Some(())
        });
        if legacy.is_none() {
            // Direct leading `require not any(...)` over the
            // composed any/first shape: no transcript source
            // exists, so the composition matcher supplies the
            // same exact guard/call/domain correspondence.
            let owner = self.create_owner()?;
            super::scenario_receipts::checked_any_first_query_ir(
                self.ir, owner, actual, self.db,
            )?;
        }
        Some(())
    }
    fn descend_first_argument_key(
        &self,
        mut source_argument: &SyntaxNode,
        domain_ty: &ResolvedType,
        depth: usize,
    ) -> Option<NodeKey> {
        for _ in depth..=64 {
            if self
                .original
                .expression_types
                .iter()
                .find(|(node, _)| *node == NodeKey::of(source_argument))
                .is_none_or(|(_, ty)| ty != domain_ty)
            {
                return None;
            }
            if source_argument.kind != SyntaxKind::Group {
                break;
            }
            let grouped = expressions(source_argument);
            let [inner] = grouped.as_slice() else {
                return None;
            };
            source_argument = inner;
        }
        Some(NodeKey::of(source_argument))
    }
    fn check_first_query_shape(
        &self,
        query: &crate::analysis::scenario_disclosure::DisclosureQuery,
        domain: &TypedExpr,
        source_key: NodeKey,
        actual: &TypedExpr,
        depth: usize,
    ) -> Option<()> {
        let IrExpr::Query(scan) = &domain.expr else {
            return None;
        };
        let alias = scan.source.as_ref()?.clauses.first()?;
        let crate::analysis::types::CheckedQueryClauseKind::As { name: alias_name } =
            &alias.kind
        else {
            return None;
        };
        if Some(alias.node) != query.alias {
            return None;
        }
        if let Some(order) = query.order.first()
            && source_path(self.nodes.get(&order.node)?, self.text)?
                != format!("{alias_name}.id")
        {
            return None;
        }
        // A contained domain spells its receiver (`p.C`); the bare
        // model name only fits unscoped scans. The receiver half is
        // already authenticated as the checked containing parent by
        // `checked_first_query_ir` above — reuse that correspondence
        // instead of re-resolving the parent here.
        let domain_path = source_path(self.nodes.get(&query.domain)?, self.text)?;
        let model_name = &self.ir.items.get(query.model.0 as usize)?.name;
        let contained_path = query
            .first
            .as_ref()
            .and_then(|first| first.contained_parent)
            .and_then(|(receiver, _)| source_path(self.nodes.get(&receiver)?, self.text))
            .map(|receiver| format!("{receiver}.{model_name}"));
        if source_key != query.node
            || (domain_path != *model_name
                && contained_path.as_deref() != Some(domain_path.as_str()))
        {
            return None;
        }
        if scan.value_order.is_some() {
            return None;
        }
        match (scan.where_pred.as_ref(), query.predicate) {
            (Some(predicate), Some(source)) => {
                SourceExpressions {
                    ir: self.ir,
                    db: self.db,
                    original: self.original,
                    owner: self.owner,
                    nodes: self.nodes,
                    text: self.text,
                    operands: self.operands,
                    membership_call: self.membership_call,
                    query_alias: Some((alias_name, &scan.where_param)),
                }
                .expression(predicate, source, depth + 1)?;
            }
            // The checked order-only first has no predicate or transported
            // input. Its domain and id order were joined above, so there is
            // no predicate expression for this constructor prefix to match.
            (None, None) if query.dependencies.is_empty() && query.inputs.is_empty() => {}
            _ => return None,
        }
        Some(())
    }
    fn match_first_call(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        args: &[TypedExpr],
        depth: usize,
    ) -> Option<()> {
        let query = super::scenario_receipts::checked_first_query_ir(
            self.ir,
            self.original,
            actual,
            key,
            self.db,
        )?;
        if source_path(children.first()?, self.text)? != "first" {
            return None;
        }
        let arguments: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        let [argument] = arguments.as_slice() else {
            return None;
        };
        let values = expressions(argument);
        let [source_argument] = values.as_slice() else {
            return None;
        };
        let [domain] = args else {
            return None;
        };
        if domain.span != source_argument.span {
            return None;
        }
        let source_key = self.descend_first_argument_key(source_argument, &domain.ty, depth)?;
        self.check_first_query_shape(query, domain, source_key, actual, depth)?;
        Some(())
    }
    fn match_starts_with(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        depth: usize,
    ) -> Option<()> {
        self.prefix_guard(actual, node, args, slots, depth)?;
        Some(())
    }
    fn match_scalar_builtin(
        &self,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        id: &str,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        depth: usize,
    ) -> Option<()> {
        // Settled pure scalar builtins consume their explicit operands
        // exactly as authored; correspondence is the callee name plus
        // each argument expression, in order.
        if let Some(slots) = slots
            && (slots.len() != args.len()
                || !slots
                    .iter()
                    .enumerate()
                    .all(|(index, slot)| *slot == Some(index)))
        {
            return None;
        }
        if source_path(children.first()?, self.text)? != id {
            return None;
        }
        let arguments: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        if arguments.len() != args.len() {
            return None;
        }
        for (argument, value) in arguments.iter().zip(args.iter()) {
            let values = expressions(argument);
            let [source_value] = values.as_slice() else {
                return None;
            };
            self.expression(value, NodeKey::of(source_value), depth + 1)?;
        }
        Some(())
    }
    fn match_authorization_call(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        depth: usize,
    ) -> Option<()> {
        if self
            .query_authorization(actual, NodeKey::of(node), depth)
            .is_none()
            && self
                .authorization(actual, NodeKey::of(node), depth)
                .is_none()
        {
            if self.authorization_shaped(actual) {
                return None;
            }
            self.derive_call(actual, node, depth)?;
        }
        Some(())
    }
    fn match_count_call(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        args: &[TypedExpr],
        id: &str,
        depth: usize,
    ) -> Option<()> {
        if matches!(args, [domain] if matches!(domain.expr, IrExpr::Query(_))) {
            super::scenario_receipts::checked_count_query_ir(
                self.ir,
                self.original,
                actual,
                key,
                self.db,
            )?;
            return Some(());
        }
        let head = children.first()?;
        if source_path(head, self.text)? != id || args.len() != 1 {
            return None;
        }
        let arguments: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        let [argument] = arguments.as_slice() else {
            return None;
        };
        let values = expressions(argument);
        let [value] = values.as_slice() else {
            return None;
        };
        self.expression(&args[0], NodeKey::of(value), depth + 1)?;
        Some(())
    }
    fn match_count_bound(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        args: &[TypedExpr],
        slots: &[Option<usize>],
        depth: usize,
    ) -> Option<()> {
        if let [argument] = args
            && !matches!(argument.expr, IrExpr::Query(_))
            && slots == [Some(0)].as_slice()
        {
            if source_path(children.first()?, self.text)? != "count" {
                return None;
            }
            let argument_node = node
                .children
                .iter()
                .find(|node| node.kind == SyntaxKind::Argument)?;
            let values = expressions(argument_node);
            let [value] = values.as_slice() else {
                return None;
            };
            self.expression(argument, NodeKey::of(value), depth + 1)?;
            return Some(());
        }
        super::scenario_receipts::checked_count_query_ir(
            self.ir,
            self.original,
            actual,
            key,
            self.db,
        )?;
        Some(())
    }
    fn match_text_name_ref(&self, node: &SyntaxNode, value: &str, actual: &TypedExpr) -> bool {
        let Some(spelling) = single_name(node, self.text) else {
            return false;
        };
        spelling == value
            && matches!(&actual.ty, ResolvedType::Enum {cases, ..} if cases.iter().any(|case| case == value))
    }
    fn match_row_name(&self, node: &SyntaxNode, name: &String, actual: &TypedExpr) -> bool {
        let Some(spelling) = single_name(node, self.text) else {
            return false;
        };
        spelling == name
            && (actual.ty == ResolvedType::Unknown
                || actual.ty
                    == (ResolvedType::Record {
                        symbol: self.original.model,
                        stored: true,
                    }))
    }
    fn match_expression_compound(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        depth: usize,
    ) -> Option<bool> {
        match (&actual.expr, node.kind) {
            (IrExpr::Int(_) | IrExpr::Decimal(_) | IrExpr::Bool(_) | IrExpr::Null
                | IrExpr::Text(_), SyntaxKind::Literal) => {
                Some(self.scalar_literal(actual, node)?)
            }
            (IrExpr::Message(_), SyntaxKind::MessageValue) if self.operands => {
                self.literal_message(actual, node)?;
                Some(true)
            }
            (IrExpr::Format { .. }, SyntaxKind::Call) if self.operands => {
                self.literal_format(actual, node, depth)?;
                Some(true)
            }
            (IrExpr::Query(_), SyntaxKind::Query) if self.operands => {
                self.inline_selection_query(actual, NodeKey::of(node), depth)
                    .or_else(|| self.transcript_query(actual, NodeKey::of(node), depth))?;
                Some(true)
            }
            (IrExpr::Text(value), SyntaxKind::Member) => {
                Some(self.match_enum_member(node, value, actual))
            }
            (IrExpr::DurationMs(value), SyntaxKind::Literal) => {
                Some(self.match_duration(node, value, actual))
            }
            _ => return self.match_member_shape(actual, node, children, key, depth),
        }
    }
    fn match_member_shape(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        depth: usize,
    ) -> Option<bool> {
        match (&actual.expr, node.kind) {
            (IrExpr::Member { base, field }, SyntaxKind::Member)
                if self.operands
                    && matches!(
                        (field.as_str(), &actual.ty),
                        ("email", ResolvedType::Scalar(Scalar::Email))
                            | ("email_verified", ResolvedType::Scalar(Scalar::Bool),)
                    )
                    && matches!(
                        &base.expr,
                        IrExpr::Member {
                            base: facts_base,
                            field: facts
                        } if facts == "actorFacts"
                            && matches!(&facts_base.expr, IrExpr::Name(context) if context == "c")
                    ) =>
            {
                let [source_base] = children else {
                    return None;
                };
                self.match_actor_facts_member(actual, node, source_base, field, base)?;
                Some(true)
            }
            (IrExpr::Member { base, field }, SyntaxKind::Member) if self.operands => {
                let [source_base] = children else {
                    return None;
                };
                self.match_profile_member(actual, node, source_base, base, field, depth)?;
                Some(true)
            }
            (IrExpr::Member { base, field }, SyntaxKind::Member) => {
                let [source_base] = children else {
                    return None;
                };
                self.match_generic_member(actual, node, source_base, base, field, depth)?;
                Some(true)
            }
            _ => self.match_data_shape(actual, node, children, key, depth),
        }
    }
    fn match_data_shape(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        depth: usize,
    ) -> Option<bool> {
        match (&actual.expr, node.kind) {
            (IrExpr::Binary { op, left, right }, SyntaxKind::Binary) => {
                self.match_binary(actual, node, children, op, left, right, depth)?;
                Some(true)
            }
            (IrExpr::Unary { op, operand }, SyntaxKind::Unary) => {
                self.match_unary(actual, node, children, op, operand, depth)?;
                Some(true)
            }
            (IrExpr::Array(values), SyntaxKind::Array) => {
                self.match_array(actual, children, values, depth)?;
                Some(true)
            }
            (IrExpr::Object(entries), SyntaxKind::Object) if self.operands => {
                self.match_object(actual, node, entries, depth)?;
                Some(true)
            }
            (IrExpr::Object(entries), SyntaxKind::Construct) if self.operands => {
                self.text_constructor(actual, node, entries, depth)?;
                Some(true)
            }
            _ => self.match_expression_call(actual, node, children, key, depth),
        }
    }
    fn match_expression_call(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        depth: usize,
    ) -> Option<bool> {
        match (&actual.expr, node.kind) {
            (
                IrExpr::Call {
                    target: IrCallTarget::DeriveFn(_),
                    ..
                }
                | IrExpr::BoundCall {
                    target: IrCallTarget::DeriveFn(_),
                    ..
                },
                SyntaxKind::Call,
            ) if self.operands
                && crate::analysis::types::checked_standard_nominal_name(match &actual.ty {
                    ResolvedType::Array { element, .. } => element,
                    ty => ty,
                }) == Some("TextMessage") =>
            {
                self.transcript_call(actual, NodeKey::of(node), depth)?;
                Some(true)
            }
            (IrExpr::Call { target, args }, SyntaxKind::Call) if self.operands => {
                self.match_call_by_target(actual, node, children, key, depth, target, args, None)
            }
            (
                IrExpr::BoundCall {
                    target,
                    args,
                    slots,
                },
                SyntaxKind::Call,
            ) if self.operands => {
                self.match_call_by_target(
                    actual,
                    node,
                    children,
                    key,
                    depth,
                    target,
                    args,
                    Some(slots),
                )
            }
            _ => Some(false),
        }
    }
    fn match_call_by_target(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        depth: usize,
        target: &IrCallTarget,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
    ) -> Option<bool> {
        match target {
            IrCallTarget::Builtin { id, awaited: false } => {
                self.match_plain_builtin_call(actual, node, children, key, depth, id, args, slots)
            }
            IrCallTarget::Builtin { id, awaited: true }
                if id == "active_member"
                    && actual.ty == ResolvedType::Scalar(Scalar::Bool) =>
            {
                self.membership(actual, node, args, slots, depth)?;
                Some(true)
            }
            IrCallTarget::DeriveFn(_)
                if actual.ty == ResolvedType::Scalar(Scalar::Bool) =>
            {
                self.match_authorization_call(actual, node, depth)?;
                Some(true)
            }
            IrCallTarget::DeriveFn(_) => {
                self.derive_call(actual, node, depth)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn match_plain_builtin_call(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        depth: usize,
        id: &str,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
    ) -> Option<bool> {
        match id {
            "any" => {
                self.match_any_call(actual, children)?;
                Some(true)
            }
            "first" if slots.is_none() => {
                self.match_first_call(actual, node, children, key, args, depth)?;
                Some(true)
            }
            "starts_with" => {
                self.match_starts_with(actual, node, args, slots, depth)?;
                Some(true)
            }
            "date" | "datetime" | "money" | "abs" | "round" | "min" | "max" => {
                self.match_scalar_builtin(node, children, id, args, slots, depth)?;
                Some(true)
            }
            _ => self.match_tail_builtin_call(
                actual, node, children, key, depth, id, args, slots,
            ),
        }
    }
    fn match_tail_builtin_call(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        children: &[&SyntaxNode],
        key: NodeKey,
        depth: usize,
        id: &str,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
    ) -> Option<bool> {
        match id {
            "trim"
                if slots.is_none_or(|slots| {
                    slots.len() == args.len()
                        && slots
                            .iter()
                            .enumerate()
                            .all(|(index, slot)| *slot == Some(index))
                }) =>
            {
                self.match_scalar_builtin(node, children, id, args, slots, depth)?;
                Some(true)
            }
            "trim" if actual.ty == ResolvedType::Scalar(Scalar::Text) => {
                self.trim_guard(actual, node, args, slots, depth)?;
                Some(true)
            }
            "count" if actual.ty == ResolvedType::Scalar(Scalar::Int) => match slots {
                None => {
                    self.match_count_call(actual, node, children, key, args, id, depth)?;
                    Some(true)
                }
                Some(slots) => {
                    self.match_count_bound(actual, node, children, key, args, slots, depth)?;
                    Some(true)
                }
            },
            _ => Some(false),
        }
    }

    fn expression(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let mut node = *self.nodes.get(&key)?;
        if self.operands && !self.operand_type_matches(actual, key) {
            return None;
        }
        let mut groups = 0usize;
        while node.kind == SyntaxKind::Group {
            groups += 1;
            if depth + groups > 64 {
                return None;
            }
            let children = expressions(node);
            let [child] = children.as_slice() else {
                return None;
            };
            if self.operands && !self.operand_type_matches(actual, NodeKey::of(child)) {
                return None;
            }
            node = child;
        }
        // Group lowering retains the inner expression's source span. Every
        // original wrapper and its inner node still have the same checked type.
        if actual.span != node.span {
            return None;
        }
        let children = expressions(node);
        let matched = match (&actual.expr, node.kind) {
            (IrExpr::Text(value), SyntaxKind::NameRef) => {
                self.match_text_name_ref(node, value, actual)
            }
            (IrExpr::Name(name), SyntaxKind::NameRef) if name == "row" && !self.operands => {
                self.match_row_name(node, name, actual)
            }
            (IrExpr::Name(name), SyntaxKind::NameRef | SyntaxKind::Name) if self.operands => {
                self.match_operand_name(node, name)
            }
            (IrExpr::Member { base, field }, SyntaxKind::NameRef | SyntaxKind::Name)
                if self.operands =>
            {
                self.match_actor_member(node, base, field, actual)
            }
            _ => self.match_expression_compound(actual, node, &children, key, depth)?,
        };
        matched.then_some(())
    }
}

fn expressions(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|child| {
            matches!(
                child.kind,
                SyntaxKind::Literal
                    | SyntaxKind::MessageValue
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

fn source_path(node: &SyntaxNode, text: &str) -> Option<String> {
    match node.kind {
        SyntaxKind::Name | SyntaxKind::NameRef => Some(single_name(node, text)?.into()),
        SyntaxKind::Member => {
            let parts = expressions(node);
            let [base] = parts.as_slice() else {
                return None;
            };
            let field = node
                .children
                .iter()
                .rev()
                .find(|child| child.kind == SyntaxKind::Name)?;
            Some(format!(
                "{}.{}",
                source_path(base, text)?,
                text.get(field.span.start as usize..field.span.end as usize)?
            ))
        }
        _ => None,
    }
}

fn single_name<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        return Some(node.token()?.text(text));
    }
    let parts: Vec<_> = node
        .children
        .iter()
        .filter(|part| !matches!(part.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect();
    let [name] = parts.as_slice() else {
        return None;
    };
    (name.kind == SyntaxKind::Name)
        .then(|| name.token().map(|token| token.text(text)))
        .flatten()
}

fn binary(op: IrBinOp) -> &'static str {
    match op {
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
    }
}

fn duration(text: &str) -> Option<i128> {
    for (unit, factor) in [
        ("ms", 1),
        ("s", 1_000),
        ("m", 60_000),
        ("h", 3_600_000),
        ("d", 86_400_000),
    ] {
        if let Some(digits) = text
            .strip_suffix(unit)
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return digits.parse::<i128>().ok()?.checked_mul(factor);
        }
    }
    None
}

