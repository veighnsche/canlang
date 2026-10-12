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
                ids.insert(&dependency.id),
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
    assert_eq!(ids.len(), 6);
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
                _ => unreachable!(),
            }
        }
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
    let (_, diagnostics) = emit(
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
}
