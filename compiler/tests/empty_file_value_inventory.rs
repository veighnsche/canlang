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
