//! Bounded original Profile scalar producer; real descriptors and exports are
//! required. Native execution and full application authority are separate.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{DependencyRole, ScenarioDisclosure};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, js};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Command,
};

const SOURCE: &str = include_str!("fixtures/source-profile-scalars.can");
const HASH: &str = "06e8633f8d0b8d1b7b57333447a4bda47db36676db8b43bab5259f6064693995";
const OWNER: &str = "SourceProfileScalars.ask";
const LEAVES: [&str; 9] = [
    "active",
    "input_tokens",
    "output_tokens",
    "system_prompt",
    "provider_key",
    "policy_revision",
    "input_tokens",
    "output_tokens",
    "duration",
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn native_owner() -> PathBuf {
    let primary = Path::new("/Users/vince/Projects/canlang");
    if primary
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        primary.into()
    } else {
        root()
    }
}
fn checked(path: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), SOURCE.into());
    let path = native_owner().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}
fn item<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}
fn operation(artifact: &Value) -> &Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == OWNER)
        .unwrap()
}
fn assert_plan(plan: &Value, ir: &IrProgram, path: &str) {
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&item(ir, OWNER).id] else {
        panic!("Complete source")
    };
    let [original] = proof.returns.as_slice() else {
        panic!("one source return")
    };
    let [returned] = plan["returns"].as_array().unwrap().as_slice() else {
        panic!("one native return")
    };
    assert_eq!(plan["source"]["path"], path);
    assert_eq!(plan["source"]["sha256"], HASH);
    assert_eq!(returned["id"], original.id);
    assert!(returned["influences"].as_array().unwrap().is_empty());
    let dependencies = returned["dependencies"].as_array().unwrap();
    assert_eq!(dependencies.len(), 18);
    let mut ids = HashSet::new();
    for (index, (actual, expected)) in dependencies.iter().zip(&original.dependencies).enumerate() {
        assert!(ids.insert(actual["id"].as_str().unwrap()));
        assert_eq!(actual["id"], expected.id);
        assert_eq!(actual["model"], expected.model_name);
        assert_eq!(actual["field"], expected.field_name);
        assert_eq!(actual["type"], expected.type_id);
        assert_eq!(actual["source"], plan["source"]);
        assert_eq!(
            actual["role"],
            if expected.role == DependencyRole::Control {
                "control"
            } else {
                "data"
            }
        );
        assert_eq!(actual["role"], if index < 2 { "control" } else { "data" });
        assert!(actual.get("queryId").is_none());
        assert!(
            actual.get("sourceDependencyId").is_none(),
            "the pairing adds no receipt carrier"
        );
    }
    for (index, pair) in dependencies.as_chunks::<2>().0.iter().enumerate() {
        assert_eq!(pair[0]["model"], "SourceProfileScalars.Branch");
        assert_eq!(pair[0]["field"], "profile");
        assert_eq!(pair[0]["type"], "SourceProfileScalars.Profile");
        assert_eq!(pair[1]["model"], "SourceProfileScalars.Profile");
        assert_eq!(pair[1]["field"], LEAVES[index]);
    }
}

#[test]
fn checked_prepared_native_profile_preserves_all_nine_original_pairs() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let (db, program, ir, catalog) = checked("source-profile-scalars.can");
    let mut result = DiagnosticResult::new("native-profile-scalars", "1.0", 1);
    result.add_sources(&db);
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let artifact: Value = serde_json::from_str(&to_json(&artifact)).unwrap();
    assert_eq!(
        operation(&artifact)["result"]["type"],
        "SourceProfileScalars.Run"
    );
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &ir,
        "source-profile-scalars.can",
    );
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(raw.diagnostics.is_empty(), "{:#?}", raw.diagnostics);
    let native = raw
        .operations
        .iter()
        .find(|operation| operation.name == OWNER)
        .unwrap();
    assert!(
        native.disclosure.is_some(),
        "genuine source emitter also joins the original pairs"
    );
}

#[test]
fn actual_cli_verified_factory_installed_state_and_export_keep_getter_marker_facade_order() {
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("source-profile-scalars.can");
    std::fs::write(&source_path, SOURCE).unwrap();
    let catalog_path = scratch.path().join("native-catalog.json");
    std::fs::copy(
        native_owner().join("packages/cloudflare/dist/native-catalog.json"),
        &catalog_path,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(&catalog_path)
        .arg(&source_path)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    let (_, _, ir, _) = checked(source_path.to_str().unwrap());
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &ir,
        source_path.to_str().unwrap(),
    );
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("native-profile-scalars.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const ownerRequire=createRequire(resolve(process.argv[6],'package.json')),ownerLoad=name=>import(pathToFileURL(ownerRequire.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),hash=createHash('sha256').update(readFileSync(process.argv[4])).digest('hex');assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,stdlib=await import(stdlibUrl);
assert.equal(typeof stdlib.readScenarioReceiptStoredReference,'function','released genuine stored-reference facade');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await ownerLoad('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='SourceProfileScalars.ask'),plan=operation.result.disclosure;
assert.equal(plan.source.sha256,hash);assert.equal(plan.source.path,process.argv[4]);assert.equal(operation.result.type,'SourceProfileScalars.Run');
const loaded=loadArtifactDescriptors(artifact,{by:'members'});
assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,plan);
assert.equal(loaded.containment.get('SourceProfileScalars.Run').parent,'SourceProfileScalars.Branch');
assert.equal(loaded.containment.get('SourceProfileScalars.Branch').parent,'SourceProfileScalars.Conversation');
const profile=artifact.models.find(model=>model.name==='SourceProfileScalars.Profile');
assert.deepEqual(profile.fields.map(field=>field.name),['name','provider_key','policy_revision','system_prompt','input_tokens','output_tokens','duration','active']);
const callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
let handler=factory;for(const member of callable.member)handler=handler[member];const body=handler.toString();
for(const [pattern,total] of [[/\bawait readScenarioReceiptStoredReference\(/g,9],[/\bawait observeScenarioReceiptDependency\(/g,18],[/\bawait create\(/g,1],[/\bawait bindScenarioReceiptModelResult\(/g,1],[/\bselectScenarioReceiptReturn\(/g,1]])assert.equal((body.match(pattern)||[]).length,total);
const create=/\bconst ([$\w]+) = await create\(c,"SourceProfileScalars\.Run",\{parent:([$\w]+),/.exec(body);assert.ok(create,'original required Branch supplies Run.parent');
const [returned]=plan.returns,reads=returned.dependencies,leaves=['active','input_tokens','output_tokens','system_prompt','provider_key','policy_revision','input_tokens','output_tokens','duration'];
assert.equal(reads.length,18);assert.equal(new Set(reads.map(read=>read.id)).size,18);assert.deepEqual(returned.influences,[]);
const q=JSON.stringify;let previous=-1;
for(let index=0;index<9;index++){
 const source=reads[index*2],scalar=reads[index*2+1];
 assert.equal(source.model,'SourceProfileScalars.Branch');assert.equal(source.field,'profile');assert.equal(source.type,'SourceProfileScalars.Profile');
 assert.equal(scalar.model,'SourceProfileScalars.Profile');assert.equal(scalar.field,leaves[index]);assert.equal(source.role,index===0?'control':'data');assert.equal(scalar.role,source.role);
 assert.deepEqual(source.source,plan.source);assert.deepEqual(scalar.source,plan.source);
 // The exact nested await establishes runtime order: getter/awaited marker
 // produces SAMEref, the facade resolves it, then the outer getter/marker runs.
 const sourceThunk=`(await (async($receiptRow)=>{const $receiptValue=$receiptRow["profile"];await observeScenarioReceiptDependency(c,${q(source.model)},$receiptRow,"profile",${q(source.id)});return $receiptValue;})(${create[2]}))`;
 const resolved=`(await readScenarioReceiptStoredReference(c,${sourceThunk},${q(source.id)},${q(scalar.id)}))`;
 const expression=`(await (async($receiptRow)=>{const $receiptValue=$receiptRow[${q(scalar.field)}];await observeScenarioReceiptDependency(c,${q(scalar.model)},$receiptRow,${q(scalar.field)},${q(scalar.id)});return $receiptValue;})(${resolved}))`;
 assert.equal(body.split(expression).length-1,1,`${index} genuine same-reference once sequence`);
 const position=body.indexOf(expression);assert.ok(position>previous,'original authored occurrence order');previous=position;
 if(index===0)assert.ok(position<create.index,'active checked before Create');
 if(index>2)assert.ok(position>create.index,'Create operands remain authored inside the awaited write');
}
assert.equal((body.match(/\["profile"\]/g)||[]).length,9,'no reference cache or eager scalar reconstruction');
assert.ok(body.includes(`const $receiptValue=${create[1]};`),'same created Run return');
assert.ok(body.includes('return $receiptModelResult;'));
assert.equal(/\brecords\(/.test(body),false);
console.log('Native Profile producer: 9 original pairs, actual CLI/verified factory/installed State and released facade; native execution and application authority remain separate');
"#).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(artifact_path)
        .arg(source_path)
        .arg(scratch.path().join("modules"))
        .arg(native_owner())
        .arg(HASH)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&output.stdout));
}

#[test]
fn native_profile_source_schema_roles_order_and_original_receiver_mutants_refuse() {
    let (db, _, ir, _) = checked("source-profile-scalars.can");
    let owner = item(&ir, OWNER).id;
    let baseline = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        baseline.diagnostics.is_empty()
            && baseline
                .operations
                .iter()
                .find(|operation| operation.name == OWNER)
                .unwrap()
                .disclosure
                .is_some()
    );
    let refused = |changed: &IrProgram, sources: Option<&SourceDb>, mode: &str| {
        let result = if let Some(db) = sources {
            js::emit_program_with_native_source_receipts(changed, true, db)
        } else {
            js::emit_program_with_native_receipts(changed, true)
        };
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}: {:#?}",
            result.diagnostics
        );
        assert!(
            result
                .operations
                .iter()
                .find(|operation| operation.name == OWNER)
                .unwrap()
                .disclosure
                .is_none(),
            "{mode} must withdraw the native recipe"
        );
    };
    refused(&ir, None, "source DB absent");
    let mut stale = SourceDb::new();
    stale.add(
        "source-profile-scalars.can".into(),
        SOURCE.replace("max=8192", "max=8193"),
    );
    refused(&ir, Some(&stale), "stale source");
    for mode in [
        "source",
        "role",
        "order",
        "missing-facts",
        "missing-proof",
        "schema",
        "binder",
        "nullable",
        "copied-receiver",
    ] {
        let mut changed = ir.clone();
        if mode == "missing-proof" {
            changed.scenario_disclosures.remove(&owner);
            refused(&changed, Some(&db), mode);
            continue;
        }
        if matches!(mode, "source" | "role" | "order" | "missing-facts") {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("Complete")
            };
            match mode {
                "source" => proof.returns[0].dependencies[6].source.sha256 = "0".repeat(64),
                "role" => proof.returns[0].dependencies[6].role = DependencyRole::Control,
                "order" => proof.returns[0].dependencies.swap(6, 7),
                _ => proof.source_facts = None,
            }
        } else if mode == "schema" {
            let field = item(&changed, "SourceProfileScalars.Profile.name").id;
            let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                panic!("Profile field")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Int));
        } else if mode == "binder" {
            let IrItemKind::Scenario { params, .. } = &changed.items[owner.0 as usize].kind else {
                panic!("scenario")
            };
            let param = params[0];
            let IrItemKind::Param { index, .. } = &mut changed.items[param.0 as usize].kind else {
                panic!("Branch parameter")
            };
            *index = 1;
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            let IrStmt::Create { input, .. } = &mut effects[1] else {
                panic!("Create")
            };
            let IrExpr::Object(fields) = &mut input.expr else {
                panic!("inputs")
            };
            let IrExpr::Member { base, .. } = &mut fields[2].1.expr else {
                panic!("scalar")
            };
            if mode == "nullable" {
                base.ty = ResolvedType::Nullable(Box::new(base.ty.clone()));
            } else {
                let IrExpr::Member { base: branch, .. } = &mut base.expr else {
                    panic!("reference")
                };
                branch.expr = IrExpr::Name("copied".into());
            }
        }
        refused(&changed, Some(&db), mode);
    }
}
