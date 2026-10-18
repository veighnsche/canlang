//! Original conditional unique declaration -> existing QueryPredicate facts.
//! These facts confer no native authority and do not change artifact uniqueKeys.
use super::ir::{
    self, IrBinOp, IrExpr, IrItem, IrItemKind, IrModule, IrProgram, IrType, IrUnOp, IrUnique,
    TypedExpr,
};
use crate::analysis::catalog::Catalog;
use crate::analysis::effects::{ModelData, RuleKind, UniqueRule};
use crate::analysis::scenario_disclosure::DisclosureSource;
use crate::analysis::{CheckedProgram, ModuleId, NodeKey, ResolvedType, Scalar, SymbolId};
use crate::diagnostic::Severity;
use crate::source::{Source, SourceDb, Span};
use crate::syntax::{SyntaxKind, SyntaxNode};
use serde_json::{Value, json};
use std::collections::HashMap;

/// One source-owned existing `uniques` entry and its exact `where` registry.
/// The defining consumer must verify the generated module and bind the State
/// uniqueWhen option; a copied fact is never a native policy certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedUniqueCondition {
    pub model: SymbolId,
    pub canonical_model: String,
    pub module: ModuleId,
    pub owner_package: String,
    pub fields: Vec<String>,
    pub field_symbols: Vec<SymbolId>,
    pub registry_id: String,
    pub ordinal: u32,
    pub node: NodeKey,
    pub fields_node: NodeKey,
    pub where_node: NodeKey,
    pub source: DisclosureSource,
    pub predicate: Value,
}

fn unique_registry_id(
    actual: &IrProgram,
    fresh: &IrProgram,
    model: &IrItem,
    unique_span: Span,
    original_value: &TypedExpr,
    index: usize,
) -> Option<String> {
    let registry_id = format!(
        "{}.unique.{}",
        ir::ir_model_rule_prefix(actual, model),
        index + 1
    );
    let mut registry = actual
        .invariants
        .iter()
        .filter(|rule| rule.id == registry_id);
    let rule = registry.next()?;
    if registry.next().is_some()
        || rule.origin.is_some()
        || rule.span != unique_span
        || format!("{:?}", rule.pred) != format!("{original_value:?}")
    {
        return None;
    }
    let mut fresh_registry = fresh
        .invariants
        .iter()
        .filter(|rule| rule.id == registry_id);
    let original_rule = fresh_registry.next()?;
    if fresh_registry.next().is_some() || format!("{rule:?}") != format!("{original_rule:?}") {
        return None;
    }
    Some(registry_id)
}

fn collect_unique_condition(
    actual: &IrProgram,
    fresh: &IrProgram,
    model: &IrItem,
    module: &IrModule,
    source: &Source,
    unique: &IrUnique,
    declared: &UniqueRule,
    index: usize,
    result: &mut Vec<CheckedUniqueCondition>,
) -> Option<()> {
    if declared.module != model.module
        || unique.fields != declared.fields
        || unique.span.file != declared.node.file
        || unique.span.start != declared.node.start
        || unique.span.end != declared.node.end
    {
        return None;
    }
    let Some(where_node) = declared.where_predicate else {
        if unique.where_predicate.is_some() {
            return None;
        }
        return Some(());
    };
    if declared.fields.len() != 1 || declared.fields[0].contains('.') {
        return None;
    }
    let value = unique.where_predicate.as_ref()?;
    let expected_model = fresh.items.get(model.id.0 as usize)?;
    let IrItemKind::Model {
        uniques: original_uniques,
        ..
    } = &expected_model.kind
    else {
        return None;
    };
    let original_value = original_uniques.get(index)?.where_predicate.as_ref()?;
    if format!("{value:?}") != format!("{original_value:?}") {
        return None;
    }
    let registry_id =
        unique_registry_id(actual, fresh, model, unique.span, original_value, index)?;
    let constrained = field(actual, model.id, &declared.fields[0])?;
    let mut work = 0;
    let predicate = query_predicate(actual, model.id, value, 0, &mut work)?;
    result.push(CheckedUniqueCondition {
        model: model.id,
        canonical_model: model.canonical.clone(),
        module: model.module,
        owner_package: module.name.clone(),
        fields: declared.fields.clone(),
        field_symbols: vec![constrained],
        registry_id,
        ordinal: declared.id,
        node: declared.node,
        fields_node: declared.fields_node?,
        where_node,
        source: DisclosureSource {
            path: source.path.clone(),
            sha256: source.sha256.clone(),
            module: module.name.clone(),
        },
        predicate,
    });
    Some(())
}

fn collect_model_uniques(
    program: &CheckedProgram,
    actual: &IrProgram,
    fresh: &IrProgram,
    db: &SourceDb,
    model: &IrItem,
    result: &mut Vec<CheckedUniqueCondition>,
) -> Option<()> {
    let IrItemKind::Model { uniques, .. } = &model.kind else {
        return Some(());
    };
    let declaration = program.effects.models.get(&model.id)?;
    if declaration.model != model.id
        || declaration.module != model.module
        || uniques.len() != declaration.uniques.len()
    {
        return None;
    }
    let module = actual.modules.get(model.module.0 as usize)?;
    let source = db.get(declaration.node.file)?;
    if module.id != model.module || module.file != declaration.node.file {
        return None;
    }
    for (index, (unique, declared)) in uniques.iter().zip(&declaration.uniques).enumerate() {
        collect_unique_condition(
            actual,
            fresh,
            model,
            module,
            source,
            unique,
            declared,
            index,
            result,
        )?;
    }
    Some(())
}

/// Only the released singular primitive conditional-unique profile is emitted.
/// No inferred unconditional key, invariant or composite-key transport exists.
pub fn collect_checked_unique_conditions(
    program: &CheckedProgram,
    actual: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<CheckedUniqueCondition>> {
    let fresh = fresh_rule_ir(program, actual, db, catalog)?;
    let _ = model_rule_origins(program, actual, db)?;
    let mut result = Vec::new();
    for model in &actual.items {
        collect_model_uniques(program, actual, &fresh, db, model, &mut result)?;
    }
    // Effects ordinals retain true declaration order across model grouping.
    result.sort_by_key(|condition| condition.ordinal);
    Some(result)
}

/// Complete nongrant global declaration census. The conditional unique fact
/// joins this single inventory by ordinal, owner, source and declaration anchor.
/// This does not register any model rule or grant callback/row authority.
pub fn collect_checked_model_rule_origins(
    program: &CheckedProgram,
    actual: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<Value>> {
    let _ = fresh_rule_ir(program, actual, db, catalog)?;
    model_rule_origins(program, actual, db)
}

fn fresh_modules_match(actual: &IrProgram, fresh: &IrProgram) -> bool {
    for (actual, expected) in actual.modules.iter().zip(&fresh.modules) {
        if actual.id != expected.id
            || actual.name != expected.name
            || actual.kind != expected.kind
            || actual.file != expected.file
            || actual.span != expected.span
            || format!("{:?}", actual.imports) != format!("{:?}", expected.imports)
        {
            return false;
        }
    }
    true
}

fn fresh_items_match(actual: &IrProgram, fresh: &IrProgram) -> bool {
    // Whole original owning declarations include type/default/server/source and
    // preserve namespace collisions which determine existing registry spelling.
    for (actual, expected) in actual.items.iter().zip(&fresh.items) {
        if (matches!(
            actual.kind,
            IrItemKind::Model { .. } | IrItemKind::Field { .. } | IrItemKind::Preferences { .. }
        ) || matches!(
            expected.kind,
            IrItemKind::Model { .. } | IrItemKind::Field { .. } | IrItemKind::Preferences { .. }
        )) && format!("{actual:?}") != format!("{expected:?}")
        {
            return false;
        }
    }
    true
}

fn fresh_rules_match(actual: &IrProgram, fresh: &IrProgram) -> bool {
    format!("{:?}", actual.read_rules) == format!("{:?}", fresh.read_rules)
        && format!("{:?}", actual.callback_read_rules)
            == format!("{:?}", fresh.callback_read_rules)
        && format!("{:?}", actual.invariants) == format!("{:?}", fresh.invariants)
        && format!("{:?}", actual.locks) == format!("{:?}", fresh.locks)
        && format!("{:?}", actual.retention) == format!("{:?}", fresh.retention)
        && format!("{:?}", actual.preferences_valid) == format!("{:?}", fresh.preferences_valid)
}

fn fresh_rule_ir(
    program: &CheckedProgram,
    actual: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<IrProgram> {
    program.validate_cohort(db, catalog).ok()?;
    let (fresh, diagnostics) = ir::build(program, db, catalog);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
        || actual.items.len() != fresh.items.len()
        || actual.modules.len() != fresh.modules.len()
        || actual.catalog_version != fresh.catalog_version
    {
        return None;
    }
    if !fresh_modules_match(actual, &fresh)
        || !fresh_items_match(actual, &fresh)
        || !fresh_rules_match(actual, &fresh)
    {
        return None;
    }
    Some(fresh)
}

fn collect_section_rules(
    db: &SourceDb,
    file: crate::source::SourceId,
    section: &SyntaxNode,
    module: ModuleId,
    syntax_order: &mut Vec<(NodeKey, ModuleId, RuleKind)>,
    original_nodes: &mut HashMap<NodeKey, SyntaxNode>,
) -> Option<()> {
    let text = &db.get(file)?.text;
    let marker = section
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)
        .and_then(|node| text.get(node.span.start as usize..node.span.end as usize))?;
    for node in &section.children {
        let kind = match (marker, node.kind) {
            ("Given", SyntaxKind::Policy) => RuleKind::Policy,
            ("Given" | "Then", SyntaxKind::Invariant) => RuleKind::Invariant,
            ("Given", SyntaxKind::Unique) => RuleKind::Unique,
            ("Given", SyntaxKind::Lock) => RuleKind::Lock,
            ("Given", SyntaxKind::Retain) => RuleKind::Retain,
            _ => continue,
        };
        let key = NodeKey::of(node);
        syntax_order.push((key, module, kind));
        if original_nodes.insert(key, node.clone()).is_some() {
            return None;
        }
    }
    Some(())
}

fn collect_syntax_order(
    program: &CheckedProgram,
    db: &SourceDb,
) -> Option<(
    Vec<(NodeKey, ModuleId, RuleKind)>,
    HashMap<NodeKey, SyntaxNode>,
)> {
    // Re-read the original source allocation order. Editable rule IDs cannot
    // authenticate themselves merely by being sorted or copied into fresh IR.
    let mut syntax_order = Vec::new();
    let mut original_nodes = HashMap::new();
    for file in program.checked_files() {
        let (tree, diagnostics) = crate::syntax::parse(db, *file);
        if !diagnostics.is_empty() {
            return None;
        }
        for module_node in tree
            .children
            .iter()
            .filter(|node| matches!(node.kind, SyntaxKind::App | SyntaxKind::Package))
        {
            let module = program
                .modules
                .iter()
                .find(|module| module.file == *file && module.span == module_node.span)?;
            let text = &db.get(*file)?.text;
            if !module_node.children.iter().any(|node| {
                node.span == module.name_span
                    && text.get(node.span.start as usize..node.span.end as usize)
                        == Some(module.name.as_str())
            }) {
                return None;
            }
            for section in module_node
                .children
                .iter()
                .filter(|node| node.kind == SyntaxKind::Section)
            {
                collect_section_rules(
                    db,
                    *file,
                    section,
                    module.id,
                    &mut syntax_order,
                    &mut original_nodes,
                )?;
            }
        }
    }
    Some((syntax_order, original_nodes))
}

fn rule_keyword(kind: RuleKind) -> &'static str {
    match kind {
        RuleKind::Policy => "policy",
        RuleKind::Invariant => "invariant",
        RuleKind::Unique => "unique",
        RuleKind::Lock => "lock",
        RuleKind::Retain => "retain",
    }
}

fn rule_declaration_ok(
    declaration: &SyntaxNode,
    expected: SyntaxKind,
    owner: &IrItem,
    owning: &IrModule,
    target: SymbolId,
    module: ModuleId,
    node: NodeKey,
) -> bool {
    declaration.kind != expected
        || owner.id != target
        || owner.module != module
        || owning.id != module
        || owning.file != node.file
        || owner.canonical != format!("{}.{}", owning.name, owner.name)
        || !matches!(
            owner.kind,
            IrItemKind::Model { .. } | IrItemKind::Preferences { .. }
        )
}

fn push_rule_origin(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    ordinal: u32,
    kind: RuleKind,
    target: SymbolId,
    module: ModuleId,
    node: NodeKey,
    registry: Option<String>,
) -> Option<()> {
    let declaration: &SyntaxNode = original_nodes.get(&node)?;
    let expected = match kind {
        RuleKind::Policy => SyntaxKind::Policy,
        RuleKind::Invariant => SyntaxKind::Invariant,
        RuleKind::Unique => SyntaxKind::Unique,
        RuleKind::Lock => SyntaxKind::Lock,
        RuleKind::Retain => SyntaxKind::Retain,
    };
    let owner = actual.items.get(target.0 as usize)?;
    let owning = actual.modules.get(module.0 as usize)?;
    let source = db.get(node.file)?;
    if !rule_declaration_ok(declaration, expected, owner, owning, target, module, node) {
        return None;
    }
    let authored = source
        .text
        .get(node.start as usize..node.end as usize)?
        .trim();
    let keyword = rule_keyword(kind);
    let subject = authored
        .strip_prefix(keyword)?
        .split_whitespace()
        .next()?
        .trim_end_matches(':');
    if subject != owner.name && subject != owner.canonical {
        return None;
    }
    let mut entry = json!({"ordinal":ordinal,"kind":keyword,"model":owner.canonical,"ownerPackage":owning.name,
        "source":{"path":source.path,"sha256":source.sha256,"module":owning.name},
        "declaredAt":{"start":node.start,"end":node.end}});
    if let Some(registry) = registry {
        entry["registryId"] = json!(registry);
    }
    output.push((ordinal, node, module, kind, entry));
    Some(())
}

fn add_policy_origins(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    model: &ModelData,
    prefix: &str,
) -> Option<()> {
    for (index, policy) in model.policies.iter().enumerate() {
        let read_id = format!("{prefix}.read.{}", index + 1);
        let callback_id = format!("{prefix}.callbackRead.{}", index + 1);
        let rules = actual
            .read_rules
            .iter()
            .chain(&actual.callback_read_rules)
            .filter(|rule| rule.id == read_id || rule.id == callback_id)
            .collect::<Vec<_>>();
        if rules.is_empty()
            || rules.iter().any(|rule| {
                rule.span.file != policy.node.file
                    || rule.span.start != policy.node.start
                    || rule.span.end != policy.node.end
                    || rule.origin.is_some()
            })
        {
            return None;
        }
        let registry = if rules.iter().any(|rule| rule.id == read_id) {
            read_id
        } else {
            callback_id
        };
        push_rule_origin(
            original_nodes,
            actual,
            db,
            output,
            policy.id,
            RuleKind::Policy,
            model.model,
            policy.module,
            policy.node,
            Some(registry),
        )?;
    }
    Some(())
}

fn add_invariant_origins(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    model: &ModelData,
    prefix: &str,
) -> Option<()> {
    for (index, invariant) in model.invariants.iter().enumerate() {
        let id = format!("{prefix}.require.{}", index + 1);
        let rule = actual.invariants.iter().find(|rule| rule.id == id)?;
        let origin = rule.origin.as_ref()?;
        if origin.model != model.model
            || origin.module != invariant.module
            || origin.node != invariant.node
            || origin.ordinal != invariant.id
            || origin.kind != ir::IrModelRuleKind::Invariant
        {
            return None;
        }
        push_rule_origin(
            original_nodes,
            actual,
            db,
            output,
            invariant.id,
            RuleKind::Invariant,
            model.model,
            invariant.module,
            invariant.node,
            Some(id),
        )?;
    }
    Some(())
}

fn add_unique_origins(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    model: &ModelData,
    prefix: &str,
) -> Option<()> {
    for (index, unique) in model.uniques.iter().enumerate() {
        let id = unique
            .where_predicate
            .map(|_| format!("{prefix}.unique.{}", index + 1));
        if let Some(id) = &id {
            let rule = actual.invariants.iter().find(|rule| &rule.id == id)?;
            if rule.origin.is_some() {
                return None;
            }
        }
        push_rule_origin(
            original_nodes,
            actual,
            db,
            output,
            unique.id,
            RuleKind::Unique,
            model.model,
            unique.module,
            unique.node,
            id,
        )?;
    }
    Some(())
}

fn add_lock_origins(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    model: &ModelData,
    prefix: &str,
) -> Option<()> {
    for (index, lock) in model.locks.iter().enumerate() {
        let id = format!("{prefix}.lock.{}", index + 1);
        let rule = actual.locks.iter().find(|rule| rule.id == id)?;
        if rule.origin.model != model.model
            || rule.origin.module != lock.module
            || rule.origin.ordinal != lock.id
            || rule.origin.node != lock.node
            || rule.origin.kind != ir::IrModelRuleKind::Lock
        {
            return None;
        }
        push_rule_origin(
            original_nodes,
            actual,
            db,
            output,
            lock.id,
            RuleKind::Lock,
            model.model,
            lock.module,
            lock.node,
            Some(id),
        )?;
    }
    Some(())
}

fn add_retain_origins(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    model: &ModelData,
    prefix: &str,
) -> Option<()> {
    for retained in &model.retains {
        let _rule = actual.retention.iter().find(|rule| rule.name == prefix)?;
        push_rule_origin(
            original_nodes,
            actual,
            db,
            output,
            retained.id,
            RuleKind::Retain,
            model.model,
            retained.module,
            retained.node,
            Some(prefix.into()),
        )?;
    }
    Some(())
}

fn add_model_origins(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    model: &ModelData,
) -> Option<()> {
    let owner = actual.items.get(model.model.0 as usize)?;
    let IrItemKind::Model { .. } = &owner.kind else {
        return None;
    };
    let prefix = ir::ir_model_rule_prefix(actual, owner);
    add_policy_origins(original_nodes, actual, db, output, model, &prefix)?;
    add_invariant_origins(original_nodes, actual, db, output, model, &prefix)?;
    add_unique_origins(original_nodes, actual, db, output, model, &prefix)?;
    add_lock_origins(original_nodes, actual, db, output, model, &prefix)?;
    add_retain_origins(original_nodes, actual, db, output, model, &prefix)?;
    Some(())
}

fn add_record_origins(
    original_nodes: &HashMap<NodeKey, SyntaxNode>,
    actual: &IrProgram,
    db: &SourceDb,
    output: &mut Vec<(u32, NodeKey, ModuleId, RuleKind, Value)>,
    program: &CheckedProgram,
) -> Option<()> {
    for record in program
        .effects
        .records
        .values()
        .filter(|record| !record.invariants.is_empty())
    {
        let owner = actual.items.get(record.record.0 as usize)?;
        let IrItemKind::Preferences {
            validate: Some(id), ..
        } = &owner.kind
        else {
            return None;
        };
        let _rule = actual
            .preferences_valid
            .iter()
            .find(|rule| &rule.name == id)?;
        for invariant in &record.invariants {
            push_rule_origin(
                original_nodes,
                actual,
                db,
                output,
                invariant.id,
                RuleKind::Invariant,
                record.record,
                invariant.module,
                invariant.node,
                Some(id.clone()),
            )?;
        }
    }
    Some(())
}

fn model_rule_origins(
    program: &CheckedProgram,
    actual: &IrProgram,
    db: &SourceDb,
) -> Option<Vec<Value>> {
    let (syntax_order, original_nodes) = collect_syntax_order(program, db)?;
    let mut output = Vec::<(u32, NodeKey, ModuleId, RuleKind, Value)>::new();
    let mut output = Vec::<(u32, NodeKey, ModuleId, RuleKind, Value)>::new();
    for model in program.effects.models.values() {
        add_model_origins(&original_nodes, actual, db, &mut output, model)?;
    }
    add_record_origins(&original_nodes, actual, db, &mut output, program)?;
    output.sort_by_key(|entry| entry.0);
    if output.len() != syntax_order.len() {
        return None;
    }
    for (index, ((ordinal, node, module, kind, _), (source_node, source_module, source_kind))) in
        output.iter().zip(&syntax_order).enumerate()
    {
        if *ordinal != u32::try_from(index).ok()?
            || node != source_node
            || module != source_module
            || kind != source_kind
        {
            return None;
        }
    }
    Some(output.into_iter().map(|entry| entry.4).collect())
}

fn field(ir: &IrProgram, model: SymbolId, name: &str) -> Option<SymbolId> {
    if matches!(
        name,
        "id" | "version"
            | "parent"
            | "created"
            | "updated"
            | "createdBy"
            | "updatedBy"
            | "archivedAt"
    ) {
        return None;
    }
    let owning = ir.items.get(model.0 as usize)?;
    let IrItemKind::Model { fields, .. } = &owning.kind else {
        return None;
    };
    let mut selected = fields.iter().filter_map(|id| {
        ir.items
            .get(id.0 as usize)
            .filter(|item| item.id == *id && item.name == name)
    });
    let selected = selected.next()?;
    if fields
        .iter()
        .filter(|id| {
            ir.items
                .get(id.0 as usize)
                .is_some_and(|item| item.name == name)
        })
        .count()
        != 1
        || selected.module != owning.module
        || selected.canonical != format!("{}.{}", owning.canonical, name)
        || !matches!(&selected.kind, IrItemKind::Field { owner, ty: IrType::Known(ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool)), required_array: false, .. } if *owner == model)
    {
        return None;
    }
    Some(selected.id)
}

fn member(ir: &IrProgram, model: SymbolId, value: &TypedExpr) -> Option<String> {
    let IrExpr::Member { base, field: name } = &value.expr else {
        return None;
    };
    if !matches!(&base.expr, IrExpr::Name(name) if name == "row")
        || base.ty
            != (ResolvedType::Record {
                symbol: model,
                stored: true,
            })
    {
        return None;
    }
    let symbol = field(ir, model, name)?;
    if !matches!(&ir.items.get(symbol.0 as usize)?.kind, IrItemKind::Field { ty: IrType::Known(ty), .. } if ty == &value.ty)
    {
        return None;
    }
    Some(name.clone())
}

fn query_predicate(
    ir: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    depth: usize,
    work: &mut usize,
) -> Option<Value> {
    *work += 1;
    if depth > 32 || *work > 128 || expr.ty != ResolvedType::Scalar(Scalar::Bool) {
        return None;
    }
    match &expr.expr {
        IrExpr::Member { .. } => {
            Some(json!({"op":"eq","field":member(ir, model, expr)?,"value":true}))
        }
        IrExpr::Binary {
            op: op @ (IrBinOp::And | IrBinOp::Or),
            left,
            right,
        } => Some(json!({
            "op":if *op == IrBinOp::And { "and" } else { "or" },
            "args":[query_predicate(ir,model,left,depth+1,work)?,query_predicate(ir,model,right,depth+1,work)?]
        })),
        IrExpr::Unary {
            op: IrUnOp::Not,
            operand,
        } => Some(json!({"op":"not","arg":query_predicate(ir,model,operand,depth+1,work)?})),
        IrExpr::Binary {
            op: op @ (IrBinOp::Eq | IrBinOp::Ne),
            left,
            right,
        } => {
            let name = member(ir, model, left)?;
            if left.ty != right.ty {
                return None;
            }
            let value = match (&right.expr, &right.ty) {
                (IrExpr::Bool(value), ResolvedType::Scalar(Scalar::Bool)) => json!(value),
                (IrExpr::Text(value), ResolvedType::Scalar(Scalar::Text)) => json!(value),
                // Stored Can int wire is canonical decimal text. Only equality
                // is admitted, so State's existing scalar comparison agrees.
                (IrExpr::Int(value), ResolvedType::Scalar(Scalar::Int)) => json!(value.to_string()),
                _ => return None,
            };
            Some(json!({"op":if *op == IrBinOp::Eq {"eq"} else {"ne"},"field":name,"value":value}))
        }
        _ => None,
    }
}
