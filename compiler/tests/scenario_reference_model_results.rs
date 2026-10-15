//! Source-only provenance for required stored-reference model returns.
//! No native owner row, query handle or runtime authority is supplied here.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{DependencyRole, ScenarioDisclosure};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, check_program};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"app ReferenceSources
Given
 Deal {title:text}
 Intake {source:text,deal:Deal}
 policy Deal read=members
 policy Intake read=members
When
 scenario promote(source:text,accept:bool) -> Deal by=members
  do
   let existing=first(Intake as candidate where candidate.source==source)
   if existing!=null
    require accept
    return existing.deal
   create Deal {title=source} as deal
   return deal
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn checked(source: &str) -> (SourceDb, CheckedProgram) {
    let mut db = SourceDb::new();
    let file = db.add("reference-results.can".into(), source.into());
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program)
}
fn disclosure(program: &CheckedProgram) -> &ScenarioDisclosure {
    let scenario = program
        .symbols
        .iter()
        .find(|symbol| symbol.name == "promote")
        .unwrap();
    program.scenario_disclosures().get(&scenario.id).unwrap()
}
fn text(db: &SourceDb, key: NodeKey) -> &str {
    db.get(key.file).unwrap().text[key.start as usize..key.end as usize].trim()
}
fn assert_reference(source: &str, source_model: &str, target: &str, field: &str, operand: &str) {
    let (db, program) = checked(source);
    let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
        panic!(
            "required reference source declined: {:?}",
            disclosure(&program)
        );
    };
    let facts = complete.source_facts.as_ref().unwrap();
    assert_eq!(facts.source.sha256, sha256_hex(source.as_bytes()));
    let queries = facts.queries.as_ref().unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].model_name, source_model);
    assert!(queries[0].first.is_some());
    assert!(queries[0].order.is_empty());
    assert_eq!(queries[0].inputs.len(), 1);
    let references: Vec<_> = complete
        .returns
        .iter()
        .filter(|returned| {
            returned
                .dependencies
                .iter()
                .any(|dependency| dependency.model_name == target && dependency.field_name == "id")
        })
        .collect();
    assert!(
        !references.is_empty(),
        "original early branch reference result"
    );
    for returned in &references {
        let source_reads: Vec<_> = returned
            .dependencies
            .iter()
            .filter(|dependency| {
                dependency.model_name == source_model
                    && dependency.field_name == field
                    && dependency.role == DependencyRole::Data
            })
            .collect();
        let ids: Vec<_> = returned
            .dependencies
            .iter()
            .filter(|dependency| {
                dependency.model_name == target
                    && dependency.field_name == "id"
                    && dependency.role == DependencyRole::Data
            })
            .collect();
        let [read] = source_reads.as_slice() else {
            panic!("one original stored reference read");
        };
        let [id] = ids.as_slice() else {
            panic!("one independent target identity read");
        };
        assert_eq!(read.node, id.node);
        assert_eq!(text(&db, read.node), operand);
        assert_ne!(
            read.id, id.id,
            "separate opaque occurrences at one real operand"
        );
        assert_eq!(read.source, id.source);
        assert_eq!(read.source, facts.source);
        assert_eq!(id.ty, ResolvedType::Scalar(Scalar::Text));
        assert_eq!(id.type_id, "text");
        assert_eq!(program.symbols[read.field.0 as usize].name, field);
        assert_eq!(program.symbols[id.model.0 as usize].canonical, target);
        assert_eq!(
            read.ty,
            ResolvedType::Record {
                symbol: id.model,
                stored: true
            }
        );
        assert!(
            !returned.decisions.is_empty(),
            "actual early branch decision retained"
        );
        assert_eq!(returned.influences, queries[0].influences);
    }
    assert!(
        complete
            .returns
            .iter()
            .any(|returned| returned.node == queries[0].return_node
                && !returned
                    .dependencies
                    .iter()
                    .any(|dependency| dependency.field_name == "id")),
        "fresh result path remains distinct from existing target identity"
    );
    assert_eq!(
        complete.effects.len(),
        1,
        "only the fresh path executes the original create"
    );
}

#[test]
fn first_selected_required_reference_and_fresh_branch_keep_original_source_and_target_identity() {
    assert_reference(
        SOURCE,
        "ReferenceSources.Intake",
        "ReferenceSources.Deal",
        "deal",
        "existing.deal",
    );
}

#[test]
fn renamed_declarations_fields_inputs_aliases_and_grouped_operands_use_the_same_provenance() {
    let renamed = SOURCE
        .replace("ReferenceSources", "Renamed")
        .replace("Intake", "Selection")
        .replace("Deal", "Outcome")
        .replace("source", "key")
        .replace("candidate", "entry")
        .replace("existing", "selected")
        .replace("deal", "outcome");
    assert_reference(
        &renamed,
        "Renamed.Selection",
        "Renamed.Outcome",
        "outcome",
        "selected.outcome",
    );
    let grouped = SOURCE
        .replace("candidate.source==source", "((candidate.source)==(source))")
        .replace("existing!=null", "(existing!=null)")
        .replace("return existing.deal", "return ((existing).deal)");
    assert_reference(
        &grouped,
        "ReferenceSources.Intake",
        "ReferenceSources.Deal",
        "deal",
        "(existing).deal",
    );
}

#[test]
fn original_required_parameter_field_has_the_same_independent_identity_anchor() {
    let source = SOURCE.replace("scenario promote(source:text,accept:bool)", "scenario promote(existing:Intake,source:text,accept:bool)")
        .replace("   let existing=first(Intake as candidate where candidate.source==source)\n   if existing!=null\n    require accept\n    return existing.deal\n   create Deal {title=source} as deal\n   return deal", "   require accept\n   return existing.deal");
    let (db, program) = checked(&source);
    let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
        panic!("{:?}", disclosure(&program));
    };
    let [returned] = complete.returns.as_slice() else {
        panic!("one parameter reference result");
    };
    let ids: Vec<_> = returned
        .dependencies
        .iter()
        .filter(|dependency| dependency.field_name == "id")
        .collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(ids[0].model_name, "ReferenceSources.Deal");
    assert_eq!(text(&db, ids[0].node), "existing.deal");
    assert!(
        returned
            .dependencies
            .iter()
            .any(|dependency| dependency.field_name == "deal"
                && dependency.model_name == "ReferenceSources.Intake"
                && dependency.node == ids[0].node)
    );
}

#[test]
fn copied_receiver_or_reference_and_structural_contract_shell_are_not_direct_stored_results() {
    for source in [
        SOURCE.replace(
            "    return existing.deal",
            "    let copied=existing\n    return copied.deal",
        ),
        SOURCE.replace(
            "    return existing.deal",
            "    let copied=existing.deal\n    return copied",
        ),
        SOURCE
            .replace(
                " Intake {source:text,deal:Deal}",
                " contract Box {deal:Deal}\n Intake {source:text,deal:Box}",
            )
            .replace("return existing.deal", "return existing.deal.deal"),
    ] {
        let (_, program) = checked(&source);
        assert!(
            matches!(disclosure(&program), ScenarioDisclosure::Declined(_)),
            "{:?}",
            disclosure(&program)
        );
    }
}

#[test]
fn nullable_or_array_reference_types_do_not_acquire_singular_model_result_provenance() {
    for source in [
        SOURCE
            .replace("deal:Deal}", "deal:Deal?}")
            .replace("-> Deal by", "-> Deal? by"),
        SOURCE
            .replace("deal:Deal}", "deal:Deal[]}")
            .replace("-> Deal by", "-> Deal[] by")
            .replace("   return deal", "   return [deal]"),
    ] {
        // Keep the final branch well typed while refusing a singular required
        // reference/result source. Nullable final rows are valid nullable values.
        let (_, program) = checked(&source);
        assert!(
            matches!(disclosure(&program), ScenarioDisclosure::Declined(_)),
            "{:?}",
            disclosure(&program)
        );
    }
}

const CHAIN_SOURCE: &str = r#"app ReferenceChains
Given
 Location {title:text}
 Unused {title:text}
 Deal {location:Location,unrelated:Unused}
 Intake {source:text,deal:Deal}
 policy Location read=members
 policy Deal read=members
 policy Intake read=members
When
 scenario promote(source:text) -> Location by=members
  do
   let existing=first(Intake as candidate where candidate.source==source)
   if existing!=null
    return existing.deal.location
   create Location {title=source} as location
   return location
Then
"#;

fn assert_chain(source: &str, edge_operands: [&str; 2]) {
    let (db, program) = checked(source);
    let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
        panic!(
            "required reference chain declined: {:?}",
            disclosure(&program)
        );
    };
    let returned = complete
        .returns
        .iter()
        .find(|returned| {
            returned
                .dependencies
                .iter()
                .any(|read| read.field_name == "id")
        })
        .expect("original chain result identity");
    let data: Vec<_> = returned
        .dependencies
        .iter()
        .filter(|read| read.role == DependencyRole::Data)
        .collect();
    assert_eq!(
        data.len(),
        3,
        "two original reference edges and final identity"
    );
    for ((read, (model, field, target)), operand) in data[..2]
        .iter()
        .zip([
            ("ReferenceChains.Intake", "deal", "ReferenceChains.Deal"),
            (
                "ReferenceChains.Deal",
                "location",
                "ReferenceChains.Location",
            ),
        ])
        .zip(edge_operands)
    {
        assert_eq!(read.model_name, model);
        assert_eq!(read.field_name, field);
        assert_eq!(read.type_id, target);
        assert_eq!(text(&db, read.node), operand);
        assert_eq!(read.source, complete.source);
        assert!(read.calls.is_empty() && read.query_id.is_none());
    }
    assert_eq!(data[2].model_name, "ReferenceChains.Location");
    assert_eq!(data[2].field_name, "id");
    assert_eq!(data[2].node, data[1].node);
    assert_ne!(data[2].id, data[1].id);
    assert_ne!(data[0].id, data[1].id);
    assert_eq!(data[2].ty, ResolvedType::Scalar(Scalar::Text));
    assert!(
        !returned
            .dependencies
            .iter()
            .any(|read| read.model_name == "ReferenceChains.Unused"),
        "an unconsumed model field supplies no dependency"
    );
}

#[test]
fn original_first_and_parameter_reference_chains_retain_each_consumed_edge() {
    assert_chain(CHAIN_SOURCE, ["existing.deal", "existing.deal.location"]);
    let grouped = CHAIN_SOURCE.replace(
        "return existing.deal.location",
        "return (((existing).deal).location)",
    );
    assert_chain(&grouped, ["(existing).deal", "((existing).deal).location"]);
    let parameter = CHAIN_SOURCE
        .replace("scenario promote(source:text)", "scenario promote(existing:Intake,source:text)")
        .replace("   let existing=first(Intake as candidate where candidate.source==source)\n   if existing!=null\n    return existing.deal.location\n   create Location {title=source} as location\n   return location", "   return existing.deal.location");
    assert_chain(&parameter, ["existing.deal", "existing.deal.location"]);
}

#[test]
fn copied_chain_receivers_and_non_singular_terminal_fields_remain_declined() {
    for source in [
        CHAIN_SOURCE.replace(
            "    return existing.deal.location",
            "    let copied=existing.deal\n    return copied.location",
        ),
        CHAIN_SOURCE.replace(
            "    return existing.deal.location",
            "    let copied=existing\n    return copied.deal.location",
        ),
        CHAIN_SOURCE
            .replace("location:Location,", "location:Location?,")
            .replace("-> Location by", "-> Location? by"),
        CHAIN_SOURCE
            .replace("location:Location,", "location:Location[],")
            .replace("-> Location by", "-> Location[] by")
            .replace("   return location", "   return [location]"),
    ] {
        let (_, program) = checked(&source);
        assert!(
            matches!(disclosure(&program), ScenarioDisclosure::Declined(_)),
            "{:?}",
            disclosure(&program)
        );
    }
}
