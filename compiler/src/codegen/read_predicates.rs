//! Private original named-page WHERE identities; no execution authority.
use std::collections::{HashMap, HashSet};
use std::fmt::Debug;
use std::hash::Hash;

use crate::analysis::CheckedProgram;
#[cfg(test)]
use crate::analysis::catalog::Catalog;
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

#[cfg(test)]
pub(super) fn prepare(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<PreparedReadPredicates> {
    let context =
        super::scenario_decisions::FreshSourceContext::prepare(program, ir, db, catalog).ok()?;
    prepare_with_context(&context)
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

/// Only source Require observers may prepare beside unrelated IR refusals.
/// Ordinary read predicates/rules remain empty; the original guard, helper
/// closure, parameters and the complete retained IR still keep their seals.
/// Unrelated diagnostics remain and still prevent installing the whole artifact.
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

fn collect_boolean_rules(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    ir: &IrProgram,
) -> Option<(HashSet<String>, HashSet<String>)> {
    let mut boolean_derives = HashSet::new();
    let mut boolean_rules = HashSet::new();
    for rule in ir.read_rules.iter().chain(&ir.callback_read_rules) {
        if let Some(sites)=context.serialize_rule(rule)
            && sites.iter().any(|site|site.calls.iter().any(|call|
                matches!(&call.target,super::scenario_decisions::SerialDecisionTarget::Builtin{id,..} if id=="active_member"))) {
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

#[cfg(test)]
mod tests {
    use super::super::ir;
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};

    const SOURCE: &str = "app ReadPredicates\nGiven\n role reviewer\n Person {account:user,enabled:bool}\n policy Person read=members\nWhen\nThen\n page /people title=\"People\"\n  list Person as person where person.enabled\n   text row.account\n  list Person as person where reviewer(person.account)\n   text row.account\n";

    fn checked() -> (SourceDb, Catalog, CheckedProgram, IrProgram) {
        checked_source(SOURCE)
    }

    fn checked_source(source: &str) -> (SourceDb, Catalog, CheckedProgram, IrProgram) {
        checked_given_source(source, None)
    }

    fn checked_given_source(
        source: &str,
        given: Option<&crate::analysis::types::GivenContractTables>,
    ) -> (SourceDb, Catalog, CheckedProgram, IrProgram) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut db = SourceDb::new();
        let file = db.add("read-predicates.can".into(), source.into());
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) =
            crate::analysis::check_program_with_given(&db, &[file], Some(&catalog), given);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, catalog, program, ir)
    }

    const BOOLEAN_SOURCE: &str =
        include_str!("../../../packages/cloudflare/test/fixtures/native-read-boolean.can");

    #[test]
    fn original_query_reference_boolean_graph_keeps_complete_source_census() {
        let source = include_str!(
            "../../../packages/cloudflare/test/fixtures/native-read-boolean-graph.can"
        );
        let (db, catalog, program, ir) = checked_source(source);
        let context = super::super::scenario_decisions::FreshSourceContext::prepare(
            &program,
            &ir,
            &db,
            Some(&catalog),
        )
        .unwrap();
        let sources = super::super::scenario_decisions::serialize_read_booleans(&context)
            .expect("original graph Boolean call census");
        assert_eq!(sources.len(), 2);
        let prepared = prepare(&program, &ir, &db, Some(&catalog))
            .expect("whole original source and execution seal");
        assert_eq!(prepared.booleans(&ir).unwrap().len(), 2);
        assert!(
            prepared
                .boolean_derives(&ir)
                .unwrap()
                .iter()
                .any(|name| name.ends_with("coverage_met"))
        );
        assert!(prepared.boolean_rules(&ir).unwrap().len() >= 4);
    }

    #[test]
    fn boolean_originals_keep_full_census_and_reject_source_ir_and_type_edits() {
        let (db, catalog, mut program, mut ir) = checked_source(BOOLEAN_SOURCE);
        let prepared =
            prepare(&program, &ir, &db, Some(&catalog)).expect("original Boolean observers");
        let observers = prepared.booleans(&ir).unwrap();
        assert_eq!(observers.len(), 3);
        assert!(
            observers
                .values()
                .any(|value| value["kind"] == "page-require")
        );
        assert!(observers.values().any(|value| value["field"] == "met"));
        for (span, identity) in observers {
            assert_eq!(identity["model"], "NativeBoolean.Item");
            assert_eq!(
                prepared.predicates(&ir).unwrap()[span]
                    .as_object()
                    .unwrap()
                    .len(),
                4
            );
        }
        let context = super::super::scenario_decisions::FreshSourceContext::prepare(
            &program,
            &ir,
            &db,
            Some(&catalog),
        )
        .unwrap();
        let sites = super::super::scenario_decisions::serialize_read_booleans(&context).unwrap();
        assert_eq!(sites.len(), 3);
        for (_, _, sites) in sites {
            assert_eq!(sites[0].stage, "read-predicate");
            assert_eq!(sites[0].calls.len(), 2);
            assert_eq!(sites[0].calls[0].defaults.len(), 1);
            assert_eq!(sites[0].calls[1].chain.len(), 1);
        }
        let original = ir.clone();
        let field = ir
            .items
            .iter_mut()
            .find(|item| item.canonical == "NativeBoolean.Item.met")
            .unwrap();
        let crate::codegen::ir::IrItemKind::DeriveField {
            expr: Some(expr), ..
        } = &mut field.kind
        else {
            panic!()
        };
        expr.expr = IrExpr::Bool(true);
        assert!(prepared.booleans(&ir).is_none());
        assert!(prepare(&program, &ir, &db, Some(&catalog)).is_none());
        ir = original.clone();
        ir.modules[0].pages[0].path = "/foreign/{Item.id}".into();
        assert!(prepare(&program, &ir, &db, Some(&catalog)).is_none());
        ir = original;
        let key = *program.types.selected_calls.keys().next().unwrap();
        program
            .types
            .selected_calls
            .get_mut(&key)
            .unwrap()
            .slots
            .reverse();
        assert!(prepare(&program, &ir, &db, Some(&catalog)).is_none());
        let mut foreign = SourceDb::new();
        foreign.add("read-predicates.can".into(), BOOLEAN_SOURCE.into());
        assert!(prepare(&program, &ir, &foreign, Some(&catalog)).is_none());
    }

    #[test]
    fn composed_given_fields_replay_original_input_for_callable_and_data_predicates() {
        use crate::analysis::types::{
            CheckedTraitApplication, CheckedTraitContract, GivenContractTables,
            GivenContributedField,
        };
        let source = "app Composed uses=[records]\npackage records\n Given\n  trait marked $\"Add archived evidence.\"\n  Item {title:text} marked\n  policy Item read=members\n When\n Then\n  page / title=\"Items\"\n   list Item as item where not item.archived\n    text row.title\n   list Item as item where item.archived\n    pagination\n    text row.title\n";
        let start = source.find(" marked\n").unwrap() + 1;
        let given = GivenContractTables {
            traits: vec![CheckedTraitContract {
                name: Some("marked".into()),
                inline: false,
                anchor: "records:trait:marked:".into(),
                unit_id: "checked-template".into(),
                fingerprint: crate::source::sha256_hex(b"checked carrier"),
                validation_fingerprint: None,
                applications: vec![CheckedTraitApplication {
                    target_model: "Item".into(),
                    target_field: None,
                    target_canonical: "records.Item".into(),
                    span: Span::new(crate::source::SourceId(0), start as u32, (start + 6) as u32),
                    order: 0,
                }],
                contributed_fields: vec![GivenContributedField {
                    name: "archived".into(),
                    type_name: "bool".into(),
                    default: Some("false".into()),
                    trim: false,
                    min: None,
                    max: None,
                    label: None,
                }],
            }],
            keywords: vec![],
        };
        let (mut db, catalog, mut program, ir) = checked_given_source(source, Some(&given));
        let prepared = prepare(&program, &ir, &db, Some(&catalog))
            .expect("private Given input must survive fresh analysis and resolution");
        assert_eq!(prepared.predicates(&ir).unwrap().len(), 1);
        let fields = program.types.given_fields.clone();
        program.types.given_fields.clear();
        assert!(
            prepare(&program, &ir, &db, Some(&catalog)).is_none(),
            "editable contribution facts are still compared to the private original input"
        );
        program.types.given_fields = fields;
        // A new source at the same display path cannot replace the checked bytes;
        // the existing unambiguous issuer-path check still refuses duplicates.
        let old = db.get(crate::source::SourceId(0)).unwrap().sha256.clone();
        db.add(
            "read-predicates.can".into(),
            source.replace("archived", "changed"),
        );
        assert_eq!(db.get(crate::source::SourceId(0)).unwrap().sha256, old);
        assert!(prepare(&program, &ir, &db, Some(&catalog)).is_none());
    }

    #[test]
    fn paged_own_bool_data_keeps_other_original_callables_and_refuses_changed_ir() {
        let source = SOURCE.replace(
            "list Person as person where person.enabled\n   text",
            "list Person as person where person.enabled\n   pagination\n   text",
        );
        let (db, catalog, program, mut ir) = checked_source(&source);
        let prepared = prepare(&program, &ir, &db, Some(&catalog))
            .expect("mixed data/callable original census");
        assert_eq!(prepared.predicates(&ir).unwrap().len(), 1);
        let filter = &ir.modules[0].pages[0].render[0]
            .props
            .iter()
            .find(|(key, _)| key == "where")
            .unwrap()
            .1;
        let IrExpr::Object(fields) = &filter.expr else {
            panic!("own Bool must use stable data filter");
        };
        assert!(matches!(&fields[0].1.expr, IrExpr::Text(op) if op == "eq"));
        assert!(matches!(&fields[1].1.expr, IrExpr::Text(field) if field == "enabled"));
        assert!(matches!(&fields[2].1.expr, IrExpr::Bool(true)));
        let filter = &mut ir.modules[0].pages[0].render[0]
            .props
            .iter_mut()
            .find(|(key, _)| key == "where")
            .unwrap()
            .1;
        let IrExpr::Object(fields) = &mut filter.expr else {
            unreachable!()
        };
        fields[2].1.expr = IrExpr::Bool(false);
        assert!(
            prepare(&program, &ir, &db, Some(&catalog)).is_none(),
            "data transport cannot bypass fresh original IR equality"
        );
        let source = SOURCE
            .replace("where person.enabled", "where not person.enabled")
            .replace(
                "where not person.enabled\n   text",
                "where not person.enabled\n   pagination\n   text",
            );
        let (_, _, _, ir) = checked_source(&source);
        assert!(
            matches!(
                &ir.modules[0].pages[0].render[0]
                    .props
                    .iter()
                    .find(|(key, _)| key == "where")
                    .unwrap()
                    .1
                    .expr,
                IrExpr::Lambda { .. }
            ),
            "non-exact Bool expressions retain callable refusal profile"
        );
    }

    #[test]
    fn shared_source_context_keeps_standalone_predicates() {
        let (db, catalog, program, ir) = checked();
        let context = super::super::scenario_decisions::FreshSourceContext::prepare(
            &program,
            &ir,
            &db,
            Some(&catalog),
        )
        .unwrap();
        let shared = prepare_with_context(&context).unwrap();
        let standalone = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        assert_eq!(shared.predicates(&ir), standalone.predicates(&ir));
    }

    #[test]
    fn pure_and_role_only_where_keep_original_identity_without_membership_sites() {
        let (db, catalog, program, ir) = checked();
        let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let predicates = prepared.predicates(&ir).unwrap();
        assert_eq!(predicates.len(), 2);
        assert!(program.types.selected_calls.values().all(|call| {
            !matches!(&call.target, crate::analysis::types::SelectedCallTarget::Builtin {id,..} if id == "active_member")
        }));
        for text in ["person.enabled", "reviewer(person.account)"] {
            let (span, identity) = predicates
                .iter()
                .find(|(span, _)| SOURCE[span.start as usize..span.end as usize].trim() == text)
                .unwrap();
            assert_eq!(identity["source"]["path"], "read-predicates.can");
            assert_eq!(
                identity["source"]["sha256"],
                db.get(span.file).unwrap().sha256
            );
            assert_eq!(identity["source"]["module"], "ReadPredicates");
            assert_eq!(
                identity["owner"],
                format!("ReadPredicates.{}", ir.modules[0].pages[0].fn_name)
            );
            assert_eq!(
                identity["node"],
                serde_json::json!({"start":span.start,"end":span.end})
            );
            let start = identity["statement"]["start"].as_u64().unwrap() as usize;
            let end = identity["statement"]["end"].as_u64().unwrap() as usize;
            assert_eq!(
                SOURCE[start..end].trim(),
                format!("Person as person where {text}")
            );
        }
    }

    #[test]
    fn substituted_source_ir_and_checked_predicate_facts_are_refused() {
        let (db, catalog, mut program, ir) = checked();
        let mut foreign = SourceDb::new();
        foreign.add("read-predicates.can".into(), SOURCE.into());
        assert!(prepare(&program, &ir, &foreign, Some(&catalog)).is_none());
        let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let mut edited = ir.clone();
        edited.modules[0].pages[0].render[0]
            .props
            .iter_mut()
            .find(|(name, _)| name == "where")
            .unwrap()
            .1
            .expr = IrExpr::Bool(true);
        assert!(prepare(&program, &edited, &db, Some(&catalog)).is_none());
        assert!(prepared.predicates(&edited).is_none());
        let mut edited = ir.clone();
        edited.modules[0].pages[0].owner = "Foreign".into();
        assert!(prepare(&program, &edited, &db, Some(&catalog)).is_none());
        let mut edited = ir.clone();
        edited.committed_sources = Default::default();
        assert!(prepare(&program, &edited, &db, Some(&catalog)).is_none());
        assert!(prepared.predicates(&edited).is_none());
        let mut edited = ir.clone();
        edited.catalog_version.push_str("-edited");
        assert!(prepared.predicates(&edited).is_none());
        let where_key = program
            .types
            .checked_queries
            .values()
            .next()
            .unwrap()
            .clauses
            .iter()
            .find(|c| c.kind == CheckedQueryClauseKind::Where)
            .unwrap()
            .expressions[0];
        program
            .types
            .node_types
            .insert(where_key, ResolvedType::Scalar(Scalar::Text));
        assert!(prepare(&program, &ir, &db, Some(&catalog)).is_none());
    }
}
