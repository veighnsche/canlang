//! Canonical WorkflowDefinition read through the original captured current Revision.
//! Source correspondence is not native stored-value or File authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{DependencyRole, ScenarioDisclosure};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, ResolvedType, check_program};
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::syntax::SyntaxKind;
use sha2::Digest;

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

fn contract_field_pairs(contract: &serde_json::Value) -> Vec<(&str, &str)> {
    contract["fields"]
        .as_array()
        .expect("contract fields")
        .iter()
        .map(|field| {
            (
                field["name"].as_str().expect("field name"),
                field["type"].as_str().expect("field type"),
            )
        })
        .collect()
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
    // The raw helper lacks prepared source/decision/feasibility context, so
    // it cannot compose the prepared nominal receipt below; its refusal is
    // harness behavior, not the production pipeline verdict.
    assert!(
        js::emit_program_with_native_source_receipts(&ir, true, &db)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "raw unprepared emission still refuses native nominal receiving"
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
    // The prepared production pipeline receives the current-revision nominal
    // with its complete dependency lineage. Assert the structured artifact:
    // usable modules, exact source record, canonical nominal closure, model
    // receiving declarations and the sourced DATA stamps.
    assert_eq!(output.status.code(), Some(0));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report.get("diagnostics").is_none(), "no error diagnostics");
    let expected_sha = format!("{:x}", sha2::Sha256::digest(source.as_bytes()));
    let sources = report["sources"].as_array().expect("source record");
    assert_eq!(sources.len(), 1);
    assert_eq!(
        sources[0]["path"].as_str().expect("source path"),
        input.to_str().expect("input path")
    );
    assert_eq!(
        sources[0]["sha256"].as_str().expect("source sha"),
        expected_sha
    );
    let modules = report["modules"].as_array().expect("emitted modules");
    assert_eq!(modules.len(), 1);
    let js = modules[0]["js"].as_str().expect("emitted js");
    for marker in [
        "bindScenarioReceiptModelResult",
        "selectScenarioReceiptReturn",
        "readScenarioReceiptNullableStoredReference",
    ] {
        assert!(js.contains(marker), "missing receipt marker {marker}");
    }
    let contracts = report["valueTypes"]["contracts"]
        .as_array()
        .expect("nominal closure");
    let contract = |name: &str| {
        contracts
            .iter()
            .find(|contract| contract["name"] == name)
            .unwrap_or_else(|| panic!("missing contract {name}"))
            .clone()
    };
    assert_eq!(
        contract_field_pairs(&contract("WorkflowDefinition")),
        [
            ("graph", "file"),
            ("prompt", "WorkflowInput"),
            ("negative", "WorkflowInput"),
            ("width", "WorkflowInput"),
            ("height", "WorkflowInput"),
        ]
    );
    assert_eq!(
        contract_field_pairs(&contract("WorkflowInput")),
        [("node", "text"), ("key", "text")]
    );
    let models = report["models"].as_array().expect("model declarations");
    let model = |name: &str| {
        models
            .iter()
            .find(|model| model["name"] == name)
            .unwrap_or_else(|| panic!("missing model {name}"))
            .clone()
    };
    let declared = |model: &serde_json::Value, field: &str| {
        model["fields"]
            .as_array()
            .expect("model fields")
            .iter()
            .find(|entry| entry["name"] == field)
            .unwrap_or_else(|| panic!("missing field {field}"))
            .clone()
    };
    for (model_name, field_name) in [
        ("SourceCurrentRevision.Revision", "definition"),
        ("SourceCurrentRevision.Run", "workflow"),
    ] {
        let entry = declared(&model(model_name), field_name);
        assert_eq!(entry["field"]["kind"], "nominal", "{field_name} kind");
        assert_eq!(
            entry["field"]["name"], "WorkflowDefinition",
            "{field_name} nominal"
        );
        assert_eq!(
            entry["valueType"], "WorkflowDefinition",
            "{field_name} type"
        );
        assert_eq!(entry["required"], true, "{field_name} required");
    }
    let generate = report["operations"]
        .as_array()
        .expect("operations")
        .iter()
        .find(|operation| operation["name"] == "SourceCurrentRevision.generate")
        .expect("generate operation")
        .clone();
    let returns = generate["result"]["disclosure"]["returns"]
        .as_array()
        .expect("result returns");
    assert_eq!(returns.len(), 1);
    let dependencies = returns[0]["dependencies"]
        .as_array()
        .expect("return dependencies");
    let stamped = |model: &str, field: &str, role: &str, ty: &str| {
        dependencies
            .iter()
            .find(|dependency| {
                dependency["model"] == model
                    && dependency["field"] == field
                    && dependency["role"] == role
                    && dependency["type"] == ty
            })
            .unwrap_or_else(|| panic!("missing dependency {model}.{field} {role} {ty}"))
            .clone()
    };
    for dependency in [
        stamped(
            "SourceCurrentRevision.Revision",
            "definition",
            "data",
            "WorkflowDefinition",
        ),
        stamped(
            "SourceCurrentRevision.Template",
            "current",
            "data",
            "SourceCurrentRevision.Revision",
        ),
    ] {
        assert_eq!(
            dependency["source"]["path"]
                .as_str()
                .expect("dependency path"),
            input.to_str().expect("input path")
        );
        assert_eq!(
            dependency["source"]["sha256"]
                .as_str()
                .expect("dependency sha"),
            expected_sha
        );
    }
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
