//! Private original named-page WHERE identities; no execution authority.
use std::collections::{HashMap, HashSet};
use std::fmt::Debug;
use std::hash::Hash;

use crate::analysis::CheckedProgram;
use crate::analysis::resolve::SymbolKind;
use crate::analysis::types::CheckedQueryClauseKind;
use crate::analysis::{NodeKey, ResolvedType, Scalar, kids};
use crate::source::{Source, SourceDb, Span};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{IrExpr, IrModule, IrPage, IrProgram, IrUi, TypedExpr};

/// Only original checked source can construct this inventory. Every IR field
/// is sealed before a consumer receives the immutable predicate map.
pub(super) struct PreparedReadPredicates {
    predicates: HashMap<Span, serde_json::Value>,
    booleans: HashMap<Span, serde_json::Value>,
    source_requires: HashMap<Span, serde_json::Value>,
    boolean_derives: HashSet<String>,
    boolean_rules: HashSet<String>,
    closure: String,
}

impl PreparedReadPredicates {
    /// An internal helper needs no ordinary entry when every checked source
    /// call selects an authenticated Require or private handler variant.
    /// A call in a default, view, hook, exported helper or ordinary write is
    /// outside these exact roots and therefore keeps the ordinary lowering.
    pub(super) fn private_only_derives(
        &self,
        context: &super::scenario_decisions::FreshSourceContext<'_>,
        owner_handlers: &HashSet<crate::analysis::resolve::SymbolId>,
    ) -> Option<HashSet<String>> {
        use crate::analysis::types::SelectedCallTarget;
        use super::ir::IrItemKind;
        checked_context(context)?;
        if self.closure != format!("{:?}", context.ir()) { return None; }
        let program = context.original();
        let private_roots = owner_handlers.iter().map(|id| {
            let owner = context.ir().items.get(id.0 as usize)?;
            super::scenario_decisions::owner_handler_queries(context, owner)?;
            let scenario = program.effects.scenarios.get(id)?;
            Some(scenario.guards.iter().chain(&scenario.effects)
                .map(|effect| effect.node).collect::<Vec<_>>())
        }).collect::<Option<Vec<_>>>()?.into_iter().flatten().collect::<Vec<_>>();
        let mut result = HashSet::new();
        for item in &context.ir().items {
            if item.exported || !matches!(&item.kind, IrItemKind::DeriveFn { expr: Some(_), .. }) {
                continue;
            }
            let calls = program.types.selected_calls.iter().filter_map(|(node, call)| {
                matches!(call.target, SelectedCallTarget::DeriveFn(id) if id == item.id).then_some(*node)
            }).collect::<Vec<_>>();
            // Unused unsupported source is still checked. In particular an
            // empty census cannot turn an unsupported derive into dead code.
            if calls.is_empty() { continue; }
            let boolean = self.boolean_derives.contains(&item.canonical);
            if calls.iter().all(|node| {
                let at = Span::new(node.file, node.start, node.end);
                private_roots.iter().any(|root| root.file == node.file
                    && root.start <= node.start && node.end <= root.end)
                    || boolean && self.source_requires.keys()
                        .any(|root| contains(*root, at))
            }) {
                result.insert(item.canonical.clone());
            }
        }
        Some(result)
    }

    pub fn source_requires(&self, ir: &IrProgram) -> Option<&HashMap<Span, serde_json::Value>> {
        (self.closure == format!("{ir:?}")).then_some(&self.source_requires)
    }
    pub fn boolean_rules(&self, ir: &IrProgram) -> Option<&HashSet<String>> {
        (self.closure == format!("{ir:?}")).then_some(&self.boolean_rules)
    }
    pub fn boolean_derives(&self, ir: &IrProgram) -> Option<&HashSet<String>> {
        (self.closure == format!("{ir:?}")).then_some(&self.boolean_derives)
    }
    pub fn booleans(&self, ir: &IrProgram) -> Option<&HashMap<Span, serde_json::Value>> {
        (self.closure == format!("{ir:?}")).then_some(&self.booleans)
    }

    pub fn predicates(&self, ir: &IrProgram) -> Option<&HashMap<Span, serde_json::Value>> {
        (self.closure == format!("{ir:?}")).then_some(&self.predicates)
    }
}

fn same_map<K: Eq + Hash, V: Debug>(a: &HashMap<K, V>, b: &HashMap<K, V>) -> bool {
    a.len() == b.len()
        && a.iter().all(|(key, value)| {
            b.get(key)
                .is_some_and(|other| format!("{value:?}") == format!("{other:?}"))
        })
}

// Stable declaration order, independently of hash-map iteration order. The
// original checked map entries are compared separately; the final seal covers
// the complete IR, including its private source inventories.
fn execution_closure(ir: &IrProgram) -> String {
    format!(
        "{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
        ir.modules,
        ir.items,
        ir.read_rules,
        ir.callback_read_rules,
        ir.invariants,
        ir.locks,
        ir.retention,
        ir.crud_when,
        ir.preferences_valid,
        ir.catalog_version,
        ir.referenced_builtins,
        ir.suites,
        ir.migrations,
    )
}

// Existing immutable census validators compare their private map-bearing
// snapshots semantically, without depending on fresh HashMap debug order.
fn same_source_inventories(actual: &IrProgram, fresh: &IrProgram, db: &SourceDb) -> bool {
    let a = &actual.committed_sources;
    let b = &fresh.committed_sources;
    let x = &actual.standard_completion_sources;
    let y = &fresh.standard_completion_sources;
    a.sources == b.sources
        && format!("{:?}", a.handlers) == format!("{:?}", b.handlers)
        && a.has_empty_value_inventory_fact() == b.has_empty_value_inventory_fact()
        && a.has_complete_empty_value_inventory(actual, db)
            == b.has_complete_empty_value_inventory(fresh, db)
        && a.has_standard_value_inventory_fact() == b.has_standard_value_inventory_fact()
        && a.standard_value_inventory_roots(actual, db)
            == b.standard_value_inventory_roots(fresh, db)
        && x.sources == y.sources
        && format!("{:?}", x.handlers) == format!("{:?}", y.handlers)
        && x.has_public_standard_completion_fact() == y.has_public_standard_completion_fact()
        && x.valid_public_standard_completions(actual, db)
            == y.valid_public_standard_completions(fresh, db)
        && format!("{:?}", actual.callback_grants) == format!("{:?}", fresh.callback_grants)
}

fn checked_context(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Option<()> {
    let program = context.program();
    let ir = context.ir();
    let db = context.db();
    let original = context.original();
    let fresh = context.fresh();
    if original.types.given_fields != program.types.given_fields
        || original.types.given_constraints != program.types.given_constraints
        || original.types.node_types != program.types.node_types
        || original.types.symbol_types != program.types.symbol_types
        || original.types.symbol_results != program.types.symbol_results
        || original.types.checked_queries != program.types.checked_queries
        || !same_map(
            &original.types.selected_calls,
            &program.types.selected_calls,
        )
        || format!("{:?}", original.modules) != format!("{:?}", program.modules)
        || format!("{:?}", original.symbols) != format!("{:?}", program.symbols)
    {
        return None;
    }
    if execution_closure(ir) != execution_closure(fresh)
        || ir.value_constraints != fresh.value_constraints
        || !same_map(&ir.scenario_disclosures, &fresh.scenario_disclosures)
        || !same_source_inventories(ir, fresh, db)
    {
        return None;
    }
    Some(())
}

/// Requires-only fallback when per-occurrence read seals refuse beside
/// unrelated IR refusals. The caller first attempts the full per-occurrence
/// preparation, which admits exactly-bound observers/read predicates whose
/// own seals verify; only when that refuses do ordinary read predicates and
/// rules remain empty here. The original guard, helper closure, parameters
/// and the complete retained IR still keep their seals. Unrelated diagnostics
/// remain and still prevent installing the whole artifact.
pub(super) fn prepare_requires_with_context(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Option<PreparedReadPredicates> {
    checked_context(context)?;
    let (source_requires, boolean_derives) = source_require_inventory(context)?;
    Some(PreparedReadPredicates {
        predicates: HashMap::new(),
        booleans: HashMap::new(),
        source_requires,
        boolean_derives,
        boolean_rules: HashSet::new(),
        closure: format!("{:?}", context.ir()),
    })
}

fn lambda_body(ui: &IrUi, page_span: Span) -> Option<Option<&TypedExpr>> {
    if !matches!(ui.factory.as_str(), "list" | "table" | "calendar" | "board") {
        return Some(None);
    }
    let mut wheres = ui.props.iter().filter(|(name, _)| name == "where");
    let Some((_, predicate)) = wheres.next() else {
        return Some(None);
    };
    if wheres.next().is_some() || !contains(page_span, ui.span) {
        return None;
    }
    // This separately sealed transport is not a callable. Its
    // presence must not discard original callables on other pages.
    // Fresh complete IR equality above also authenticates checked
    // Bool-field data objects; they are not original callables.
    if matches!(
        &predicate.expr,
        IrExpr::PageTimePredicate(_) | IrExpr::Object(_)
    ) {
        return Some(None);
    }
    let IrExpr::Lambda { body, .. } = &predicate.expr else {
        return None;
    };
    Some(Some(body))
}

fn clause_topology_mismatch(
    original: &CheckedProgram,
    query: &SyntaxNode,
    source_clause: &SyntaxNode,
    expression: &SyntaxNode,
    clause_node: NodeKey,
    key: NodeKey,
    body: &TypedExpr,
) -> bool {
    source_clause.kind != SyntaxKind::QueryClause
        || !kids(query).iter().any(|n| NodeKey::of(n) == clause_node)
        || !kids(source_clause).iter().any(|n| NodeKey::of(n) == key)
        || expression.span != body.span
        || !contains(query.span, expression.span)
        || expression.span.start >= expression.span.end
        || original.types.node_types.get(&key) != Some(&ResolvedType::Scalar(Scalar::Bool))
        || body.ty != ResolvedType::Scalar(Scalar::Bool)
}

fn resolve_lambda_query(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    original: &CheckedProgram,
    page_node: &SyntaxNode,
    seal_steps: &mut usize,
    ui_span: Span,
    body: &TypedExpr,
) -> Option<(Span, NodeKey, Span)> {
    let collection = super::scenario_decisions::find_page_key(
        page_node,
        NodeKey {
            file: ui_span.file,
            start: ui_span.start,
            end: ui_span.end,
            kind: SyntaxKind::Collection as u8,
        },
        seal_steps,
    )?;
    let query = super::scenario_decisions::collection_source_query(collection)?;
    if !contains(collection.span, query.span) {
        return None;
    }
    let checked = original.types.checked_queries.get(&NodeKey::of(query))?;
    let ResolvedType::Array { element, .. } = &checked.domain_type else {
        return None;
    };
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = element.as_ref()
    else {
        return None;
    };
    if !matches!(
        original.symbols.get(symbol.0 as usize)?.kind,
        SymbolKind::Model { .. }
    ) {
        return None;
    }
    let mut clauses = checked
        .clauses
        .iter()
        .filter(|c| c.kind == CheckedQueryClauseKind::Where);
    let clause = clauses.next()?;
    let [key] = clause.expressions.as_slice() else {
        return None;
    };
    let expression = super::scenario_decisions::find_page_key(page_node, *key, seal_steps)?;
    let source_clause =
        super::scenario_decisions::find_page_key(page_node, clause.node, seal_steps)?;
    if clauses.next().is_some()
        || clause_topology_mismatch(
            original,
            query,
            source_clause,
            expression,
            clause.node,
            *key,
            body,
        )
    {
        return None;
    }
    Some((query.span, *key, expression.span))
}

fn seal_ui_predicate(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    original: &CheckedProgram,
    page_node: &SyntaxNode,
    seal_steps: &mut usize,
    source: &Source,
    module: &IrModule,
    page: &IrPage,
    ui: &IrUi,
    predicates: &mut HashMap<Span, serde_json::Value>,
) -> Option<()> {
    let Some(body) = lambda_body(ui, page_node.span)? else {
        return Some(());
    };
    let (query_span, key, expression_span) =
        resolve_lambda_query(context, original, page_node, seal_steps, ui.span, body)?;
    let identity = serde_json::json!({
        "source":{"path":source.path,"sha256":source.sha256,"module":module.name},
        "owner":format!("{}.{}", page.owner, page.fn_name),
        "node":{"start":key.start,"end":key.end},
        "statement":{"start":query_span.start,"end":query_span.end},
    });
    if predicates.len() >= 200 || predicates.insert(expression_span, identity).is_some() {
        return None;
    }
    Some(())
}

fn seal_page_predicates(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    seal_steps: &mut usize,
    source: &Source,
    module: &IrModule,
    page: &IrPage,
    predicates: &mut HashMap<Span, serde_json::Value>,
) -> Option<()> {
    let trees = context.trees();
    let original = context.original();
    // The sealed page subtree carries this owner's CST; a missing
    // anchor refuses exactly like the previous whole-tree lookup did.
    let (_, tree) = trees.iter().find(|(file, _)| *file == page.span.file)?;
    let page_node = super::scenario_decisions::find_page_root(
        tree,
        NodeKey {
            file: page.span.file,
            start: page.span.start,
            end: page.span.end,
            kind: SyntaxKind::Page as u8,
        },
        seal_steps,
    )?;
    if page.owner != module.name || !contains(module.span, page.span) {
        return None;
    }
    let mut pending = page.render.iter().rev().collect::<Vec<_>>();
    while let Some(ui) = pending.pop() {
        pending.extend(ui.children.iter().rev());
        seal_ui_predicate(
            context,
            original,
            page_node,
            seal_steps,
            source,
            module,
            page,
            ui,
            predicates,
        )?;
    }
    Some(())
}

fn seal_module_predicates(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    seal_steps: &mut usize,
    module: &IrModule,
    predicates: &mut HashMap<Span, serde_json::Value>,
) -> Option<()> {
    let db = context.db();
    let source = db.get(module.file)?;
    if db
        .iter()
        .filter(|(_, file)| file.path == source.path)
        .count()
        != 1
    {
        return None;
    }
    for page in &module.pages {
        seal_page_predicates(context, seal_steps, source, module, page, predicates)?;
    }
    Some(())
}

fn collect_boolean_predicates(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    predicates: &mut HashMap<Span, serde_json::Value>,
) -> Option<(
    HashMap<Span, serde_json::Value>,
    HashSet<String>,
)> {
    let mut booleans = HashMap::new();
    let mut boolean_derives = HashSet::new();
    for (span, identity, sites) in super::scenario_decisions::serialize_read_booleans(context)? {
        for site in sites {
            for call in site.calls {
                if let super::scenario_decisions::SerialDecisionTarget::Derive { name } =
                    call.target
                {
                    boolean_derives.insert(name);
                }
            }
        }
        let mut predicate = identity.clone();
        let object = predicate.as_object_mut()?;
        object.remove("model");
        object.remove("kind");
        object.remove("field");
        if predicates.insert(span, predicate).is_some() || booleans.insert(span, identity).is_some()
        {
            return None;
        }
    }
    Some((booleans, boolean_derives))
}

/// Required business-reference receivers must be resolved only when the
/// original read predicate reaches them. A plain identity carrier has no
/// stored fields; treating it as a row silently turns a genuine policy false.
fn reads_required_reference(value: &TypedExpr, depth: usize) -> bool {
    if depth > 64 { return false; }
    match &value.expr {
        IrExpr::Member {base,..} => matches!(base.ty,ResolvedType::Record{stored:true,..})
            && matches!(base.expr,IrExpr::Member{..}) || reads_required_reference(base,depth+1),
        IrExpr::Binary {left,right,..}=>reads_required_reference(left,depth+1)||reads_required_reference(right,depth+1),
        IrExpr::Unary {operand,..}=>reads_required_reference(operand,depth+1),
        IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}=>args.iter().any(|value|reads_required_reference(value,depth+1)),
        IrExpr::Array(values)=>values.iter().any(|value|reads_required_reference(value,depth+1)),
        IrExpr::Object(fields)=>fields.iter().any(|(_,value)|reads_required_reference(value,depth+1)),
        _=>false,
    }
}

fn collect_boolean_rules(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    ir: &IrProgram,
) -> Option<(HashSet<String>, HashSet<String>)> {
    let mut boolean_derives = HashSet::new();
    let mut boolean_rules = HashSet::new();
    for rule in ir.read_rules.iter().chain(&ir.callback_read_rules) {
        if let Some(sites)=context.serialize_rule(rule)
            && (reads_required_reference(&rule.pred,0) || sites.iter().any(|site|site.calls.iter().any(|call|
                matches!(&call.target,super::scenario_decisions::SerialDecisionTarget::Builtin{id,..} if id=="active_member")))) {
            boolean_rules.insert(rule.id.clone());
            for site in sites { for call in site.calls {
                if let super::scenario_decisions::SerialDecisionTarget::Derive {name}=call.target {boolean_derives.insert(name);}
            }}
        }
    }
    Some((boolean_rules, boolean_derives))
}

pub(super) fn prepare_with_context(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Option<PreparedReadPredicates> {
    checked_context(context)?;
    let ir = context.ir();
    // Only the sealed pages spend the finite lookup budget. Unrelated
    // Given/When bulk remains in the checked/fresh cohort unvisited.
    let mut seal_steps = 0usize;
    let mut predicates = HashMap::new();
    for module in &ir.modules {
        seal_module_predicates(context, &mut seal_steps, module, &mut predicates)?;
    }
    let (booleans, mut boolean_derives) = collect_boolean_predicates(context, &mut predicates)?;
    let (source_requires, require_derives) = source_require_inventory(context)?;
    boolean_derives.extend(require_derives);
    let (boolean_rules, rule_derives) = collect_boolean_rules(context, ir)?;
    boolean_derives.extend(rule_derives);
    Some(PreparedReadPredicates {
        predicates,
        booleans,
        source_requires,
        boolean_derives,
        boolean_rules,
        closure: format!("{ir:?}"),
    })
}

fn source_require_inventory(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Option<(HashMap<Span, serde_json::Value>, HashSet<String>)> {
    let mut boolean_derives = HashSet::new();
    let mut source_requires = HashMap::new();
    for (span, identity) in super::scenario_decisions::serialize_scenario_requires(context)? {
        for site in identity["sites"].as_array()? {
            for call in site["calls"].as_array()? {
                if call["target"]["kind"] == "derive" {
                    boolean_derives.insert(call["target"]["name"].as_str()?.to_owned());
                }
            }
        }
        if source_requires.insert(span, identity).is_some() {
            return None;
        }
    }
    Some((source_requires, boolean_derives))
}

fn contains(outer: Span, inner: Span) -> bool {
    outer.file == inner.file && outer.start <= inner.start && inner.end <= outer.end
}

