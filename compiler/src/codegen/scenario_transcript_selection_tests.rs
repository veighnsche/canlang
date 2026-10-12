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
            assert_eq!(data[field_index]["id"], dependency.id);
            assert_eq!(data[field_index]["field"], dependency.field_name);
            assert_eq!(data[field_index]["type"], dependency.type_id);
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
        8,
        "six selection IDs plus each caller's position CONTROL"
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
}
