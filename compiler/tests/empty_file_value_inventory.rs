//! Original File source produces complete declaration metadata, including empty sets.
//! Native checks validate schema correspondence; they do not issue retirement authority.
use canlang_compiler::{
    analysis::{
        catalog::{CatalogRequest, load_catalog},
        check_program,
        resolve::CheckedValueConstraints,
        types::{ResolvedType, Scalar},
    },
    codegen::{
        ir::{self, IrImport, IrItemKind, IrType},
        js,
    },
    source::{SourceDb, Span, sha256_hex},
};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const ORIGINAL: &str =
    include_str!("../../packages/cloudflare/test/fixtures/typed-file-journey.can");
const DEFERRED: &str = include_str!("../../packages/cloudflare/test/fixtures/native-file-deferred.can");
const DEFERRED_SHA256: &str = "b92403ac05f5b1de879ab4201047c0d915520cf7f730d1c525a6f257bf2c6fc8";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn checked(source: &str) -> (SourceDb, ir::IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add("typed-file-journey.can".into(), source.into());
    let root = root();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, lowered)
}

#[test]
fn original_cli_empty_declarations_reach_actual_state_file_inventory_consumer() {
    let root = root();
    let fixture = root.join("packages/cloudflare/test/fixtures/typed-file-journey.can");
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&fixture)
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
    assert_eq!(
        artifact["sources"][0]["sha256"],
        sha256_hex(ORIGINAL.as_bytes())
    );
    assert_eq!(artifact["valueTypes"], serde_json::json!({"contracts": []}));
    assert_eq!(artifact["models"].as_array().unwrap().len(), 1);
    assert_eq!(artifact["models"][0]["name"], "TypedFileJourney.Entry");
    assert_eq!(artifact["models"][0]["fields"][1]["valueType"], "file?");
    let scratch = tempfile::tempdir().unwrap();
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("inventory.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.argv[2],require=createRequire(resolve(root,'package.json'));
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const {checkedFileInventory}=await import(pathToFileURL(resolve(dirname(require.resolve('@canlang/state/storage/memory')),'file-retirement.js')));
const artifact=JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'artifact.json'),'utf8'));
const loaded=loadArtifactDescriptors(artifact,{by:()=> 'owner'});
assert.deepEqual(loaded.valueTypes,{contracts:[]});
// Validate only the original domain declarations. No backend, framework
// writer, assigned namespace or durable retirement authority is created.
const input={owner:artifact.models[0].name.split('.')[0],
 snapshotId:artifact.sources[0].sha256,digest:artifact.sources[0].sha256,
 canonicalModels:loaded.models,artifactModels:artifact.models,
 valueTypes:loaded.valueTypes,frameworkModels:[]};
const checked=checkedFileInventory(input);
assert.deepEqual(checked.valueTypes,artifact.valueTypes);
assert.deepEqual(checked.artifactModels,artifact.models);
assert.deepEqual(checked.canonicalModels,loaded.models);
const absent={...input};delete absent.valueTypes;
assert.throws(()=>checkedFileInventory(absent),/closed metadata required/);
assert.throws(()=>checkedFileInventory({...input,valueTypes:{}}),/complete explicit declarations required/);
console.log('actual original File declaration inventory, explicit empty contracts and missing-evidence refusal passed');
"#).unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .arg(&root)
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
fn empty_file_inventory_requires_original_source_and_refuses_changed_source() {
    let (db, program) = checked(ORIGINAL);
    let valid = js::emit_program_with_native_source_receipts(&program, true, &db);
    assert!(valid.diagnostics.is_empty(), "{:?}", valid.diagnostics);
    assert!(valid.value_types.unwrap().contracts.is_empty());
    assert!(
        js::emit_program_with_native_receipts(&program, true)
            .value_types
            .is_none()
    );
    for source in [Some(format!("{ORIGINAL}\n## changed source\n")), None] {
        let mut changed = SourceDb::new();
        if let Some(source) = source {
            changed.add("typed-file-journey.can".into(), source);
        }
        let output = js::emit_program_with_native_source_receipts(&program, true, &changed);
        assert!(output.value_types.is_none());
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

#[test]
fn edited_file_declaration_census_never_acquires_empty_inventory_evidence() {
    let (db, program) = checked(ORIGINAL);
    let model = program
        .items
        .iter()
        .find(|item| item.canonical == "TypedFileJourney.Entry")
        .unwrap()
        .id;
    let field = program
        .items
        .iter()
        .find(|item| item.canonical == "TypedFileJourney.Entry.attachment")
        .unwrap()
        .id;
    for change in 0..7 {
        let mut changed = program.clone();
        let module_span = changed.modules[0].span;
        match change {
            0 => changed.items[model.0 as usize].canonical = "TypedFileJourney.Other".into(),
            1 => {
                let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                    unreachable!()
                };
                *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
            }
            2 => {
                let IrItemKind::Model { fields, .. } = &mut changed.items[model.0 as usize].kind
                else {
                    unreachable!()
                };
                fields.clear();
            }
            3 => {
                changed.items[model.0 as usize].kind = IrItemKind::Contract {
                    fields: vec![field],
                    label: None,
                }
            }
            4 => changed.modules[0].imports.push(IrImport {
                provider: "std.FilesV1".into(),
                provider_span: module_span,
                members: vec![],
                from: None,
                span: module_span,
            }),
            5 => {
                changed.value_constraints.insert(
                    field,
                    CheckedValueConstraints {
                        alias: Some(field),
                        ..Default::default()
                    },
                );
            }
            6 => changed.modules[0].name = "OtherFileJourney".into(),
            _ => unreachable!(),
        }
        let output = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            output.value_types.is_none(),
            "edited census {change} emitted a schema claim"
        );
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "edited census {change}: {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn nonempty_and_unsupported_contract_sources_keep_original_inventory_behavior() {
    let (db, program) =
        checked(&ORIGINAL.replace(" Entry {", " contract Note {label:text}\n Entry {"));
    let output = js::emit_program_with_native_source_receipts(&program, true, &db);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let values = output.value_types.unwrap();
    assert!(
        values
            .contracts
            .iter()
            .any(|contract| contract.name == "TypedFileJourney.Note")
    );
    let (db, program) =
        checked(&ORIGINAL.replace(" Entry {", " contract Opaque {metadata:json}\n Entry {"));
    assert!(
        js::emit_program_with_native_source_receipts(&program, true, &db)
            .value_types
            .is_none(),
        "an unsupported declared contract is not an empty declaration set"
    );
}

#[test]
fn original_scheduled_file_event_reaches_complete_empty_inventory_consumer() {
    assert_eq!(sha256_hex(DEFERRED.as_bytes()), DEFERRED_SHA256);
    let root = root();
    let fixture = root.join("packages/cloudflare/test/fixtures/native-file-deferred.can");
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&fixture)
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
    assert!(artifact.get("diagnostics").is_none(), "{artifact}");
    assert_eq!(artifact["sources"][0]["sha256"], DEFERRED_SHA256);
    assert_eq!(artifact["modules"][0]["map"]["sourcesContent"][0], DEFERRED);
    assert_eq!(artifact["valueTypes"], serde_json::json!({"contracts": []}));
    for name in [
        "NativeFileDeferred.arm",
        "NativeFileDeferred.cancel_pending",
    ] {
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == name)
            .unwrap();
        assert_eq!(operation["result"], serde_json::json!({"type": "void"}));
    }
    let scratch = tempfile::tempdir().unwrap();
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, compiled.stdout).unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let runner = scratch.path().join("deferred-inventory.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.argv[2],require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile}=await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const {checkedFileInventory}=await import(pathToFileURL(resolve(dirname(require.resolve('@canlang/state/storage/memory')),'file-retirement.js')));
const original=readFileSync(process.argv[3]);
const loadedFile=loadArtifactFile(process.argv[3]),artifact=loadedFile.artifact;
const loaded=loadArtifactDescriptors(artifact,{by:()=> 'owner'});
assert.deepEqual(artifact.valueTypes,{contracts:[]});
assert.deepEqual(loaded.valueTypes,artifact.valueTypes);
const checked=checkedFileInventory({owner:'NativeFileDeferred',
 snapshotId:artifact.sources[0].sha256,digest:artifact.sources[0].sha256,
 canonicalModels:loaded.models,artifactModels:artifact.models,
 valueTypes:loaded.valueTypes,frameworkModels:[]});
assert.deepEqual(checked.valueTypes,artifact.valueTypes);
assert.deepEqual(checked.artifactModels,artifact.models);
assert.deepEqual(checked.canonicalModels,loaded.models);
const assembly=await assembleModules(loadedFile,{workDir:process.argv[4],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const handler=artifact.callables.find(value=>value.id==='NativeFileDeferred.fire');
assert(handler);assert.equal(handler.kind,'handler');
assert.equal(artifact.operations.some(value=>value.name===handler.id),false);
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(assembly,handler.module,artifact);
let callable=canApp();for(const member of handler.member)callable=callable[member];
assert.equal(typeof callable,'function');
assert.deepEqual(definition.contracts,{});
assert.equal(definition.operations[handler.id].event,'NativeFileDeferred.Retained');
const event=definition.events['NativeFileDeferred.Retained'];
assert.deepEqual(event.inputs,{entry:{type:'NativeFileDeferred.Entry'},attachment:{type:'file'},
 note:{type:'text',trim:true,min:1,max:16}});
assert.deepEqual(event.inputFields,[
 {name:'entry',field:{kind:'ref',model:'NativeFileDeferred.Entry',requireVersion:false},required:true},
 {name:'attachment',field:{kind:'file'},valueType:'file',required:true},
 {name:'note',field:{kind:'string'},valueType:'text',required:true},
]);
assert.deepEqual(Object.keys(event.inputs),event.inputFields.map(field=>field.name));
assert.deepEqual(definition.operations[handler.id].invocation.inputs.fields,event.inputFields);
for(const id of ['NativeFileDeferred.arm','NativeFileDeferred.cancel_pending']){
 const operation=artifact.operations.find(value=>value.name===id);assert(operation);
 assert.equal(operation.kind,'scenario');assert.deepEqual(operation.result,{type:'void'});
 const reference=artifact.callables.find(value=>value.id===id);assert(reference);
 assert.equal(reference.kind,'operation');assert.equal(reference.module,handler.module);
 let fn=canApp();for(const member of reference.member)fn=fn[member];assert.equal(typeof fn,'function');
}
assert.deepEqual(readFileSync(process.argv[3]),original,'original emitted inventory is consumed unchanged');
console.log('actual original scheduled File event carries complete empty inventory and its event descriptor pair; no deferred execution authority claimed');
"#).unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .arg(&root)
        .arg(artifact_path)
        .arg(scratch.path().join("staged"))
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
fn original_event_absence_census_refuses_edited_fields_and_stale_source() {
    let (db, program) = checked(DEFERRED);
    let valid = js::emit_program_with_native_source_receipts(&program, true, &db);
    assert!(valid.diagnostics.is_empty(), "{:?}", valid.diagnostics);
    assert!(valid.value_types.unwrap().contracts.is_empty());
    assert!(
        js::emit_program_with_native_receipts(&program, true)
            .value_types
            .is_none()
    );
    let identity = |name: &str| {
        program
            .items
            .iter()
            .find(|item| item.canonical == name)
            .unwrap()
            .id
    };
    let event = identity("NativeFileDeferred.Retained");
    let model = identity("NativeFileDeferred.Entry");
    let attachment = identity("NativeFileDeferred.Retained.attachment");
    let note = identity("NativeFileDeferred.Retained.note");
    for mutation in ["owner", "order", "type", "constraint", "omission"] {
        let mut changed = program.clone();
        match mutation {
            "owner" => {
                let IrItemKind::Field { owner, .. } =
                    &mut changed.items[attachment.0 as usize].kind
                else {
                    unreachable!()
                };
                *owner = model;
            }
            "order" | "omission" => {
                let IrItemKind::Event { fields } = &mut changed.items[event.0 as usize].kind else {
                    unreachable!()
                };
                if mutation == "order" {
                    fields.swap(0, 1);
                } else {
                    fields.pop();
                }
            }
            "type" => {
                let IrItemKind::Field { ty, .. } = &mut changed.items[attachment.0 as usize].kind
                else {
                    unreachable!()
                };
                *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
            }
            "constraint" => {
                let IrItemKind::Field { modifiers, .. } = &mut changed.items[note.0 as usize].kind
                else {
                    unreachable!()
                };
                modifiers.min.as_mut().unwrap().expr = ir::IrExpr::Int(2);
            }
            _ => unreachable!(),
        }
        let output = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            output.value_types.is_none(),
            "{mutation} retained original event absence evidence"
        );
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mutation}: {:?}",
            output.diagnostics
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "typed-file-journey.can".into(),
        format!("{DEFERRED}\n## changed original event source\n"),
    );
    let output = js::emit_program_with_native_source_receipts(&program, true, &stale);
    assert!(output.value_types.is_none());
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        output.diagnostics
    );
}

#[test]
fn original_event_absence_census_refuses_prebuild_field_metadata_edits() {
    let mut db = SourceDb::new();
    let file = db.add("native-file-deferred.can".into(), DEFERRED.into());
    let root = root();
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let identity = |name: &str| {
        checked
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == name)
            .unwrap()
            .id
    };
    let event = identity("NativeFileDeferred.Retained");
    let note = identity("NativeFileDeferred.Retained.note");
    let model = identity("NativeFileDeferred.Entry");
    let original_note = checked.effects.records[&event]
        .fields
        .iter()
        .find(|field| field.field == note)
        .unwrap();
    let min = original_note
        .modifiers
        .iter()
        .find(|modifier| modifier.name == "min")
        .unwrap()
        .value
        .unwrap();
    let text = checked.effects.models[&model]
        .fields
        .iter()
        .find_map(|field| field.default)
        .unwrap();
    let attachment = identity("NativeFileDeferred.Retained.attachment");
    for mutation in [
        "type",
        "trim",
        "min",
        "max",
        "default",
        "server",
        "label",
        "description",
        "required-array",
    ] {
        let (mut changed, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{mutation}: {diagnostics:?}");
        let field = changed
            .effects
            .records
            .get_mut(&event)
            .unwrap()
            .fields
            .iter_mut()
            .find(|field| field.field == note)
            .unwrap();
        match mutation {
            "type" => {
                changed
                    .types
                    .symbol_types
                    .insert(attachment, ResolvedType::Scalar(Scalar::Text));
            }
            "trim" | "min" => field.modifiers.retain(|modifier| modifier.name != mutation),
            "max" => {
                field
                    .modifiers
                    .iter_mut()
                    .find(|modifier| modifier.name == "max")
                    .unwrap()
                    .value = Some(min)
            }
            "default" => field.default = Some(text),
            "server" => field.server = Some(text),
            "label" => field.label = Some(text),
            "description" => field.description = Some("Edited event payload".into()),
            "required-array" => field.required_array = true,
            _ => unreachable!(),
        }
        let (lowered, diagnostics) = ir::build(&changed, &db, catalog.as_ref());
        let output = js::emit_program_with_native_source_receipts(&lowered, true, &db);
        assert!(
            output.value_types.is_none(),
            "prebuild {mutation} borrowed original event absence evidence"
        );
        assert!(
            diagnostics
                .iter()
                .chain(&output.diagnostics)
                .any(|diagnostic| diagnostic.code == "E6008"),
            "prebuild {mutation}: {diagnostics:?}; {:?}",
            output.diagnostics
        );
    }
}
