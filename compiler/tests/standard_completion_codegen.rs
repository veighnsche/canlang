//! Private completion projection, separate from terminal-source runtime authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir::{
    self, IrBinOp, IrEventSource, IrExpr, IrItemKind, IrProgram, IrStmt,
};
use canlang_compiler::codegen::{artifact, bdd, js};
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

const SOURCE: &str = r#"app CompletionProjection
use std {EmailV1 as Secondary} from=deployment.secondary
use std {EmailV1 as Primary} from=deployment.primary
use std {PaymentsV1 as Cash} from=deployment.cash
use std {TextGenerationV1 as LLM} from=deployment.llm
use std {ImagesV1 as Images} from=deployment.images
Given
 Entry {seen:text}
 CompletionAudit {delivery:text,reference:text}
When
 scenario primary_first on=Primary.send.completed
  do
   let status=event.status
   require event.result!=null
   let reference=event.result.reference
   create CompletionAudit {delivery=event.delivery_id,reference=event.result.reference} as audit
   require reference!="late-reject"
 scenario secondary on=Secondary.send.completed
  do let status=event.status
 scenario primary_cohort on=Primary.send.completed each=Entry as entry
  do
   let status=event.status
   require event.result!=null
   let reference=event.result.reference
   set entry {seen=event.result.reference}
   require reference!="late-reject"
 scenario primary_last on=Primary.send.completed
  do let status=event.status
 scenario cash on=Cash.cancel.completed
  do let result=event.result
 scenario text_result on=LLM.generate.completed
  do let result=event.result
 scenario image_result on=Images.submit.completed
  do let result=event.result
Then
"#;

// The original Email bodies, models, routes and order are unchanged. Only the
// three provider imports/handlers outside the released Email carrier are absent.
const PUBLIC_EMAIL_SOURCE: &str = r#"app CompletionProjection
use std {EmailV1 as Secondary} from=deployment.secondary
use std {EmailV1 as Primary} from=deployment.primary
Given
 Entry {seen:text}
 CompletionAudit {delivery:text,reference:text}
When
 scenario primary_first on=Primary.send.completed
  do
   let status=event.status
   require event.result!=null
   let reference=event.result.reference
   create CompletionAudit {delivery=event.delivery_id,reference=event.result.reference} as audit
   require reference!="late-reject"
 scenario secondary on=Secondary.send.completed
  do let status=event.status
 scenario primary_cohort on=Primary.send.completed each=Entry as entry
  do
   let status=event.status
   require event.result!=null
   let reference=event.result.reference
   set entry {seen=event.result.reference}
   require reference!="late-reject"
 scenario primary_last on=Primary.send.completed
  do let status=event.status
Then
"#;

fn public_email_ir() -> (SourceDb, IrProgram) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add(
        "completion-projection.can".into(),
        PUBLIC_EMAIL_SOURCE.into(),
    );
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, ir)
}

#[cfg(unix)]
#[test]
fn public_email_cli_artifact_preserves_original_routes_bodies_and_native_schemas() {
    use canlang_compiler::source::sha256_hex;
    use serde_json::{Value, json};
    use std::process::Command;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let qualification = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/standard-completion-public-qualification");
    std::fs::create_dir_all(&qualification).unwrap();
    std::fs::write(
        qualification.join("completion-projection.can"),
        PUBLIC_EMAIL_SOURCE,
    )
    .unwrap();
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(&catalog_path)
        .arg("completion-projection.can")
        .current_dir(&qualification)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let compiled: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        compiled["sources"],
        json!([{
            "path":"completion-projection.can", "sha256":sha256_hex(PUBLIC_EMAIL_SOURCE.as_bytes())
        }])
    );
    assert_eq!(
        compiled["operations"],
        json!([]),
        "trusted handlers acquire no public invocation authority"
    );
    assert_eq!(compiled["tests"], json!([]));
    assert_eq!(
        compiled["callables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|callable| callable["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "CompletionProjection.primary_first",
            "CompletionProjection.secondary",
            "CompletionProjection.primary_cohort",
            "CompletionProjection.primary_last"
        ]
    );
    let (db, ir) = public_email_ir();
    for (name, create) in [("primary_first", true), ("primary_cohort", false)] {
        let handler = ir
            .items
            .iter()
            .find(|item| item.canonical == format!("CompletionProjection.{name}"))
            .unwrap();
        let IrItemKind::Scenario { effects, .. } = &handler.kind else {
            unreachable!()
        };
        assert_eq!(effects.len(), 5, "original ordered body");
        assert!(
            matches!(&effects[3], IrStmt::Create { .. }) && create
                || matches!(&effects[3], IrStmt::Set { .. }) && !create
        );
        assert!(matches!(&effects[4], IrStmt::Require { cond, .. }
            if matches!(&cond.expr, IrExpr::Binary { op: IrBinOp::Ne, left, right }
                if matches!(&left.expr, IrExpr::Name(value) if value == "reference")
                    && matches!(&right.expr, IrExpr::Text(value) if value == "late-reject"))));
    }
    let emitted = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    assert_eq!(
        serde_json::to_value(emitted.value_types.unwrap()).unwrap(),
        compiled["valueTypes"]
    );
    // This is the actual public CLI output consumed by Dev, never a private
    // artifact assembly, rewritten module or replacement metadata envelope.
    std::fs::write(qualification.join("artifact.json"), &output.stdout).unwrap();
    std::fs::write(
        qualification.join("catalog.json"),
        std::fs::read(&catalog_path).unwrap(),
    )
    .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let runner = scratch.path().join("public-email.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json'));
const dir=process.argv[3];
const original=readFileSync(resolve(dir,'artifact.json'));
const artifact=JSON.parse(original);
const {assembleModules,importVerifiedAssemblyModule}=await import(pathToFileURL(require.resolve('@canlang/cloudflare/runtime/modules')));
const asm=await assembleModules({artifact,sourcePath:resolve(dir,'completion-projection.can')},{
 workDir:process.argv[4],stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(asm,artifact.modules[0].path,artifact);
const registry=canApp();
assert.equal(registry.standardCompletions,definition.standardCompletions);
assert.deepEqual(definition.standardCompletions,[
 {source:'std.EmailV1.send',event:'CompletionProjection.Primary.send.completed',binding:'CompletionProjection.Primary',from:'deployment.primary',resultType:'EmailAccepted',handlers:['CompletionProjection.primary_first','CompletionProjection.primary_cohort','CompletionProjection.primary_last']},
 {source:'std.EmailV1.send',event:'CompletionProjection.Secondary.send.completed',binding:'CompletionProjection.Secondary',from:'deployment.secondary',resultType:'EmailAccepted',handlers:['CompletionProjection.secondary']},
]);
assert.deepEqual(Object.keys(definition.contracts).sort(),['DeliveryError','EmailAccepted']);
const {normalizeValueTypes,normalizeSchema}=await import('@canlang/values');
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,artifact.models.map(model=>model.name));
const declarations={contracts:definition.contracts,enums:definition.enums,
 ...(definition.aliases===undefined?{}:{aliases:definition.aliases})};
assert.deepEqual(normalizeSchema(declarations),valueSchema);
const operations={};
for(const route of definition.standardCompletions) {
 assert.deepEqual(Object.keys(route),['source','event','binding','from','resultType','handlers']);
 const binding=definition.bindings[route.binding];assert.equal(binding.from,route.from);
 assert.equal(binding.capability,'std.EmailV1');
 const source=definition.capabilities[binding.capability].operations.send;
 assert.deepEqual(source.result,{type:'EmailAccepted'});
 operations[route.source]={inputs:source.inputs};
 const event=definition.events[route.event];
 assert.deepEqual(Object.keys(event.inputs),['delivery_id','status','result','error']);
 assert.equal(event.inputs.result.type,'EmailAccepted?');assert.equal(event.inputs.error.type,'DeliveryError?');
 operations[route.event]={inputs:event.inputs};
 for(const id of route.handlers) {
  const handler=definition.operations[id];assert.equal(handler.event,route.event);
  const fields=handler.invocation.inputs.fields;
  assert.deepEqual(fields.slice(0,4).map(field=>field.name),['delivery_id','status','result','error']);
  assert(fields.slice(0,4).every(field=>field.required===true));
  assert.deepEqual(fields[1].field,{kind:'enum',values:['succeeded','failed','unknown','skipped']});
  assert.equal(fields[2].valueType,'EmailAccepted?');assert.equal(fields[2].nullable,true);
  assert.equal(fields[3].valueType,'DeliveryError?');assert.equal(fields[3].nullable,true);
  const callable=artifact.callables.find(callable=>callable.id===id);assert.equal(callable.kind,'handler');
  let fn=registry;for(const part of callable.member)fn=fn[part];assert.equal(typeof fn,'function');
 }
}
normalizeSchema({...declarations,operations});
assert.deepEqual(definition.cohorts['CompletionProjection.primary_cohort'],{kind:'model',model:'CompletionProjection.Entry',bind:'entry'});
assert.deepEqual(readFileSync(resolve(dir,'artifact.json')),original);
console.log('Public Email CLI artifact binds exact source routes, original registry references and installed Values schemas');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(&qualification)
        .arg(scratch.path().join("native-modules"))
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&run.stdout));
}

#[test]
fn public_email_publication_refuses_raw_stale_and_edited_handler_censuses() {
    let (db, original) = public_email_ir();
    let raw = js::emit_program(&original);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
    assert!(!raw.entry.js.contains("standardCompletions:"));
    let mut stale = SourceDb::new();
    stale.add(
        "completion-projection.can".into(),
        PUBLIC_EMAIL_SOURCE.replace("late-reject", "changed-rejection"),
    );
    let output = js::emit_program_with_native_source_receipts(&original, false, &stale);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
    assert!(!output.entry.js.contains("standardCompletions:"));
    for change in 0..7 {
        let mut ir = original.clone();
        let entry = ir
            .items
            .iter()
            .find(|item| item.canonical == "CompletionProjection.Entry")
            .unwrap()
            .id;
        let handler = ir
            .items
            .iter_mut()
            .find(|item| {
                item.canonical
                    == if change == 3 {
                        "CompletionProjection.primary_cohort"
                    } else {
                        "CompletionProjection.primary_first"
                    }
            })
            .unwrap();
        let IrItemKind::Scenario {
            event_source,
            effects,
            params,
            cohort,
            read,
            ..
        } = &mut handler.kind
        else {
            unreachable!()
        };
        match change {
            0 => {
                assert!(matches!(effects.pop(), Some(IrStmt::Require { .. })));
            }
            1 => ir.modules[0].imports[1].from = Some("deployment.copied".into()),
            2 => params.push(entry),
            3 => *cohort = None,
            4 => {
                let Some(IrEventSource::StandardCompleted {
                    canonical_operation,
                    ..
                }) = event_source
                else {
                    unreachable!()
                };
                *canonical_operation = "std.PaymentsV1.cancel".into();
            }
            5 => {
                effects.remove(3);
            }
            6 => *read = true,
            _ => unreachable!(),
        }
        let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "change{change}: {:?}",
            output.diagnostics
        );
        assert!(
            !output.entry.js.contains("standardCompletions:"),
            "change{change}: no partial publication"
        );
    }
}

#[test]
fn public_email_cli_does_not_release_unbound_or_unsupported_terminal_sources() {
    use serde_json::Value;
    use std::process::Command;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // `std.PaymentsV1.cancel` left this refusal list when family D
    // released the four PaymentsV1 terminal carriers (outcome 9):
    // `ErrorsV1.report` remains outside the released set.
    let unsupported = "app UnsupportedTerminal\nuse std {ErrorsV1 as Problems} from=deployment.problems\nGiven\nWhen\n scenario observed on=Problems.report.completed\n  do let result=event.result\nThen\n";
    let read_handler = "app ReadTerminal\nuse std {EmailV1 as Mail} from=deployment.mail\nGiven\nWhen\n scenario observed on=Mail.send.completed read=true\n  do let status=event.status\nThen\n";
    for (source, code) in [
        (SOURCE.to_string(), "E6008"),
        (
            PUBLIC_EMAIL_SOURCE.replace(" from=deployment.primary", ""),
            "E6008",
        ),
        (unsupported.to_string(), "E6008"),
        (read_handler.to_string(), "E1200"),
    ] {
        let scratch = tempfile::tempdir().unwrap();
        std::fs::write(scratch.path().join("refused.can"), source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg("refused.can")
            .current_dir(scratch.path())
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert!(!output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == code),
            "{result}"
        );
        assert!(
            result.get("modules").is_none(),
            "no refused executable artifact: {result}"
        );
    }
}

fn build(source: &str) -> (SourceDb, IrProgram, Catalog) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add("completion-projection.can".into(), source.into());
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics): (Option<Catalog>, _) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    if source.contains(".completed") {
        assert!(
            !diagnostics.is_empty(),
            "terminal publication remains refused"
        );
    }
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("handler triggers")),
        "{diagnostics:?}"
    );
    (db, ir, catalog.expect("owning installed catalog"))
}

#[cfg(unix)]
#[test]
fn standard_completion_projection_keeps_routes_census_and_complete_native_value_schemas() {
    use std::process::Command;
    let (db, ir, catalog) = build(SOURCE);
    for (handler, creates) in [("primary_first", true), ("primary_cohort", false)] {
        let item = ir
            .items
            .iter()
            .find(|item| item.canonical == format!("CompletionProjection.{handler}"))
            .unwrap();
        let IrItemKind::Scenario { effects, .. } = &item.kind else {
            unreachable!()
        };
        assert_eq!(
            effects.len(),
            5,
            "{handler}: complete authored statement order"
        );
        assert!(
            matches!(&effects[3], IrStmt::Create { .. }) && creates
                || matches!(&effects[3], IrStmt::Set { .. }) && !creates,
            "{handler}: domain write precedes the late guard"
        );
        assert!(
            matches!(&effects[4], IrStmt::Require { cond, .. }
                if matches!(&cond.expr, IrExpr::Binary { op: IrBinOp::Ne, left, right }
                    if matches!(&left.expr, IrExpr::Name(value) if value == "reference")
                        && matches!(&right.expr, IrExpr::Text(value) if value == "late-reject"))),
            "{handler}: exact authored late rejection follows the domain write"
        );
    }
    let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(
        ir.suites.is_empty(),
        "this private fixture has no authored examples"
    );
    assert!(
        !ir.items
            .iter()
            .any(|item| matches!(item.kind, IrItemKind::Fixture { .. })),
        "this private fixture has no orphan recipes"
    );
    let mut test_modules = Vec::new();
    let mut test_builtins = Vec::new();
    for suite in &ir.suites {
        let (module, diagnostics, builtins) = bdd::emit_suite(&ir, suite);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        test_modules.push(module);
        test_builtins.extend(builtins);
    }
    let (compiled, diagnostics) = artifact::assemble(
        &ir,
        &output,
        &test_modules,
        &test_builtins,
        &db,
        Some(&catalog),
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(compiled.tests.is_empty());
    let original_artifact = artifact::to_json(&compiled);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    // Original emitted modules and the genuine installed stdlib, without patches.
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    for module in &compiled.modules {
        let path = scratch.path().join(&module.path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &module.js).unwrap();
    }
    std::fs::write(scratch.path().join("artifact.json"), &original_artifact).unwrap();
    std::fs::write(scratch.path().join("completion-projection.can"), SOURCE).unwrap();
    let runner = scratch.path().join("projection.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const artifact=JSON.parse(readFileSync(new URL('./artifact.json',import.meta.url),'utf8'));
const require=createRequire(resolve(process.argv[2],'package.json'));
const {assembleModules,importVerifiedAssemblyModule}=await import(pathToFileURL(require.resolve('@canlang/cloudflare/runtime/modules')));
const asm=await assembleModules({artifact,sourcePath:fileURLToPath(new URL('./completion-projection.can',import.meta.url))},{
 workDir:fileURLToPath(new URL('./native-modules',import.meta.url)),
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(asm,artifact.modules[0].path,artifact);
const registry=canApp();
assert.equal(registry.standardCompletions,definition.standardCompletions,'one original census reference');
assert.deepEqual(definition.standardCompletions,[
 {source:'std.EmailV1.send',event:'CompletionProjection.Primary.send.completed',binding:'CompletionProjection.Primary',from:'deployment.primary',resultType:'EmailAccepted',handlers:['CompletionProjection.primary_first','CompletionProjection.primary_cohort','CompletionProjection.primary_last']},
 {source:'std.EmailV1.send',event:'CompletionProjection.Secondary.send.completed',binding:'CompletionProjection.Secondary',from:'deployment.secondary',resultType:'EmailAccepted',handlers:['CompletionProjection.secondary']},
 {source:'std.PaymentsV1.cancel',event:'CompletionProjection.Cash.cancel.completed',binding:'CompletionProjection.Cash',from:'deployment.cash',resultType:'PaymentState',handlers:['CompletionProjection.cash']},
 {source:'std.TextGenerationV1.generate',event:'CompletionProjection.LLM.generate.completed',binding:'CompletionProjection.LLM',from:'deployment.llm',resultType:'TextRun',handlers:['CompletionProjection.text_result']},
 {source:'std.ImagesV1.submit',event:'CompletionProjection.Images.submit.completed',binding:'CompletionProjection.Images',from:'deployment.images',resultType:'ImageRun',handlers:['CompletionProjection.image_result']},
]);
const valueTypes=artifact.valueTypes;
const callables=artifact.callables;
assert.deepEqual(artifact.tests,[]);
const {normalizeValueTypes,normalizeSchema}=await import('@canlang/values');
const {valueSchema}=normalizeValueTypes(valueTypes,['CompletionProjection.Entry','CompletionProjection.CompletionAudit']);
const declarations={contracts:definition.contracts,enums:definition.enums,...(definition.aliases===undefined?{}:{aliases:definition.aliases})};
const definitionSchema=normalizeSchema(declarations);
assert.deepEqual(definitionSchema,valueSchema,'emitted declaration and installed value inventory have one complete schema');
const operations={};
for(const completion of definition.standardCompletions) {
 assert.deepEqual(Object.keys(completion),['source','event','binding','from','resultType','handlers']);
 const binding=definition.bindings[completion.binding];
 assert.equal(binding.from,completion.from);
 const method=completion.source.slice(binding.capability.length+1);
 const source=definition.capabilities[binding.capability].operations[method];
 assert.equal(source.result.type,completion.resultType);
 operations[completion.source]={inputs:source.inputs};
 const event=definition.events[completion.event];
 assert.deepEqual(Object.keys(event.inputs),['delivery_id','status','result','error']);
 assert.equal(event.inputs.result.type,`${completion.resultType}?`);
 assert.equal(event.inputs.error.type,'DeliveryError?');
 operations[completion.event]={inputs:event.inputs};
 for(const id of completion.handlers) {
  const handler=definition.operations[id];
  assert.equal(handler.event,completion.event);
  const fields=handler.invocation.inputs.fields;
  assert.deepEqual(fields.slice(0,4).map(field=>field.name),['delivery_id','status','result','error']);
  assert(fields.slice(0,4).every(field=>field.required===true));
  assert.deepEqual(fields[1].field,{kind:'enum',values:['succeeded','failed','unknown','skipped']});
  assert.deepEqual(fields[2].field,{kind:'nominal',name:completion.resultType});
  assert.equal(fields[2].valueType,`${completion.resultType}?`);
  assert.equal(fields[2].nullable,true);
  assert.deepEqual(fields[3].field,{kind:'nominal',name:'DeliveryError'});
  assert.equal(fields[3].valueType,'DeliveryError?');
  assert.equal(fields[3].nullable,true);
  const callable=callables.find(ref=>ref.id===id);
  assert.equal(callable.kind,'handler');
  let fn=registry;for(const part of callable.member)fn=fn[part];assert.equal(typeof fn,'function');
 }
}
normalizeSchema({...declarations,operations});
assert.deepEqual(definition.cohorts['CompletionProjection.primary_cohort'],{kind:'model',model:'CompletionProjection.Entry',bind:'entry'});
const leaf=(record,name)=>valueTypes.contracts.find(contract=>contract.name===record).fields.find(field=>field.name===name).type;
assert.equal(leaf('ImageRun','outputs'),'GeneratedImage[]');
assert.equal(leaf('GeneratedImage','image'),'file');
assert.equal(leaf('ImageRequest','workflow'),'WorkflowDefinition');
assert.equal(leaf('WorkflowDefinition','prompt'),'WorkflowInput');
assert.equal(leaf('TextRequest','messages'),'TextMessage[]');
assert.equal(leaf('TextRequest','max_duration'),'duration');
assert.equal(leaf('ImageRequest','max_duration'),'duration');
assert.equal(leaf('DeliveryError','code'),'text');
console.log('Unchanged emitted private completion census, original registry reference, exact routes/callables/cohort and installed Values closure passed; terminal publication remains refused');
"#).unwrap();
    let run = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(scratch.path().join(&output.entry.path))
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    // One private executable fixture for the retained native consumer. This
    // projection does not remove the public compiler's terminal E6008 gate.
    let qualification = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/standard-completion-private-qualification");
    std::fs::create_dir_all(&qualification).unwrap();
    std::fs::write(qualification.join("artifact.json"), original_artifact).unwrap();
    std::fs::write(qualification.join("completion-projection.can"), SOURCE).unwrap();
    let catalog_bytes = std::fs::read(root.join("packages/values/dist/catalog.json")).unwrap();
    let catalog_wire: serde_json::Value = serde_json::from_slice(&catalog_bytes).unwrap();
    assert_eq!(
        catalog_wire["catalog_version"].as_str(),
        Some(catalog.version())
    );
    std::fs::write(qualification.join("catalog.json"), catalog_bytes).unwrap();
    eprint!("{}", String::from_utf8_lossy(&run.stdout));
}

#[test]
fn standard_completion_projection_refuses_partial_skewed_raw_or_unknown_sources() {
    let (db, original, _catalog) = build(SOURCE);
    for change in 0..5 {
        let mut ir = original.clone();
        let handler = ir
            .items
            .iter_mut()
            .find(|item| item.canonical == "CompletionProjection.primary_first")
            .unwrap();
        let IrItemKind::Scenario { event_source, .. } = &mut handler.kind else {
            unreachable!()
        };
        match change {
            0 => *event_source = None,
            1 => {
                let Some(IrEventSource::StandardCompleted { result_type, .. }) = event_source
                else {
                    unreachable!()
                };
                *result_type = "IncomingEmail".into();
            }
            2 => {
                let Some(IrEventSource::StandardCompleted { from, .. }) = event_source else {
                    unreachable!()
                };
                *from = "deployment.copied".into();
            }
            3 => ir.modules[0].imports[1].from = Some("deployment.copied".into()),
            4 => ir.standard_completion_sources = Default::default(),
            _ => unreachable!(),
        }
        let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("standardCompletions")),
            "change{change}: {:?}",
            output.diagnostics
        );
        assert!(
            !output.entry.js.contains("standardCompletions:"),
            "change{change} cannot publish a partial census"
        );
    }
    let raw = js::emit_program(&original);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("standardCompletions"))
    );
    assert!(!raw.entry.js.contains("standardCompletions:"));
    let (db, mut ir, _catalog) = build(
        "app CheckedInspection\nuse std {ImagesV1 as Images} from=deployment.images\nGiven\nWhen\n scenario inspected on=Images.inspect.completed\n  do let result=event.result\nThen\n",
    );
    // WorkflowInspection now has its released canonical nominal closure.
    // That owning result is distinct from an unknown edited result identity.
    let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(
        output
            .value_types
            .as_ref()
            .unwrap()
            .contracts
            .iter()
            .any(|contract| contract.name == "WorkflowInspection")
    );
    assert!(
        output
            .value_types
            .as_ref()
            .unwrap()
            .contracts
            .iter()
            .any(|contract| contract.name == "WorkflowField")
    );
    let handler = ir
        .items
        .iter_mut()
        .find(|item| item.canonical == "CheckedInspection.inspected")
        .unwrap();
    let IrItemKind::Scenario {
        event_source: Some(IrEventSource::StandardCompleted { result_type, .. }),
        ..
    } = &mut handler.kind
    else {
        unreachable!()
    };
    *result_type = "UnreleasedWorkflowInspection".into();
    let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        output.diagnostics
    );
    assert!(!output.entry.js.contains("standardCompletions:"));
    let (db, ir, _catalog) =
        build("app Ordinary\nGiven\nWhen\n scenario ready() by=members\n  do let value=1\nThen\n");
    let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(!output.entry.js.contains("standardCompletions"));
}

#[test]
fn full_driver_seals_original_invoice_terminal_census_body_and_catalog() {
    use canlang_compiler::analysis::{ResolvedType, Scalar};
    use canlang_compiler::codegen::{emit, EmitOptions, EmitSources};
    use canlang_compiler::diagnostic::DiagnosticResult;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = std::fs::read_to_string(root.join(
        "packages/cloudflare/test/fixtures/invoice-terminal-owner-probe.can")).unwrap();
    let mut db = SourceDb::new();
    let id = db.add("invoice-terminals.can".into(), source.clone());
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest { flag: Some(&path), env: None,
        cwd: root, primary: Span::new(id,0,0) });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (original, diagnostics) = check_program(&db,&[id],catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut result = DiagnosticResult::new("terminal-source","1.0",1);
    result.complete = true;
    let run = |program: &canlang_compiler::analysis::CheckedProgram, db: &SourceDb| {
        emit(program,&EmitSources {db,result:&result,catalog:catalog.as_ref(),
            options:EmitOptions {allow_incomplete_test_only:false,native_scenario_receipts:true}})
    };
    let (artifact, diagnostics) = run(&original,&db);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let handlers = artifact.callables.iter().filter(|callable| callable.kind=="handler")
        .map(|callable|callable.id.as_str()).collect::<std::collections::BTreeSet<_>>();
    assert_eq!(handlers, std::collections::BTreeSet::from(["invoice.collected", "invoice.refunded",
        "invoice.checkout_cancelled", "invoice.reconciled", "invoice.observe_commercial_payment"]));
    // The older independent IR API retains its bounded body contract. Its
    // refusal cannot be promoted by standalone JS, even with source receipts.
    let (legacy, diagnostics) = ir::build(&original,&db,catalog.as_ref());
    assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"));
    let standalone = js::emit_program_with_native_source_receipts(&legacy,true,&db);
    assert!(standalone.diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"));
    for mutation in 0..9 {
        let (mut changed, diagnostics) = check_program(&db,&[id],catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let handler = changed.symbols.iter().find(|symbol|symbol.canonical=="invoice.collected").unwrap().id;
        match mutation {
            0 => changed.effects.scenarios.get_mut(&handler).unwrap().on = None,
            1 => {changed.effects.scenarios.remove(&handler);},
            2 => changed.types.std_delivery_completion_handlers.clear(),
            3 => changed.types.std_delivery_completion_handlers.values_mut().find(|fact|fact.op=="collect").unwrap().canonical_operation="std.PaymentsV1.cancel".into(),
            4 => changed.types.std_delivery_completion_handlers.values_mut().find(|fact|fact.op=="collect").unwrap().result_type="EmailAccepted".into(),
            5 => changed.modules.iter_mut().flat_map(|module|&mut module.imports).find(|import|import.from.is_some()).unwrap().from=Some("deployment.other".into()),
            6 => changed.effects.scenarios.get_mut(&handler).unwrap().effects.clear(),
            7 => { let fact=changed.types.std_delivery_completion_handlers.values_mut().find(|fact|fact.op=="collect").unwrap(); fact.payload=ResolvedType::Scalar(Scalar::Text); },
            8 => { let helper=changed.symbols.iter().find(|symbol|symbol.canonical=="invoice.settlement").unwrap().id;
                changed.types.symbol_results.insert(helper,Some(ResolvedType::Scalar(Scalar::Text))); },
            _ => unreachable!(),
        }
        let (_, diagnostics) = run(&changed,&db);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),
            "edited source mutation {mutation} cannot prepare terminal handlers: {diagnostics:?}");
    }
    let mut stale=SourceDb::new();
    stale.add("invoice-terminals.can".into(),source.replace("limit=1","limit=2"));
    let (_, diagnostics)=run(&original,&stale);
    assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6011"),"{diagnostics:?}");
    // An independently unsupported declaration must keep its precise diagnostic;
    // the terminal candidate never filters other lowering errors.
    let mut unrelated=SourceDb::new();
    let bad=unrelated.add("invoice-terminals.can".into(),source.replace("  role finance", "  role finance\n  corpus Unsupported model=Invoice scope=source title=source content=source where=true from=deployment.knowledge"));
    let (checked, diagnostics)=check_program(&unrelated,&[bad],catalog.as_ref());
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let (partial, diagnostics)=run(&checked,&unrelated);
    assert!(partial.modules.iter().any(|module|module.js.contains("standardCompletions:")),
        "unrelated IR refusal must retain independent terminal preparation");
    assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008" && diagnostic.message.contains("corpus")),"{diagnostics:?}");
}
