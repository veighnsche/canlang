//! Actual CLI policy descriptors and emitted native predicate conventions.
//! Canonical owner activation remains a separate runtime-adapter qualification.
use std::{path::Path, process::Command};

const SOURCE: &str = "app PolicyProducer\nGiven\n Item {quantity:int,label:text,locked:bool,state:enum(open,closed)=open}\n Other {quantity:int}\n policy Item read=public\n invariant Item: row.quantity>=0\n lock Item fields=label when=row.locked\n invariant Item: row.state==open or row.quantity<=100\n lock Other fields=quantity\nWhen\nThen\n";

fn compile(source: &str, output: &Path) -> serde_json::Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let input = output.join("policy.can");
    std::fs::write(&input, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let value = serde_json::from_slice(&compiled.stdout).unwrap();
    std::fs::write(output.join("artifact.json"), compiled.stdout).unwrap();
    value
}

#[test]
fn local_policy_descriptors_and_native_callbacks_share_exact_identity_and_order() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let artifact = compile(SOURCE, scratch.path());
    let module = artifact["modules"][0]["path"].as_str().unwrap();
    assert_eq!(
        artifact["modelPolicies"],
        serde_json::json!([
            {"abi":"state.owner-model-policies@1","model":"PolicyProducer.Item","ownerPackage":"PolicyProducer","module":module,
             "rules":[{"kind":"invariant","id":"PolicyProducer.Item.require.1","dependencies":[]},
                      {"kind":"lock","id":"PolicyProducer.Item.lock.1","fields":["label"]},
                      {"kind":"invariant","id":"PolicyProducer.Item.require.2","dependencies":[]}],"hooks":[]},
            {"abi":"state.owner-model-policies@1","model":"PolicyProducer.Other","ownerPackage":"PolicyProducer","module":module,
             "rules":[{"kind":"lock","id":"PolicyProducer.Other.lock.1","fields":["quantity"]}],"hooks":[]}
        ])
    );
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {decodeValue}=await load('@canlang/values');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'policy.can')},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/stdlib')).href});
const registry=(await import(asm.entryUrl)).canApp();
const bindings=registry.modelPolicyBindings;
assert.equal(bindings.length,4);
const expected=artifact.modelPolicies.flatMap(d=>d.rules.map(r=>({id:r.id,kind:r.kind,module:d.module,ownerPackage:d.ownerPackage,model:d.model})));
assert.deepEqual(bindings.map(({evaluate,...identity})=>identity).sort((a,b)=>a.id.localeCompare(b.id)),expected.sort((a,b)=>a.id.localeCompare(b.id)));
const byId=new Map(bindings.map(binding=>[binding.id,binding]));
const call=(id,row)=>byId.get(id).evaluate(undefined,Object.freeze(row));
// Only this context-free native callback boundary is exercised here.
// State raw rows and the genuine per-session context require its owning adapter.
assert.equal(await call('PolicyProducer.Item.require.1',{quantity:decodeValue('int','9223372036854775807')}),true);
assert.equal(await call('PolicyProducer.Item.require.1',{quantity:decodeValue('int','-1')}),false);
assert.equal(await call('PolicyProducer.Item.require.2',{quantity:decodeValue('int','101'),state:'closed'}),false);
assert.equal(await call('PolicyProducer.Item.require.2',{quantity:decodeValue('int','101'),state:'open'}),true);
assert.equal(await call('PolicyProducer.Item.lock.1',{locked:true}),true);
assert.equal(await call('PolicyProducer.Item.lock.1',{locked:false}),false);
assert.equal(await call('PolicyProducer.Other.lock.1',{}),true);
"#).unwrap();
    let run = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
}

#[test]
fn unsupported_dependencies_do_not_publish_partial_or_empty_certificates() {
    for predicate in ["count(Item)>0", "positive(row.quantity)", "row.version>0"] {
        let scratch = tempfile::tempdir().unwrap();
        let source = SOURCE.replace(
            " invariant Item: row.quantity>=0",
            &format!(" derive positive(value:int):bool = value>0\n invariant Item: {predicate}"),
        );
        let artifact = compile(&source, scratch.path());
        assert!(artifact.get("modelPolicies").is_none());
        assert!(
            !artifact["modules"][0]["js"]
                .as_str()
                .unwrap()
                .contains("modelPolicyBindings:")
        );
        assert!(
            artifact["modules"][0]["js"]
                .as_str()
                .unwrap()
                .contains("invariants:["),
            "declared unsupported rules remain visible to activation refusal"
        );
    }
}

#[test]
fn protected_lock_targets_obey_the_same_native_field_profile() {
    for field in ["text?", "money", "Other"] {
        let scratch = tempfile::tempdir().unwrap();
        let artifact = compile(
            &SOURCE.replace("label:text", &format!("label:{field}")),
            scratch.path(),
        );
        assert!(artifact.get("modelPolicies").is_none(), "{field}");
        assert!(
            !artifact["modules"][0]["js"]
                .as_str()
                .unwrap()
                .contains("modelPolicyBindings:")
        );
    }
}

#[test]
fn checked_hook_policy_reuses_original_callback_and_state_snapshot_shape() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let artifact = compile(
        include_str!("fixtures/hook_order_rollback.can"),
        scratch.path(),
    );
    let module = artifact["modules"][0]["path"].as_str().unwrap();
    assert_eq!(
        artifact["modelPolicies"],
        serde_json::json!([
            {"abi":"state.owner-model-policies@1","model":"HookOrder.Entry",
             "ownerPackage":"HookOrder","module":module,"rules":[],
             "hooks":[{"id":"HookOrder.adjustEntry","op":"update","operation":"HookOrder.Entry.update"}]}
        ])
    );
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(js.contains("($candidate,$hookCtx,c)"));
    assert!(js.contains("version:$hookCtx.after.version"));
    assert!(!js.contains("before.version+1"));
    assert!(!js.contains("$hookCtx.before.data"));
    let runner = scratch.path().join("hook-projection.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const {assembleModules}=await import(pathToFileURL(require.resolve('@canlang/cloudflare/runtime/modules')));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'policy.can')},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const registry=(await import(asm.entryUrl)).canApp();
const hook=artifact.modelPolicies[0].hooks[0],binding=registry.modelPolicyBindings[0];
assert.deepEqual({...binding,run:undefined},{id:hook.id,module:artifact.modelPolicies[0].module,ownerPackage:'HookOrder',model:'HookOrder.Entry',kind:'hook',run:undefined});
assert.equal(binding.run,registry.hooks[hook.operation].run,'one original callback');
assert.deepEqual(registry.hooks[hook.operation].ops,[hook.op]);
const callables=artifact.callables.filter(callable=>callable.id===hook.id);
assert.equal(callables.length,1);assert.equal(callables[0].module,artifact.modelPolicies[0].module);
assert.deepEqual(callables[0].member,['hooks',hook.operation,'run']);
"#).unwrap();
    let run = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
}
