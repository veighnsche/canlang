//! Created-model native receipts for contract-valued fields.
//!
//! A scenario that creates a model holding a nullable contract value
//! (`held:Note?`) must carry that contract's exact stored schema in its
//! disclosure census; otherwise `nominal_identity` has nothing to prove
//! and the receipt builder refuses with a created-model E6008. The census
//! is seeded from the scenario's own creates (models plus their
//! nullable/array-unwrapped contract field targets). Deployment-qualified
//! imports (`from=deployment.<binding>`) keep the exact qualifier as part
//! of the checked correspondence: absence must match absence and a present
//! qualifier must equal the recorded deployment path.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrItem, IrProgram};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span};
use serde_json::Value;
use std::path::{Path, PathBuf};

const LOCAL: &str = r#"app Probe uses=[worker]
package worker
 Given
  contract Note {value:text}
  contract Unused {x:text}
  R {held:Note?,w:int}
  policy R read=members fields=held,w
 When
  scenario go(n:int) -> R by=members
   do
    create R {w=n} as r
    return r
 Then
"#;

const DEPLOYMENT: &str = r#"app Probe uses=[worker]
package api
 Given
  export contract Note {value:text}
  export capability PortV1 version=1
   read() -> Note
 When
 Then
package worker
 use api {Note,PortV1 as Port} from=deployment.port
 Given
  R {held:Note?,w:int}
  policy R read=members fields=held,w
 When
  scenario go(n:int) -> R by=members
   do
    create R {w=n} as r
    return r
 Then
"#;

const SPLIT: &str = r#"app Probe uses=[worker]
package api
 Given
  export contract Note {value:text}
  export capability PortV1 version=1
   read() -> Note
 When
 Then
package worker
 use api {Note}
 use api {PortV1 as Port} from=deployment.port
 Given
  R {held:Note?,w:int}
  policy R read=members fields=held,w
 When
  scenario go(n:int) -> R by=members
   do
    create R {w=n} as r
    return r
 Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn checked(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("created-contract-census.can".into(), source.into());
    let path = root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
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

fn prepared(program: &CheckedProgram, db: &SourceDb, catalog: &Catalog) -> (Value, Vec<Diagnostic>) {
    let mut result = DiagnosticResult::new("created-contract-census", "1.0", 1);
    result.add_sources(db);
    let (artifact, diagnostics) = emit(
        program,
        &EmitSources {
            db,
            result: &result,
            catalog: Some(catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    (
        serde_json::from_str(&to_json(&artifact)).unwrap(),
        diagnostics,
    )
}

fn owner<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}

#[test]
fn local_contract_field_create_has_native_receipt() {
    let (db, program, ir, catalog) = checked(LOCAL);
    let scenario = owner(&ir, "worker.go");

    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&scenario.id] else {
        panic!("disclosure Complete");
    };
    let facts = proof.source_facts.as_ref().unwrap();
    assert_eq!(
        facts.result,
        Some(canlang_compiler::analysis::ResolvedType::Record {
            symbol: owner(&ir, "worker.R").id,
            stored: true
        })
    );
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "worker.go")
        .expect("contract-field create operation");
    let disclosure = operation["result"]["disclosure"]
        .as_object()
        .expect("created model result disclosure");

    let disclosed_returns = disclosure
        .get("returns")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(
        !disclosed_returns.is_empty(),
        "disclosure carries the created model return, got {disclosure:?}"
    );
    assert_eq!(
        disclosed_returns.len(),
        1,
        "exactly the created model return is disclosed, got {disclosed_returns:?}"
    );
    // The single-scenario fixture admits no other receipt: the emitted
    // model-result binder proves the native receipt was built for it, not
    // merely described in metadata.
    let bound = artifact["modules"].as_array().unwrap().iter().any(|module| {
        module["js"]
            .as_str()
            .is_some_and(|js| js.contains("bindScenarioReceiptModelResult"))
    });
    assert!(bound, "emitted assembly binds the created model result");
    let source = &disclosure["source"];
    assert!(source["path"]
        .as_str()
        .unwrap()
        .ends_with("created-contract-census.can"));
    assert!(
        source["sha256"].as_str().unwrap().len() >= 16,
        "disclosure source carries its content identity"
    );
}

#[test]
fn deployment_import_contract_field_create_has_native_receipt() {
    let (db, program, ir, catalog) = checked(DEPLOYMENT);
    let scenario = owner(&ir, "worker.go");
    let ScenarioDisclosure::Complete(_) = &ir.scenario_disclosures[&scenario.id] else {
        panic!("disclosure Complete");
    };
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let names: Vec<_> = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|operation| operation["name"].as_str().unwrap().to_string())
        .collect();
    assert!(
        names.iter().any(|name| name == "worker.go"),
        "emitted operations carry the deployment-import create, got {names:?}"
    );
}

#[test]
fn split_import_spelling_still_admits() {
    let (db, program, ir, catalog) = checked(SPLIT);
    let scenario = owner(&ir, "worker.go");
    let ScenarioDisclosure::Complete(_) = &ir.scenario_disclosures[&scenario.id] else {
        panic!("disclosure Complete");
    };
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "worker.go")
        .expect("deployment-import create operation");
    assert!(
        operation["result"]["disclosure"].is_object(),
        "deployment-import create carries its result disclosure"
    );
}
