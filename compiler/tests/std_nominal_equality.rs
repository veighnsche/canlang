//! Exact standard nominal equality, without generic object or ingress admission.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, check_program};
use canlang_compiler::codegen::ir::{self, IrItemKind, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

const INBOX: &str = include_str!("../../draft/CanInbox.can");
const SOURCE: &str = r#"app NominalEquality
use std {IncomingEmail}
Given
 derive envelope_equal(left:IncomingEmail,right:IncomingEmail):bool = left==right
 derive nullable_equal(left:IncomingEmail?,right:IncomingEmail?):bool = left==right
 derive sequence_equal(left:IncomingEmail[],right:IncomingEmail[]):bool = left==right
 derive selected_equal(condition:bool,left:IncomingEmail,right:IncomingEmail):bool = choose(condition,left,right)==left
 derive copied(value:IncomingEmail):IncomingEmail = value
 derive copied_equal(left:IncomingEmail,right:IncomingEmail):bool = copied(left)==right
 derive received_equal(left:IncomingEmail.received,right:IncomingEmail.received):bool = left==right
When
 scenario lexically_equal(left:IncomingEmail,right:IncomingEmail) -> bool by=members
  do
   let original=left
   return original==right
Then
"#;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn check(
    source: &str,
) -> (
    SourceDb,
    CheckedProgram,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
) {
    let mut db = SourceDb::new();
    let id = db.add("nominal-equality.can".into(), source.into());
    let root = root();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics): (Option<Catalog>, _) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    (db, checked, diagnostics)
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

#[test]
fn original_inbox_replay_guard_retains_the_whole_named_envelope() {
    let guard = "require existing.envelope==event.value";
    assert_eq!(INBOX.lines().nth(106).unwrap().trim(), guard);
    assert!(INBOX.contains("create Message {mailbox,source=event.value.source,queue=mailbox.intake,envelope=event.value} as message"));
    let (_, checked, diagnostics) = check(INBOX);
    let guard_start = INBOX.find(guard).unwrap() as u32;
    let guard_end = guard_start + guard.len() as u32;
    assert!(
        !diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3002"
                && diagnostic.primary.start < guard_end
                && diagnostic.primary.end > guard_start),
        "{diagnostics:?}"
    );
    let envelope = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "inbox.Message.envelope")
        .unwrap();
    assert!(
        matches!(&checked.types.symbol_types[&envelope.id], ResolvedType::StdNominal { name: "IncomingEmail", fields } if fields.len()==12)
    );
    // Same-width control keeps every other original source position unchanged.
    // It checks that this guard introduces no collateral diagnostic change;
    // the owning original-composition check retains the historical delta.
    let predicate = "existing.envelope==event.value";
    let neutral = INBOX.replacen(
        predicate,
        &format!("true{}", " ".repeat(predicate.len() - 4)),
        1,
    );
    let (_, _, control) = check(&neutral);
    let keys = |diagnostics: Vec<canlang_compiler::diagnostic::Diagnostic>| {
        diagnostics
            .into_iter()
            .map(|diagnostic| {
                (
                    diagnostic.code,
                    diagnostic.message,
                    diagnostic.primary.start,
                    diagnostic.primary.end,
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        keys(diagnostics),
        keys(control),
        "all other current original Inbox findings stay unchanged"
    );
}

#[test]
fn named_input_wrappers_and_lexical_bindings_preserve_incoming_email_identity() {
    let (_, checked, diagnostics) = check(SOURCE);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "NominalEquality.lexically_equal")
        .unwrap();
    for parameter in &checked.effects.scenarios[&operation.id].params {
        assert!(
            matches!(&checked.types.symbol_types[&parameter.param], ResolvedType::StdNominal { name: "IncomingEmail", fields } if fields.len()==12)
        );
    }
}

#[test]
fn altered_nominal_identity_or_fields_cannot_publish_a_checked_schema() {
    let mut db = SourceDb::new();
    let source_id = db.add("nominal-equality.can".into(), SOURCE.into());
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root(),
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(diagnostics.is_empty());
    let (checked, diagnostics) = check_program(&db, &[source_id], catalog.as_ref());
    assert!(diagnostics.is_empty());
    let (original, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        js::emit_program_with_native_source_receipts(&original, false, &db)
            .diagnostics
            .is_empty()
    );
    for change_name in [true, false] {
        let mut altered = original.clone();
        let parameter = altered
            .items
            .iter_mut()
            .find(|item| item.canonical == "NominalEquality.lexically_equal.left")
            .unwrap();
        let IrItemKind::Param {
            ty: IrType::Known(ResolvedType::StdNominal { name, fields }),
            ..
        } = &mut parameter.kind
        else {
            panic!("actual checked nominal parameter");
        };
        if change_name {
            *name = "MailReply";
        } else {
            fields.pop();
        }
        let output = js::emit_program_with_native_source_receipts(&altered, false, &db);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{:?}",
            output.diagnostics
        );
    }
}

#[cfg(unix)]
#[test]
fn unchanged_cli_native_pure_functions_compare_canonical_complete_envelopes() {
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("nominal-equality.can");
    let output = compile(SOURCE, &source_path);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        artifact["sources"],
        json!([{"path":source_path.to_str().unwrap(),"sha256":sha256_hex(SOURCE.as_bytes())}])
    );
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "NominalEquality.lexically_equal")
        .unwrap();
    for field in operation["inputs"]["fields"].as_array().unwrap() {
        assert_eq!(
            field["field"],
            json!({"kind":"nominal","name":"IncomingEmail"})
        );
        assert_eq!(field["valueType"], "IncomingEmail");
    }
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, &output.stdout).unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let runner = scratch.path().join("nominal-equality.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const bytes=readFileSync(process.argv[3]);const artifact=JSON.parse(bytes);
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const registry=canApp();
const {normalizeValueTypes,normalizeSchema,validateValue,validateOperationInput,encodeValue}=await load('@canlang/values');
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,artifact.models.map(model=>model.name));
const declarations={contracts:definition.contracts,enums:definition.enums,
 ...(definition.aliases===undefined?{}:{aliases:definition.aliases})};
assert.deepEqual(normalizeSchema(declarations),valueSchema);
assert.deepEqual(Object.keys(definition.contracts),['IncomingEmail']);
const fields=definition.contracts.IncomingEmail.fields;
assert.deepEqual(Object.keys(fields),['mailbox','source','thread','sender','reply_to','subject','body','body_complete','attachments','attachment_count','attachments_complete','received']);
assert.equal(fields.received.type,'datetime');assert.equal(fields.attachments.type,'file[]');
assert.equal(fields.reply_to.type,'text?');
const inputSchema=normalizeSchema({...declarations,operations:{'NominalEquality.lexically_equal':{
 inputs:definition.operations['NominalEquality.lexically_equal'].inputs}}});
const wire={mailbox:'inbox',source:'incoming-1',thread:'thread-1',sender:'sender@example.test',
 reply_to:null,subject:'Subject',body:'Complete body',body_complete:true,
 attachments:[{id:'file-one'},{id:'file-two'}],attachment_count:'2',attachments_complete:true,
 received:'2026-10-04T08:00:00.000Z'};
const decode=value=>validateValue(valueSchema,'IncomingEmail',value,'create');
const original=decode(wire), identical=decode({...wire,attachments:[...wire.attachments]});
assert.notEqual(original,identical);assert(Object.isFrozen(original));
assert.equal(original.attachment_count,2n);assert.equal(original.received.kind,'datetime');
assert.equal(typeof original.received.ms,'bigint');
assert.deepEqual(original.attachments.map(file=>({kind:file.kind,id:file.id})),
 [{kind:'file',id:'file-one'},{kind:'file',id:'file-two'}]);
assert.deepEqual(encodeValue('IncomingEmail',original),wire);
assert.deepEqual(validateOperationInput(inputSchema,'NominalEquality.lexically_equal',{left:wire,right:wire}),
 {left:original,right:identical},'the real emitted named input schema admits the full canonical envelope');
const pure=name=>{
 const descriptor=artifact.callables.find(callable=>callable.id===`NominalEquality.${name}`);
 assert(descriptor);assert.equal(descriptor.kind,'pure');
 let fn=registry;for(const member of descriptor.member)fn=fn[member];assert.equal(typeof fn,'function');return fn;
};
// Pure expression host: no invocation/authorizing frame, State write, ingress or
// file-finalization grant is fabricated. Inputs came from installed Values.
const equality=pure('envelope_equal');
assert.equal(await equality(undefined,original,identical),true);
for(const [field,value] of Object.entries({mailbox:'other',source:'incoming-2',thread:'thread-2',
 sender:'different@example.test',reply_to:'reply@example.test',subject:'Other subject',body:'Other body',
 body_complete:false,attachments:[{id:'file-other'},{id:'file-two'}],attachment_count:'3',attachments_complete:false,
 received:'2026-10-04T08:00:00.001Z'})) {
 assert.equal(await equality(undefined,original,decode({...wire,[field]:value})),false,`whole guard observes ${field}`);
}
assert.equal(await equality(undefined,original,decode({...wire,attachments:[{id:'file-two'},{id:'file-one'}]})),false);
assert.equal(await pure('nullable_equal')(undefined,null,null),true);
assert.equal(await pure('nullable_equal')(undefined,null,original),false);
assert.equal(await pure('nullable_equal')(undefined,original,identical),true);
const different=decode({...wire,source:'incoming-2'});
assert.equal(await pure('sequence_equal')(undefined,[original,different],[identical,decode({...wire,source:'incoming-2'})]),true);
assert.equal(await pure('sequence_equal')(undefined,[original,different],[different,original]),false);
assert.equal(await pure('selected_equal')(undefined,true,original,different),true);
assert.equal(await pure('selected_equal')(undefined,false,original,different),false);
assert.equal(await pure('copied_equal')(undefined,original,identical),true);
assert.equal(await pure('received_equal')(undefined,original.received,identical.received),true);
assert.equal(await pure('received_equal')(undefined,original.received,different.received),true);
for(const malformed of [
 Object.fromEntries(Object.entries(wire).filter(([key])=>key!=='body')),
 {...wire,extra:'unowned'}, {...wire,attachment_count:2}, {...wire,attachment_count:null},
 {...wire,attachments:'file-one'}, {...wire,attachments:['file-one']}, {...wire,attachments:[{kind:'file',id:'file-one'}]},
 {...wire,received:'2026-10-04T10:00:00+02:00'}, {...wire,received:'2026-10-04T08:00:00Z'},
 {...wire,received:{kind:'datetime',ms:original.received.ms}},
]) {
 assert.throws(()=>decode(malformed));
 assert.throws(()=>validateOperationInput(inputSchema,'NominalEquality.lexically_equal',{left:wire,right:malformed}));
}
assert.deepEqual(readFileSync(process.argv[3]),bytes);
console.log('Actual CLI nominal input/schema and untouched native pure expressions compare all twelve canonical IncomingEmail fields; ingress/State/File authority unqualified');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact_path)
        .arg(&source_path)
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
fn generic_objects_lookalikes_other_nominals_and_unknown_leaves_stay_refused() {
    let object = "app AnonymousEquality\nGiven\nWhen\n scenario compare() -> bool by=members\n  do\n   let left={value=\"mail\"}\n   let right={value=\"mail\"}\n   return left==right\nThen\n";
    let lookalike = "app LookalikeEquality\nuse std {IncomingEmail}\nGiven\n contract Copy {mailbox:text,source:text,thread:text,sender:text,reply_to:text?,subject:text,body:text,body_complete:bool,attachments:file[],attachment_count:int,attachments_complete:bool,received:datetime}\nWhen\n scenario compare(left:IncomingEmail,right:Copy) -> bool by=members\n  do return left==right\nThen\n";
    let other = "app DifferentNominalEquality\nuse std {IncomingEmail,MailReply}\nGiven\nWhen\n scenario compare(left:IncomingEmail,right:MailReply) -> bool by=members\n  do return left==right\nThen\n";
    let json = "app JsonEquality\nGiven\nWhen\n scenario compare(left:json,right:json) -> bool by=members\n  do return left==right\nThen\n";
    for source in [object, lookalike, other, json] {
        let (_, _, diagnostics) = check(source);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E3002"),
            "{diagnostics:?}"
        );
        let scratch = tempfile::tempdir().unwrap();
        let output = compile(source, &scratch.path().join("refused.can"));
        assert!(!output.status.success());
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(response.get("modules").is_none(), "{response}");
    }
    let opaque = "app OpaqueNominal\nuse std {WorkflowInspection}\nGiven\nWhen\n scenario inspect(value:WorkflowInspection.fields) -> bool by=members\n  do return true\nThen\n";
    let scratch = tempfile::tempdir().unwrap();
    let output = compile(opaque, &scratch.path().join("opaque.can"));
    assert!(!output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        response["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"),
        "{response}"
    );
    assert!(
        response.get("modules").is_none(),
        "unknown WorkflowField remains unqualified"
    );
}
