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
    let (_, _, checked, diagnostics) = check_with_source(source);
    (checked, diagnostics)
}

fn check_with_source(
    source: &str,
) -> (
    SourceDb,
    Option<canlang_compiler::analysis::catalog::Catalog>,
    CheckedProgram,
    Vec<Diagnostic>,
) {
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
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    (db, catalog, checked, diagnostics)
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

#[test]
fn imported_two_stage_nominal_projection_maps_exact_checked_row_fields() {
    use canlang_compiler::analysis::types::CheckedQueryProjectionMapping as Mapping;
    let source = r#"package shared
 Given
  export Task {title:text trim min=1,done:bool=false,state:enum(todo,done)=todo,description:text?}
  policy Task read=members
 When
 Then
app Projection
use shared {Task as Job}
Given
 contract Fact {task:Job,version:int,title:Job.title,done:bool,state:Job.state,description:text?}
When
 scenario facts(targets:Job[]) read=true -> Fact[] by=members
  do
   let visible=Job as task where task in targets
   require count(visible)==count(targets)
   return visible as task select Fact {task,version=task.version,title=task.title,done=task.done,state=task.state,description=task.description}
Then
"#;
    let (checked, diagnostics) = check(source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let symbol = |name: &str| {
        checked
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == name)
            .unwrap()
            .id
    };
    let task = symbol("shared.Task");
    let fact = symbol("Projection.Fact");
    let mut queries = checked.types.checked_queries.values().collect::<Vec<_>>();
    queries.sort_by_key(|query| query.node.start);
    assert_eq!(queries.len(), 2);
    assert!(
        queries[0].projection.is_none(),
        "filter only has no nominal projection"
    );
    let query = queries[1];
    assert_eq!(text(source, query.domain), "visible");
    let projection = query
        .projection
        .as_ref()
        .expect("complete checked direct-row constructor");
    assert_eq!(projection.model, task);
    assert_eq!(projection.contract, fact);
    assert_eq!(projection.alias, query.clauses[0].node);
    assert_ne!(
        projection.alias, queries[0].clauses[0].node,
        "same spelling never joins different lexical declarations"
    );
    assert_eq!(
        projection
            .fields
            .iter()
            .map(|field| field.field)
            .collect::<Vec<_>>(),
        ["task", "version", "title", "done", "state", "description"]
            .map(|name| symbol(&format!("Projection.Fact.{name}")))
    );
    assert_eq!(projection.fields[0].mapping, Mapping::StoredReference);
    assert_eq!(
        projection.fields[0].ty,
        ResolvedType::Record {
            symbol: task,
            stored: true
        }
    );
    assert_eq!(text(source, projection.fields[0].node), "task");
    assert_eq!(projection.fields[1].mapping, Mapping::Version);
    assert_eq!(projection.fields[1].ty, ResolvedType::Scalar(Scalar::Int));
    for (field, name) in
        projection.fields[2..]
            .iter()
            .zip(["title", "done", "state", "description"])
    {
        assert_eq!(
            field.mapping,
            Mapping::DirectField {
                field: symbol(&format!("shared.Task.{name}"))
            }
        );
        assert_eq!(text(source, field.node), format!("task.{name}"));
        assert_eq!(field.ty, checked.types.node_types[&field.node]);
    }
    assert!(
        matches!(&projection.fields[4].ty, ResolvedType::Enum {owner:Some(owner),..} if *owner==symbol("shared.Task.state"))
    );
    assert_eq!(
        projection.fields[5].ty,
        ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text)))
    );
}

#[test]
fn computed_foreign_and_mixed_nominal_projections_keep_raw_query_without_attribution() {
    for value in [
        "lower(task.title ?? \"\")",
        "other.title",
        "task.title ?? other.title",
    ] {
        let source = format!(
            "app ProjectionRefusal\nGiven\n Task {{title:text?}}\n policy Task read=members\n contract Fact {{task:Task,title:text?}}\nWhen\n scenario facts(other:Task) read=true -> Fact[] by=members\n  do return Task as task select Fact {{task,title={value}}}\nThen\n"
        );
        let (checked, diagnostics) = check(&source);
        assert!(diagnostics.is_empty(), "{value}: {diagnostics:?}");
        let query = checked.types.checked_queries.values().next().unwrap();
        assert_eq!(query.clauses.len(), 2);
        assert!(
            query.projection.is_none(),
            "{value} must not fabricate direct-row attribution"
        );
    }
}

#[test]
fn selected_collection_calls_retain_external_predicates_and_canonical_slots() {
    use canlang_compiler::analysis::types::SelectedCallTarget;
    let source = r#"package staff
 Given
  export Employee {user:user,active:bool=false}
  policy Employee read=members
 When
 Then
app CollectionFacts
use staff {Employee as PersonRow}
Given
When
 scenario inspect(person:user) read=true -> bool by=members
  do return any(PersonRow as e,e.user==person and e.active)
 scenario every(person:user) read=true -> bool by=members
  do return all(domain=PersonRow as e,predicate=e.user==person)
 scenario reordered() read=true -> bool by=members
  do return any(predicate=true,domain=PersonRow as e)
 scenario earliest() read=true -> PersonRow? by=members
  do return first(PersonRow as e)
 scenario size() read=true -> int by=members
  do return count(PersonRow as e)
Then
"#;
    let (checked, diagnostics) = check(source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let model = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "staff.Employee")
        .unwrap()
        .id;
    let mut facts = checked
        .types
        .checked_collection_calls
        .values()
        .collect::<Vec<_>>();
    facts.sort_by_key(|fact| fact.node.start);
    assert_eq!(facts.len(), 5);
    assert_eq!(
        facts
            .iter()
            .map(|fact| fact.builtin.as_str())
            .collect::<Vec<_>>(),
        ["any", "all", "any", "first", "count"]
    );
    for fact in &facts {
        assert_eq!(fact.model, model);
        let query = &checked.types.checked_queries[&fact.query];
        assert_eq!(query.clauses[0].node, fact.alias);
        assert!(
            query
                .clauses
                .iter()
                .all(|clause| clause.kind != CheckedQueryClauseKind::Where),
            "external predicate never fabricates Where"
        );
        let selected = &checked.types.selected_calls[&fact.node];
        assert!(
            matches!(&selected.target, SelectedCallTarget::Builtin {id,overload} if *id==fact.builtin && *overload==fact.overload)
        );
        let domain = selected.arguments[selected.slots[0].unwrap()];
        assert_eq!(domain, fact.query);
        if let Some(predicate) = &fact.predicate {
            assert_eq!(
                predicate.node,
                selected.arguments[selected.slots[1].unwrap()]
            );
            assert_eq!(predicate.ty, ResolvedType::Scalar(Scalar::Bool));
        } else {
            assert_eq!(selected.arguments.len(), 1);
        }
    }
    assert_eq!(
        text(source, facts[0].predicate.as_ref().unwrap().node),
        "e.user==person and e.active"
    );
    assert_eq!(
        checked.types.selected_calls[&facts[2].node].slots,
        [Some(1), Some(0)]
    );
    assert_eq!(
        text(source, facts[2].predicate.as_ref().unwrap().node),
        "true"
    );
    assert!(facts[3].predicate.is_none() && facts[4].predicate.is_none());
}

#[test]
fn nested_collection_aliases_are_separate_and_failed_or_nonquery_calls_have_no_fact() {
    let source = "app NestedCollections\nGiven\n Employee {active:bool=false}\n policy Employee read=members\nWhen\n scenario inspect() read=true -> bool by=members\n  do return any(Employee as e,all(Employee as e,e.active))\nThen\n";
    let (checked, diagnostics) = check(source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut facts = checked
        .types
        .checked_collection_calls
        .values()
        .collect::<Vec<_>>();
    facts.sort_by_key(|fact| fact.node.start);
    assert_eq!(facts.len(), 2);
    assert_ne!(facts[0].alias, facts[1].alias);
    assert_eq!(text(source, facts[0].alias), "as e");
    assert_eq!(text(source, facts[1].alias), "as e");
    assert_eq!(
        text(source, facts[1].predicate.as_ref().unwrap().node),
        "e.active"
    );
    for (expression, must_error) in [
        ("any(rows,true)", false),
        ("any(Employee as e,1)", true),
        ("any(predicate=e.active,domain=Employee as e)", true),
    ] {
        let source = format!(
            "app RefusedCollections\nGiven\n Employee {{active:bool=false}}\n policy Employee read=members\nWhen\n scenario inspect(rows:Employee[]) read=true -> bool by=members\n  do return {expression}\nThen\n"
        );
        let (checked, diagnostics) = check(&source);
        if must_error {
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.severity == Severity::Error),
                "{expression}: {diagnostics:?}"
            );
        }
        assert!(
            checked.types.checked_collection_calls.is_empty(),
            "{expression}: {:?}",
            checked.types.checked_collection_calls
        );
    }
}

#[test]
fn collection_source_facts_join_real_predicate_lambdas_and_refuse_altered_proofs() {
    use canlang_compiler::{
        analysis::SymbolId,
        codegen::ir::{self, IrCallTarget, IrExpr, IrItemKind, IrProgram, IrStmt, TypedExpr},
    };
    fn returned<'a>(program: &'a IrProgram, name: &str) -> &'a TypedExpr {
        let item = program
            .items
            .iter()
            .find(|item| item.canonical == name)
            .unwrap();
        let IrItemKind::Scenario { effects, .. } = &item.kind else {
            panic!("scenario")
        };
        let IrStmt::Return {
            value: Some(value), ..
        } = &effects[0]
        else {
            panic!("return")
        };
        value
    }
    let source = r#"package people
 Given
  export Employee {user:user,active:bool=false}
  policy Employee read=members
 When
 Then
app IRCollections
use people {Employee as Staff}
Given
 Other {active:bool=false}
When
 scenario positive(person:user) read=true -> bool by=members
  do return any(Staff as e,(e.user==person))
 scenario every(person:user) read=true -> bool by=members
  do return all(domain=Staff as e,predicate=e.user==person and e.active)
 scenario reordered() read=true -> bool by=members
  do return any(predicate=true,domain=Staff as e)
 scenario size() read=true -> int by=members
  do return count(Staff as e)
 scenario earliest() read=true -> Staff? by=members
  do return first(Staff as e)
Then
"#;
    let (db, catalog, checked, diagnostics) = check_with_source(source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for (name, builtin) in [
        ("positive", "any"),
        ("every", "all"),
        ("reordered", "any"),
        ("size", "count"),
        ("earliest", "first"),
    ] {
        let value = returned(&lowered, &format!("IRCollections.{name}"));
        let (target, args, slots) = match &value.expr {
            IrExpr::Call { target, args } => {
                (target, args, (0..args.len()).map(Some).collect::<Vec<_>>())
            }
            IrExpr::BoundCall {
                target,
                args,
                slots,
            } => (target, args, slots.clone()),
            other => panic!("{name}: {other:?}"),
        };
        assert!(matches!(target,IrCallTarget::Builtin {id,..} if id==builtin));
        let IrExpr::Query(query) = &args[slots[0].unwrap()].expr else {
            panic!("domain")
        };
        let fact = query
            .collection_call
            .as_ref()
            .expect("actual query owns the checked call association");
        assert_eq!(fact.builtin, builtin);
        assert_eq!(fact.query, query.source.as_ref().unwrap().node);
        assert!(
            query.where_pred.is_none(),
            "external predicate cannot become authored Where"
        );
        if let Some(predicate) = &fact.predicate {
            let IrExpr::Lambda { param, body } = &args[slots[1].unwrap()].expr else {
                panic!("external predicate lambda")
            };
            assert_eq!(param, "e");
            assert_eq!(body.ty, ResolvedType::Scalar(Scalar::Bool));
            if name == "positive" {
                assert_eq!(text(source, predicate.node), "(e.user==person)");
                assert_eq!(
                    &source[body.span.start as usize..body.span.end as usize],
                    "e.user==person"
                );
            }
            if name == "reordered" {
                assert_eq!(slots, [Some(1), Some(0)]);
                assert!(
                    matches!(args[0].expr, IrExpr::Lambda { .. }),
                    "authored predicate remains first"
                );
                assert!(
                    matches!(args[1].expr, IrExpr::Query(_)),
                    "authored domain remains second"
                );
            }
        } else {
            assert_eq!(args.len(), 1);
        }
    }
    let original = checked
        .types
        .checked_collection_calls
        .values()
        .find(|fact| text(source, fact.node).starts_with("any(Staff"))
        .unwrap()
        .clone();
    let other_call = checked
        .types
        .checked_collection_calls
        .values()
        .find(|fact| fact.builtin == "all")
        .unwrap()
        .clone();
    let other_model = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "IRCollections.Other")
        .unwrap()
        .id;
    let field = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "people.Employee.active")
        .unwrap()
        .id;
    for corruption in [
        "owner",
        "model",
        "out-of-range",
        "query",
        "alias",
        "predicate-node",
        "predicate-type",
        "missing-predicate",
        "builtin",
        "overload",
    ] {
        let (mut altered, diagnostics) =
            check_program(&db, &[checked.checked_files()[0]], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let proof = altered
            .types
            .checked_collection_calls
            .get_mut(&original.node)
            .unwrap();
        match corruption {
            "owner" => proof.node = other_call.node,
            "model" => proof.model = other_model,
            "out-of-range" => proof.model = SymbolId(u32::MAX),
            "query" => proof.query = other_call.query,
            "alias" => proof.alias = other_call.alias,
            "predicate-node" => {
                proof.predicate.as_mut().unwrap().node = other_call.predicate.as_ref().unwrap().node
            }
            "predicate-type" => {
                proof.predicate.as_mut().unwrap().ty = ResolvedType::Scalar(Scalar::Int)
            }
            "missing-predicate" => proof.predicate = None,
            "builtin" => proof.builtin = "all".into(),
            "overload" => proof.overload = usize::MAX,
            _ => unreachable!(),
        }
        let (altered, diagnostics) = ir::build(&altered, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{corruption}: {diagnostics:?}");
        assert!(
            matches!(&returned(&altered,"IRCollections.positive").expr,IrExpr::Unsupported {what,..} if what=="collection call source facts"),
            "{corruption}: {:?}",
            returned(&altered, "IRCollections.positive")
        );
    }
    // A real declared field is also an invalid row owner; ordinal validity
    // alone cannot establish the required model declaration kind.
    let (mut altered, diagnostics) =
        check_program(&db, &[checked.checked_files()[0]], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    altered
        .types
        .checked_collection_calls
        .get_mut(&original.node)
        .unwrap()
        .model = field;
    let (altered, diagnostics) = ir::build(&altered, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(matches!(
        returned(&altered, "IRCollections.positive").expr,
        IrExpr::Unsupported { .. }
    ));
}
