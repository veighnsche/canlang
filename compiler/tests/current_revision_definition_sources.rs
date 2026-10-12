//! Canonical WorkflowDefinition read through the original captured current Revision.
//! Source correspondence is not native stored-value or File authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{DependencyRole, ScenarioDisclosure};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, ResolvedType, check_program};
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::syntax::SyntaxKind;

fn source() -> String {
    // Preserve the original Template/Revision declaration, rules, locks and
    // required current/published/digest guards. The added Run sink consumes
    // exactly the original generate SEND operand revision.definition.
    include_str!("fixtures/source-current-revision.can")
        .replace("Run {revision:Revision,digest:text,outputs:int,duration:duration}",
            "Run {revision:Revision,digest:text,outputs:int,duration:duration,workflow:WorkflowDefinition}")
        .replace("   create Run {revision,digest=validation,outputs=revision.outputs,duration=revision.duration} as run",
            "   let workflow=revision.definition\n   create Run {revision,digest=validation,outputs=revision.outputs,duration=revision.duration,workflow} as run")
}

fn checked(source: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("current-definition.can".into(), source.into());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
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
    (db, program, ir, catalog)
}

#[test]
fn original_definition_read_retains_canonical_type_field_and_captured_lineage() {
    let original = include_str!("fixtures/original-a850/CanCreative.can");
    assert!(original.contains("workflow=revision.definition"));
    let source = source();
    let (db, program, ir, catalog) = checked(&source);
    let owner = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "SourceCurrentRevision.generate")
        .unwrap();
    let revision = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "SourceCurrentRevision.Revision")
        .unwrap();
    let field = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "SourceCurrentRevision.Revision.definition")
        .unwrap();
    let begin = source.find("revision.definition").unwrap() as u32;
    let node = NodeKey {
        file: program.checked_files()[0],
        start: begin,
        end: begin + "revision.definition".len() as u32,
        kind: SyntaxKind::Member as u8,
    };
    let declared = &program.types.symbol_types[&field.id];
    assert!(matches!(declared,ResolvedType::StdNominal {name,fields}
        if *name=="WorkflowDefinition" && fields.iter().map(|(name,_)| name.as_str()).collect::<Vec<_>>()
            == ["graph","prompt","negative","width","height"]));
    assert_eq!(&program.types.node_types[&node], declared);
    let ScenarioDisclosure::Complete(proof) = &program.scenario_disclosures()[&owner.id] else {
        panic!("{:?}", program.scenario_disclosures()[&owner.id]);
    };
    assert!(!proof.returns.is_empty());
    for returned in &proof.returns {
        let reads: Vec<_> = returned
            .dependencies
            .iter()
            .filter(|read| read.node == node)
            .collect();
        assert_eq!(reads.len(), 1);
        let read = reads[0];
        assert_eq!(read.model, revision.id);
        assert_eq!(read.field, field.id);
        assert_eq!(read.field_name, "definition");
        assert_eq!(read.type_id, "WorkflowDefinition");
        assert_eq!(read.ty, *declared);
        assert_eq!(read.role, DependencyRole::Data);
        assert!(read.calls.is_empty() && read.query_id.is_none());
        assert_eq!(read.source, proof.source);
        assert_eq!(
            &db.get(node.file).unwrap().text[node.start as usize..node.end as usize],
            "revision.definition"
        );
        assert!(
            returned
                .dependencies
                .iter()
                .any(|read| read.field_name == "current" && read.role == DependencyRole::Data)
        );
    }
    assert!(
        js::emit_program_with_native_source_receipts(&ir, true, &db)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "source schema does not provide native nominal receiving"
    );
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("current-definition.can");
    std::fs::write(&input, &source).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root.join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(10));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["complete"], true);
    assert!(report.get("modules").is_none());
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008")
    );
    let _catalog = catalog;
}

#[test]
fn definition_does_not_admit_a_copied_revision_or_other_standard_nominal() {
    let cases = [
        source().replace(
            "let revision=template.current",
            "let current=template.current\n   let revision=current",
        ),
        source()
            .replace(
                "use std {WorkflowDefinition}",
                "use std {WorkflowDefinition,WorkflowInput}",
            )
            .replace("definition:WorkflowDefinition", "definition:WorkflowInput")
            .replace("workflow:WorkflowDefinition", "workflow:WorkflowInput"),
    ];
    for changed in cases {
        let (_, program, _, _) = checked(&changed);
        let owner = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "SourceCurrentRevision.generate")
            .unwrap();
        assert!(
            matches!(
                program.scenario_disclosures()[&owner.id],
                ScenarioDisclosure::Declined(_)
            ),
            "copied or foreign source must not acquire captured current lineage"
        );
    }
}

#[test]
fn renamed_current_definition_declarations_keep_the_genuine_standard_type_alias() {
    let source = source()
        .replace("SourceCurrentRevision", "DeclarationBound")
        .replace("Template", "Blueprint")
        .replace("Revision", "Edition")
        .replace("template", "blueprint")
        .replace("revision", "edition")
        .replace("validation", "stamp")
        .replace("WorkflowDefinition", "Workflow")
        .replace(
            "use std {Workflow}",
            "use std {WorkflowDefinition as Workflow}",
        );
    let (_, program, _, _) = checked(&source);
    let owner = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "DeclarationBound.generate")
        .unwrap();
    let revision = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "DeclarationBound.Edition")
        .unwrap();
    let definition = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "DeclarationBound.Edition.definition")
        .unwrap();
    let ScenarioDisclosure::Complete(proof) = &program.scenario_disclosures()[&owner.id] else {
        panic!("{:?}", program.scenario_disclosures()[&owner.id]);
    };
    for returned in &proof.returns {
        let read = returned
            .dependencies
            .iter()
            .find(|read| read.field == definition.id)
            .expect("owning definition read");
        assert_eq!(read.model, revision.id);
        assert_eq!(read.type_id, "WorkflowDefinition");
        assert_eq!(read.role, DependencyRole::Data);
        assert_eq!(read.ty, program.types.symbol_types[&definition.id]);
        assert!(read.calls.is_empty() && read.query_id.is_none());
    }
}
