//! Nongrant correspondence for the original schema of a scenario-created row.
//! Defaults stay in the owning model descriptor; this join never evaluates them.
use std::collections::{HashMap, HashSet};

use crate::analysis::NodeKey;
use crate::analysis::resolve::{ModelOwner, ModuleKind};
use crate::analysis::scenario_disclosure::{
    CheckedScenarioCreate, DisclosureSource, ScenarioDisclosure,
};
use crate::analysis::types::{ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrExpr, IrItem, IrItemKind, IrModelRuleKind, IrOwner,
    IrProgram, IrServer, IrStmt, IrType, IrUnOp, TypedExpr, ir_model_rule_prefix,
};
use super::js::{Emitter, JsModel, js_field_default, literal_json};

pub(super) fn checked_created_schema(
    ir: &IrProgram,
    owner: &IrItem,
    models: &[JsModel],
    original: &CheckedScenarioCreate,
    db: &SourceDb,
) -> Option<()> {
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
                // The original mixed ask returns an oversized conservative
                // source inventory. Its mandatory private feasibility proof
                // compares the entire member declaration/body to fresh IR.
                // A derived member remains outside stored Create inputs.
                let ScenarioDisclosure::Complete(checked) =
                    ir.scenario_disclosures.get(&owner.id)?
                else {
                    return None;
                };
                let facts = checked.source_facts.as_deref()?;
                if checked.returns.len() <= 200
                    || super::scenario_receipts::checked_scenario_query_influences(facts)?.len()
                        != 24
                {
                    return None;
                }
                let schema = facts
                    .stored_contracts
                    .as_deref()?
                    .iter()
                    .find(|schema| schema.model && schema.id == model.id)?;
                super::scenario_receipts::match_stored_contract_schema(ir, schema, db)?;
                if member.canonical != format!("{}.{}", model.canonical, member.name) {
                    return None;
                }
            }
            _ => return None,
        }
    }
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
        || authored_fields.len() != definition.fields.len()
        || !authored_fields
            .iter()
            .copied()
            .eq(declaration.fields.iter().map(|field| field.field))
        || !authored_fields
            .iter()
            .copied()
            .eq(definition.fields.iter().map(|field| field.field))
        || original.source != definition.source
    {
        return None;
    }
    source(ir, &definition.source, model.span, db)?;
    source(ir, &definition.source, span(declaration.node), db)?;
    let (tree, diagnostics) = crate::syntax::parse(db, declaration.node.file);
    if !diagnostics.is_empty() {
        return None;
    }
    let text = &db.get(declaration.node.file)?.text;
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
    let matcher = SourceExpressions {
        ir,
        db,
        original,
        nodes: &nodes,
        text,
        operands: false,
        membership_call: None,
        query_alias: None,
    };
    for (data, original_field) in declaration.fields.iter().zip(&definition.fields) {
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
        if field.id != original_field.field
            || *field_owner != model.id
            || field.module != model.module
            || field.name != original_field.name
            || field.canonical != original_field.canonical
            || ty != &original_field.ty
            || *required_array != data.required_array
            || description != &data.description
            || ir.value_constraints.get(&field.id) != original_field.constraints.as_ref()
            || original_field.source != definition.source
            || text.get(field.span.start as usize..field.span.end as usize)
                != Some(field.name.as_str())
            || field.span.file != data.node.file
            || field.span.start < data.node.start
            || field.span.end > data.node.end
        {
            return None;
        }
        source(ir, &original_field.source, field.span, db)?;
        source(ir, &original_field.source, span(data.node), db)?;
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
        match (default, data.default) {
            (None, None)
                if original_field.modifier_sources.first().is_none_or(
                    |(_, _, _, _, values)| values.iter().all(|value| value.default.is_none()),
                ) => {}
            (Some(IrDefault::Literal(actual)), None) => {
                let value = original_field
                    .modifier_sources
                    .first()?
                    .4
                    .iter()
                    .find_map(|value| value.default.as_deref())?;
                let expected = super::ir::given_constant_expr(value, ty, field.span);
                if actual.ty != expected.ty
                    || actual.span != expected.span
                    || literal_json(actual)? != literal_json(&expected)?
                    || js_field_default(default.as_ref(), None).is_none()
                {
                    return None;
                }
            }
            (Some(IrDefault::Literal(actual)), Some(node)) => {
                matcher.expression(actual, node, 0)?;
                if literal_json(actual).is_none()
                    || js_field_default(default.as_ref(), None).is_none()
                {
                    return None;
                }
                if actual.ty != *ty
                    && ty.nullable_inner() != Some(&actual.ty)
                    && !(actual.ty == ResolvedType::Null && ty.nullable_inner().is_some())
                {
                    return None;
                }
            }
            (
                Some(
                    default @ IrDefault::Computed {
                        expr,
                        has_parent: false,
                    },
                ),
                Some(node),
            ) if matches!(
                js_field_default(Some(default), None),
                Some(super::js::JsFieldDefault::ContextActor)
            ) && matcher.word(node)? == "actor"
                && expr.span == span(node)
                && (*ty == ResolvedType::Scalar(Scalar::User)
                    || ty.nullable_inner() == Some(&ResolvedType::Scalar(Scalar::User))) => {}
            // Other computed defaults require their own checked native join.
            _ => return None,
        }
        match (server, data.server) {
            (None, None) => {}
            (Some(IrServer::Actor), Some(node))
                if matcher.word(node)? == "actor" && *ty == ResolvedType::Scalar(Scalar::User) => {}
            (Some(IrServer::Now), Some(node))
                if matcher.word(node)? == "now"
                    && *ty == ResolvedType::Scalar(Scalar::Datetime) => {}
            _ => return None,
        }
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
        if original_field
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
    }
    for original_field in &definition.contributed {
        checked_contributed_field(ir, model, original_field, db)?;
    }
    let prefix = ir_model_rule_prefix(ir, model);
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
        matcher.expression(&actual.pred, original_rule.predicate?, 0)?;
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
    }
    for (index, (original_rule, actual)) in declaration.uniques.iter().zip(uniques).enumerate() {
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
    }
    let retention: Vec<_> = ir
        .retention
        .iter()
        .filter(|rule| rule.name == prefix)
        .collect();
    match (declaration.retains.as_slice(), retain, retention.as_slice()) {
        ([], None, []) => {}
        ([original_rule], Some(actual), [rule])
            if actual.span == span(original_rule.node) && rule.span == actual.span =>
        {
            matcher.expression(&actual.until, original_rule.until?, 0)?;
            matcher.expression(&rule.body, original_rule.until?, 0)?;
        }
        _ => return None,
    }
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

fn span(node: NodeKey) -> Span {
    Span::new(node.file, node.start, node.end)
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
    let declaration_name = declaration
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .nth(1)?;
    if declaration_name.token()?.text(text) != module.name || module.kind != declaration_kind {
        return None;
    }
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
    let candidates: Vec<_> = module
        .imports
        .iter()
        .filter(|import| import.provider == *provider && import.from.is_none())
        .flat_map(|import| import.members.iter().map(move |member| (import, member)))
        .filter(|(_, (name, alias, _))| *name == item.name && alias == spelling)
        .collect();
    let [(import, (_, _, member_span))] = candidates.as_slice() else {
        return None;
    };
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
        .find(|node| node.kind == SyntaxKind::Import && node.span == import.span)?;
    if text.get(import.provider_span.start as usize..import.provider_span.end as usize)
        != Some(provider.as_str())
        || source_import.children.iter().any(|node| {
            node.kind == SyntaxKind::Attribute
                && node
                    .children
                    .iter()
                    .find(|child| child.kind == SyntaxKind::Name)
                    .is_some_and(|name| {
                        name.token().is_some_and(|token| token.text(text) == "from")
                    })
        })
    {
        return None;
    }
    let path = source_import
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Path)?;
    let provider_name = path
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    if provider_name.span != import.provider_span {
        return None;
    }
    let member = source_import
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::ImportMember && node.span == *member_span)?;
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
    (original_name == item.name && original_alias == spelling).then_some(())
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
fn checked_field_trait_modifiers(
    ir: &IrProgram,
    original: &CheckedScenarioCreate,
    field: &crate::analysis::scenario_disclosure::CheckedScenarioCreatedField,
    actual: &super::ir::IrModifiers,
    db: &SourceDb,
) -> Option<()> {
    fn bound(
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
        fn literal(
            matcher: &SourceExpressions<'_>,
            node: &SyntaxNode,
            ty: &ResolvedType,
        ) -> Option<TypedExpr> {
            let value = match node.kind {
                SyntaxKind::Group => return literal(matcher, expressions(node).first()?, ty),
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
                        operand: Box::new(literal(matcher, expressions(node).first()?, ty)?),
                    }
                }
                _ => return None,
            };
            Some(TypedExpr::new(value, ty.clone(), node.span))
        }
        let value = literal(matcher, matcher.nodes.get(&node)?, ty)?;
        matcher.expression(&value, node, 0)?;
        Some(value)
    }
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
        let matcher = SourceExpressions {
            ir,
            db,
            original,
            nodes: &nodes,
            text,
            operands: false,
            membership_call: None,
            query_alias: None,
        };
        if let Some(target) = reuse {
            let target = ir.items.get(target.0 as usize)?;
            let IrItemKind::Field {
                owner: target_owner,
                ..
            } = target.kind
            else {
                return None;
            };
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
            nominal_identity(ir, scenario, target_owner, db)?;
            reference_name(ir, owner, target_owner, provider, db)?;
        }
        let bound_ty = super::ir::given_bound_type(ty);
        for modifier in &data.modifiers {
            match (modifier.name.as_str(), modifier.value) {
                ("trim", None) => expected.trim = true,
                ("min" | "max", Some(node)) => {
                    let minimum = modifier.name == "min";
                    let candidates = if minimum {
                        [actual.min.as_ref(), modifiers.min.as_ref()]
                    } else {
                        [actual.max.as_ref(), modifiers.max.as_ref()]
                    };
                    let value = bound(&matcher, node, &bound_ty, &candidates)?;
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
                }
                ("unique" | "machine", None) => {}
                _ => return None,
            }
        }
        if given.iter().any(|value| value.name != item.name) {
            return None;
        }
        super::ir::apply_given_field_constraints_to(&mut expected, &bound_ty, item.span, given);
    }
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

/// Match the same original Given field for construction and stored disclosure.
/// Its span names the checked attachment, never an invented Field syntax node.
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
    source(ir, &original_field.source, field.span, db)?;
    let value = expected.default.as_deref()?;
    let IrDefault::Literal(actual) = default.as_ref()? else {
        return None;
    };
    let expected_default = super::ir::given_constant_expr(value, ty, field.span);
    if actual.ty != expected_default.ty
        || actual.span != field.span
        || literal_json(actual)? != literal_json(&expected_default)?
    {
        return None;
    }
    let bound_type = super::ir::given_bound_type(ty);
    for (actual, expected) in [
        (&modifiers.min, &expected.min),
        (&modifiers.max, &expected.max),
    ] {
        match (actual, expected) {
            (None, None) => {}
            (Some(actual), Some(expected)) => {
                let expected = super::ir::given_constant_expr(expected, &bound_type, field.span);
                if actual.ty != expected.ty
                    || actual.span != field.span
                    || literal_json(actual)? != literal_json(&expected)?
                {
                    return None;
                }
            }
            _ => return None,
        }
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

impl SourceExpressions<'_> {
    fn prefix_statement(&self, actual: &IrStmt, node: &SyntaxNode, depth: usize) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let values = expressions(node);
        match actual {
            IrStmt::Require { cond, span }
                if node.kind == SyntaxKind::Require && node.span == *span =>
            {
                let [value] = values.as_slice() else {
                    return None;
                };
                if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
                    return None;
                }
                self.expression(cond, NodeKey::of(value), depth + 1)
            }
            IrStmt::Return { value, span }
                if node.kind == SyntaxKind::Return && node.span == *span =>
            {
                match (value, values.as_slice()) {
                    (Some(value), [authored]) => {
                        self.expression(value, NodeKey::of(authored), depth + 1)
                    }
                    (None, []) => Some(()),
                    _ => None,
                }
            }
            IrStmt::If {
                cond,
                then_branch,
                else_branch,
                span,
            } if node.kind == SyntaxKind::If && node.span == *span => {
                let [condition] = values.as_slice() else {
                    return None;
                };
                if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
                    return None;
                }
                self.expression(cond, NodeKey::of(condition), depth + 1)?;
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
        if !matches!(target, IrCallTarget::DeriveFn(name) if name == &callee.canonical)
            || params.as_slice() != [fact.formal]
            || result != &fact.ty
            || actual.ty != fact.ty
            || body.span != span(fact.body)
            || body.ty != fact.ty
            || !matches!(&argument.expr, IrExpr::Name(name) if name == &parameter.name)
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
        self.expression(argument, fact.argument, depth + 1)?;
        self.expression(body, fact.body, depth + 1)
    }

    /// Match the original inline, WHERE-bound standard message selection.
    /// The source query has no local Contract identity or helper invocation.
    fn inline_selection_query(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
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
            || query.order.len() != 1
            || query.order[0].field != "position"
            || query.order[0].descending
            || fact.query.first.is_some()
            || fact.query.count.is_some()
            || fact.query.projection.is_some()
        {
            return None;
        }
        self.expression(parent, fact.parent.node, depth + 1)?;
        // Ordinary query predicates lower their authored alias to `row`; the
        // select expression keeps `prior`. Authenticate that existing rewrite
        // at this exact checked predicate instead of changing source or IR.
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
        self.expression(right, NodeKey::of(original_right), depth + 1)?;
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
        if actual.ty != fact.ty
            || query.source.as_deref() != Some(&fact.query)
            || !matches!(&query.domain, super::ir::IrQueryDomain::Model(name) if name == &model.canonical)
            || !matches!(&parent.expr, IrExpr::Name(name) if name == &formal.name)
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
        let ResolvedType::StdNominal { fields, .. } = &actual.ty else {
            return None;
        };
        if modules.next().is_some()
            || module.id.0 as usize >= self.ir.modules.len()
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
            || fields.len() != entries.len()
            || entries.len() > 200
        {
            return None;
        }
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

    fn authenticated_derive_inner(
        &self,
        target: &str,
        depth: usize,
        seen: &mut std::collections::HashSet<String>,
    ) -> Option<bool> {
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
        }
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
            &formal_types,
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

    /// Authenticate the existing stored-query/collection producer without
    /// admitting its execution. The query and its external predicate share one
    /// original alias scope; ordinary derive fallback must keep this sealed.
    #[allow(clippy::too_many_arguments)]
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
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
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
        let IrExpr::Lambda { param, body } = &predicate.expr else {
            return None;
        };
        let retained_predicate = call.predicate.as_ref()?;
        let model = self.ir.items.get(call.model.0 as usize)?;
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
            || alias_words.as_slice() != ["as", name.as_str()]
            || !matches!(model.kind, IrItemKind::Model { .. })
            || !matches!(&query.domain, super::ir::IrQueryDomain::Model(canonical) if canonical == &model.canonical)
            || domain.ty != array
            || checked.domain_type != array
            || checked.result != array
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
            || domain.span != domain_node.span
            || predicate.span != predicate_node.span
            || predicate.ty != boolean
            || body.ty != boolean
            || body.span != ungrouped_predicate.span
            || retained_predicate.node != NodeKey::of(predicate_node)
            || retained_predicate.ty != boolean
            || param != name
        {
            return None;
        }
        reference_name(
            self.ir,
            owner,
            model.id,
            &source_path(authored_domain, text)?,
            self.db,
        )?;
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
            || original.arguments != vec![(checked.node, array), (retained_predicate.node, boolean)]
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
            (IrExpr::Name(name), SyntaxKind::NameRef) | (IrExpr::Name(name), SyntaxKind::Name) => {
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
            }
            (IrExpr::Member { base, field }, SyntaxKind::NameRef)
                if expr.ty == ResolvedType::Team
                    && field == "team"
                    && matches!(&base.expr, IrExpr::Name(name) if name == "c")
                    && single_name(node, text)? == "team"
                    && !formals.iter().any(|(name, _)| name == "team") => {}
            (IrExpr::Member { base, field }, SyntaxKind::Member) => {
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
                )?;
            }
            (IrExpr::Binary { op, left, right }, SyntaxKind::Binary) => {
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
                )?;
            }
            (IrExpr::Unary { op, operand }, SyntaxKind::Unary) => {
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
                )?;
            }
            (
                IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. },
                SyntaxKind::Call,
            ) => {
                if let IrExpr::BoundCall { slots, .. } = &expr.expr
                    && (slots.len() != args.len()
                        || slots
                            .iter()
                            .enumerate()
                            .any(|(index, slot)| *slot != Some(index)))
                {
                    return None;
                }
                let callee = source_path(expressions(node).first()?, text)?;
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
            }
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
        let IrExpr::Name(name) = &root.expr else {
            return None;
        };
        if edges == 0 {
            return None;
        }
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
        let (binding_index, initializer, binding_span) = bindings.next()?;
        if bindings.next().is_some() {
            return None;
        }
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
    fn query_authorization(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        use crate::analysis::scenario_disclosure::{
            CheckedDecisionCallTarget, CheckedDecisionStage, DependencyRole,
        };
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
        let IrItemKind::Scenario {
            guards, effects, ..
        } = &owner.kind
        else {
            return None;
        };
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
        let [Some(person_slot), Some(location_slot)] = slots.as_slice() else {
            return None;
        };
        if person_slot == location_slot
            || args.len() != 2
            || outer.arguments.len() != 2
            || sites.next().is_some()
            || calls.next().is_some()
            || outer.module != owner.module
            || outer.source != facts.source
            || outer.slots != slots
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
            || args.get(*person_slot)?.ty != ResolvedType::Scalar(Scalar::User)
            || &args.get(*location_slot)?.ty != location_type
            || !matches!(&args[*person_slot].expr, IrExpr::Member { base, field } if field == "actor" && matches!(&base.expr, IrExpr::Name(name) if name == "c"))
            || self.authenticated_derive(target, 0, &mut HashSet::new()) != Some(true)
        {
            return None;
        }
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
        self.query_require_call(require?, source_cond, key, depth + 1)?;
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
                        &args[*location_slot],
                        Some(self.db),
                    )?;
                if actual_parameter != *parameter || *argument != outer.arguments[*location_slot].0
                {
                    return None;
                }
            }
            [] if site.stage == CheckedDecisionStage::BodyRequire => {
                self.query_required_argument(
                    owner,
                    &args[*location_slot],
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
        for (value, (node, ty)) in args.iter().zip(&outer.arguments) {
            if value.ty != *ty {
                return None;
            }
            self.expression(value, *node, depth + 1)?;
        }
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
        source(self.ir, &query.source, body.span, self.db)?;
        let mut fields = Vec::new();
        let mut pending = vec![predicate_body.as_ref()];
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
                }
                IrExpr::Name(_) | IrExpr::Bool(_) => {}
                _ => return None,
            }
            if fields.len() > 200 || pending.len() > 16384 {
                return None;
            }
        }
        if fields.len() != query.dependencies.len() {
            return None;
        }
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
                || read.id != identity("query-control", &query.source, read.node, &id)
            {
                return None;
            }
        }
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
                    || influence.query_id.as_ref() != Some(&id)
                    || influence.id
                        != identity(
                            "query-influence",
                            &query.source,
                            query.node,
                            &format!("{id}:{kind:?}"),
                        )
            })
        {
            return None;
        }
        let first = query.dependencies.first()?;
        let mut eager = predicate_body.as_ref();
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

    fn authorization(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        use crate::analysis::scenario_disclosure::{
            CheckedDecisionCallTarget, CheckedDecisionStage,
        };
        if self.membership_call.is_some() {
            return None;
        }
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
        if self.authenticated_derive(target, 0, &mut HashSet::new()) != Some(true) {
            return None;
        }
        let [actor, parent] = args else {
            return None;
        };
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
        let mut sites = facts.decision_sites.as_deref()?.iter().filter(|site| {
            site.owner == owner.id
                && site.stage == CheckedDecisionStage::LeadingRequire
                && site.source == self.original.source
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
        let IrItemKind::Scenario { guards, .. } = &owner.kind else {
            return None;
        };
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
        // A separate source owns imported formals/body. Keep the caller nodes
        // for real argument occurrences and parse the defining file when needed.
        let defining_tree = if defining.file != self.original.node.file {
            let (tree, diagnostics) = crate::syntax::parse(self.db, defining.file);
            if !diagnostics.is_empty() {
                return None;
            }
            Some(tree)
        } else {
            None
        };
        let mut defining_nodes: HashMap<_, _> =
            self.nodes.iter().map(|(key, node)| (*key, *node)).collect();
        if let Some(tree) = &defining_tree {
            let mut pending = vec![tree];
            while let Some(node) = pending.pop() {
                defining_nodes.insert(NodeKey::of(node), node);
                pending.extend(node.children.iter());
            }
        }
        if sites.next().is_some() || outer_calls.next().is_some()
            || !guards.iter().any(|statement|
                matches!(statement, super::ir::IrStmt::Require {span:at, ..} if *at == span(site.statement)))
            || item.id != derive || item.canonical != *target
            || outer.module != owner.module
            || outer.source != self.original.source || !outer.defaults.is_empty()
            || outer.slots.as_slice() != [Some(0),Some(1)]
            || slots.is_some_and(|slots| slots != outer.slots.as_slice())
            || outer.arguments.len() != 2 || params.len() != 2
            || *result != ResolvedType::Scalar(Scalar::Bool)
            || actual.ty != *result || body.ty != *result
        { return None; }
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
        let conversation = if imported {
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
            let argument = self.nodes.get(&outer.arguments[1].0)?;
            if parameters.next().is_some()
                || *parameter_owner != owner.id
                || *index != position
                || caller_params.get(position) != Some(&parameter.id)
                || parameter.module != owner.module
                || parameter.canonical != format!("{}.{}", owner.canonical, binding)
                || parameter_fact.parameter != parameter.id
                || parameter_fact.ty != expected
                || declared != &expected
                || NodeKey::of(authored_type) != parameter_fact.type_node
                || parameter_fact.default != Some(*default)
                || parameter_fact.constraints.is_some()
                || authored.kind != SyntaxKind::Parameter
                || parameter.span != authored_name.span
                || authored_name.token()?.text(self.text) != binding
                || argument.kind != SyntaxKind::NameRef
                || single_name(argument, self.text)? != binding
                || parent.span != argument.span
                || parent.ty != outer.arguments[1].1
                || literal.ty != ResolvedType::Null
                || !matches!(literal.expr, IrExpr::Null)
            {
                return None;
            }
            self.expression(literal, *default, depth + 1)?;
            let mut schemas = facts
                .stored_contracts
                .as_deref()?
                .iter()
                .filter(|schema| schema.model && schema.id == *model);
            let conversation = schemas.next()?;
            let model_item = self.ir.items.get(model.0 as usize)?;
            if schemas.next().is_some()
                || conversation.module != item.module
                || conversation.source != defining_source
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
                *model,
                single_name(type_path, self.text)?,
                self.db,
            )?;
            super::scenario_receipts::match_stored_contract_schema(self.ir, conversation, self.db)?;
            conversation
        } else {
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
            conversation
        };
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
                || field.source != defining_source
                || !conversation.field_order.contains(&field.id)
            {
                return None;
            }
            super::scenario_receipts::match_stored_contract_field(self.ir, field, self.db)?;
        }
        if !matches!(&actor.expr,IrExpr::Member {base,field}
            if field == "actor" && matches!(&base.expr,IrExpr::Name(name) if name == "c"))
        {
            return None;
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
        let authored_params: Vec<_> = declaration
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::Parameter)
            .collect();
        if authored_params.len() != 2 {
            return None;
        }
        for (index, (parameter, authored)) in params.iter().zip(&authored_params).enumerate() {
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
        }
        let mut membership_calls = site.calls.iter().filter(|call|
            matches!(&call.target,CheckedDecisionCallTarget::Builtin {id,overload:0} if id == "active_member")
                && matches!(call.chain.as_slice(),[frame] if frame.node == key && frame.derive == derive));
        let membership = membership_calls.next()?;
        let [frame] = membership.chain.as_slice() else {
            return None;
        };
        if membership_calls.next().is_some()
            || frame.module != owner.module
            || frame.source != self.original.source
            || membership.module != item.module
            || membership.source != defining_source
        {
            return None;
        }
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
            nodes: &defining_nodes,
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

    fn membership(
        &self,
        actual: &TypedExpr,
        node: &SyntaxNode,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        depth: usize,
    ) -> Option<()> {
        use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
        let original = self.membership_call?;
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
        use crate::analysis::scenario_disclosure::{
            CheckedDecisionCallTarget, CheckedDecisionStage,
        };
        let source = self.transcript_source()?;
        let key = NodeKey::of(node);
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
        if calls.next().is_some()
            || original.source != self.original.source
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
        let authored: Vec<_> = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::Argument)
            .collect();
        if authored.len() != args.len() {
            return None;
        }
        for ((argument, value), (key, ty)) in authored.iter().zip(args).zip(&original.arguments) {
            let values = expressions(argument);
            let [source_value] = values.as_slice() else {
                return None;
            };
            if NodeKey::of(source_value) != *key
                || *ty != ResolvedType::Scalar(Scalar::Text)
                || value.ty != *ty
            {
                return None;
            }
            self.expression(value, *key, depth + 1)?;
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
        use crate::analysis::scenario_disclosure::{
            CheckedDecisionCallTarget, CheckedDecisionStage,
        };
        let source = self.transcript_source()?;
        let key = NodeKey::of(node);
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
        let [argument] = args else {
            return None;
        };
        let [(argument_node, argument_type)] = original.arguments.as_slice() else {
            return None;
        };
        if calls.next().is_some()
            || original.source != self.original.source
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
        let name = single_name(value, self.text)?;
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
        let token = |kind| {
            node.children
                .iter()
                .find(|child| child.kind == kind)
                .and_then(|child| {
                    self.text
                        .get(child.span.start as usize..child.span.end as usize)
                })
        };
        let primitive = |scalar| actual.ty == ResolvedType::Scalar(scalar);
        let matched = match (&actual.expr, node.kind) {
            (IrExpr::Query(_), SyntaxKind::Query) if self.operands => {
                self.inline_selection_query(actual, NodeKey::of(node), depth)
                    .or_else(|| self.transcript_query(actual, NodeKey::of(node), depth))?;
                true
            }
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
                true
            }
            (IrExpr::Int(value), SyntaxKind::Literal) => {
                primitive(Scalar::Int)
                    && token(SyntaxKind::Integer)?.parse::<i128>().ok()? == *value
            }
            (IrExpr::Decimal(value), SyntaxKind::Literal) => {
                primitive(Scalar::Decimal) && token(SyntaxKind::Decimal)? == value
            }
            (IrExpr::Bool(value), SyntaxKind::Literal) => {
                primitive(Scalar::Bool)
                    && token(SyntaxKind::Name)? == if *value { "true" } else { "false" }
            }
            (IrExpr::Null, SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Null && token(SyntaxKind::Name)? == "null"
            }
            (IrExpr::Text(value), SyntaxKind::Literal) => {
                // Checked operand literals retain contextual Email identity.
                // Schema/default matching keeps its existing Text-only path.
                (primitive(Scalar::Text) || self.operands && primitive(Scalar::Email))
                    && node
                        .children
                        .iter()
                        .find(|child| child.kind == SyntaxKind::String)?
                        .token()?
                        .string_value
                        .as_ref()?
                        == value
            }
            (IrExpr::Text(value), SyntaxKind::NameRef) => {
                single_name(node, self.text)? == value
                    && matches!(&actual.ty, ResolvedType::Enum {cases, ..} if cases.contains(value))
            }
            (IrExpr::DurationMs(value), SyntaxKind::Literal) => {
                primitive(Scalar::Duration) && duration(token(SyntaxKind::Duration)?)? == *value
            }
            (IrExpr::Name(name), SyntaxKind::NameRef) if name == "row" && !self.operands => {
                single_name(node, self.text)? == name
                    && (actual.ty == ResolvedType::Unknown
                        || actual.ty
                            == (ResolvedType::Record {
                                symbol: self.original.model,
                                stored: true,
                            }))
            }
            (IrExpr::Name(name), SyntaxKind::NameRef | SyntaxKind::Name) if self.operands => {
                let authored = single_name(node, self.text)?;
                if let Some((source, lowered)) = self.query_alias
                    && authored == source
                {
                    name == lowered
                } else {
                    authored == name
                }
            }
            (IrExpr::Member { base, field }, SyntaxKind::NameRef | SyntaxKind::Name)
                if self.operands =>
            {
                let name = single_name(node, self.text)?;
                matches!(name, "actor" | "now" | "team" | "operation")
                    && field == name
                    && matches!(&base.expr, IrExpr::Name(name) if name == "c")
                    && base.ty == ResolvedType::Unknown
                    && base.span == actual.span
            }
            (IrExpr::Member { base, field }, SyntaxKind::Member) if self.operands => {
                let [source_base] = children.as_slice() else {
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
                // Only the original checked profile or leading run scalar pair joins
                // its actual reads here; this issues no native row view.
                if matches!(&base.expr, IrExpr::Member { field, .. } if field == "profile" || field == "run")
                    && self.original.expression_types.iter().any(|(at, ty)| {
                        *at == NodeKey::of(source_base)
                            && matches!(ty, ResolvedType::Record { symbol, stored: true }
                                if self.ir.items.get(symbol.0 as usize).is_some_and(|item| item.id == *symbol && matches!(item.kind, IrItemKind::Model { .. })))
                    })
                {
                    let mut owners = self.ir.items.iter().filter(|owner| {
                        self.ir.scenario_disclosures.get(&owner.id).and_then(|disclosure| disclosure.source_facts())
                            .is_some_and(|facts| facts.source == self.original.source
                                && facts.creates.as_deref().is_some_and(|creates|
                                    creates.iter().any(|created| created.node == self.original.node)))
                    });
                    let owner = owners.next()?;
                    if owners.next().is_some() { return None; }
                    super::scenario_receipts::checked_profile_scalar_pairs(self.ir, owner, actual, self.db)?;
                }
                self.expression(base, NodeKey::of(source_base), depth + 1)?;
                true
            }
            (IrExpr::Member { base, field }, SyntaxKind::Member) => {
                let [source_base] = children.as_slice() else {
                    return None;
                };
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
                let declared = self
                    .original
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
                    })?;
                if &actual.ty != declared && declared.nullable_inner() != Some(&actual.ty) {
                    return None;
                }
                self.expression(base, NodeKey::of(source_base), depth + 1)?;
                true
            }
            (IrExpr::Binary { op, left, right }, SyntaxKind::Binary) => {
                let [source_left, source_right] = children.as_slice() else {
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
                match op {
                    IrBinOp::Eq
                    | IrBinOp::Ne
                    | IrBinOp::Lt
                    | IrBinOp::Le
                    | IrBinOp::Gt
                    | IrBinOp::Ge
                    | IrBinOp::And
                    | IrBinOp::Or
                    | IrBinOp::In => primitive(Scalar::Bool),
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
                }
            }
            (IrExpr::Unary { op, operand }, SyntaxKind::Unary) => {
                let [child] = children.as_slice() else {
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
                match op {
                    IrUnOp::Neg => actual.ty == operand.ty,
                    IrUnOp::Not => primitive(Scalar::Bool),
                }
            }
            (IrExpr::Array(values), SyntaxKind::Array) => {
                let ResolvedType::Array { element, .. } = &actual.ty else {
                    return None;
                };
                if values.len() != children.len() || values.len() > 200 {
                    return None;
                }
                for (value, child) in values.iter().zip(&children) {
                    if value.ty != **element {
                        return None;
                    }
                    self.expression(value, NodeKey::of(child), depth + 1)?;
                }
                true
            }
            (IrExpr::Object(entries), SyntaxKind::Construct) if self.operands => {
                self.text_constructor(actual, node, entries, depth)?;
                true
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    ..
                }
                | IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    ..
                },
                SyntaxKind::Call,
            ) if self.operands && id == "any" => {
                let source = self.transcript_source()?;
                let owner = self.ir.items.get(source.scenario.0 as usize)?;
                super::scenario_receipts::checked_any_query_ir(self.ir, owner, actual, self.db)?;
                source_path(children.first()?, self.text)? == "any"
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "first" => {
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
                let [domain] = args.as_slice() else {
                    return None;
                };
                if domain.span != source_argument.span {
                    return None;
                }
                let mut source_argument = *source_argument;
                for _ in depth..=64 {
                    if self
                        .original
                        .expression_types
                        .iter()
                        .find(|(node, _)| *node == NodeKey::of(source_argument))
                        .is_none_or(|(_, ty)| ty != &domain.ty)
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
                    .and_then(|(receiver, _)| {
                        source_path(self.nodes.get(&receiver)?, self.text)
                    })
                    .map(|receiver| format!("{receiver}.{model_name}"));
                if NodeKey::of(source_argument) != query.node
                    || (domain_path != *model_name
                        && contained_path.as_deref() != Some(domain_path.as_str()))
                {
                    return None;
                }
                if scan.value_order.is_some() {
                    return None;
                }
                SourceExpressions {
                    ir: self.ir,
                    db: self.db,
                    original: self.original,
                    nodes: self.nodes,
                    text: self.text,
                    operands: self.operands,
                    membership_call: self.membership_call,
                    query_alias: Some((alias_name, &scan.where_param)),
                }
                .expression(
                    scan.where_pred.as_ref()?,
                    query.predicate?,
                    depth + 1,
                )?;
                true
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "starts_with" => {
                self.prefix_guard(actual, node, args, None, depth)?;
                true
            }
            (
                IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                    slots,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "starts_with" => {
                self.prefix_guard(actual, node, args, Some(slots), depth)?;
                true
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                },
                SyntaxKind::Call,
            ) if self.operands
                && matches!(
                    id.as_str(),
                    "date" | "datetime" | "money" | "abs" | "round" | "min" | "max" | "trim"
                ) =>
            {
                // Settled pure scalar builtins consume their explicit operands
                // exactly as authored; correspondence is the callee name plus
                // each argument expression, in order.
                if source_path(children.first()?, self.text)? != id.as_str() {
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
                true
            }
            (
                IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                    slots,
                },
                SyntaxKind::Call,
            ) if self.operands
                && matches!(
                    id.as_str(),
                    "date" | "datetime" | "money" | "abs" | "round" | "min" | "max" | "trim"
                )
                && slots.len() == args.len()
                && slots
                    .iter()
                    .enumerate()
                    .all(|(index, slot)| *slot == Some(index)) =>
            {
                if source_path(children.first()?, self.text)? != id.as_str() {
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
                true
            }
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
            ) if self.operands && primitive(Scalar::Bool) => {
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
                true
            }
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
            ) if self.operands => {
                self.derive_call(actual, node, depth)?;
                true
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: true },
                    args,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "active_member" && primitive(Scalar::Bool) => {
                self.membership(actual, node, args, None, depth)?;
                true
            }
            (
                IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, awaited: true },
                    args,
                    slots,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "active_member" && primitive(Scalar::Bool) => {
                self.membership(actual, node, args, Some(slots), depth)?;
                true
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "trim" && primitive(Scalar::Text) => {
                self.trim_guard(actual, node, args, None, depth)?;
                true
            }
            (
                IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                    slots,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "trim" && primitive(Scalar::Text) => {
                self.trim_guard(actual, node, args, Some(slots), depth)?;
                true
            }
            (
                IrExpr::Call {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "count" && primitive(Scalar::Int) => {
                if matches!(args.as_slice(), [domain] if matches!(domain.expr, IrExpr::Query(_))) {
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
                if source_path(head, self.text)? != *id || args.len() != 1 {
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
                true
            }
            (
                IrExpr::BoundCall {
                    target: IrCallTarget::Builtin { id, awaited: false },
                    args,
                    slots,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "count" && primitive(Scalar::Int) => {
                if let [argument] = args.as_slice()
                    && !matches!(argument.expr, IrExpr::Query(_))
                    && slots.as_slice() == [Some(0)]
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
                true
            }
            _ => false,
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

#[cfg(test)]
mod tests {
    use super::super::ir::IrStmt;
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    use crate::analysis::{ResolvedType, Scalar, check_program};
    use crate::source::Span;

    const SOURCE: &str = include_str!("../../tests/fixtures/native-authorization-can-use.can");

    fn fixture() -> (SourceDb, IrProgram) {
        let mut db = SourceDb::new();
        let file = db.add("authorization.can".into(), SOURCE.into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let catalog_path = root.join("packages/cloudflare/dist/native-catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: &root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, ir)
    }

    fn authorization_guard(ir: &IrProgram) -> (TypedExpr, crate::source::Span) {
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "AuthorizationCanUse.ask")
            .unwrap();
        let IrItemKind::Scenario { guards, .. } = &owner.kind else {
            panic!("scenario")
        };
        let [IrStmt::Require { cond, .. }] = guards.as_slice() else {
            panic!("one leading require")
        };
        (cond.clone(), cond.span)
    }

    fn create_fact(ir: &IrProgram) -> &CheckedScenarioCreate {
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "AuthorizationCanUse.ask")
            .unwrap();
        ir.scenario_disclosures[&owner.id]
            .source_facts()
            .unwrap()
            .creates
            .as_deref()
            .unwrap()
            .first()
            .unwrap()
    }

    fn node_at(db: &SourceDb, span: crate::source::Span) -> NodeKey {
        let (tree, diagnostics) = crate::syntax::parse(db, span.file);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let mut pending = vec![&tree];
        while let Some(node) = pending.pop() {
            if node.span == span {
                return NodeKey::of(node);
            }
            pending.extend(node.children.iter());
        }
        panic!("guard source node")
    }

    #[test]
    fn field_trait_defaults_and_reused_constraints_match_checked_sources() {
        use crate::analysis::generation::{GenerationKind, discover_program};
        use crate::analysis::generation_intake::{AssociationKey, UnitKind};
        use crate::analysis::types::{GivenSavedUnit, check_given_contract_tables};
        for (reused, authored_default) in [(false, false), (false, true), (true, true)] {
            let source = if reused {
                "package Limits\n Given\n  trait floor $\"Default two with bounds one through ten.\"\n  export Bounded {quantity:int floor}\n When\n Then\napp GivenField\nuse Limits {Bounded as Alias}\nGiven\n Item {quantity:Alias.quantity=7 min=3 max=9}\n Other {quantity:int}\nWhen\n scenario pick() -> Item by=members\n  require true\n  do\n   create Item {} as item\n   return item\nThen\n"
            } else {
                "app GivenField\nGiven\n trait floor $\"Default two with bounds one through ten.\"\n Item {quantity:int floor}\n Other {quantity:int}\nWhen\n scenario pick() -> Item by=members\n  require true\n  do\n   create Item {} as item\n   return item\nThen\n"
            };
            let source = if authored_default && !reused {
                source.replace("quantity:int floor", "quantity:int=2 min=0 max=99 floor")
            } else {
                source.into()
            };
            let source = source.replace("   return item\nThen\n", "   return item\n scenario inspect(item:Item) -> Item by=members\n  do return item\nThen\n");
            let mut db = SourceDb::new();
            let file = db.add("field-trait.can".into(), source.into());
            let (initial, _) = crate::analysis::check_program(&db, &[file], None);
            let found = discover_program(&db, initial.checked_files());
            let mut saved = HashMap::new();
            for descriptor in found
                .descriptors
                .iter()
                .filter(|value| value.kind == GenerationKind::NamedTrait)
            {
                let label = descriptor.label.as_deref().unwrap();
                let (default, min, max) = if label == "floor" {
                    (2, 1, 10)
                } else {
                    (5, 4, 8)
                };
                let carrier = db.add(
                    format!("saved/{label}.can"),
                    format!(
                        "app {}\nGiven\n {label} {{value:int={default} min={min} max={max}}}\n",
                        descriptor.owner
                    ),
                );
                saved.insert(
                    AssociationKey {
                        owner: descriptor.owner.clone(),
                        kind: UnitKind::NamedTrait,
                        label: descriptor.label.clone(),
                        anchor: descriptor.anchor.clone(),
                    },
                    GivenSavedUnit {
                        unit_id: label.into(),
                        contributions: Some(carrier),
                        implementation_js: None,
                        implementation_imports: Vec::new(),
                        declaration: None,
                    },
                );
            }
            let (given, diagnostics) = check_given_contract_tables(&db, &initial, &saved);
            assert!(diagnostics.is_empty(), "{diagnostics:?}");
            let (checked, diagnostics) =
                crate::analysis::check_program_with_given(&db, &[file], None, Some(&given));
            assert!(diagnostics.is_empty(), "{diagnostics:?}");
            let (ir, diagnostics) = super::super::ir::build(&checked, &db, None);
            assert!(diagnostics.is_empty(), "{diagnostics:?}");
            let owner = ir
                .items
                .iter()
                .find(|item| item.canonical == "GivenField.pick")
                .unwrap();
            let original = ir.scenario_disclosures[&owner.id]
                .source_facts()
                .unwrap()
                .creates
                .as_ref()
                .unwrap()[0]
                .clone();
            let field = ir
                .items
                .iter()
                .find(|item| item.canonical == "GivenField.Item.quantity")
                .unwrap()
                .id;
            let other = ir
                .items
                .iter()
                .find(|item| item.canonical == "GivenField.Other")
                .unwrap()
                .id;
            let accepts = |candidate: &IrProgram| {
                let models = Emitter::source_models(candidate, &db)?;
                checked_created_schema(
                    candidate,
                    &candidate.items[owner.id.0 as usize],
                    &models,
                    &original,
                    &db,
                )
            };
            let IrItemKind::Field {
                modifiers: original_modifiers,
                ..
            } = &ir.items[field.0 as usize].kind
            else {
                unreachable!()
            };
            assert!(
                checked_field_trait_modifiers(
                    &ir,
                    &original,
                    &original.definition.fields[0],
                    original_modifiers,
                    &db
                )
                .is_some(),
                "field-trait modifier gate reused={reused} authored={authored_default}"
            );
            assert!(
                accepts(&ir).is_some(),
                "checked field trait default/bounds, including aliased reusable source field reused={reused} authored={authored_default}"
            );
            let stored_owner = ir
                .items
                .iter()
                .find(|item| item.canonical == "GivenField.inspect")
                .unwrap();
            let stored = ir.scenario_disclosures[&stored_owner.id]
                .source_facts()
                .unwrap()
                .stored_contracts
                .as_ref()
                .unwrap()
                .iter()
                .find(|schema| schema.canonical == "GivenField.Item")
                .unwrap()
                .fields
                .iter()
                .find(|candidate| candidate.id == field)
                .unwrap();
            assert!(
                super::super::scenario_receipts::match_stored_contract_field(&ir, stored, &db)
                    .is_some(),
                "the same checked Given constraints seal the stored Model field, including alias reuse"
            );
            let mut changed = ir.clone();
            let crate::analysis::scenario_disclosure::ScenarioDisclosure::Complete(facts) =
                changed.scenario_disclosures.get_mut(&owner.id).unwrap()
            else {
                panic!("complete")
            };
            facts
                .source_facts
                .as_mut()
                .unwrap()
                .creates
                .as_mut()
                .unwrap()[0]
                .definition
                .fields[0]
                .modifier_sources[0]
                .1
                .path
                .push_str(".foreign");
            assert!(
                super::super::scenario_receipts::match_stored_contract_field(&changed, stored, &db)
                    .is_none(),
                "a forged Given field origin cannot fall back to ordinary authored bounds"
            );
            if reused {
                let mut forged = stored.clone();
                forged.reuse = None;
                assert!(
                    super::super::scenario_receipts::match_stored_contract_field(&ir, &forged, &db)
                        .is_none(),
                    "ordinary authored receiving bounds cannot hide a changed reuse source"
                );
            }
            let IrItemKind::Field {
                default: Some(IrDefault::Literal(value)),
                modifiers,
                ..
            } = &ir.items[field.0 as usize].kind
            else {
                panic!("effective field");
            };
            assert!(
                matches!(value.expr, IrExpr::Int(actual) if actual == if reused {7} else {2}),
                "authored receiving default wins and inherited defaults do not replace it"
            );
            assert!(
                matches!(modifiers.min.as_ref().unwrap().expr, IrExpr::Int(actual) if actual == if reused {3} else {1})
            );
            assert!(
                matches!(modifiers.max.as_ref().unwrap().expr, IrExpr::Int(actual) if actual == if reused {9} else {10})
            );
            assert_eq!(
                value.span,
                original.definition.declaration.fields[0]
                    .default
                    .map(span)
                    .unwrap_or(ir.items[field.0 as usize].span),
                "authored default source wins when present; Given defaults retain the receiving field attachment"
            );
            for mutation in 0..6 {
                let mut changed = ir.clone();
                let IrItemKind::Field {
                    default,
                    modifiers,
                    owner: field_owner,
                    ..
                } = &mut changed.items[field.0 as usize].kind
                else {
                    unreachable!()
                };
                match mutation {
                    0 => {
                        let Some(IrDefault::Literal(value)) = default else {
                            unreachable!()
                        };
                        value.expr = IrExpr::Int(99);
                    }
                    1 => modifiers.min.as_mut().unwrap().expr = IrExpr::Int(0),
                    2 => modifiers.max.as_mut().unwrap().expr = IrExpr::Int(99),
                    3 => *field_owner = other,
                    4 => changed.items[field.0 as usize].span.start += 1,
                    _ if reused => {
                        changed
                            .modules
                            .iter_mut()
                            .find(|module| module.name == "GivenField")
                            .unwrap()
                            .imports[0]
                            .members[0]
                            .1 = "Forged".into();
                    }
                    _ => {
                        let Some(IrDefault::Literal(value)) = default else {
                            unreachable!()
                        };
                        value.span.start += 1;
                    }
                }
                assert!(
                    accepts(&changed).is_none(),
                    "checked field trait mutation {mutation} refuses"
                );
            }
        }
    }

    #[test]
    fn contributed_create_schema_and_named_role_refuse_changed_lowering() {
        use crate::analysis::types::{
            CheckedTraitApplication, CheckedTraitContract, GivenContractTables,
            GivenContributedField,
        };
        let source = "app GivenCreate\nGiven\n role curator\n trait marked $\"Add archived evidence.\"\n Item {title:text} marked\n Other {title:text}\n policy Item read=members\nWhen\n crud Item by=curator fields=title\n scenario pick(title:text) by=curator -> Item\n  do\n   create Item {title} as item\n   return item\n scenario archive(item:Item) by=curator\n  require not item.archived\n  do set item {archived=true,archived_by=actor,archive_recorded_at=now}\n scenario restore(item:Item) by=curator\n  require item.archived\n  do set item {archived=false,archived_by=null,archive_recorded_at=null}\nThen\n";
        let mut db = SourceDb::new();
        let file = db.add("given-create.can".into(), source.into());
        let start = source.find(" marked\n").unwrap() + 1;
        let attachment = Span::new(file, start as u32, (start + "marked".len()) as u32);
        let given = GivenContractTables {
            traits: vec![CheckedTraitContract {
                name: Some("marked".into()),
                inline: false,
                anchor: "GivenCreate:trait:marked:".into(),
                unit_id: "checked-template".into(),
                fingerprint: sha256_hex(b"checked carrier"),
                validation_fingerprint: None,
                applications: vec![CheckedTraitApplication {
                    target_model: "Item".into(),
                    target_field: None,
                    target_canonical: "GivenCreate.Item".into(),
                    span: attachment,
                    order: 0,
                }],
                contributed_fields: [
                    ("archived", "bool", "false"),
                    ("archived_by", "user?", "null"),
                    ("archive_recorded_at", "datetime?", "null"),
                ]
                .into_iter()
                .map(|(name, ty, default)| GivenContributedField {
                    name: name.into(),
                    type_name: ty.into(),
                    default: Some(default.into()),
                    trim: false,
                    min: None,
                    max: None,
                    label: None,
                })
                .collect(),
            }],
            keywords: vec![],
        };
        let (program, diagnostics) =
            crate::analysis::check_program_with_given(&db, &[file], None, Some(&given));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = super::super::ir::build(&program, &db, None);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "GivenCreate.pick")
            .unwrap()
            .id;
        let field = ir
            .items
            .iter()
            .find(|item| item.canonical == "GivenCreate.Item.archived")
            .unwrap()
            .id;
        let created = ir
            .items
            .iter()
            .find(|item| item.canonical == "GivenCreate.Item")
            .unwrap()
            .id;
        let other = ir
            .items
            .iter()
            .find(|item| item.canonical == "GivenCreate.Other")
            .unwrap()
            .id;
        let owners = [
            "GivenCreate.pick",
            "GivenCreate.archive",
            "GivenCreate.restore",
        ]
        .map(|canonical| {
            ir.items
                .iter()
                .find(|item| item.canonical == canonical)
                .unwrap()
                .id
        });
        for owner in owners {
            assert!(
                matches!(
                    ir.scenario_disclosures[&owner],
                    ScenarioDisclosure::Complete(_)
                ),
                "original contributed read/write plan: {:?}",
                ir.scenario_disclosures[&owner]
            );
        }
        let accepts_one = |candidate: &IrProgram, owner: crate::analysis::SymbolId| {
            let models = Emitter::source_models(candidate, &db).unwrap();
            super::super::scenario_receipts::collect_native_scenario_receipt(
                candidate,
                &candidate.items[owner.0 as usize],
                &models,
                "given-create.mjs",
                None,
                super::super::scenario_receipts::NativeReceiptSources {
                    db: Some(&db),
                    send_guards: None,
                    query_plan: None,
                },
            )
            .is_some()
        };
        assert!(owners.iter().all(|owner| accepts_one(&ir, *owner)));
        for change in [
            "default",
            "type",
            "owner",
            "attachment",
            "order",
            "role",
            "bounds",
            "nullable-user",
            "nullable-time",
        ] {
            let mut changed = ir.clone();
            match change {
                "default" => {
                    let IrItemKind::Field {
                        default: Some(IrDefault::Literal(value)),
                        ..
                    } = &mut changed.items[field.0 as usize].kind
                    else {
                        panic!()
                    };
                    value.expr = IrExpr::Bool(true);
                }
                "type" => {
                    let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind
                    else {
                        panic!()
                    };
                    *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
                }
                "owner" => {
                    let IrItemKind::Field { owner, .. } = &mut changed.items[field.0 as usize].kind
                    else {
                        panic!()
                    };
                    *owner = other;
                }
                "attachment" => changed.items[field.0 as usize].span.start += 1,
                "order" => {
                    let IrItemKind::Model { fields, .. } =
                        &mut changed.items[created.0 as usize].kind
                    else {
                        panic!()
                    };
                    fields.reverse();
                }
                "bounds" => {
                    let IrItemKind::Field { modifiers, .. } =
                        &mut changed.items[field.0 as usize].kind
                    else {
                        panic!()
                    };
                    modifiers.max = Some(TypedExpr::new(
                        IrExpr::Int(1),
                        ResolvedType::Scalar(Scalar::Int),
                        attachment,
                    ));
                }
                "nullable-user" | "nullable-time" => {
                    let (name, scalar) = if change == "nullable-user" {
                        ("archived_by", Scalar::User)
                    } else {
                        ("archive_recorded_at", Scalar::Datetime)
                    };
                    let member = changed
                        .items
                        .iter_mut()
                        .find(|item| item.canonical == format!("GivenCreate.Item.{name}"))
                        .unwrap();
                    let IrItemKind::Field { ty, .. } = &mut member.kind else {
                        panic!()
                    };
                    *ty = IrType::Known(ResolvedType::Scalar(scalar));
                }
                "role" => {
                    let IrItemKind::Scenario { by, .. } = &mut changed.items[owner.0 as usize].kind
                    else {
                        panic!()
                    };
                    *by = vec![super::super::ir::IrGuard::Role("members".into())];
                }
                _ => unreachable!(),
            }
            for candidate in owners {
                if change == "role" && candidate != owner {
                    continue;
                }
                assert!(
                    !accepts_one(&changed, candidate),
                    "changed {change} must not retain original disclosure for {:?}",
                    candidate
                );
            }
        }
    }

    const ORDINARY_SOURCE: &str = "app OrdinaryDerive\nGiven\n Conversation {account:user,active:bool}\n Run {conversation:Conversation,label:text}\n policy Conversation read=members\n policy Run read=members\n derive can_use(person:user?,conversation:Conversation):bool = person!=null and conversation.account==person and conversation.active\nWhen\n crud Conversation by=members fields=account,active\n crud Run by=members fields=conversation,label\n scenario pick(conversation:Conversation,label:text=\"x\") -> Run by=members\n  require can_use(actor,conversation)\n  do\n   create Run {conversation,label} as run\n   return run\nThen\n";

    const TRANSITIVE_SOURCE: &str = "app TransitiveDerive\nGiven\n Conversation {account:user,active:bool}\n Run {conversation:Conversation,label:text}\n policy Conversation read=members\n policy Run read=members\n derive inner(person:user?,conversation:Conversation):bool = person!=null and active_member(person,team) and conversation.account==person\n derive outer(person:user?,conversation:Conversation):bool = inner(person,conversation) and conversation.active\nWhen\n crud Conversation by=members fields=account,active\n crud Run by=members fields=conversation,label\n scenario pick(conversation:Conversation,label:text=\"x\") -> Run by=members\n  require outer(actor,conversation)\n  do\n   create Run {conversation,label} as run\n   return run\nThen\n";

    fn fixture_for(source: &str, path: &str) -> (SourceDb, IrProgram) {
        fixture_modules(&[(path, source)])
    }

    fn fixture_modules(sources: &[(&str, &str)]) -> (SourceDb, IrProgram) {
        let mut db = SourceDb::new();
        let files: Vec<_> = sources
            .iter()
            .map(|(path, source)| db.add((*path).into(), (*source).into()))
            .collect();
        let file = files[0];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let catalog_path = root.join("packages/cloudflare/dist/native-catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: &root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &files, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, ir)
    }

    fn guard_and_fact(
        ir: &IrProgram,
        owner_name: &str,
    ) -> (TypedExpr, crate::source::Span, CheckedScenarioCreate) {
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == owner_name)
            .unwrap();
        let IrItemKind::Scenario { guards, .. } = &owner.kind else {
            panic!("scenario")
        };
        let [IrStmt::Require { cond, .. }] = guards.as_slice() else {
            panic!("one leading require")
        };
        let fact = ir.scenario_disclosures[&owner.id]
            .source_facts()
            .unwrap()
            .creates
            .as_deref()
            .unwrap()
            .first()
            .unwrap()
            .clone();
        (cond.clone(), cond.span, fact)
    }

    fn derive_mut<'a>(ir: &'a mut IrProgram, canonical: &'a str) -> &'a mut TypedExpr {
        let derive = ir
            .items
            .iter()
            .find(|item| item.canonical == canonical)
            .unwrap()
            .id;
        let IrItemKind::DeriveFn { expr, .. } = &mut ir.items[derive.0 as usize].kind else {
            panic!("derive")
        };
        expr.as_mut().unwrap()
    }

    fn authenticate_for_guard(
        ir: &IrProgram,
        db: &SourceDb,
        original: &CheckedScenarioCreate,
        target: &str,
    ) -> Option<bool> {
        let (tree, diagnostics) = crate::syntax::parse(db, original.node.file);
        assert!(diagnostics.is_empty());
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
            nodes: &nodes,
            text: &db.get(original.node.file).unwrap().text,
            operands: true,
            membership_call: None,
            query_alias: None,
        }
        .authenticated_derive(target, 0, &mut HashSet::new())
    }

    fn query_arguments_mut(ir: &mut IrProgram) -> &mut Vec<TypedExpr> {
        let body = derive_mut(ir, "OrdinaryDerive.can_use");
        let IrExpr::Binary { right, .. } = &mut body.expr else {
            panic!("outer null guard")
        };
        let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut right.expr else {
            panic!("collection call")
        };
        args
    }

    #[test]
    fn query_derive_authentication_retains_source_alias_and_authority_seal() {
        let scalar_body = "person!=null and conversation.account==person and conversation.active";
        for membership in [false, true] {
            let predicate = if membership {
                "candidate.account==person and candidate.active and active_member(person,team)"
            } else {
                "candidate.account==person and candidate.active"
            };
            let source = ORDINARY_SOURCE.replace(
                scalar_body,
                &format!("person!=null and any(Conversation as candidate,{predicate})"),
            );
            let (db, ir) = fixture_for(&source, "query-derive.can");
            let (cond, span, original) = guard_and_fact(&ir, "OrdinaryDerive.pick");
            assert_eq!(
                authenticate_for_guard(&ir, &db, &original, "OrdinaryDerive.can_use"),
                Some(true),
                "exact stored query source authenticates and remains authority sealed"
            );
            assert!(
                checked_create_expression(&ir, &original, &cond, node_at(&db, span), &db).is_none(),
                "source authentication alone grants no query execution or ordinary fallback"
            );
            for mutation in 0..8 {
                let mut changed = ir.clone();
                match mutation {
                    0 => {
                        let IrExpr::Query(query) = &mut query_arguments_mut(&mut changed)[0].expr
                        else {
                            panic!("query")
                        };
                        query.domain =
                            super::super::ir::IrQueryDomain::Model("OrdinaryDerive.Run".into());
                    }
                    1 => {
                        let IrExpr::Query(query) = &mut query_arguments_mut(&mut changed)[0].expr
                        else {
                            panic!("query")
                        };
                        query.collection_call.as_mut().unwrap().alias.start += 1;
                    }
                    2 => {
                        let IrExpr::Query(query) = &mut query_arguments_mut(&mut changed)[0].expr
                        else {
                            panic!("query")
                        };
                        query.source.as_mut().unwrap().domain.start += 1;
                    }
                    3 => {
                        let IrExpr::Lambda { param, .. } =
                            &mut query_arguments_mut(&mut changed)[1].expr
                        else {
                            panic!("lambda")
                        };
                        *param = "substitute".into();
                    }
                    4 => {
                        let IrExpr::Lambda { body, .. } =
                            &mut query_arguments_mut(&mut changed)[1].expr
                        else {
                            panic!("lambda")
                        };
                        body.expr = IrExpr::Bool(true);
                    }
                    5 => {
                        let IrExpr::Query(query) = &mut query_arguments_mut(&mut changed)[0].expr
                        else {
                            panic!("query")
                        };
                        query.collection_call.as_mut().unwrap().overload += 1;
                    }
                    6 => {
                        let IrExpr::Query(query) = &mut query_arguments_mut(&mut changed)[0].expr
                        else {
                            panic!("query")
                        };
                        query.collection_call = None;
                    }
                    _ => {
                        let field = changed
                            .items
                            .iter_mut()
                            .find(|item| item.canonical == "OrdinaryDerive.Conversation.active")
                            .unwrap();
                        let IrItemKind::Field { ty, .. } = &mut field.kind else {
                            panic!("active field")
                        };
                        *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
                    }
                }
                assert_eq!(
                    authenticate_for_guard(&changed, &db, &original, "OrdinaryDerive.can_use"),
                    None,
                    "query/body/source proof mutation {mutation} must refuse"
                );
                assert!(
                    checked_create_expression(&changed, &original, &cond, node_at(&db, span), &db)
                        .is_none(),
                    "tampered sealed query must never reclassify ordinary"
                );
            }
        }
    }

    const QUERY_HELPER_SOURCE: &str = r#"package Places
 Given
  export Location {name:text}
 When
 Then
package People
 use Places {Location as Site}
 Given
  export Worker {account:user,enabled:bool,all_sites:bool,home:Site,sites:Site[]}
  export derive allowed(person:user,location:Site):bool = any(Worker as worker,worker.account==person and worker.enabled and active_member(person,team) and (worker.all_sites or worker.home==location or location in worker.sites))
 When
 Then
app QueryConsumer
use People {allowed}
use Places {Location}
Given
 contract Input {location:Location}
 Run {location:Location}
When
 scenario pick(input:Input) -> Run by=members
  require allowed(actor,input.location)
  do
   create Run {location=input.location} as run
   return run
Then
"#;

    #[test]
    fn leading_query_authorization_matches_original_call_and_control_census() {
        let source = QUERY_HELPER_SOURCE;
        for named in [false, true] {
            let source = if named {
                source.replace(
                    "allowed(actor,input.location)",
                    "allowed(location=input.location,person=actor)",
                )
            } else {
                source.into()
            };
            let (db, ir) = fixture_for(&source, "leading-query.can");
            let (cond, at, original) = guard_and_fact(&ir, "QueryConsumer.pick");
            let owner = ir
                .items
                .iter()
                .find(|item| item.canonical == "QueryConsumer.pick")
                .unwrap();
            assert_eq!(
                authenticate_for_guard(&ir, &db, &original, "People.allowed"),
                Some(true),
                "source derive seal"
            );
            assert!(
                checked_create_expression(&ir, &original, &cond, node_at(&db, at), &db).is_some(),
                "source-owned leading query authorization, including aliased Model type and named evaluation order"
            );
            assert!(
                super::super::scenario_receipts::checked_helper_any_query_ir(
                    &ir, owner, &cond, &db
                )
                .is_some()
            );
            for mutation in 0..7 {
                let mut changed = ir.clone();
                match mutation {
                    0 => {
                        derive_mut(&mut changed, "People.allowed").expr = IrExpr::Bool(true);
                    }
                    1 => {
                        let owner = changed
                            .items
                            .iter()
                            .find(|item| item.canonical == "QueryConsumer.pick")
                            .unwrap()
                            .id;
                        let disclosure = changed.scenario_disclosures.get_mut(&owner).unwrap();
                        let facts = match disclosure {
                            ScenarioDisclosure::Complete(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                            ScenarioDisclosure::Declined(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                        };
                        let query = facts
                            .queries
                            .as_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|query| {
                                query
                                    .dependencies
                                    .first()
                                    .is_some_and(|read| read.calls.len() == 1)
                            })
                            .unwrap();
                        query.dependencies.pop();
                    }
                    2 => {
                        let owner = changed
                            .items
                            .iter()
                            .find(|item| item.canonical == "QueryConsumer.pick")
                            .unwrap()
                            .id;
                        let disclosure = changed.scenario_disclosures.get_mut(&owner).unwrap();
                        let facts = match disclosure {
                            ScenarioDisclosure::Complete(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                            ScenarioDisclosure::Declined(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                        };
                        let query = facts
                            .queries
                            .as_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|query| !query.dependencies.is_empty())
                            .unwrap();
                        query.dependencies.swap(0, 1);
                    }
                    3 => {
                        let field = changed
                            .items
                            .iter_mut()
                            .find(|item| item.canonical == "People.Worker.enabled")
                            .unwrap();
                        let IrItemKind::Field { ty, .. } = &mut field.kind else {
                            panic!("field")
                        };
                        *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
                    }
                    4 => {
                        let owner = changed
                            .items
                            .iter()
                            .find(|item| item.canonical == "QueryConsumer.pick")
                            .unwrap()
                            .id;
                        let disclosure = changed.scenario_disclosures.get_mut(&owner).unwrap();
                        let facts = match disclosure {
                            ScenarioDisclosure::Complete(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                            ScenarioDisclosure::Declined(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                        };
                        let query = facts
                            .queries
                            .as_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|query| !query.dependencies.is_empty())
                            .unwrap();
                        query.dependencies[0].calls.clear();
                    }
                    5 => {
                        let derive = changed
                            .items
                            .iter_mut()
                            .find(|item| item.canonical == "People.allowed")
                            .unwrap();
                        let IrItemKind::DeriveFn { params, .. } = &mut derive.kind else {
                            panic!("derive")
                        };
                        params.swap(0, 1);
                    }
                    _ => {
                        let owner = changed
                            .items
                            .iter()
                            .find(|item| item.canonical == "QueryConsumer.pick")
                            .unwrap()
                            .id;
                        let disclosure = changed.scenario_disclosures.get_mut(&owner).unwrap();
                        let facts = match disclosure {
                            ScenarioDisclosure::Complete(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                            ScenarioDisclosure::Declined(value) => {
                                value.source_facts.as_mut().unwrap()
                            }
                        };
                        let query = facts
                            .queries
                            .as_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|query| !query.dependencies.is_empty())
                            .unwrap();
                        query.id = "substituted".into();
                    }
                }
                let (cond, at, _) = guard_and_fact(&changed, "QueryConsumer.pick");
                assert!(
                    checked_create_expression(&changed, &original, &cond, node_at(&db, at), &db)
                        .is_none(),
                    "source/body/field/ordered census mutation {mutation} must not take ordinary fallback"
                );
            }
        }
    }

    #[test]
    fn body_query_authorization_keeps_first_row_branch_and_required_edges() {
        fn body_call(ir: &IrProgram) -> TypedExpr {
            let owner = ir
                .items
                .iter()
                .find(|item| item.canonical == "QueryConsumer.pick")
                .unwrap();
            let IrItemKind::Scenario { effects, .. } = &owner.kind else {
                panic!("scenario");
            };
            let IrStmt::If { then_branch, .. } = effects
                .iter()
                .find(|value| matches!(value, IrStmt::If { .. }))
                .unwrap()
            else {
                unreachable!()
            };
            let IrStmt::Require { cond, .. } = &then_branch[0] else {
                panic!("require");
            };
            let IrExpr::Binary {
                op: IrBinOp::And,
                right,
                ..
            } = &cond.expr
            else {
                panic!("ordered compound guard");
            };
            right.as_ref().clone()
        }
        let source = QUERY_HELPER_SOURCE
            .replace(" Run {location:Location}", " Run {location:Location}\n Intake {source:text unique,input:Input,deal:Run}")
            .replace("scenario pick(input:Input)", "scenario pick(source:text,input:Input)")
            .replace("  do\n   create Run", "  do\n   let existing=first(Intake as prior where prior.source==source)\n   if existing!=null\n    require existing.input==input and allowed(actor,existing.deal.location)\n    return existing.deal\n   create Run")
            .replace("   return run", "   create Intake {source,input,deal=run} as intake\n   return run");
        for named in [false, true] {
            let source = if named {
                source
                    .replace(
                        "allowed(actor,input.location)",
                        "allowed(location=input.location,person=actor)",
                    )
                    .replace(
                        "allowed(actor,existing.deal.location)",
                        "allowed(location=existing.deal.location,person=actor)",
                    )
            } else {
                source.clone()
            };
            let (db, ir) = fixture_for(&source, "body-query.can");
            let (_, _, original) = guard_and_fact(&ir, "QueryConsumer.pick");
            let actual = body_call(&ir);
            let at = node_at(&db, actual.span);
            assert!(
                checked_create_expression(&ir, &original, &actual, at, &db).is_some(),
                "first-row body helper source, including earlier compound guard and original Model edges"
            );
            for mutation in 0..6 {
                let mut changed = ir.clone();
                let owner = changed
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "QueryConsumer.pick")
                    .unwrap();
                let IrItemKind::Scenario { effects, .. } = &mut owner.kind else {
                    unreachable!()
                };
                match mutation {
                    0 => {
                        let IrStmt::Let { value, .. } = &mut effects[0] else {
                            panic!("first let");
                        };
                        value.expr = IrExpr::Bool(true);
                    }
                    1 => {
                        let IrStmt::If { cond, .. } = &mut effects[1] else {
                            panic!("if");
                        };
                        let IrExpr::Binary { op, .. } = &mut cond.expr else {
                            panic!("nonnull");
                        };
                        *op = IrBinOp::Eq;
                    }
                    2 => {
                        let IrStmt::If { then_branch, .. } = &mut effects[1] else {
                            panic!("if");
                        };
                        let IrStmt::Require { cond, .. } = &mut then_branch[0] else {
                            panic!("require");
                        };
                        let IrExpr::Binary { left, .. } = &mut cond.expr else {
                            panic!("and");
                        };
                        left.expr = IrExpr::Bool(true);
                    }
                    3 => effects.swap(0, 1),
                    4 => {
                        let field = changed
                            .items
                            .iter_mut()
                            .find(|item| item.canonical == "QueryConsumer.Intake.deal")
                            .unwrap();
                        let IrItemKind::Field {
                            ty: IrType::Known(ty),
                            ..
                        } = &mut field.kind
                        else {
                            panic!("reference field");
                        };
                        *ty = ResolvedType::Nullable(Box::new(ty.clone()));
                    }
                    _ => {
                        let IrStmt::If { then_branch, .. } = &mut effects[1] else {
                            panic!("if");
                        };
                        let IrStmt::Require { cond, .. } = &mut then_branch[0] else {
                            panic!("require");
                        };
                        let IrExpr::Binary { right, .. } = &mut cond.expr else {
                            panic!("and");
                        };
                        let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) =
                            &mut right.expr
                        else {
                            panic!("helper");
                        };
                        let reference = args.iter_mut().find(|arg| matches!(arg.expr, IrExpr::Member {ref field, ..} if field == "location")).unwrap();
                        let IrExpr::Member { base, .. } = &mut reference.expr else {
                            unreachable!()
                        };
                        let IrExpr::Member { base, .. } = &mut base.expr else {
                            panic!("deal");
                        };
                        base.ty = ResolvedType::Nullable(Box::new(base.ty.clone()));
                    }
                }
                let actual = body_call(&changed);
                assert!(
                    checked_create_expression(&changed, &original, &actual, at, &db).is_none(),
                    "body source tamper {mutation} must refuse without ordinary fallback"
                );
            }
        }
    }

    #[test]
    fn ordinary_body_and_formal_mutations_refuse_at_create_source_boundary() {
        let (db, ir) = fixture_for(ORDINARY_SOURCE, "ordinary-derive.can");
        let (cond, span, original) = guard_and_fact(&ir, "OrdinaryDerive.pick");
        let node = node_at(&db, span);
        assert!(
            checked_create_expression(&ir, &original, &cond, node, &db).is_some(),
            "original ordinary derive keeps create-source correspondence"
        );
        // Body-only replacement: same call, result type and span, but the
        // supplied body is no longer the authored body. The authenticated
        // declaration/body correspondence refuses it.
        let mut changed = ir.clone();
        let body = derive_mut(&mut changed, "OrdinaryDerive.can_use");
        assert_eq!(body.ty, ResolvedType::Scalar(Scalar::Bool));
        body.expr = IrExpr::Bool(true);
        let (cond, span, _) = guard_and_fact(&changed, "OrdinaryDerive.pick");
        assert!(
            checked_create_expression(&changed, &original, &cond, node_at(&db, span), &db)
                .is_none(),
            "ordinary body-only replacement must refuse"
        );
        // Stored field-type corruption: only the supplied IR declaration
        // of Conversation.active changes Bool -> Text; source, checked
        // facts, body, call and arguments are unchanged. The body walk
        // authenticates reached stored fields, so this refuses too.
        let mut changed = ir.clone();
        let field = changed
            .items
            .iter()
            .find(|item| item.canonical == "OrdinaryDerive.Conversation.active")
            .unwrap()
            .id;
        let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
            panic!("field")
        };
        *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
        let (cond, span, _) = guard_and_fact(&changed, "OrdinaryDerive.pick");
        assert!(
            checked_create_expression(&changed, &original, &cond, node_at(&db, span), &db)
                .is_none(),
            "stored field-type corruption must refuse"
        );
        // Formal-ID swap: the supplied formal order no longer matches the
        // authored declaration order.
        let mut changed = ir.clone();
        let derive = changed
            .items
            .iter()
            .find(|item| item.canonical == "OrdinaryDerive.can_use")
            .unwrap()
            .id;
        let IrItemKind::DeriveFn { params, .. } = &mut changed.items[derive.0 as usize].kind else {
            panic!("derive")
        };
        params.swap(0, 1);
        let (cond, span, _) = guard_and_fact(&changed, "OrdinaryDerive.pick");
        assert!(
            checked_create_expression(&changed, &original, &cond, node_at(&db, span), &db)
                .is_none(),
            "formal-ID swap must refuse"
        );
    }

    #[test]
    fn transitive_membership_seals_outer_derive() {
        let (db, ir) = fixture_for(TRANSITIVE_SOURCE, "transitive-derive.can");
        let (cond, span, original) = guard_and_fact(&ir, "TransitiveDerive.pick");
        // The outer derive performs the membership read transitively, so
        // it is sealed: the strict authorization lane refuses its call at
        // this boundary instead of admitting it as an ordinary derive.
        assert!(
            checked_create_expression(&ir, &original, &cond, node_at(&db, span), &db).is_none(),
            "transitively sealed derive must not take the ordinary lane"
        );
    }

    #[test]
    fn ordinary_transitive_target_must_keep_its_defining_module_binding() {
        let source = ORDINARY_SOURCE.replace(
            "derive can_use(person:user?,conversation:Conversation):bool = person!=null and conversation.account==person and conversation.active",
            "derive inner(person:user?):bool = person!=null\n derive can_use(person:user?,conversation:Conversation):bool = inner(person) and conversation.account==person and conversation.active",
        );
        let (db, ir) = fixture_modules(&[
            ("ordinary-derive.can", &source),
            (
                "other.can",
                "package Other\n Given\n  export derive inner(person:user?):bool = false\n When\n Then\n",
            ),
        ]);
        let (cond, span, original) = guard_and_fact(&ir, "OrdinaryDerive.pick");
        assert!(
            checked_create_expression(&ir, &original, &cond, node_at(&db, span), &db).is_some()
        );
        let mut changed = ir.clone();
        fn first_call(expression: &mut TypedExpr) -> &mut IrCallTarget {
            match &mut expression.expr {
                IrExpr::Binary { left, .. } => first_call(left),
                IrExpr::Call { target, .. } | IrExpr::BoundCall { target, .. } => target,
                _ => panic!("transitive inner call"),
            }
        }
        // Change only the exact call target, retaining the authored name,
        // operands, type and source span.
        let target = first_call(derive_mut(&mut changed, "OrdinaryDerive.can_use"));
        assert!(matches!(target, IrCallTarget::DeriveFn(name) if name == "OrdinaryDerive.inner"));
        *target = IrCallTarget::DeriveFn("Other.inner".into());
        assert!(
            checked_create_expression(&changed, &original, &cond, node_at(&db, span), &db)
                .is_none(),
            "same-named foreign target without an authored import must refuse"
        );
    }

    #[test]
    fn body_only_membership_deletion_refuses_at_create_source_boundary() {
        let (db, ir) = fixture();
        let (cond, span) = authorization_guard(&ir);
        let node = node_at(&db, span);
        let original = create_fact(&ir).clone();
        assert!(
            checked_create_expression(&ir, &original, &cond, node, &db).is_some(),
            "original authorization call keeps create-source correspondence"
        );
        // Body-only deletion: the mutable IR callee body loses its
        // membership read while the checked call, result type and span
        // stay identical. Lane selection authenticates the original
        // declaration, so the sealed lane refuses; ordinary derive
        // matching must never admit this call.
        let mut changed = ir.clone();
        let derive = changed
            .items
            .iter()
            .find(|item| item.canonical == "AuthorizationCanUse.can_use")
            .unwrap()
            .id;
        let IrItemKind::DeriveFn { expr, .. } = &mut changed.items[derive.0 as usize].kind else {
            panic!("derive")
        };
        let body = expr.as_mut().unwrap();
        assert_eq!(body.ty, ResolvedType::Scalar(Scalar::Bool));
        body.expr = IrExpr::Bool(true);
        let (cond, span) = authorization_guard(&changed);
        let node = node_at(&db, span);
        assert!(
            checked_create_expression(&changed, &original, &cond, node, &db).is_none(),
            "body-only membership deletion must refuse"
        );
    }
}
