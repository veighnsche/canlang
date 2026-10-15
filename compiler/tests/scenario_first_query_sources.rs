//! Source-only ordered first lineage. No native query handle or row is issued.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, InfluenceKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, check_program};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::path::{Path, PathBuf};

// Budget is the original owning declaration. This visibly bounded body keeps
// the original first query and successful guard, then one created result row.
// It does not replace the full original generation body or assert authority.
const BOUNDED: &str = include_str!("fixtures/native-first-budget.can");

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn checked(sources: &[(&str, &str)]) -> (SourceDb, CheckedProgram) {
    let mut db = SourceDb::new();
    let files: Vec<_> = sources
        .iter()
        .map(|(path, source)| db.add((*path).into(), (*source).into()))
        .collect();
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &files, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program)
}

fn disclosure<'a>(program: &'a CheckedProgram, name: &str) -> &'a ScenarioDisclosure {
    let symbol = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == name)
        .unwrap();
    program.scenario_disclosures().get(&symbol.id).unwrap()
}

fn text(db: &SourceDb, node: NodeKey) -> &str {
    db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
}

fn assert_first(db: &SourceDb, program: &CheckedProgram, name: &str, model: &str) {
    let source = disclosure(program, name).source_facts().unwrap();
    let queries = source.queries.as_ref().expect("original first inventory");
    let mut first_queries = queries.iter().filter(|query| query.first.is_some());
    let query = first_queries
        .next()
        .expect("one original ordered first query");
    assert!(
        first_queries.next().is_none(),
        "unique original first query"
    );
    let first = query
        .first
        .as_ref()
        .expect("exact first source association");
    assert_eq!(query.model_name, model);
    assert_eq!(program.symbols[query.model.0 as usize].canonical, model);
    assert!(text(db, first.call).starts_with("first("));
    assert!(text(db, first.binding).starts_with("let "));
    assert_eq!(text(db, first.operand), "actor");
    let alias = query.alias.expect("original first query alias");
    let predicate = query.predicate.expect("original first query predicate");
    assert_eq!(text(db, predicate), "row.account==actor");
    assert!(text(db, query.return_node).starts_with("return run"));
    assert!(query.projection.is_none());
    assert!(query.cardinality_guard.is_none());
    assert!(query.count.is_none());
    assert!(query.inputs.is_empty());
    assert_eq!(query.limit, None);
    assert!(!query.archived);
    let [order] = query.order.as_slice() else {
        panic!("original id order");
    };
    assert_eq!(order.field, None);
    assert_eq!(order.field_name, "id");
    assert!(!order.descending);
    assert_eq!(text(db, order.node), "row.id");
    let [dependency] = query.dependencies.as_slice() else {
        panic!("account control");
    };
    assert_eq!(dependency.role, DependencyRole::Control);
    assert_eq!(dependency.model, query.model);
    assert_eq!(dependency.model_name, model);
    assert_eq!(dependency.field_name, "account");
    assert_eq!(dependency.ty, ResolvedType::Scalar(Scalar::User));
    assert_eq!(dependency.type_id, "user");
    assert_eq!(text(db, dependency.node), "row.account");
    assert_eq!(
        program.symbols[dependency.field.0 as usize].canonical,
        format!("{model}.account")
    );
    assert_eq!(query.source, source.source);
    assert_eq!(
        query.source.sha256,
        sha256_hex(db.get(query.node.file).unwrap().text.as_bytes())
    );
    assert_eq!(
        query
            .influences
            .iter()
            .map(|influence| influence.kind)
            .collect::<Vec<_>>(),
        vec![
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder,
        ]
    );
    assert!(
        query
            .influences
            .iter()
            .all(|influence| influence.query_id.as_ref() == Some(&query.id)
                && influence.node == query.node
                && influence.source == query.source)
    );
    let call = program
        .types
        .checked_collection_calls
        .get(&first.call)
        .unwrap();
    assert_eq!(call.builtin, "first");
    assert_eq!(call.overload, first.overload);
    assert_eq!(call.query, query.node);
    assert_eq!(call.alias, alias);
    assert_eq!(call.model, query.model);
    assert!(call.predicate.is_none());
}

#[test]
fn bounded_original_first_retains_selected_reads_and_created_return_influences() {
    let (db, program) = checked(&[("bounded-first.can", BOUNDED)]);
    assert_first(
        &db,
        &program,
        "FirstSources.generate",
        "FirstSources.Budget",
    );
    let ScenarioDisclosure::Complete(complete) = disclosure(&program, "FirstSources.generate")
    else {
        panic!(
            "bounded original first source declined: {:?}",
            disclosure(&program, "FirstSources.generate")
        );
    };
    let queries = complete
        .source_facts
        .as_ref()
        .unwrap()
        .queries
        .as_ref()
        .unwrap();
    let [query] = queries.as_slice() else {
        panic!("bounded source retains exactly one original first query");
    };
    assert!(!complete.returns.is_empty());
    for returned in &complete.returns {
        assert_eq!(returned.node, query.return_node);
        assert_eq!(returned.influences, query.influences);
        assert!(
            returned
                .dependencies
                .iter()
                .all(|dependency| dependency.field_name != "id")
        );
    }
    assert!(
        complete
            .returns
            .iter()
            .flat_map(|returned| &returned.dependencies)
            .any(|dependency| dependency.model_name == "FirstSources.Budget"
                && dependency.field_name == "held")
    );
}

#[test]
fn byte_exact_original_first_queries_preserve_closed_chat_and_declined_creative_scopes() {
    let sources = [
        (
            "CanChat.can",
            include_str!("fixtures/original-a850/CanChat.can"),
        ),
        (
            "CanCreative.can",
            include_str!("fixtures/original-a850/CanCreative.can"),
        ),
    ];
    let (db, program) = checked(&sources);
    assert_first(&db, &program, "chat.ask", "chat.Allowance");
    assert_first(&db, &program, "creative.generate", "creative.Budget");
    // The original six-query Chat source criterion is closed. Its complete
    // conservative proof remains distinct from the original Creative closure.
    let ScenarioDisclosure::Complete(chat) = disclosure(&program, "chat.ask") else {
        panic!("accepted original Chat source closure");
    };
    assert_eq!(chat.returns.len(), 256);
    let source = chat.source_facts.as_deref().unwrap();
    assert_eq!(source.queries.as_deref().unwrap().len(), 4);
    assert!(matches!(
        disclosure(&program, "creative.generate"),
        ScenarioDisclosure::Declined(_)
    ));
}

const INPUT_LOOKUP: &str = r#"app ScalarLookup
Given
 Lookup {key:text,other:text}
 Result {value:int=0}
 policy Lookup read=members
 policy Result read=members
When
 scenario lookup(needle:text,other:text) -> Result by=members
  do
   let existing=first(Lookup as candidate where candidate.key==needle)
   require existing==null
   create Result {} as result
   return result
Then
"#;

fn assert_input_lookup(
    db: &SourceDb,
    program: &CheckedProgram,
    owner: &str,
    model: &str,
    member: &str,
    operand: &str,
    ty: Scalar,
    explicit: bool,
) {
    let facts = disclosure(program, owner).source_facts().unwrap();
    let [query] = facts
        .queries
        .as_deref()
        .expect("original input lookup inventory")
    else {
        panic!("one original first lookup");
    };
    let first = query.first.as_ref().unwrap();
    assert_eq!(query.model_name, model);
    assert_eq!(text(db, first.operand), operand);
    let [(input, parameter)] = query.inputs.as_slice() else {
        panic!("one original required input");
    };
    assert_eq!(*input, first.operand);
    assert_eq!(program.symbols[parameter.0 as usize].name, operand);
    assert_eq!(
        program.types.symbol_types.get(parameter),
        Some(&ResolvedType::Scalar(ty))
    );
    let [dependency] = query.dependencies.as_slice() else {
        panic!("one original control field");
    };
    assert_eq!(dependency.role, DependencyRole::Control);
    assert_eq!(dependency.field_name, member.rsplit('.').next().unwrap());
    assert_eq!(text(db, dependency.node).trim_matches(['(', ')']), member);
    assert_eq!(dependency.model_name, model);
    assert_eq!(dependency.model, query.model);
    assert_eq!(dependency.ty, ResolvedType::Scalar(ty));
    assert_eq!(dependency.type_id, ty.as_str());
    assert_eq!(
        program.symbols[dependency.field.0 as usize].canonical,
        format!("{model}.{}", dependency.field_name)
    );
    if explicit {
        let [order] = query.order.as_slice() else {
            panic!("one authored metadata order");
        };
        assert_eq!(order.field_name, "id");
        assert_eq!(order.field, None);
        assert!(!order.descending);
    } else {
        assert!(
            query.order.is_empty(),
            "implicit created/id order has no fabricated source nodes"
        );
        assert!(
            !program.types.checked_queries[&query.node]
                .clauses
                .iter()
                .any(|clause| matches!(
                    clause.kind,
                    canlang_compiler::analysis::types::CheckedQueryClauseKind::Order
                ))
        );
    }
    assert_eq!(
        query.source.sha256,
        sha256_hex(db.get(query.node.file).unwrap().text.as_bytes())
    );
    assert_eq!(
        query
            .influences
            .iter()
            .map(|influence| influence.kind)
            .collect::<Vec<_>>(),
        [
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder
        ]
    );
    let selected = &program.types.checked_collection_calls[&first.call];
    assert_eq!(selected.query, query.node);
    assert_eq!(selected.model, query.model);
    assert_eq!(Some(selected.alias), query.alias);
    assert_eq!(selected.overload, first.overload);
}

#[test]
fn scalar_required_input_lookup_derives_fields_bindings_and_optional_order() {
    for ty in [
        Scalar::Text,
        Scalar::Int,
        Scalar::Bool,
        Scalar::Decimal,
        Scalar::Money,
        Scalar::Date,
        Scalar::Datetime,
        Scalar::Duration,
        Scalar::User,
    ] {
        let source = INPUT_LOOKUP.replace(":text", &format!(":{}", ty.as_str()));
        let (db, program) = checked(&[("scalar-first.can", &source)]);
        assert_input_lookup(
            &db,
            &program,
            "ScalarLookup.lookup",
            "ScalarLookup.Lookup",
            "candidate.key",
            "needle",
            ty,
            false,
        );
    }
    for (source, owner, model, member, operand, explicit) in [
        (
            INPUT_LOOKUP.replace("candidate.key==needle", "(candidate.key)==(needle)"),
            "ScalarLookup.lookup",
            "ScalarLookup.Lookup",
            "candidate.key",
            "needle",
            false,
        ),
        (
            INPUT_LOOKUP.replace(
                "candidate.key==needle)",
                "candidate.key==needle order=candidate.id)",
            ),
            "ScalarLookup.lookup",
            "ScalarLookup.Lookup",
            "candidate.key",
            "needle",
            true,
        ),
        (
            INPUT_LOOKUP
                .replace("ScalarLookup", "RenamedLookup")
                .replace("Lookup {", "Entry {")
                .replace("policy Lookup", "policy Entry")
                .replace("first(Lookup", "first(Entry")
                .replace("candidate", "selected")
                .replace("key", "reference")
                .replace("needle", "requested"),
            "RenamedLookup.lookup",
            "RenamedLookup.Entry",
            "selected.reference",
            "requested",
            false,
        ),
        (
            INPUT_LOOKUP.replace("candidate.key==needle", "candidate.key==other"),
            "ScalarLookup.lookup",
            "ScalarLookup.Lookup",
            "candidate.key",
            "other",
            false,
        ),
    ] {
        let (db, program) = checked(&[("scalar-first.can", &source)]);
        assert_input_lookup(
            &db,
            &program,
            owner,
            model,
            member,
            operand,
            Scalar::Text,
            explicit,
        );
    }
    // Actor is the original context alternative, independent of field spelling.
    let source = INPUT_LOOKUP
        .replace(":text", ":user")
        .replace("candidate.key==needle", "candidate.other==actor");
    let (db, program) = checked(&[("actor-first.can", &source)]);
    let facts = disclosure(&program, "ScalarLookup.lookup")
        .source_facts()
        .unwrap();
    let query = &facts.queries.as_ref().unwrap()[0];
    assert_eq!(text(&db, query.first.as_ref().unwrap().operand), "actor");
    assert!(query.inputs.is_empty() && query.order.is_empty());
    assert_eq!(query.dependencies[0].field_name, "other");
}

#[test]
fn input_lookup_refuses_copied_or_rebound_operands_reversal_and_unsupported_order() {
    for source in [
        INPUT_LOOKUP.replace("candidate.key==needle", "needle==candidate.key"),
        INPUT_LOOKUP.replace("candidate.key==needle", "candidate.key==candidate.other"),
        INPUT_LOOKUP
            .replace("other:text)", "other:Lookup)")
            .replace("candidate.key==needle", "other.key==needle"),
        INPUT_LOOKUP
            .replace("   let existing=", "   let copied=needle\n   let existing=")
            .replace("candidate.key==needle", "candidate.key==copied"),
        INPUT_LOOKUP.replace(
            "lookup(needle:text,other:text)",
            "lookup(other:text,needle:text=\"default\")",
        ),
        INPUT_LOOKUP.replace(
            "candidate.key==needle)",
            "candidate.key==needle order=candidate.other)",
        ),
        INPUT_LOOKUP.replace(
            "candidate.key==needle)",
            "candidate.key==needle order=-candidate.id)",
        ),
    ] {
        let (_, program) = checked(&[("refused-input-first.can", &source)]);
        let result = disclosure(&program, "ScalarLookup.lookup");
        assert!(
            result.source_facts().unwrap().queries.is_none(),
            "{result:?}\n{source}"
        );
    }
}

#[test]
fn original_crm_lookup_expression_has_input_and_implicit_order_inventory() {
    // Preserve the original expression bytes in this bounded source-inventory
    // witness. CRM's existing-reference branch/result remains a separate owner.
    let crm = include_str!("../../draft/apps/CanCRM/CanCRM.can");
    let original = crm
        .lines()
        .find(|line| {
            line.trim()
                .starts_with("let existing=first(ResearchIntake as intake ")
        })
        .unwrap()
        .trim();
    let source = INPUT_LOOKUP
        .replace(
            " Lookup {key:text,other:text}",
            " ResearchIntake {source:text,other:text}",
        )
        .replace("policy Lookup", "policy ResearchIntake")
        .replace("needle:text", "source:text")
        .replace(
            "let existing=first(Lookup as candidate where candidate.key==needle)",
            original,
        );
    let (db, program) = checked(&[("crm-lookup-expression.can", &source)]);
    assert_input_lookup(
        &db,
        &program,
        "ScalarLookup.lookup",
        "ScalarLookup.ResearchIntake",
        "intake.source",
        "source",
        Scalar::Text,
        false,
    );
    let query = &disclosure(&program, "ScalarLookup.lookup")
        .source_facts()
        .unwrap()
        .queries
        .as_ref()
        .unwrap()[0];
    assert_eq!(
        format!(
            "let existing={}",
            text(&db, query.first.as_ref().unwrap().call)
        ),
        original
    );
}

#[test]
fn different_query_shapes_and_copied_selected_row_are_not_admitted() {
    for changed in [
        BOUNDED.replace("where row.account==actor", "where row.active"),
        BOUNDED.replace("order=row.id", "order=row.held"),
        BOUNDED.replace("order=row.id", "order=-row.id"),
    ] {
        let (_, program) = checked(&[("refused-first.can", &changed)]);
        let result = disclosure(&program, "FirstSources.generate");
        assert!(
            matches!(result, ScenarioDisclosure::Declined(_)),
            "{result:?}"
        );
        assert!(result.source_facts().unwrap().queries.is_none());
    }
    let limited = BOUNDED.replace("order=row.id)", "order=row.id limit=1)");
    let (_, diagnostics) =
        canlang_compiler::syntax::parse_source(canlang_compiler::source::SourceId(0), &limited);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E1200"),
        "a source query limit is outside the current grammar: {diagnostics:?}"
    );
    let copied = BOUNDED.replace(
        "   create Run {budget}",
        "   let copy=budget\n   create Run {budget=copy}",
    );
    let (_, program) = checked(&[("copied-first.can", &copied)]);
    assert!(matches!(
        disclosure(&program, "FirstSources.generate"),
        ScenarioDisclosure::Declined(_)
    ));
    let ordinary = BOUNDED
        .replace(
            "generate(enabled:bool",
            "generate(candidate:Budget,enabled:bool",
        )
        .replace(
            "first(Budget as row where row.account==actor order=row.id)",
            "first([candidate])",
        );
    let (_, program) = checked(&[("ordinary-first.can", &ordinary)]);
    let result = disclosure(&program, "FirstSources.generate");
    assert!(matches!(result, ScenarioDisclosure::Declined(_)));
    assert!(
        result
            .source_facts()
            .unwrap()
            .queries
            .as_ref()
            .is_none_or(Vec::is_empty)
    );
}

#[test]
fn unprepared_original_query_first_refuses_both_call_forms_without_facade_import() {
    use canlang_compiler::codegen::ir::{self, IrExpr, IrItemKind, IrStmt};
    let mut db = SourceDb::new();
    let file = db.add("first-refusal.can".into(), BOUNDED.into());
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (original, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for bound in [false, true] {
        let mut ir = original.clone();
        let owner = ir
            .items
            .iter_mut()
            .find(|item| item.name == "generate")
            .unwrap();
        let IrItemKind::Scenario { effects, .. } = &mut owner.kind else {
            panic!("scenario");
        };
        let IrStmt::Let { value, .. } = &mut effects[0] else {
            panic!("original first binding");
        };
        let (target, args) = match &value.expr {
            IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                (target.clone(), args.clone())
            }
            _ => panic!("original first call"),
        };
        value.expr = if bound {
            IrExpr::BoundCall {
                target,
                args,
                slots: vec![Some(0)],
            }
        } else {
            IrExpr::Call { target, args }
        };
        // The raw source receiver has no independently prepared native query.
        // Neither spelling can become an ordinary array builtin or a grant.
        let output =
            canlang_compiler::codegen::js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert_eq!(
            output
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("first query"))
                .count(),
            1
        );
        assert!(!output.stdlib_imports.iter().any(|name| name == "first"));
        assert!(
            output
                .entry
                .js
                .contains("first query lacks its checked native source")
        );
    }
}
