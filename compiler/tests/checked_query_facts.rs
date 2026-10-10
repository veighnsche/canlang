//! Actual query checker facts; no native execution or disclosure admission.
use canlang_compiler::{
    analysis::{
        CheckedProgram, NodeKey,
        catalog::{CatalogRequest, load_catalog},
        check_program,
        types::{CheckedQueryClauseKind, ResolvedType, Scalar},
    },
    diagnostic::{Diagnostic, Severity},
    source::{SourceDb, Span},
};

fn check(source: &str) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let file = db.add("checked-query.can".into(), source.into());
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: path.parent().unwrap(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    check_program(&db, &[file], catalog.as_ref())
}

fn text(source: &str, node: NodeKey) -> &str {
    source[node.start as usize..node.end as usize].trim()
}

#[test]
fn model_projection_retains_stored_reference_and_authored_clause_order() {
    let source = "app QueryFacts\nGiven\n Task {title:text,done:bool=false}\n policy Task read=members\n contract Fact {task:Task,title:text}\nWhen\n scenario facts() read=true -> Fact[] by=members\n  do\n   return Task archived=include as task where task.done==false order=-task.title select Fact {task,title=task.title}\nThen\n";
    let (checked, diagnostics) = check(source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.checked_queries.len(), 1);
    let query = checked.types.checked_queries.values().next().unwrap();
    assert_eq!(
        checked.types.checked_queries.get(&query.node).unwrap().node,
        query.node
    );
    assert_eq!(text(source, query.domain), "Task");
    let task = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "QueryFacts.Task")
        .unwrap()
        .id;
    let fact = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "QueryFacts.Fact")
        .unwrap()
        .id;
    assert!(
        matches!(&query.domain_type, ResolvedType::Array {element,ordered:true,..}
        if **element == ResolvedType::Record {symbol:task,stored:true})
    );
    assert!(matches!(&query.result, ResolvedType::Array {element,..}
        if **element == ResolvedType::Record {symbol:fact,stored:false}));
    assert_eq!(
        query
            .clauses
            .iter()
            .map(|clause| clause.kind.clone())
            .collect::<Vec<_>>(),
        vec![
            CheckedQueryClauseKind::Archived,
            CheckedQueryClauseKind::As {
                name: "task".into()
            },
            CheckedQueryClauseKind::Where,
            CheckedQueryClauseKind::Order,
            CheckedQueryClauseKind::Select,
        ]
    );
    assert!(query.clauses[0].expressions.is_empty());
    assert!(query.clauses[1].expressions.is_empty());
    for (clause, expected) in query.clauses[2..].iter().zip([
        "task.done==false",
        "-task.title",
        "Fact {task,title=task.title}",
    ]) {
        assert_eq!(clause.expressions.len(), 1);
        assert_eq!(text(source, clause.expressions[0]), expected);
    }
    let selection = query.clauses[4].expressions[0];
    assert!(
        checked
            .types
            .node_types
            .iter()
            .any(|(node, ty)| node.start >= selection.start
                && node.end <= selection.end
                && text(source, *node) == "task"
                && *ty
                    == ResolvedType::Record {
                        symbol: task,
                        stored: true
                    })
    );
}

#[test]
fn value_domains_and_same_name_aliases_keep_distinct_declarations() {
    let source = "app ValueQueries\nGiven\nWhen\n scenario increasing(values:int[]) read=true -> int[] by=members\n  do\n   return values as item where item>0 order=-item select item+1\n scenario doubling(values:int[]) read=true -> int[] by=members\n  do\n   return values as item where item<10 select item*2\nThen\n";
    let (checked, diagnostics) = check(source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut queries = checked.types.checked_queries.values().collect::<Vec<_>>();
    queries.sort_by_key(|query| query.node.start);
    assert_eq!(queries.len(), 2);
    assert_ne!(queries[0].clauses[0].node, queries[1].clauses[0].node);
    for query in queries {
        assert_eq!(
            query.clauses[0].kind,
            CheckedQueryClauseKind::As {
                name: "item".into()
            }
        );
        assert_eq!(text(source, query.clauses[0].node), "as item");
        assert_eq!(text(source, query.domain), "values");
        assert!(
            matches!(&query.domain_type, ResolvedType::Array {element,..}
            if **element == ResolvedType::Scalar(Scalar::Int))
        );
        assert!(matches!(&query.result, ResolvedType::Array {element,..}
            if **element == ResolvedType::Scalar(Scalar::Int)));
    }
}

#[test]
fn invalid_queries_do_not_publish_successful_query_facts() {
    for expression in [
        "Task as task where task.title",
        "Task as task order=task.done",
        "1 as task select task",
        "Task as task select task.missing",
    ] {
        let source = format!(
            "app InvalidQuery\nGiven\n Task {{title:text,done:bool=false}}\n policy Task read=members\nWhen\n scenario inspect() read=true by=members\n  do\n   let result={expression}\nThen\n"
        );
        let (checked, diagnostics) = check(&source);
        assert!(
            diagnostics
                .iter()
                .any(|diag| diag.severity == Severity::Error),
            "{expression}: {diagnostics:?}"
        );
        assert!(
            checked.types.checked_queries.is_empty(),
            "{expression}: {:?}",
            checked.types.checked_queries
        );
    }
}
