//! Nongrant correspondence for the original schema of a scenario-created row.
//! Defaults stay in the owning model descriptor; this join never evaluates them.
use std::collections::HashMap;

use crate::analysis::NodeKey;
use crate::analysis::resolve::{ModelOwner, ModuleKind};
use crate::analysis::scenario_disclosure::{CheckedScenarioCreate, DisclosureSource};
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
    if model.id != original.model
        || declaration.model != original.model
        || model.module != owner.module
        || model.module != declaration.module
        || model.canonical != definition.canonical
        || model.span != definition.span
        || *actual_owner != expected_owner
        || fields.len() > 200
        || fields.len() != declaration.fields.len()
        || fields.len() != definition.fields.len()
        || !fields
            .iter()
            .copied()
            .eq(declaration.fields.iter().map(|field| field.field))
        || !fields
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
    let generated = Emitter::new(ir).collect_models();
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
}

impl SourceExpressions<'_> {
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

    fn expression(&self, actual: &TypedExpr, key: NodeKey, depth: usize) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let mut node = *self.nodes.get(&key)?;
        if actual.span != node.span
            || self.operands
                && self
                    .original
                    .expression_types
                    .iter()
                    .find(|(at, _)| *at == key)
                    .is_none_or(|(_, original)| original != &actual.ty)
        {
            return None;
        }
        while node.kind == SyntaxKind::Group {
            let children = expressions(node);
            let [child] = children.as_slice() else {
                return None;
            };
            if self.operands
                && self
                    .original
                    .expression_types
                    .iter()
                    .find(|(at, _)| *at == NodeKey::of(child))
                    .is_none_or(|(_, original)| original != &actual.ty)
            {
                return None;
            }
            node = child;
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
                    IrBinOp::Mod | IrBinOp::Add | IrBinOp::Sub | IrBinOp::Mul | IrBinOp::Div => {
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
                    target: IrCallTarget::Builtin { id, .. },
                    args,
                },
                SyntaxKind::Call,
            ) if self.operands && id == "count" && primitive(Scalar::Int) => {
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
