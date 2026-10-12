//! Original transcript selection IDs are source evidence; the native
//! stored-message/File receiver remains a defining owner prerequisite.
use super::*;
use crate::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use crate::analysis::scenario_disclosure::{CheckedScenarioDisclosure, InfluenceKind};
use crate::analysis::{CheckedProgram, NodeKey, check_program};
use crate::codegen::{EmitOptions, EmitSources, emit};
use crate::diagnostic::DiagnosticResult;
use std::path::{Path, PathBuf};

const SOURCE: &str = include_str!("../../tests/fixtures/source-transcript.can");
const HASH: &str = "c198c3b891cc577b2b928039abd695da227a8ee21da49258c802dc61d216511c";
const OWNER: &str = "SourceTranscript.compose";

fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("source-transcript.can".into(), SOURCE.into());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let primary = PathBuf::from("/Users/vince/Projects/canlang");
    let primary_catalog = primary.join("packages/cloudflare/dist/native-catalog.json");
    let path = if primary_catalog.is_file() {
        primary_catalog
    } else {
        root.join("packages/cloudflare/dist/native-catalog.json")
    };
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
    let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}
fn owner(ir: &IrProgram) -> &IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == OWNER)
        .unwrap()
}
fn checked(ir: &IrProgram) -> &CheckedScenarioDisclosure {
    let ScenarioDisclosure::Complete(checked) = &ir.scenario_disclosures[&owner(ir).id] else {
        panic!("genuine Complete source")
    };
    checked
}
fn text(db: &SourceDb, node: NodeKey) -> &str {
    db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
}

fn checked_transcript_source<'a>(
    program: &CheckedProgram,
    ir: &'a IrProgram,
    owner: &IrItem,
    call: NodeKey,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedTranscriptSource> {
    super::super::scenario_decisions::collect_decision_sources(program, ir, owner, db, catalog)?;
    ir.scenario_disclosures
        .get(&owner.id)?
        .source_facts()?
        .transcripts
        .as_deref()?
        .iter()
        .find(|fact| fact.call == call)
}

fn query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<serde_json::Value> {
    super::super::scenario_queries::serialize_query_sources(
        program,
        ir,
        owner(ir),
        db,
        catalog,
        &super::super::js::module_path("SourceTranscript"),
    )
}
fn selections(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<serde_json::Value> {
    super::super::scenario_queries::serialize_transcript_selections(
        program,
        ir,
        owner(ir),
        db,
        catalog,
        &super::super::js::module_path("SourceTranscript"),
    )
}

fn full_original_fixture(
    catalog_edit: Option<(&str, &str, &str)>,
) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let files = [
        db.add(
            "CanChat.can".into(),
            include_str!("../../tests/fixtures/original-a850/CanChat.can").into(),
        ),
        db.add(
            "CanCreative.can".into(),
            include_str!("../../tests/fixtures/original-a850/CanCreative.can").into(),
        ),
    ];
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let primary_catalog = Path::new("/Users/vince/Projects/canlang")
        .join("packages/cloudflare/dist/native-catalog.json");
    let mut path = if primary_catalog.is_file() {
        primary_catalog
    } else {
        root.join("packages/cloudflare/dist/native-catalog.json")
    };
    let scratch = tempfile::tempdir().unwrap();
    if let Some((id, field, replacement)) = catalog_edit {
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let entry = value["entries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|entry| entry["id"] == id)
            .unwrap();
        entry[field] = replacement.into();
        path = scratch.path().join("catalog.json");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &files, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

#[test]
fn full_original_query_composition_cannot_borrow_an_isolated_transcript_plan() {
    let (db, program, ir, catalog) = full_original_fixture(None);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "chat.ask")
        .unwrap();
    let disclosure = &ir.scenario_disclosures[&owner.id];
    let facts = disclosure
        .source_facts()
        .expect("full original source inventory");
    let transcripts = facts.transcripts.as_deref().expect("original helper calls");
    let queries = facts.queries.as_deref().expect("original ordinary queries");
    assert_eq!(transcripts.len(), 2);
    assert_eq!(queries.len(), 4);
    assert_ne!(transcripts[0].id, transcripts[1].id);
    for fact in transcripts {
        assert_eq!(text(&db, fact.call), "transcript(branch)");
        assert_eq!(fact.source, facts.source);
    }
    let ScenarioDisclosure::Complete(proof) = disclosure else {
        panic!("exact repeated-work reuse must finish the original source analysis");
    };
    assert_eq!(proof.returns.len(), 256);
    assert!(queries[0].first.is_none() && queries[0].count.is_none());
    let [control] = queries[0].dependencies.as_slice() else {
        panic!("real aggregate predicate control");
    };
    assert_eq!(control.field_name, "unfinished");
    assert_eq!(control.role, DependencyRole::Control);
    assert_eq!(text(&db, control.node), "run.unfinished");
    assert_eq!(control.source, facts.source);
    assert_eq!(control.ty, ResolvedType::Scalar(Scalar::Bool));
    assert_eq!(control.type_id, "bool");
    assert_eq!(control.model, queries[0].model);
    assert!(control.calls.is_empty());
    assert_eq!(text(&db, queries[0].node), "branch.Run as run");
    assert_eq!(text(&db, queries[0].predicate.unwrap()), "run.unfinished");
    assert!(queries[0].projection.is_none() && queries[0].order.is_empty());
    assert!(!queries[0].archived && queries[0].limit.is_none());
    let [(receiver, parent)] = queries[0].inputs.as_slice() else {
        panic!("original required Branch");
    };
    assert_eq!(text(&db, *receiver), "branch");
    assert_eq!(ir.items[parent.0 as usize].canonical, "chat.ask.branch");
    assert!(
        facts
            .stored_contracts
            .as_deref()
            .unwrap()
            .iter()
            .any(|schema| schema.model
                && schema.id == queries[0].model
                && schema.fields.iter().any(|field| field.id == control.field))
    );
    assert_eq!(queries[0].influences.len(), 4);
    let IrItemKind::Scenario { guards, .. } = &owner.kind else {
        panic!("original scenario");
    };
    let IrStmt::Require { cond, .. } = &guards[2] else {
        panic!("original aggregate guard");
    };
    let IrExpr::Unary {
        op: super::super::ir::IrUnOp::Not,
        operand,
    } = &cond.expr
    else {
        panic!("original not any");
    };
    let (id, args) = match &operand.expr {
        IrExpr::Call {
            target: super::super::ir::IrCallTarget::Builtin { id, awaited: false },
            args,
        } => (id, args),
        IrExpr::BoundCall {
            target: super::super::ir::IrCallTarget::Builtin { id, awaited: false },
            args,
            slots,
        } => {
            assert_eq!(slots, &[Some(0), Some(1)]);
            (id, args)
        }
        _ => panic!("actual aggregate call"),
    };
    assert_eq!(id, "any");
    let [domain, predicate] = args.as_slice() else {
        panic!("separate domain and predicate");
    };
    let IrExpr::Query(query) = &domain.expr else {
        panic!("actual contained domain");
    };
    assert!(query.where_pred.is_none());
    let original_call = query.collection_call.as_ref().unwrap();
    assert_eq!(original_call.builtin, "any");
    assert_eq!(original_call.query, queries[0].node);
    assert_eq!(original_call.alias, queries[0].alias.unwrap());
    assert_eq!(
        original_call.predicate.as_ref().unwrap().node,
        queries[0].predicate.unwrap()
    );
    assert!(matches!(predicate.expr, IrExpr::Lambda { .. }));
    assert!(
        queries[1]
            .count
            .as_ref()
            .unwrap()
            .contained_parent
            .is_none()
    );
    assert!(queries[2].first.is_some());
    assert!(
        queries[3]
            .count
            .as_ref()
            .unwrap()
            .contained_parent
            .is_some()
    );
    let entry = super::super::js::pick_entrypoint(&ir).unwrap();
    let entry_module = super::super::js::module_path(&ir.module(entry).name);
    assert!(
        super::super::scenario_queries::collect_transcript_query_source(
            &program,
            &ir,
            owner,
            &db,
            Some(&catalog),
            &entry_module,
        )
        .is_none(),
        "the full original closure needs its combined producer"
    );
}

#[test]
fn original_input_guards_refuse_changed_effect_or_signature_before_the_model_query() {
    for (id, field, replacement, expected) in [
        ("trim", "effects", "state-read", "trim(prompt)"),
        (
            "trim",
            "signature",
            "trim(value:text)->text",
            "trim(prompt)",
        ),
        ("count", "effects", "state-read", "count(attachments)"),
        (
            "count",
            "signature",
            "count(items:C<T>)->int",
            "count(attachments)",
        ),
    ] {
        let (db, _, ir, _) = full_original_fixture(Some((id, field, replacement)));
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "chat.ask")
            .unwrap();
        let ScenarioDisclosure::Declined(decline) = &ir.scenario_disclosures[&owner.id] else {
            panic!("changed {id} declaration must not gain pure source admission");
        };
        assert_eq!(text(&db, decline.node), expected, "{id}/{field}");
    }
}

#[test]
fn original_pure_guard_ir_matches_its_source_and_refuses_changed_calls() {
    fn builtin<'a>(value: &'a TypedExpr, id: &str) -> Option<&'a TypedExpr> {
        match &value.expr {
            IrExpr::Call {
                target: super::super::ir::IrCallTarget::Builtin { id: actual, .. },
                ..
            }
            | IrExpr::BoundCall {
                target: super::super::ir::IrCallTarget::Builtin { id: actual, .. },
                ..
            } if actual == id => Some(value),
            IrExpr::Binary { left, right, .. } => builtin(left, id).or_else(|| builtin(right, id)),
            _ => None,
        }
    }
    let (db, _, ir, _) = full_original_fixture(None);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "chat.ask")
        .unwrap();
    let facts = ir.scenario_disclosures[&owner.id].source_facts().unwrap();
    let created = facts
        .creates
        .as_deref()
        .unwrap()
        .iter()
        .find(|created| ir.items[created.model.0 as usize].canonical == "chat.Run")
        .unwrap();
    let IrItemKind::Scenario { guards, .. } = &owner.kind else {
        panic!("original scenario");
    };
    let IrStmt::Require { cond, .. } = &guards[0] else {
        panic!("original leading guard");
    };
    for id in ["trim", "count"] {
        let call = builtin(cond, id).unwrap();
        let key = created
            .expression_types
            .iter()
            .map(|(key, _)| *key)
            .find(|key| {
                key.kind == crate::syntax::SyntaxKind::Call as u8 && node_span(*key) == call.span
            })
            .unwrap();
        assert!(
            super::super::scenario_create_sources::checked_create_expression(
                &ir, created, call, key, &db,
            )
            .is_some(),
            "original {id} source/IR join"
        );
        for edit in ["awaited", "argument", "slot", "type"] {
            let mut changed = call.clone();
            if edit == "type" {
                changed.ty = ResolvedType::Scalar(Scalar::Bool);
            } else if edit == "slot" {
                let (target, args) = match changed.expr {
                    IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                        (target, args)
                    }
                    _ => panic!("original builtin"),
                };
                changed.expr = IrExpr::BoundCall {
                    target,
                    args,
                    slots: vec![None],
                };
            } else {
                let (target, args) = match &mut changed.expr {
                    IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                        (target, args)
                    }
                    _ => panic!("original builtin"),
                };
                match edit {
                    "awaited" => {
                        let super::super::ir::IrCallTarget::Builtin { awaited, .. } = target else {
                            panic!("builtin");
                        };
                        *awaited = true;
                    }
                    "argument" => args[0].expr = IrExpr::Name("copied".into()),
                    _ => unreachable!(),
                }
            }
            assert!(
                super::super::scenario_create_sources::checked_create_expression(
                    &ir, created, &changed, key, &db,
                )
                .is_none(),
                "changed {id}/{edit} cannot borrow original correspondence"
            );
        }
    }
}

#[test]
fn both_real_transcript_consumers_keep_distinct_query_and_selected_turn_field_ids() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let (db, program, ir, catalog) = fixture();
    let proof = checked(&ir);
    let facts = proof
        .source_facts
        .as_ref()
        .unwrap()
        .transcripts
        .as_deref()
        .unwrap();
    let [first, later] = facts else {
        panic!("two actual transcript invocations")
    };
    assert_ne!(first.id, later.id);
    assert_ne!(first.call, later.call);
    assert!(first.call.start < later.call.start);
    assert_eq!(proof.source.sha256, HASH);
    let [returned] = proof.returns.as_slice() else {
        panic!("one actual count(messages) source result")
    };
    assert_eq!(returned.influences.len(), 8);
    let mut ids = HashSet::new();
    let plan =
        query_plan(&program, &ir, &db, Some(&catalog)).expect("real checked query source plan");
    let queries = plan["queries"].as_array().unwrap();
    assert_eq!(queries.len(), 2);
    let metadata =
        selections(&program, &ir, &db, Some(&catalog)).expect("genuine selection metadata");
    let metadata = metadata.as_array().unwrap();
    assert_eq!(metadata.len(), 2);
    let ordinary_ids = plan["returns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|returned| returned["dependencies"].as_array().unwrap())
        .map(|read| read["id"].as_str().unwrap())
        .collect::<HashSet<_>>();
    for returned in plan["returns"].as_array().unwrap() {
        let influences = returned["influences"].as_array().unwrap();
        assert_eq!(influences.len(), 8);
        for (index, group) in influences.as_chunks::<4>().0.iter().enumerate() {
            assert_eq!(
                group
                    .iter()
                    .map(|influence| influence["kind"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                [
                    "query-existence",
                    "query-cardinality",
                    "query-membership",
                    "query-order"
                ]
            );
            assert!(
                group
                    .iter()
                    .all(|influence| influence["queryId"] == queries[index]["id"])
            );
        }
    }
    for (index, fact) in facts.iter().enumerate() {
        let original =
            checked_transcript_source(&program, &ir, owner(&ir), fact.call, &db, Some(&catalog))
                .expect("actual source/IR transcript consumer");
        assert!(
            std::ptr::eq(original, fact),
            "borrow the original caller-specific selection"
        );
        assert_eq!(text(&db, fact.call), "transcript(branch)");
        assert_eq!(fact.source, proof.source);
        assert_eq!(fact.slots, [Some(0)]);
        assert_eq!(fact.dependencies.len(), 3);
        assert_eq!(fact.query_dependencies.len(), 3);
        assert_eq!(fact.fields.len(), 3);
        let query = &queries[index];
        assert_eq!(query["id"], fact.id);
        assert_eq!(query["model"], "SourceTranscript.Turn");
        assert_eq!(query["source"]["sha256"], HASH);
        assert_eq!(
            query["order"],
            serde_json::json!([{"field":"position","direction":"asc"}])
        );
        assert_eq!(query["parent"]["model"], "SourceTranscript.Branch");
        assert_eq!(
            query["parent"]["origin"],
            serde_json::json!({"kind":"admitted-reference","parameter":"branch"})
        );
        let controls = query["dependencies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|read| read["role"] == "control")
            .collect::<Vec<_>>();
        let [position] = controls.as_slice() else {
            panic!("one original position CONTROL")
        };
        assert_eq!(position["field"], "position");
        assert_eq!(position["type"], "int");
        assert_eq!(position["source"], query["source"]);
        assert_eq!(position["id"], fact.order_dependency.id);
        assert!(ids.insert(position["id"].as_str().unwrap()));
        assert!(!ordinary_ids.contains(position["id"].as_str().unwrap()));
        assert_eq!(text(&db, fact.order_node), "turn.position");
        assert_eq!(
            program.types.symbol_types[&fact.order],
            ResolvedType::Scalar(Scalar::Int)
        );
        assert_eq!(fact.order_dependency.field, fact.order);
        assert_eq!(fact.order_dependency.node, fact.order_node);
        assert_eq!(fact.order_dependency.ty, ResolvedType::Scalar(Scalar::Int));
        assert_eq!(fact.order_dependency.role, DependencyRole::Control);
        assert_eq!(fact.order_dependency.calls, [fact.call]);
        assert!(
            !returned
                .dependencies
                .iter()
                .any(|read| read.id == fact.order_dependency.id),
            "query position control stays query-owned"
        );
        assert_eq!(metadata[index]["queryId"], fact.id);
        assert_eq!(metadata[index]["type"], "TextMessage[]");
        assert_eq!(metadata[index]["fields"].as_array().unwrap().len(), 3);
        let data = query["dependencies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|read| read["role"] == "data")
            .collect::<Vec<_>>();
        assert_eq!(data.len(), 3);
        for ((field, dependency), name) in
            fact.fields
                .iter()
                .zip(&fact.dependencies)
                .zip(["role", "content", "attachments"])
        {
            let source_field = ir
                .items
                .iter()
                .find(|item| item.canonical == format!("SourceTranscript.Turn.{name}"))
                .unwrap();
            assert!(
                ids.insert(dependency.id.as_str()),
                "each caller owns distinct original read IDs"
            );
            assert_eq!(field.name, name);
            assert_eq!(dependency.field_name, name);
            assert_eq!(field.source_field, source_field.id);
            assert_eq!(dependency.field, source_field.id);
            assert_eq!(dependency.model, fact.model);
            assert_eq!(dependency.model_name, "SourceTranscript.Turn");
            assert_eq!(dependency.node, field.value_node);
            assert_eq!(text(&db, dependency.node), format!("turn.{name}"));
            assert_eq!(dependency.source, fact.source);
            assert_eq!(dependency.calls, [fact.call]);
            assert_eq!(dependency.role, DependencyRole::Data);
            assert_eq!(dependency.query_id.as_deref(), Some(fact.id.as_str()));
            assert!(
                returned.dependencies.contains(dependency),
                "each consuming Return retains the actual query-linked DATA read"
            );
            assert_eq!(dependency.ty, field.ty);
            assert_eq!(dependency.ty, program.types.symbol_types[&source_field.id]);
            assert!(!dependency.type_id.is_empty());
            if name == "attachments" {
                assert_eq!(dependency.type_id, "file[]");
            }
            if name == "content" {
                assert_eq!(dependency.type_id, "text");
            }
            let field_index = ["role", "content", "attachments"]
                .iter()
                .position(|field| *field == name)
                .unwrap();
            let query_read = &fact.query_dependencies[field_index];
            assert_eq!(data[field_index]["id"], query_read.id);
            assert_eq!(data[field_index]["field"], dependency.field_name);
            assert_eq!(data[field_index]["type"], dependency.type_id);
            assert_eq!(data[field_index]["source"], query["source"]);
            assert_ne!(query_read.id, dependency.id);
            assert!(
                ids.insert(query_read.id.as_str()),
                "caller-specific query DATA identity"
            );
            assert!(
                !ordinary_ids.contains(query_read.id.as_str()),
                "query-only IDs cannot collide with any ordinary Return read"
            );
            assert_eq!(query_read.field, dependency.field);
            assert_eq!(query_read.model, dependency.model);
            assert_eq!(query_read.node, dependency.node);
            assert_eq!(query_read.ty, dependency.ty);
            assert_eq!(query_read.type_id, dependency.type_id);
            assert_eq!(query_read.source, dependency.source);
            assert_eq!(query_read.calls, dependency.calls);
            assert_eq!(query_read.role, DependencyRole::Data);
            assert!(query_read.query_id.is_none());
            for emitted_return in plan["returns"].as_array().unwrap() {
                let original = emitted_return["dependencies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|read| read["id"] == dependency.id)
                    .expect("every consuming Return has original DATA ID");
                assert_eq!(original["role"], "data");
                assert_eq!(original["queryId"], fact.id);
                assert_eq!(original["model"], "SourceTranscript.Turn");
                assert_eq!(original["field"], dependency.field_name);
            }
        }
        for (field, dependency) in metadata[index]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .zip(&fact.dependencies)
        {
            assert_eq!(field["name"], dependency.field_name);
            assert_eq!(field["dependencyId"], dependency.id);
        }
        assert_eq!(fact.influences.len(), 4);
        let group = &returned.influences[index * 4..index * 4 + 4];
        for (actual, kind) in group.iter().zip([
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder,
        ]) {
            assert_eq!(actual.kind, kind);
            assert_eq!(actual.query_id.as_deref(), Some(fact.id.as_str()));
            assert_eq!(actual.source, fact.source);
        }
        assert_eq!(
            group,
            fact.influences.as_slice(),
            "the actual leading count and later concat/count carry these same query influences"
        );
    }
    assert_eq!(
        ids.len(),
        14,
        "six ordinary selection IDs, six distinct query DATA IDs and two position CONTROL IDs"
    );
}

#[test]
fn altered_selection_source_field_type_role_order_id_or_caller_loses_source_correspondence() {
    let (db, program, ir, catalog) = fixture();
    let owner_id = owner(&ir).id;
    let originals = checked(&ir)
        .source_facts
        .as_ref()
        .unwrap()
        .transcripts
        .as_deref()
        .unwrap();
    let call = originals[0].call;
    assert!(
        checked_transcript_source(&program, &ir, owner(&ir), call, &db, Some(&catalog)).is_some()
    );
    assert!(query_plan(&program, &ir, &db, Some(&catalog)).is_some());
    assert!(selections(&program, &ir, &db, Some(&catalog)).is_some());
    for mode in [
        "source",
        "field",
        "type",
        "role",
        "order",
        "id",
        "caller",
        "query-id",
        "source-schema",
        "order-control",
        "query-order",
        "selection-type",
        "return-data",
        "query-data-id-collision",
    ] {
        let mut changed = ir.clone();
        if mode == "source-schema" {
            let field = changed
                .items
                .iter()
                .find(|item| item.canonical == "SourceTranscript.Turn.attachments")
                .unwrap()
                .id;
            let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                panic!("genuine stored File[] field")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::File));
        } else if mode == "query-order" {
            let helper = changed
                .items
                .iter()
                .find(|item| item.canonical == "SourceTranscript.transcript")
                .unwrap()
                .id;
            let IrItemKind::DeriveFn {
                expr: Some(body), ..
            } = &mut changed.items[helper.0 as usize].kind
            else {
                panic!("owning transcript helper")
            };
            let IrExpr::Binary { right, .. } = &mut body.expr else {
                panic!("prefix and query")
            };
            let IrExpr::Query(query) = &mut right.expr else {
                panic!("original Turn query")
            };
            query.order[0].descending = true;
        } else if mode == "return-data" {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner_id).unwrap()
            else {
                panic!("Complete")
            };
            let data_id = proof
                .source_facts
                .as_ref()
                .unwrap()
                .transcripts
                .as_ref()
                .unwrap()[0]
                .dependencies[2]
                .id
                .clone();
            proof.returns[0]
                .dependencies
                .retain(|read| read.id != data_id);
        } else {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner_id).unwrap()
            else {
                panic!("Complete")
            };
            let facts = proof
                .source_facts
                .as_mut()
                .unwrap()
                .transcripts
                .as_mut()
                .unwrap();
            let other_call = facts[1].call;
            let other_id = facts[1].id.clone();
            let fact = &mut facts[0];
            match mode {
                "source" => fact.dependencies[0].source.sha256 = "0".repeat(64),
                "field" => fact.dependencies[0].field = fact.fields[1].source_field,
                "type" => fact.dependencies[0].ty = ResolvedType::Scalar(Scalar::Int),
                "role" => fact.dependencies[0].role = DependencyRole::Control,
                "order" => fact.dependencies.swap(0, 1),
                "id" => fact.dependencies[0].id = fact.dependencies[1].id.clone(),
                "caller" => fact.dependencies[0].calls = vec![other_call],
                "query-id" => fact.id = other_id,
                "query-data-id-collision" => {
                    fact.query_dependencies[0].id = fact.dependencies[0].id.clone()
                }
                "order-control" => fact.order_dependency.role = DependencyRole::Data,
                "selection-type" => {
                    fact.ty = ResolvedType::Array {
                        element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                        ordered: true,
                        nonempty: false,
                    }
                }
                _ => unreachable!(),
            }
        }
        if mode != "return-data" {
            assert!(
                checked_transcript_source(
                    &program,
                    &changed,
                    owner(&changed),
                    call,
                    &db,
                    Some(&catalog)
                )
                .is_none(),
                "{mode}"
            );
        }
        assert!(
            query_plan(&program, &changed, &db, Some(&catalog)).is_none(),
            "query plan {mode}"
        );
        assert!(
            selections(&program, &changed, &db, Some(&catalog)).is_none(),
            "selection metadata {mode}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "source-transcript.can".into(),
        SOURCE.replace("attachments:file[] max=8", "attachments:file[] max=9"),
    );
    assert!(
        checked_transcript_source(&program, &ir, owner(&ir), call, &stale, Some(&catalog))
            .is_none(),
        "stale owning field source"
    );
    assert!(query_plan(&program, &ir, &stale, Some(&catalog)).is_none());
    assert!(selections(&program, &ir, &stale, Some(&catalog)).is_none());
    assert!(
        checked_transcript_source(&program, &ir, owner(&ir), call, &db, None).is_none(),
        "no genuine standard schema catalog"
    );
}

#[test]
fn additional_selection_ids_do_not_publish_a_native_stored_message_receiver() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let (db, program, ir, catalog) = fixture();
    assert_eq!(checked(&ir).returns[0].influences.len(), 8);
    assert!(has_original_transcript_source(&ir, owner(&ir).id));
    for output in [
        super::super::js::emit_program_with_native_source_receipts(&ir, true, &db),
        super::super::js::emit_program_with_native_receipts(&ir, true),
    ] {
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("transcript")),
            "{:#?}",
            output.diagnostics
        );
        assert!(
            output
                .operations
                .iter()
                .find(|operation| operation.name == OWNER)
                .unwrap()
                .disclosure
                .is_none()
        );
    }
    let mut result = DiagnosticResult::new("transcript-selection", "1.0", 1);
    result.add_sources(&db);
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("transcript")),
        "{diagnostics:?}"
    );
    let metadata =
        selections(&program, &ir, &db, Some(&catalog)).expect("actual producer metadata");
    let module = artifact
        .modules
        .iter()
        .find(|module| module.path == super::super::js::module_path("SourceTranscript"))
        .unwrap();
    let definition = module
        .js
        .lines()
        .find(|line| line.starts_with("export const appDefinition="))
        .unwrap();
    let name = serde_json::to_string(OWNER).unwrap();
    let declaration = &definition[definition
        .find(&format!("{name}:{{handler:{name},"))
        .expect("actual owning operation declaration")..];
    assert!(
        declaration.contains(&format!(
            "querySelections:{}",
            serde_json::to_string(&metadata).unwrap()
        )),
        "the actual checked emission carries its authenticated selection array"
    );
    assert_eq!(definition.matches("querySelections:").count(), 1);
    let raw = super::super::js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        !raw.entry.js.contains("querySelections:"),
        "raw source inventory does not manufacture prepared operation metadata"
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let primary = Path::new("/Users/vince/Projects/canlang");
    let installed = if primary
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        primary
    } else {
        root
    };
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("source-transcript.can");
    std::fs::write(&source_path, SOURCE).unwrap();
    std::fs::write(
        scratch.path().join("artifact.json"),
        crate::codegen::artifact::to_json(&artifact),
    )
    .unwrap();
    let runner = scratch.path().join("selection-binder.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const state=dirname(require.resolve('@canlang/state'));
const {checkScenarioResultDisclosurePlan}=await import(pathToFileURL(resolve(state,'invocation/scenario-receipt.js')));
const {bindScenarioQuerySelection}=await import(pathToFileURL(resolve(state,'invocation/scenario-query-selection.js')));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:process.argv[3]},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const plan=module.canScenarioQuerySources()['SourceTranscript.compose'];
const selections=module.appDefinition.operations['SourceTranscript.compose'].querySelections;
assert.deepEqual(checkScenarioResultDisclosurePlan(plan),plan);
const loaded=loadArtifactDescriptors(artifact,{by:{role:'members'}});
const bound={plan,artifactModels:new Map(artifact.models.map(model=>[model.name,model])),canonicalModels:loaded.models,valueSchema:loaded.valueSchema};
assert.equal(selections.length,2);
for(const metadata of selections) {
 const profile=bindScenarioQuerySelection(bound,metadata);
 assert.equal(profile.queryId,metadata.queryId);assert.equal(profile.type,'TextMessage[]');
 assert.equal(profile.model,'SourceTranscript.Turn');
 assert.deepEqual(profile.fields.map(field=>[field.name,field.dependencyId]),metadata.fields.map(field=>[field.name,field.dependencyId]));
 assert.ok(profile.fields.find(field=>field.name==='attachments').fileProfile);
}
// These are literal loader/selection declarations, not an admitted call,
// query execution, selected slot, row/File grant or native result receipt.
const collision=structuredClone(plan);
collision.queries[0].dependencies.find(dep=>dep.role==='data').id=selections[0].fields[0].dependencyId;
assert.throws(()=>checkScenarioResultDisclosurePlan(collision));
const wrong=structuredClone(selections[0]);wrong.fields[0].dependencyId=selections[1].fields[0].dependencyId;
assert.throws(()=>bindScenarioQuerySelection(bound,wrong));
"#).unwrap();
    let executed = std::process::Command::new("node")
        .arg(runner)
        .arg(installed)
        .arg(source_path)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
