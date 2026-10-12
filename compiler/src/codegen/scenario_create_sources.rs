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
    IrProgram, IrServer, IrType, IrUnOp, TypedExpr, ir_model_rule_prefix,
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
    if model.id != original.model
        || declaration.model != original.model
        || model.module != owner.module
        || model.module != declaration.module
        || model.canonical != definition.canonical
        || model.span != definition.span
        || *actual_owner != expected_owner
        || fields.len() > 200
        || stored_fields.len() != declaration.fields.len()
        || stored_fields.len() != definition.fields.len()
        || !stored_fields
            .iter()
            .copied()
            .eq(declaration.fields.iter().map(|field| field.field))
        || !stored_fields
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
            model_identity(ir, owner, *symbol, db)?;
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
            (None, None) => {}
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
            // No original application creates a model with an established
            // computed default here; retain its refusal instead of dropping it.
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
        if modifiers.trim != trim || modifiers.unique != unique || modifiers.machine != machine {
            return None;
        }
        matcher.optional(modifiers.min.as_ref(), minimum)?;
        matcher.optional(modifiers.max.as_ref(), maximum)?;
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

fn reference_name(
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
    checked_create_expression(ir, original, actual, node, db)
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
    }
    .expression(actual, node, 0)
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
}

impl SourceExpressions<'_> {
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
        if actual.ty != *result {
            return None;
        }
        if let Some(slots) = slots {
            if slots.len() != args.len()
                || slots
                    .iter()
                    .enumerate()
                    .any(|(index, slot)| *slot != Some(index))
            {
                return None;
            }
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
    fn authorization_shaped(&self, actual: &TypedExpr) -> bool {
        fn contains_membership(expr: &TypedExpr, depth: usize) -> bool {
            if depth > 32 {
                return false;
            }
            match &expr.expr {
                IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                    matches!(target, IrCallTarget::Builtin { id, .. } if id == "active_member")
                        || args.iter().any(|arg| contains_membership(arg, depth + 1))
                }
                IrExpr::Member { base, .. } => contains_membership(base, depth + 1),
                IrExpr::Binary { left, right, .. } => {
                    contains_membership(left, depth + 1) || contains_membership(right, depth + 1)
                }
                IrExpr::Unary { operand, .. } => contains_membership(operand, depth + 1),
                _ => false,
            }
        }
        let target = match &actual.expr {
            IrExpr::Call {
                target: IrCallTarget::DeriveFn(target),
                ..
            }
            | IrExpr::BoundCall {
                target: IrCallTarget::DeriveFn(target),
                ..
            } => target,
            _ => return false,
        };
        let Some(item) = self.ir.items.iter().find(|item| &item.canonical == target) else {
            return false;
        };
        let IrItemKind::DeriveFn {
            expr: Some(body), ..
        } = &item.kind
        else {
            return false;
        };
        contains_membership(body, 0)
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
                single_name(node, self.text)? == name
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
                    || !matches!(&base.expr, IrExpr::Name(name) if name == "row")
                {
                    return None;
                }
                let declared = self
                    .original
                    .definition
                    .fields
                    .iter()
                    .find(|item| item.name == *field)?;
                if actual.ty != declared.ty && declared.ty.nullable_inner() != Some(&actual.ty) {
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
                if NodeKey::of(source_argument) != query.node
                    || source_path(self.nodes.get(&query.domain)?, self.text)?
                        != self.ir.items.get(query.model.0 as usize)?.name
                    || source_path(self.nodes.get(&query.first.as_ref()?.actor)?, self.text)?
                        != "actor"
                    || source_path(self.nodes.get(&query.order.first()?.node)?, self.text)?
                        != "row.id"
                {
                    return None;
                }
                let IrExpr::Query(scan) = &domain.expr else {
                    return None;
                };
                self.expression(scan.where_pred.as_ref()?, query.predicate?, depth + 1)?;
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
                if self.authorization(actual, NodeKey::of(node), depth).is_none() {
                    if self.authorization_shaped(actual) {
                        return None;
                    }
                    self.derive_call(actual, &node, depth)?;
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
                self.derive_call(actual, &node, depth)?;
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
