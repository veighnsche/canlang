//! Private original named-page WHERE identities; no execution authority.
use std::collections::HashMap;
use std::fmt::Debug;
use std::hash::Hash;

#[cfg(test)]
use crate::analysis::CheckedProgram;
#[cfg(test)]
use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::SymbolKind;
use crate::analysis::types::CheckedQueryClauseKind;
use crate::analysis::{NodeKey, ResolvedType, Scalar, kids};
use crate::source::{SourceDb, Span};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrProgram};

/// Only original checked source can construct this inventory. Every IR field
/// is sealed before a consumer receives the immutable predicate map.
pub(super) struct PreparedReadPredicates {
    predicates: HashMap<Span, serde_json::Value>,
    closure: String,
}

impl PreparedReadPredicates {
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

pub(super) fn prepare_with_context(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Option<PreparedReadPredicates> {
    let program = context.program();
    let ir = context.ir();
    let db = context.db();
    let original = context.original();
    let fresh = context.fresh();
    let trees = context.trees();
    if original.types.node_types != program.types.node_types
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
    let mut nodes = HashMap::new();
    for (_, tree) in trees {
        for node in tree.descendants() {
            if nodes.len() >= 200000 {
                return None;
            }
            nodes.insert(NodeKey::of(node), node);
        }
    }
    let mut predicates = HashMap::new();
    for module in &ir.modules {
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
            let page_node = nodes.get(&NodeKey {
                file: page.span.file,
                start: page.span.start,
                end: page.span.end,
                kind: SyntaxKind::Page as u8,
            })?;
            if page.owner != module.name || !contains(module.span, page.span) {
                return None;
            }
            let mut pending = page.render.iter().rev().collect::<Vec<_>>();
            while let Some(ui) = pending.pop() {
                pending.extend(ui.children.iter().rev());
                if !matches!(ui.factory.as_str(), "list" | "table" | "calendar" | "board") {
                    continue;
                }
                let mut wheres = ui.props.iter().filter(|(name, _)| name == "where");
                let Some((_, predicate)) = wheres.next() else {
                    continue;
                };
                if wheres.next().is_some() || !contains(page_node.span, ui.span) {
                    return None;
                }
                // This separately sealed transport is not a callable. Its
                // presence must not discard original callables on other pages.
                if matches!(&predicate.expr, IrExpr::PageTimePredicate(_)) {
                    continue;
                }
                let IrExpr::Lambda { body, .. } = &predicate.expr else {
                    return None;
                };
                let collection = nodes.get(&NodeKey {
                    file: ui.span.file,
                    start: ui.span.start,
                    end: ui.span.end,
                    kind: SyntaxKind::Collection as u8,
                })?;
                let mut queries = kids(collection)
                    .into_iter()
                    .filter(|n| n.kind == SyntaxKind::Query);
                let query = queries.next()?;
                if queries.next().is_some() || !contains(collection.span, query.span) {
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
                let expression = nodes.get(key)?;
                let source_clause = nodes.get(&clause.node)?;
                if clauses.next().is_some()
                    || source_clause.kind != SyntaxKind::QueryClause
                    || !kids(query).iter().any(|n| NodeKey::of(n) == clause.node)
                    || !kids(source_clause).iter().any(|n| NodeKey::of(n) == *key)
                    || expression.span != body.span
                    || !contains(query.span, expression.span)
                    || expression.span.start >= expression.span.end
                    || original.types.node_types.get(key)
                        != Some(&ResolvedType::Scalar(Scalar::Bool))
                    || body.ty != ResolvedType::Scalar(Scalar::Bool)
                {
                    return None;
                }
                let identity = serde_json::json!({
                    "source":{"path":source.path,"sha256":source.sha256,"module":module.name},
                    "owner":format!("{}.{}", page.owner, page.fn_name),
                    "node":{"start":key.start,"end":key.end},
                    "statement":{"start":query.span.start,"end":query.span.end},
                });
                if predicates.len() >= 200 || predicates.insert(expression.span, identity).is_some()
                {
                    return None;
                }
            }
        }
    }
    Some(PreparedReadPredicates {
        predicates,
        closure: format!("{ir:?}"),
    })
}

fn contains(outer: Span, inner: Span) -> bool {
    outer.file == inner.file && outer.start <= inner.start && inner.end <= outer.end
}

#[cfg(test)]
mod tests {
    use super::super::ir;
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    use crate::analysis::check_program;

    const SOURCE: &str = "app ReadPredicates\nGiven\n role reviewer\n Person {account:user,enabled:bool}\n policy Person read=members\nWhen\nThen\n page /people title=\"People\"\n  list Person as person where person.enabled\n   text row.account\n  list Person as person where reviewer(person.account)\n   text row.account\n";

    fn checked() -> (SourceDb, Catalog, CheckedProgram, IrProgram) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut db = SourceDb::new();
        let file = db.add("read-predicates.can".into(), SOURCE.into());
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, catalog, program, ir)
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
