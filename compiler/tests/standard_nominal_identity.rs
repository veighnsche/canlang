//! Source-owned standard value identity for the original Chat/Creative inputs.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, check_program};
use canlang_compiler::codegen::ir::{self, IrItemKind, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = r#"app StandardIdentity
use std {TextMessage as Message,TextRequest as Request,WorkflowInput as Input,WorkflowDefinition as Definition}
Given
 Snapshot {messages:Message[],request:Request,workflow:Definition}
 derive copy(messages:Message[]):Message[] = messages
 derive message(content:text):Message = Message {role=user,content}
 derive request(value:Message):Request = Request {source="source",revision=1,profile="profile",policy_revision="policy",messages=[value],max_input_tokens=100,max_output_tokens=10,max_duration=1s}
 derive workflow(graph:file):Definition = Definition {graph,prompt=Input {node="6",key="text"},negative=Input {node="7",key="text"},width=Input {node="5",key="width"},height=Input {node="5",key="height"}}
When
 scenario original(message:Message,request:Request,workflow:Definition) -> Message by=members
  do return message
Then
"#;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn check(source: &str) -> (SourceDb, CheckedProgram, Catalog) {
    let mut db = SourceDb::new();
    let id = db.add("standard-nominal-identity.can".into(), source.into());
    let root = root();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, checked, catalog)
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
fn aliases_fields_arrays_and_nested_construction_keep_the_exact_owner() {
    let (_, checked, _) = check(SOURCE);
    let field = |name| {
        let symbol = checked
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == name)
            .unwrap();
        &checked.types.symbol_types[&symbol.id]
    };
    assert!(matches!(field("StandardIdentity.Snapshot.messages"),
        ResolvedType::Array {element, ..} if matches!(element.as_ref(), ResolvedType::StdNominal {name:"TextMessage",fields} if fields.len()==3)));
    assert!(matches!(field("StandardIdentity.Snapshot.request"),
        ResolvedType::StdNominal {name:"TextRequest",fields} if fields.len()==8));
    let ResolvedType::StdNominal { name, fields } = field("StandardIdentity.Snapshot.workflow")
    else {
        panic!("the owning definition must retain a nominal identity");
    };
    assert_eq!(*name, "WorkflowDefinition");
    for (_, value) in &fields[1..] {
        assert!(
            matches!(value, ResolvedType::StdNominal {name:"WorkflowInput",fields} if fields.len()==2)
        );
    }
    for (name, expected) in [
        ("message", "TextMessage"),
        ("request", "TextRequest"),
        ("workflow", "WorkflowDefinition"),
    ] {
        let symbol = checked
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == format!("StandardIdentity.{name}"))
            .unwrap();
        assert!(
            matches!(&checked.types.symbol_results[&symbol.id], Some(ResolvedType::StdNominal {name, ..}) if *name==expected)
        );
    }
}

#[test]
fn edited_or_foreign_nominals_never_acquire_the_original_schema() {
    let (db, checked, catalog) = check(SOURCE);
    let (original, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        js::emit_program_with_native_source_receipts(&original, false, &db)
            .diagnostics
            .is_empty()
    );
    for mutation in 0..4 {
        let mut altered = original.clone();
        let field = altered
            .items
            .iter_mut()
            .find(|item| item.canonical == "StandardIdentity.Snapshot.workflow")
            .unwrap();
        let IrItemKind::Field {
            ty: IrType::Known(ty),
            ..
        } = &mut field.kind
        else {
            panic!("original typed field")
        };
        let ResolvedType::StdNominal { name, fields } = ty else {
            panic!("original named definition")
        };
        match mutation {
            0 => *name = "UnreleasedDefinition",
            1 => fields.pop().map(|_| ()).unwrap(),
            2 => {
                let ResolvedType::StdNominal { fields, .. } = &mut fields[1].1 else {
                    panic!("original nested input")
                };
                fields.reverse();
            }
            _ => *ty = ResolvedType::Object(fields.clone()),
        }
        let output = js::emit_program_with_native_source_receipts(&altered, false, &db);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mutation}: {:?}",
            output.diagnostics
        );
    }
    for source in [
        "app ForeignNominal\nuse foreign {TextMessage}\nGiven\n Snapshot {message:TextMessage}\nWhen\nThen\n",
        "app UnreleasedNominal\nuse std {UnknownDefinition}\nGiven\n Snapshot {value:UnknownDefinition}\nWhen\nThen\n",
        // Its schema is known for observations, but this stored-value profile
        // does not admit every catalog schema merely because it is named.
        "app OtherNominal\nuse std {TextRun}\nGiven\n Snapshot {value:TextRun}\nWhen\nThen\n",
        "app AnonymousNominal\nGiven\nWhen\n scenario copy() by=members\n  do\n   let value={node=\"5\",key=\"width\"}\n   let another={node=\"5\",key=\"width\"}\n   require value==another\nThen\n",
    ] {
        let scratch = tempfile::tempdir().unwrap();
        let output = compile(source, &scratch.path().join("refused.can"));
        assert!(!output.status.success(), "{source}");
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(response.get("modules").is_none(), "{response}");
    }
}

#[cfg(unix)]
#[test]
fn actual_cli_schema_and_installed_values_consume_the_original_named_inputs() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("standard-nominal-identity.can");
    let output = compile(SOURCE, &source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, output.stdout).unwrap();
    let runner = scratch.path().join("named-inputs.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const {normalizeValueTypes,normalizeSchema,validateValue,encodeValue}=await load('@canlang/values');
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,artifact.models.map(model=>model.name));
assert.deepEqual(normalizeSchema({contracts:definition.contracts,enums:definition.enums}),valueSchema);
for(const [name,type,array] of [['messages','TextMessage',true],['request','TextRequest',false],['workflow','WorkflowDefinition',false]]) {
 const descriptor=definition.models['StandardIdentity.Snapshot'].fields[name];
 assert.equal(descriptor.type,type);assert.equal(descriptor.array===true,array);
}
assert.equal(definition.contracts.WorkflowDefinition.fields.prompt.type,'WorkflowInput');
const registry=canApp();
const pure=name=>{let fn=registry;const callable=artifact.callables.find(callable=>callable.id===`StandardIdentity.${name}`);
 assert.equal(callable.kind,'pure');for(const key of callable.member)fn=fn[key];return fn;};
// Canonical copied values only; these calls claim no State or File authority.
const message=await pure('message')(undefined,'source message');
assert.deepEqual(message,{role:'user',content:'source message',attachments:[]});
assert.deepEqual(encodeValue('TextMessage',message),message);
const request=await pure('request')(undefined,message);
assert.equal(request.revision,1n);assert.equal(request.max_duration,1000n);
assert.deepEqual(encodeValue('TextRequest',request),{source:'source',revision:'1',profile:'profile',policy_revision:'policy',
 messages:[message],max_input_tokens:'100',max_output_tokens:'10',max_duration:'1000'});
const wire={graph:{id:'workflow-file'},prompt:{node:'6',key:'text'},negative:{node:'7',key:'text'},
 width:{node:'5',key:'width'},height:{node:'5',key:'height'}};
const canonical=validateValue(valueSchema,'WorkflowDefinition',wire,'create');
const workflow=await pure('workflow')(undefined,canonical.graph);
assert.deepEqual(encodeValue('WorkflowDefinition',workflow),wire);
assert.strictEqual(workflow.graph,canonical.graph);
assert.deepEqual(await pure('copy')(undefined,[message]),[message]);
for(const malformed of [{...wire,extra:'unowned'},{...wire,prompt:{node:'6',key:'text',extra:'unowned'}},{...wire,prompt:{node:'6'}}]) {
 assert.throws(()=>validateValue(valueSchema,'WorkflowDefinition',malformed,'create'));
}
console.log('Actual CLI named Chat/Creative schemas and pure constructors consumed by installed Values; native authority unqualified');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("modules"))
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
