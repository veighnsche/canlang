//! Selected standard value schemas remain tied to their original checked source.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrItemKind, IrProgram, IrStmt, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

const ORIGINAL: &str =
    include_str!("../../packages/cloudflare/test/fixtures/typed-images-progress.can");
const PATH: &str = "typed-images-progress.can";
const SELECTED: [&str; 6] = [
    "DeliveryError",
    "GeneratedImage",
    "ImageRequest",
    "ImageRun",
    "WorkflowDefinition",
    "WorkflowInput",
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn catalog(db: &SourceDb) -> Catalog {
    let root = root();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

fn checked(source: &str) -> (SourceDb, CheckedProgram, Catalog) {
    let mut db = SourceDb::new();
    let id = db.add(PATH.into(), source.into());
    let catalog = catalog(&db);
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, checked, catalog)
}

fn build(source: &str) -> (SourceDb, IrProgram) {
    let (db, checked, catalog) = checked(source);
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, ir)
}

fn names(inventory: &Value) -> BTreeSet<&str> {
    inventory["contracts"]
        .as_array()
        .expect("complete contract inventory")
        .iter()
        .map(|contract| contract["name"].as_str().unwrap())
        .collect()
}

fn assert_inventory(inventory: &Value) {
    assert_eq!(names(inventory), BTreeSet::from(SELECTED));
    let leaf = |record: &str, name: &str| {
        inventory["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|contract| contract["name"] == record)
            .unwrap()["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["name"] == name)
            .unwrap()["type"]
            .as_str()
            .unwrap()
    };
    for (record, name, expected) in [
        ("ImageRequest", "workflow", "WorkflowDefinition"),
        ("ImageRequest", "max_duration", "duration"),
        ("WorkflowDefinition", "graph", "file"),
        ("WorkflowDefinition", "prompt", "WorkflowInput"),
        ("WorkflowDefinition", "negative", "WorkflowInput"),
        ("WorkflowDefinition", "width", "WorkflowInput"),
        ("WorkflowDefinition", "height", "WorkflowInput"),
        ("WorkflowInput", "node", "text"),
        ("WorkflowInput", "key", "text"),
        ("ImageRun", "outputs", "GeneratedImage[]"),
        ("ImageRun", "charged_jobs", "int?"),
        ("ImageRun", "detail", "text?"),
        (
            "ImageRun",
            "state",
            "enum(queued,running,succeeded,failed,unknown,cancelled)",
        ),
        ("GeneratedImage", "image", "file"),
        ("DeliveryError", "code", "text"),
        ("DeliveryError", "message", "text"),
    ] {
        assert_eq!(leaf(record, name), expected, "{record}.{name}");
    }
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

fn successful_artifact(output: &std::process::Output) -> Value {
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn unchanged_image_progress_and_documents_identity_publish_complete_selected_inventory() {
    for source in [
        ORIGINAL.to_string(),
        ORIGINAL.replace("app TypedImagesProgress\n", "app Documents\n"),
    ] {
        let scratch = tempfile::tempdir().unwrap();
        let source_path = scratch.path().join(PATH);
        let output = compile(&source, &source_path);
        let artifact = successful_artifact(&output);
        assert_eq!(
            artifact["sources"],
            json!([{ "path": source_path.to_str().unwrap(), "sha256": sha256_hex(source.as_bytes()) }])
        );
        assert_inventory(&artifact["valueTypes"]);
        let (db, ir) = build(&source);
        let emitted = js::emit_program_with_native_source_receipts(&ir, false, &db);
        assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
        assert_eq!(
            serde_json::to_value(emitted.value_types.as_ref().unwrap()).unwrap(),
            artifact["valueTypes"],
            "the direct producer and untouched CLI artifact share the inventory"
        );
    }
}

#[cfg(unix)]
#[test]
fn original_cli_modules_bind_the_same_inventory_through_installed_values() {
    for source in [
        ORIGINAL.to_string(),
        ORIGINAL.replace("app TypedImagesProgress\n", "app Documents\n"),
    ] {
        let scratch = tempfile::tempdir().unwrap();
        let source_path = scratch.path().join(PATH);
        let output = compile(&source, &source_path);
        let artifact = successful_artifact(&output);
        assert_inventory(&artifact["valueTypes"]);
        let artifact_path = scratch.path().join("artifact.json");
        std::fs::write(&artifact_path, &output.stdout).unwrap();
        std::os::unix::fs::symlink(
            root().join("node_modules"),
            scratch.path().join("node_modules"),
        )
        .unwrap();
        let runner = scratch.path().join("inventory.mjs");
        std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json'));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const {assembleModules,importVerifiedAssemblyModule}=await import(pathToFileURL(require.resolve('@canlang/cloudflare/runtime/modules')));
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{
 workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
assert.equal(typeof canApp,'function');
const {normalizeValueTypes,normalizeSchema}=await import('@canlang/values');
const models=artifact.models.map(model=>model.name);
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,models);
assert.deepEqual(normalizeSchema({contracts:definition.contracts,enums:definition.enums,
 ...(definition.aliases===undefined?{}:{aliases:definition.aliases})}),valueSchema);
assert.deepEqual(Object.keys(definition.contracts).sort(),
 ['DeliveryError','GeneratedImage','ImageRequest','ImageRun','WorkflowDefinition','WorkflowInput']);
for(const name of ['WorkflowInspection','WorkflowField','WorkflowValidation','EmailAccepted']) {
 assert.equal(Object.hasOwn(definition.contracts,name),false);
}
const leaf=(record,name)=>artifact.valueTypes.contracts.find(contract=>contract.name===record).fields.find(field=>field.name===name).type;
assert.equal(leaf('WorkflowDefinition','graph'),'file');
assert.equal(leaf('GeneratedImage','image'),'file');
assert.equal(leaf('ImageRequest','max_duration'),'duration');
assert.equal(leaf('ImageRun','outputs'),'GeneratedImage[]');
assert.equal(leaf('ImageRun','charged_jobs'),'int?');
assert.equal(leaf('ImageRun','detail'),'text?');
assert.equal(leaf('ImageRun','state'),'enum(queued,running,succeeded,failed,unknown,cancelled)');
const binding=Object.entries(definition.bindings).find(([key])=>key.endsWith('.Images'));
assert.equal(binding[1].from,'deployment.comfyui');
assert.equal(binding[1].capability,'std.ImagesV1');
const operations=definition.capabilities[binding[1].capability].operations;
assert.deepEqual(operations.submit.inputs,{value:{type:'ImageRequest'}});
for(const name of ['submit','cancel','reconcile']) assert.deepEqual(operations[name].result,{type:'ImageRun'});
for(const name of ['cancel','reconcile']) assert.deepEqual(operations[name].inputs,{source:{type:'text'},revision:{type:'int'}});
const job=artifact.models.find(model=>model.name.endsWith('.Job'));
for(const name of ['request','cancellation','reconciliation']) {
 const field=job.fields.find(field=>field.name===name);
 assert.equal(field.nullable,true);
 assert.equal(field.field.kind,'delivery');
 const schema=definition.models[job.name].fields[name];
 assert.equal(schema.type,'delivery');
 assert.equal(schema.nullable,true);
 const method={request:'submit',cancellation:'cancel',reconciliation:'reconcile'}[name];
 assert.equal(schema.operation,`std.ImagesV1.${method}`);
}
console.log('Original CLI/module schemas bind through installed Values; File leaves remain typed metadata, without State/provider admission');
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
    }
}

#[test]
fn nested_unsaved_sends_and_two_aliases_select_only_their_own_closure() {
    let source = r#"app SelectedOnly
use std {ImagesV1 as First} from=deployment.first
use std {ImagesV1 as Second} from=deployment.second
use std {EmailV1 as Unused} from=deployment.unused
Given
When
 scenario run() by=members
  do
   if true
    send First.cancel {source="job",revision=1} as first
   send Second.reconcile {source="job",revision=1} as second
Then
"#;
    let scratch = tempfile::tempdir().unwrap();
    let output = compile(source, &scratch.path().join("selected.can"));
    let artifact = successful_artifact(&output);
    assert_eq!(
        names(&artifact["valueTypes"]),
        BTreeSet::from(["DeliveryError", "GeneratedImage", "ImageRun"]),
        "a nested send without a saved receipt still selects its result/error; unrelated imports do not"
    );
    let (db, ir) = build(source);
    let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert_eq!(
        serde_json::to_value(output.value_types.unwrap()).unwrap(),
        artifact["valueTypes"]
    );
    let mut bindings = Vec::new();
    let scenario = ir.items.iter().find(|item| item.name == "run").unwrap();
    let IrItemKind::Scenario { effects, .. } = &scenario.kind else {
        unreachable!()
    };
    let IrStmt::If { then_branch, .. } = &effects[0] else {
        panic!("original nested send")
    };
    for statement in [&then_branch[0], &effects[1]] {
        let IrStmt::Send {
            binding,
            deployment_binding,
            ..
        } = statement
        else {
            unreachable!()
        };
        assert!(binding.is_some(), "original lexical receipt binding");
        bindings.push(deployment_binding.as_deref().unwrap());
    }
    assert_eq!(bindings, ["SelectedOnly.First", "SelectedOnly.Second"]);
    assert!(
        !ir.items.iter().any(|item| matches!(
            item.kind,
            IrItemKind::Model { .. } | IrItemKind::Field { .. }
        )),
        "receipt selection requires no stored model or field"
    );
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
fn raw_stale_and_edited_standard_censuses_cannot_publish_the_inventory() {
    let (db, ir) = build(ORIGINAL);
    for output in [
        js::emit_program(&ir),
        js::emit_program_with_native_receipts(&ir, false),
    ] {
        assert!(
            output.value_types.as_ref().is_none_or(|inventory| inventory
                .contracts
                .iter()
                .all(|contract| !SELECTED.contains(&contract.name.as_str()))),
            "raw emission cannot acquire the standard inventory"
        );
    }
    refused(&ir, &SourceDb::new(), "missing owning source");
    let mut stale = SourceDb::new();
    stale.add(
        PATH.into(),
        ORIGINAL.replace("revision:int=0", "revision:int=1"),
    );
    refused(&ir, &stale, "stale owning source");
    let mut edited = ir.clone();
    edited.catalog_version.push_str("-edited");
    refused(&edited, &db, "edited catalog identity");
    let mut edited = ir.clone();
    edited.committed_sources = Default::default();
    refused(&edited, &db, "missing private census");
    let mut edited = ir.clone();
    edited.modules[0]
        .imports
        .iter_mut()
        .find(|import| import.from.is_some())
        .unwrap()
        .from = Some("deployment.other".into());
    refused(&edited, &db, "edited bound import");
    let mut edited = ir.clone();
    let scenario = edited
        .items
        .iter_mut()
        .find(|item| item.name == "generate")
        .unwrap();
    let IrItemKind::Scenario { effects, .. } = &mut scenario.kind else {
        unreachable!()
    };
    let send = effects
        .iter_mut()
        .find(|statement| matches!(statement, IrStmt::Send { .. }))
        .unwrap();
    let IrStmt::Send { operation, .. } = send else {
        unreachable!()
    };
    *operation = "std.ImagesV1.cancel".into();
    refused(&edited, &db, "edited selected operation");
    let mut edited = ir.clone();
    let scenario = edited
        .items
        .iter_mut()
        .find(|item| item.name == "generate")
        .unwrap();
    let IrItemKind::Scenario { effects, .. } = &mut scenario.kind else {
        unreachable!()
    };
    effects.retain(|statement| !matches!(statement, IrStmt::Send { .. }));
    refused(
        &edited,
        &db,
        "dropped selected send despite unchanged receipt declarations",
    );
    let mut edited = ir.clone();
    let receipt = edited
        .items
        .iter_mut()
        .find(|item| item.canonical == "TypedImagesProgress.Job.request")
        .unwrap();
    let IrItemKind::Field { ty, .. } = &mut receipt.kind else {
        unreachable!()
    };
    *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
    refused(&edited, &db, "edited stored receipt type");
    let model = ir
        .items
        .iter()
        .find(|item| item.canonical == "TypedImagesProgress.Job")
        .unwrap();
    let receipt = ir
        .items
        .iter()
        .find(|item| item.canonical == "TypedImagesProgress.Job.request")
        .unwrap();
    let mut edited = ir.clone();
    edited.items[model.id.0 as usize]
        .canonical
        .push_str("Other");
    refused(&edited, &db, "edited owning model identity");
    let mut edited = ir.clone();
    let IrItemKind::Model { fields, .. } = &mut edited.items[model.id.0 as usize].kind else {
        unreachable!()
    };
    fields.retain(|id| *id != receipt.id);
    refused(&edited, &db, "detached receipt field declaration");
    let mut edited = ir.clone();
    let IrItemKind::Field { owner, .. } = &mut edited.items[receipt.id.0 as usize].kind else {
        unreachable!()
    };
    *owner = receipt.id;
    refused(&edited, &db, "edited receipt field ownership");
    let mut edited = ir.clone();
    let mut added = model.clone();
    added.id = canlang_compiler::analysis::resolve::SymbolId(edited.items.len() as u32);
    added.canonical = "TypedImagesProgress.Added".into();
    added.name = "Added".into();
    added.kind = IrItemKind::Contract {
        fields: Vec::new(),
        label: None,
    };
    edited.items.push(added);
    refused(&edited, &db, "added unproven contract declaration");
}

#[test]
fn checked_source_catalog_and_selection_associations_are_required_before_ir_sealing() {
    let (db, mut checked, catalog) = checked(ORIGINAL);
    let scratch = tempfile::tempdir().unwrap();
    let mut wire: Value = serde_json::from_slice(
        &std::fs::read(root().join("packages/values/dist/catalog.json")).unwrap(),
    )
    .unwrap();
    wire["catalog_version"] = json!(format!("{}-other", catalog.version()));
    let path = scratch.path().join("other-catalog.json");
    std::fs::write(&path, serde_json::to_vec(&wire).unwrap()).unwrap();
    let owning_root = root();
    let (foreign_catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &owning_root,
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let foreign_catalog = foreign_catalog.unwrap();
    let (_, diagnostics) = ir::build(&checked, &db, Some(&foreign_catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6011"),
        "{diagnostics:?}"
    );
    let mut stale = SourceDb::new();
    stale.add(
        PATH.into(),
        ORIGINAL.replace("deployment.comfyui", "deployment.other"),
    );
    let (_, diagnostics) = ir::build(&checked, &stale, Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6011"),
        "{diagnostics:?}"
    );
    checked.catalog_version.push_str("-edited");
    let (edited, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    if !diagnostics
        .iter()
        .any(|diagnostic| matches!(diagnostic.code, "E6006" | "E6008" | "E6011"))
    {
        refused(&edited, &db, "edited checked catalog fact");
    }
    let (db, mut checked, catalog) = self::checked(ORIGINAL);
    let generate = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "TypedImagesProgress.generate")
        .unwrap()
        .id;
    let scenario = checked
        .effects
        .scenarios
        .get_mut(&generate)
        .expect("original selected submit");
    scenario.effects.clear();
    let (edited, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    if !diagnostics
        .iter()
        .any(|diagnostic| matches!(diagnostic.code, "E6006" | "E6008" | "E6011"))
    {
        refused(&edited, &db, "dropped checked selected effects");
    }
}

#[test]
fn selected_inspection_with_unknown_workflow_fields_remains_a_cli_refusal() {
    let source = r#"app UnresolvedInspection
use std {ImagesV1 as Images} from=deployment.images
Given
When
 scenario inspect(graph:file) by=members
  do
   send Images.inspect {graph} as attempt
Then
"#;
    let scratch = tempfile::tempdir().unwrap();
    let output = compile(source, &scratch.path().join("inspection.can"));
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"),
        "{result}"
    );
    assert!(
        result.get("artifact").is_none_or(Value::is_null),
        "no partial artifact: {result}"
    );
    assert!(
        result.get("modules").is_none(),
        "no partial executable modules: {result}"
    );
}
