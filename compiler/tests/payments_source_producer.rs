//! Bound Payments source metadata and raw nominal handler execution.
//! Provider verification, ingress identity and File authority remain separate.
use std::{path::Path, process::Command};

const SOURCE: &str = r#"app PaymentsSource uses=[invoice]
package invoice
 use std {PaymentsV1 as Payments} from=deployment.payments
 use std {PaymentState, IncomingEmail}
 use std {MailboxV1 as Post} from=deployment.inbox
 Given
  event ProviderReceipt {value:PaymentState}
  event InboxReceipt {value:IncomingEmail}
 When
  scenario result on=Payments.changed
   do emit ProviderReceipt {value=event}
  scenario received on=Post.received
   do emit InboxReceipt {value=event.value}
 Then
"#;

#[test]
fn payments_changed_preserves_raw_nominal_in_the_executed_private_handler() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("payments-source.can");
    std::fs::write(&input, SOURCE.as_bytes()).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root.join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&input)
        .current_dir(root)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&compiled.stdout).unwrap();
    let hash = canlang_compiler::source::sha256_hex(SOURCE.as_bytes());
    assert_eq!(
        artifact["sources"],
        serde_json::json!([{"path":input.to_str().unwrap(),"sha256":hash}])
    );
    let handlers = artifact["callables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|callable| callable["id"] == "invoice.result")
        .collect::<Vec<_>>();
    assert_eq!(handlers.len(), 1);
    assert_eq!(handlers[0]["kind"], "handler");
    assert_eq!(handlers[0]["member"], serde_json::json!(["invoice.result"]));
    assert!(
        !artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|operation| operation["name"] == "invoice.result"),
        "private handler stays out of public operation admission"
    );
    assert!(
        artifact["models"].as_array().unwrap().is_empty(),
        "implicit event does not create a stored model"
    );
    std::fs::write(scratch.path().join("artifact.json"), &compiled.stdout).unwrap();
    let runner = scratch.path().join("payments-source.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const base=dirname(fileURLToPath(import.meta.url)),root=realpathSync(process.argv[2]),sourcePath=process.argv[3];
const require=createRequire(resolve(root,'package.json'));
const own=specifier=>{
 const file=realpathSync(require.resolve(specifier));
 assert.ok(file.startsWith(root+'/'),specifier+' must use this compiler worktree output');
 return pathToFileURL(file);
};
const {assembleModules,importVerifiedAssemblyModule}=await import(own('@canlang/cloudflare/runtime/modules'));
const {normalizeValueTypes,normalizeSchema,validateOperationInput,encodeValue}=await import(own('@canlang/values'));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
assert.equal(createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),process.argv[4]);
const assembly=await assembleModules({artifact,sourcePath},{workDir:resolve(base,'modules'),stdlibUrl:own('@canlang/cloudflare/runtime/stdlib').href});
const callable=artifact.callables.find(value=>value.id==='invoice.result');
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(assembly,callable.module,artifact);
const registry=canApp();let handler=registry;for(const member of callable.member) handler=handler[member];
assert.equal(typeof handler,'function');
const route=definition.operations[callable.id];
assert.equal(route.event,'invoice.Payments.changed');
assert.equal(route.read,false);
assert.equal(route.invocation.name,callable.id);
assert.equal(route.invocation.kind,'scenario');
assert.deepEqual(route.invocation.inputs.fields,[{name:'value',field:{kind:'nominal',name:'PaymentState'},valueType:'PaymentState',required:true}]);
assert.deepEqual(route.invocation.result,{type:'void'});
assert.deepEqual(Object.keys(definition.events),['invoice.ProviderReceipt','invoice.InboxReceipt','invoice.Payments.changed','invoice.Post.received']);
assert.deepEqual(definition.events[route.event],{inputs:{value:{type:'PaymentState'}}});
const binding=definition.bindings['invoice.Payments'];
assert.equal(binding.capability,'std.PaymentsV1');assert.equal(binding.from,'deployment.payments');
// The catalog event itself is a raw nominal; the private invocation uses
// a named carrier to pass it through owning Values input admission.
assert.equal(Object.hasOwn(definition.models,route.event),false);
assert.deepEqual(Object.keys(definition.contracts.PaymentState.fields),
 ['reference','revision','provider_reference','amount','status','checkout_url','failure']);
const declarations={contracts:definition.contracts,enums:definition.enums,
 ...(definition.aliases===undefined?{}:{aliases:definition.aliases})};
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,artifact.models.map(model=>model.name));
assert.deepEqual(normalizeSchema(declarations),valueSchema,'complete owning catalog schema, not a shape guess');
const operationSchema=normalizeSchema({...declarations,operations:{[route.event]:{inputs:definition.events[route.event].inputs}}});
const wire={reference:'payment-1',revision:'9223372036854775807',provider_reference:'provider-1',
 amount:{minor:'12345',currency:'EUR'},status:'succeeded',checkout_url:null,failure:null};
const captured=validateOperationInput(operationSchema,route.event,{value:wire});
assert.deepEqual(encodeValue('PaymentState',captured.value,undefined,valueSchema),wire);
const events=[];
const context={canonical:{},emitDeferred:async(event,payload)=>events.push({event,payload})};
await handler(context,{event:captured});
assert.equal(events.length,1);
assert.equal(events[0].event,'invoice.ProviderReceipt');
assert.strictEqual(events[0].payload.value,captured.value,'the authored raw event retains its owning nominal instance');
assert.deepEqual(encodeValue('PaymentState',events[0].payload.value,undefined,valueSchema),wire);
const mailbox=artifact.callables.find(value=>value.id==='invoice.received');
let receive=registry;for(const member of mailbox.member) receive=receive[member];
const inbox=definition.operations[mailbox.id];
assert.equal(inbox.event,'invoice.Post.received');
assert.deepEqual(inbox.invocation.inputs.fields,[{name:'value',field:{kind:'nominal',name:'IncomingEmail'},valueType:'IncomingEmail',required:true}]);
const mailSchema=normalizeSchema({...declarations,operations:{[inbox.event]:{inputs:definition.events[inbox.event].inputs}}});
const mailWire={mailbox:'inbox',source:'message-1',thread:'thread-1',sender:'sender@example.test',reply_to:null,
 subject:'Message',body:'Contents',body_complete:true,attachments:[],attachment_count:'0',attachments_complete:true,
 received:'2026-10-22T12:00:00.000Z'};
const mail=validateOperationInput(mailSchema,inbox.event,{value:mailWire});
await receive(context,{event:mail});
assert.equal(events.length,2);
assert.equal(events[1].event,'invoice.InboxReceipt');
assert.strictEqual(events[1].payload.value,mail.value,'Mailbox keeps its authored event.value envelope');
assert.deepEqual(encodeValue('IncomingEmail',events[1].payload.value,undefined,valueSchema),mailWire);
await assert.rejects(()=>handler({}, {event:captured}),/canonical source staging/);
console.log('Payments source: executed private handler preserves raw PaymentState as ProviderReceipt.value; metadata supplies no ingress authority');
"#).unwrap();
    let executed = Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(&input)
        .arg(&hash)
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

#[test]
fn payments_changed_refuses_withdrawn_or_retargeted_checked_sources() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::{ResolvedType, check_program};
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    use canlang_compiler::diagnostic::DiagnosticResult;
    use canlang_compiler::source::{SourceDb, Span};

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("payments-source.can".into(), SOURCE.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for mutation in [
        "handler-withdrawn",
        "trigger-withdrawn",
        "binding-retargeted",
        "nominal-flattened",
    ] {
        let (mut program, diagnostics) = check_program(&db, &[id], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let handler = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "invoice.result")
            .unwrap()
            .id;
        match mutation {
            "handler-withdrawn" => {
                program.effects.scenarios.remove(&handler);
            }
            "trigger-withdrawn" => {
                program.effects.scenarios.get_mut(&handler).unwrap().on = None;
            }
            "binding-retargeted" => {
                let import = program
                    .modules
                    .iter_mut()
                    .flat_map(|module| &mut module.imports)
                    .find(|import| import.from.is_some())
                    .unwrap();
                import.from = Some("deployment.other".into());
            }
            "nominal-flattened" => {
                let fact = program
                    .types
                    .std_capability_event_handlers
                    .values_mut()
                    .find(|fact| fact.capability == "std.PaymentsV1")
                    .unwrap();
                let ResolvedType::StdNominal { fields, .. } = &fact.payload else {
                    panic!("expected nominal");
                };
                fact.payload = ResolvedType::Object(fields.clone());
            }
            _ => unreachable!(),
        }
        let mut result = DiagnosticResult::new("payments-source", "1.0", 1);
        result.add_sources(&db);
        let (_, diagnostics) = emit(
            &program,
            &EmitSources {
                db: &db,
                result: &result,
                catalog: catalog.as_ref(),
                options: EmitOptions::new(),
            },
        );
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mutation} must lose its original source proof: {diagnostics:?}"
        );
    }
}
