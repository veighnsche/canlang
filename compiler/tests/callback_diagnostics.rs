//! Genuine producer output and integrity of the protected callback source closure.
//! Native consumer authority is qualified separately against the actual Dev helper.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrEventSource, IrItemKind, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

const SOURCE: &str = include_str!("fixtures/callback-diagnostics.can");

fn checked() -> (SourceDb, Catalog, CheckedProgram) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("callback-diagnostics.can".into(), SOURCE.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, catalog, program)
}

#[test]
fn cli_emits_original_callback_authority_independently_of_ordinary_read_grants() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/callback-diagnostics.can");
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(fixture)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    assert!(output.status.success(), "{artifact}");
    let modules = artifact["modules"].as_array().unwrap();
    assert_eq!(modules.len(), 1);
    let emitted = modules[0]["js"].as_str().unwrap();
    let mut syntax = Command::new("node")
        .args(["--check", "--input-type=module"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    syntax
        .stdin
        .take()
        .unwrap()
        .write_all(emitted.as_bytes())
        .unwrap();
    let syntax = syntax.wait_with_output().unwrap();
    assert!(
        syntax.status.success(),
        "{}",
        String::from_utf8_lossy(&syntax.stderr)
    );
    assert!(emitted.contains("kind:\"empty\""), "{emitted}");
    assert!(
        emitted.contains("Geen historische callbackweigeringen."),
        "{emitted}"
    );
    assert_eq!(
        emitted
            .matches("await generationCallbackDiagnostics(c,{record:")
            .count(),
        1,
        "{emitted}"
    );
    assert!(emitted.contains(",field:\"request\"})"), "{emitted}");
    assert!(
        emitted.contains("{record:$can$rv$"),
        "protected UI observation must keep the original RowView: {emitted}"
    );
    assert!(
        emitted.contains(concat!(
            "callbackReadGrants:[{rule:\"Job.callbackRead.5\",field:\"request\",fields:[]},",
            "{rule:\"Job.callbackRead.6\",field:\"request\",fields:[]}]"
        )),
        "{emitted}"
    );
    assert!(
        emitted.contains(concat!(
            "readGrants:[{rule:\"Job.read.1\",by:[\"members\"]},",
            "{rule:\"Job.read.2\",fields:[\"request\"],by:[\"members\"]},",
            "{rule:\"Job.read.3\",fields:[\"request.error\"],by:[\"members\"]},",
            "{rule:\"Job.read.4\",fields:[\"request.result\"],by:[\"members\"]},",
            "{rule:\"Job.read.6\",fields:[\"label\",\"request.error\",\"request.result.content\"]}]"
        )),
        "{emitted}"
    );
    let (db, catalog, program) = checked();
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        ir.read_rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect::<Vec<_>>(),
        [
            "Job.read.1",
            "Job.read.2",
            "Job.read.3",
            "Job.read.4",
            "Job.read.6"
        ]
    );
    assert_eq!(
        ir.callback_read_rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect::<Vec<_>>(),
        ["Job.callbackRead.5", "Job.callbackRead.6"]
    );
    assert!(emitted.contains("callbackRead:{"), "{emitted}");
    // The helper receives the source-owned record and field only; provenance
    // is supplied by the checked declaration, never by authored origin data.
    let call = emitted
        .split("await generationCallbackDiagnostics(c,")
        .nth(1)
        .unwrap()
        .split('}')
        .next()
        .unwrap();
    assert_eq!(call.matches(':').count(), 2, "{call}");
    assert!(!call.contains("origin") && !call.contains("handler") && !call.contains("event"));
}

#[test]
fn altered_owning_ir_closure_refuses_protected_callback_publication() {
    let (db, catalog, program) = checked();
    let (original, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for mutation in [
        "field",
        "operation",
        "import",
        "from",
        "event",
        "census",
        "predicate",
        "foreign-module-transplant",
    ] {
        let mut ir = original.clone();
        let field_index = ir
            .items
            .iter()
            .position(|item| item.canonical == "CallbackDiagnostics.Job.request")
            .unwrap();
        let handler_index = ir
            .items
            .iter()
            .position(|item| item.canonical == "CallbackDiagnostics.progressed")
            .unwrap();
        let import_index = ir.modules[0]
            .imports
            .iter()
            .position(|import| import.members.iter().any(|(_, alias, _)| alias == "LLM"))
            .unwrap();
        match mutation {
            "foreign-module-transplant" => {
                let mut foreign = ir.modules[0].clone();
                foreign.id = canlang_compiler::analysis::resolve::ModuleId(ir.modules.len() as u32);
                foreign.name = "Foreign".into();
                ir.modules.push(foreign);
            }
            "field" => ir.items[field_index].canonical.push_str("Changed"),
            "operation" => {
                let IrItemKind::Field {
                    ty: IrType::Known(ty),
                    ..
                } = &mut ir.items[field_index].kind
                else {
                    panic!("owning checked delivery field");
                };
                let canlang_compiler::analysis::types::ResolvedType::Nullable(inner) = ty else {
                    panic!("nullable original delivery");
                };
                let canlang_compiler::analysis::types::ResolvedType::StdDelivery { op, .. } =
                    inner.as_mut()
                else {
                    panic!("standard original delivery");
                };
                *op = canlang_compiler::analysis::catalog::std_operation(
                    "std.TextGenerationV1",
                    "cancel",
                )
                .unwrap();
            }
            "import" => ir.modules[0].imports[import_index].members[0].0 = "EmailV1".into(),
            "from" => ir.modules[0].imports[import_index].from = Some("deployment.other".into()),
            "event" => {
                let IrItemKind::Scenario { event_source, .. } = &mut ir.items[handler_index].kind
                else {
                    panic!("ordinary progressed handler");
                };
                *event_source = Some(IrEventSource::DeliveryProgressed(
                    "CallbackDiagnostics.LLM.generate.other".into(),
                ));
            }
            "census" => {
                let IrItemKind::Scenario { event_source, .. } = &mut ir.items[handler_index].kind
                else {
                    panic!("ordinary progressed handler");
                };
                *event_source = None;
            }
            "predicate" => ir.callback_read_rules[0].pred = ir.read_rules[0].pred.clone(),
            _ => unreachable!(),
        }
        let output = js::emit_program(&ir);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mutation}: {:?}",
            output.diagnostics
        );
        assert!(
            !output.entry.js.contains("callbackReadGrants:["),
            "{mutation}: {}",
            output.entry.js
        );
        assert!(
            !output
                .entry
                .js
                .contains("await generationCallbackDiagnostics(c,{record:"),
            "{mutation}: {}",
            output.entry.js
        );
    }
}

#[test]
fn direct_callback_card_gate_preserves_the_original_row_view() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = format!(
        "{}Then\n page / title=\"Direct callback\"\n  list Job\n   card \"Direct\"\n    require row.request?.callback_diagnostics!=null\n    text \"Historical diagnostics available.\"\n",
        SOURCE.split("Then\n").next().unwrap()
    );
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("callback-direct-row.can");
    std::fs::write(&path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    let artifact: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "{error}: status={} stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            )
        });
    assert!(output.status.success(), "{artifact}");
    let emitted = artifact["modules"][0]["js"].as_str().unwrap();
    assert_eq!(
        emitted
            .matches("await generationCallbackDiagnostics(c,{record:$can$rv$")
            .count(),
        1,
        "{emitted}"
    );
    assert!(emitted.contains("const $can$rv$"), "{emitted}");
}
