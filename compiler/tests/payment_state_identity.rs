//! The consumed payment state keeps its catalog owner through value boundaries.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{ResolvedType, check_program};
use canlang_compiler::codegen::ir::{self, IrItemKind, IrProgram, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = r#"app PaymentOwner
use std {PaymentState as State}
Given
 capability Gateway version=1
  apply() -> State
 event Observed {value:State}
 derive echo(value:State):State = value
 derive make(reference:text,revision:int,amount:money):State = State {reference,revision,amount,status=succeeded}
When
Then
"#;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn build() -> (SourceDb, IrProgram) {
    let mut db = SourceDb::new();
    let id = db.add("payment-owner.can".into(), SOURCE.into());
    let root = root();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog: Catalog = catalog.unwrap();
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let event_field = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "PaymentOwner.Observed.value")
        .unwrap();
    assert!(matches!(&checked.types.symbol_types[&event_field.id],
        ResolvedType::StdNominal {name:"PaymentState",fields} if fields.len()==7));
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, ir)
}

fn compile(source: &str, path: &Path) -> std::process::Output {
    std::fs::write(path, source).unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(path)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap()
}

fn refused(ir: &IrProgram, db: &SourceDb, reason: &str) {
    let output = js::emit_program_with_native_source_receipts(ir, false, db);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{reason}: {:?}",
        output.diagnostics
    );
}

#[test]
fn payment_alias_result_event_and_literal_use_the_exact_catalog_schema() {
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("payment.can");
    let compiled = compile(SOURCE, &source_path);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact: Value = serde_json::from_slice(&compiled.stdout).unwrap();
    assert_eq!(
        artifact["valueTypes"]["contracts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        artifact["valueTypes"]["contracts"][0]["name"],
        "PaymentState"
    );
    let script = r#"
import assert from 'node:assert/strict';
import {normalizeValueTypes,normalizeSchema,validateValue,encodeValue,makeMoney,SchemaError} from '@canlang/values';
const artifact=__ARTIFACT__;
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,[]);
const text=artifact.modules[0].js.replaceAll('"@canlang/stdlib"',JSON.stringify(import.meta.resolve('@canlang/cloudflare/runtime/stdlib')));
const {appDefinition,canApp}=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
assert.deepEqual(normalizeSchema({contracts:appDefinition.contracts}),valueSchema);
assert.deepEqual(Object.keys(appDefinition.contracts.PaymentState.fields),['reference','revision','provider_reference','amount','status','checkout_url','failure']);
assert.equal(appDefinition.events['PaymentOwner.Observed'].fields.value.type,'PaymentState');
assert.deepEqual(appDefinition.events['PaymentOwner.Observed'].inputFields,[{name:'value',field:{kind:'nominal',name:'PaymentState'},valueType:'PaymentState',required:true}]);
assert.deepEqual(appDefinition.capabilities['PaymentOwner.Gateway'].operations.apply.result,{type:'PaymentState'});
assert.equal(valueSchema.contracts.PaymentState.fields.status.typeId,'enum(pending,unknown,succeeded,failed)');
assert.equal(valueSchema.contracts.PaymentState.fields.failure.typeId,'enum(transient,action_required,permanent,cancelled)?');
assert.equal(valueSchema.contracts.PaymentState.fields.checkout_url.typeId,'url?');
const registry=canApp(),make=registry['PaymentOwner.make'],echo=registry['PaymentOwner.echo'];
const amount=makeMoney(100n,'EUR'),made=await make(undefined,'payment',9223372036854775807n,amount);
assert.deepEqual(made,{reference:'payment',revision:9223372036854775807n,provider_reference:null,amount,status:'succeeded',checkout_url:null,failure:null});
assert.strictEqual(await echo(undefined,made),made);
const wire={reference:'payment',revision:'9223372036854775807',provider_reference:null,amount:{minor:'100',currency:'EUR'},status:'succeeded',checkout_url:null,failure:null};
assert.deepEqual(encodeValue('PaymentState',made,undefined,valueSchema),wire);
for(const status of ['pending','unknown','succeeded','failed']) {
 const input={...wire,status,provider_reference:'provider-id',checkout_url:'https://payments.example.test/checkout'};
 const decoded=validateValue(valueSchema,'PaymentState',input,'create');
 assert.equal(decoded.revision,9223372036854775807n);
 assert.deepEqual(encodeValue('PaymentState',decoded,undefined,valueSchema),input);
}
for(const failure of [null,'transient','action_required','permanent','cancelled']) {
 const input={...wire,status:'failed',failure};
 assert.deepEqual(encodeValue('PaymentState',validateValue(valueSchema,'PaymentState',input,'create'),undefined,valueSchema),input);
}
const rejects=(input,code,path)=>assert.throws(()=>validateValue(valueSchema,'PaymentState',input,'create'),error=>
 error instanceof SchemaError&&error.violations.some(violation=>violation.code===code&&violation.path.join('/')===path));
rejects({...wire,status:'forged'},'format','status');
rejects({...wire,failure:'forged'},'format','failure');
rejects({...wire,revision:'9223372036854775808'},'bound','revision');
rejects({...wire,amount:{minor:'100',currency:'NOT'}},'format','amount/currency');
rejects({...wire,checkout_url:'ftp://payments.example.test/file'},'format','checkout_url');
rejects({...wire,checkout_url:'invalid'},'format','checkout_url');
rejects({...wire,privilege:'owner'},'unknown-field','privilege');
const {reference,...missing}=wire;rejects(missing,'required','reference');
assert.throws(()=>encodeValue('PaymentState',{...made,checkout_url:'invalid'},undefined,valueSchema),error=>error.code==='invalid-construction');
console.log('PaymentState catalog identity: alias/result/event/derive/literal, all states, nullable failures and exact money/int64/URL schemas passed; provider authority unqualified');
"#.replace("__ARTIFACT__", &serde_json::to_string(&artifact).unwrap());
    let executed = Command::new("node")
        .args(["--input-type=module", "--eval", &script])
        .current_dir(root())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
    for invalid in [
        SOURCE.replace("status=succeeded", "status=forged"),
        SOURCE.replace("reference,revision,amount", "reference,amount"),
        SOURCE.replace("status=succeeded", "status=succeeded,privilege=\"owner\""),
    ] {
        let refused = compile(&invalid, &source_path);
        assert!(!refused.status.success(), "{invalid}");
        let response: Value = serde_json::from_slice(&refused.stdout).unwrap();
        assert!(response.get("modules").is_none(), "{response}");
    }
}

#[test]
fn payment_identity_requires_its_exact_schema_and_original_source_census() {
    let (db, ir) = build();
    let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let field = ir
        .items
        .iter()
        .find(|item| item.canonical == "PaymentOwner.Observed.value")
        .unwrap();
    for mutation in 0..4 {
        let mut edited = ir.clone();
        let IrItemKind::Field {
            ty: IrType::Known(ty),
            ..
        } = &mut edited.items[field.id.0 as usize].kind
        else {
            unreachable!()
        };
        let ResolvedType::StdNominal { name, fields } = ty else {
            unreachable!()
        };
        match mutation {
            0 => *name = "UnreleasedPaymentState",
            1 => {
                fields.pop();
            }
            2 => fields.reverse(),
            _ => *ty = ResolvedType::Object(fields.clone()),
        }
        refused(&edited, &db, "changed declared payment schema");
    }
    let mut edited = ir.clone();
    edited.committed_sources = Default::default();
    refused(&edited, &db, "missing source census");
    let mut stale = SourceDb::new();
    stale.add(
        "payment-owner.can".into(),
        SOURCE.replace("event Observed", "event Replaced"),
    );
    refused(&ir, &stale, "changed original event source");
}

#[test]
fn provider_changed_event_retains_its_declared_payment_state_owner() {
    let mut db = SourceDb::new();
    let source = SOURCE
        .replace(
            "use std {PaymentState as State}",
            "use std {PaymentState as State, PaymentsV1 as Payments}",
        )
        .replace(
            "When\nThen",
            "When\n scenario receive on=Payments.changed\n  do emit Observed {value=event}\nThen",
        );
    let id = db.add("payment-event.can".into(), source);
    let (checked, diagnostics) = check_program(&db, &[id], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let event = checked
        .types
        .std_capability_event_handlers
        .values()
        .next()
        .unwrap();
    assert!(
        matches!(&event.payload, ResolvedType::StdNominal {name:"PaymentState",fields} if fields.len()==7)
    );
    // This checks declared event typing; provider ingress execution has its own gate.
    let capability = canlang_compiler::analysis::catalog::std_capability("PaymentsV1").unwrap();
    let schema = canlang_compiler::analysis::catalog::nominal_schema("PaymentState").unwrap();
    assert_eq!(capability.events[0].payload, Some(schema.name));
    assert_eq!(capability.events[0].fields, schema.fields);
}
