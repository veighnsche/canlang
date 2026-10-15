//! Whole required Contract parameters at their original native Create sites.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir, js};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"app Snapshots
Given
 Customer {active:bool}
 Location {title:text}
 Result {title:text trim min=1}
 contract Selection {location:Location}
 contract Lead {customer:Customer,selection:Selection,title:Result.title,value:money}
 Snapshot {input:Lead}
 policy Customer read=members
 policy Location read=members
 policy Snapshot read=members
When
 scenario capture(input:Lead,other:Lead,accept:bool) -> Snapshot by=members
  do
   create Snapshot {input} as snapshot
   require accept
   return snapshot
 scenario same(snapshot:Snapshot,input:Lead) -> bool by=members
  do
   return snapshot.input==input
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn checked(source: &str) -> (SourceDb, CheckedProgram, Option<Catalog>) {
    let mut db = SourceDb::new();
    let file = db.add("contract-snapshots.can".into(), source.into());
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
    (db, program, catalog)
}

#[test]
fn original_whole_contract_parameter_preserves_nested_schema_and_late_guard() {
    for source in [
        SOURCE.to_string(),
        SOURCE.replace("create Snapshot {input}", "create Snapshot {input=input}"),
        SOURCE
            .replace("Snapshots", "Renamed")
            .replace("Lead", "Request")
            .replace("Selection", "Choice")
            .replace("input", "payload")
            .replace("customer", "buyer"),
        format!("{}\npackage Shared\n Given\n  export Customer {{active:bool}}\n  export Location {{title:text}}\n  export contract Selection {{location:Location}}\n  export contract Lead {{customer:Customer,selection:Selection,title:text trim min=1,value:money}}\n  policy Customer read=members\n  policy Location read=members\n When\n Then\n",
            SOURCE.replace("app Snapshots", "app Snapshots\nuse Shared {Lead as Reviewed}")
                .replace(" contract Selection {location:Location}\n", "")
                .replace(" contract Lead {customer:Customer,selection:Selection,title:Result.title,value:money}\n", "")
                .replace(":Lead", ":Reviewed")),
    ] {
        let (db, program, catalog) = checked(&source);
        let mut result = DiagnosticResult::new("contract-snapshots", "1.0", 1);
        result.add_sources(&db);
        let (_, diagnostics) = emit(
            &program,
            &EmitSources {
                db: &db,
                result: &result,
                catalog: catalog.as_ref(),
                options: EmitOptions {
                    allow_incomplete_test_only: false,
                    native_scenario_receipts: true,
                },
            },
        );
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }
}

#[test]
fn whole_contract_correspondence_refuses_parameter_and_nested_schema_substitutions() {
    let (db, program, catalog) = checked(SOURCE);
    let (original, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for corruption in 0..4 {
        let mut lowered = original.clone();
        match corruption {
            0 => {
                let owner = lowered
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "Snapshots.capture")
                    .unwrap();
                let ir::IrItemKind::Scenario { effects, .. } = &mut owner.kind else {
                    panic!("scenario");
                };
                let ir::IrStmt::Create { input, .. } = &mut effects[0] else {
                    panic!("create");
                };
                let ir::IrExpr::Object(entries) = &mut input.expr else {
                    panic!("fields");
                };
                // Same type and original source span, different admitted slot.
                entries[0].1.expr = ir::IrExpr::Name("other".into());
            }
            1 => {
                let parameter = lowered
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "Snapshots.capture.input")
                    .unwrap();
                let ir::IrItemKind::Param { index, .. } = &mut parameter.kind else {
                    panic!("parameter");
                };
                *index = 1;
            }
            2 => {
                let contract = lowered
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "Snapshots.Lead")
                    .unwrap();
                let ir::IrItemKind::Contract { fields, .. } = &mut contract.kind else {
                    panic!("contract");
                };
                fields.swap(0, 1);
            }
            3 => {
                let customer = lowered
                    .items
                    .iter()
                    .find(|item| item.canonical == "Snapshots.Customer")
                    .unwrap()
                    .id;
                let location = lowered
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "Snapshots.Selection.location")
                    .unwrap();
                let ir::IrItemKind::Field { ty, .. } = &mut location.kind else {
                    panic!("field");
                };
                *ty = ir::IrType::Known(canlang_compiler::analysis::types::ResolvedType::Record {
                    symbol: customer,
                    stored: true,
                });
            }
            _ => unreachable!(),
        }
        let output = js::emit_program_with_native_source_receipts(&lowered, true, &db);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "corruption {corruption}: {:?}",
            output.diagnostics
        );
    }
}
