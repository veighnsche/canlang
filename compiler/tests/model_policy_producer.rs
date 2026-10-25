//! Actual CLI policy descriptors and emitted native predicate conventions.
//! Canonical owner activation remains a separate runtime-adapter qualification.
use std::{path::Path, process::Command};

const SOURCE: &str = "app PolicyProducer\nGiven\n Item {quantity:int,label:text,locked:bool,state:enum(open,closed)=open}\n Other {quantity:int}\n policy Item read=public\n invariant Item: row.quantity>=0\n lock Item fields=label when=row.locked\n invariant Item: row.state==open or row.quantity<=100\n lock Other fields=quantity\nWhen\nThen\n";

fn compile(source: &str, output: &Path) -> serde_json::Value {
    compile_with_native_receipts(source, output, false)
}

fn compile_with_native_receipts(source: &str, output: &Path, native: bool) -> serde_json::Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let input = output.join("policy.can");
    std::fs::write(&input, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .args(native.then_some("--native-scenario-receipts"))
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
fn composed_archive_evidence_rules_activate_and_refuse_inconsistent_native_writes() {
    let source = r#"app AuditApp uses=[audit]
package audit
 Given
  Entry {title:text,archived:bool=false,archived_by:user?,archive_recorded_at:datetime?}
  Tag {title:text,archived:bool=false,archived_by:user?,archive_recorded_at:datetime?}
  policy Entry read=members
  policy Tag read=members
  invariant Entry: (not row.archived and row.archived_by==null and row.archive_recorded_at==null) or (row.archived and row.archived_by!=null and row.archive_recorded_at!=null)
  invariant Tag: (not row.archived and row.archived_by==null and row.archive_recorded_at==null) or (row.archived and row.archived_by!=null and row.archive_recorded_at!=null)
 When
  crud Entry by=members fields=title when=not row.archived delete=remove
  crud Tag by=members fields=title when=not row.archived delete=remove
  scenario archive_entry(entry:Entry) by=members
   do set entry {archived=true,archived_by=actor,archive_recorded_at=now}
  scenario bad_archive(entry:Entry) by=members
   do set entry {archived=true}
 Then
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let artifact = compile_with_native_receipts(source, scratch.path(), true);
    let policies = artifact["modelPolicies"]
        .as_array()
        .expect("both owning audit invariants must be emitted");
    assert_eq!(policies.len(), 2);
    for (policy, model) in policies.iter().zip(["audit.Entry", "audit.Tag"]) {
        assert_eq!(policy["model"], model);
        assert_eq!(policy["ownerPackage"], "audit");
        assert_eq!(policy["rules"][0]["kind"], "invariant");
        assert_eq!(policy["rules"][0]["dependencies"], serde_json::json!([]));
    }
    let runner = scratch.path().join("archive.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {createMemoryIdentityStore,seedMember,makeIdentity,FIXED_NOW,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'policy.can')},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const memberships=createMemoryIdentityStore(),member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const {store,probe}=createTestMemoryStorage();
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const invoke=async(operation,inputs)=>{const id=uuidv7(FIXED_NOW,++sequence);return {id,outcome:await invoker.invokeMutation({operation:`audit.${operation}`,operation_id:id,inputs},identity)};};
const committed=call=>{assert.ok('result' in call.outcome,JSON.stringify(call));assert.equal(call.outcome.result.status,'committed');return call.id;};
const id=committed(await invoke('Entry.create',{title:'Archive me'}));
const original=await store.load('audit.Entry',id),history=probe.historyFor('audit.Entry',id);
assert.deepEqual(original.data,{title:'Archive me',archived:false,archived_by:null,archive_recorded_at:null});
const refused=await invoke('bad_archive',{entry:{id,version:'1'}});
assert.ok('error' in refused.outcome,JSON.stringify(refused));
assert.equal(refused.outcome.error.code,'rule_failed');
assert.deepEqual(await store.load('audit.Entry',id),original);
assert.deepEqual(probe.historyFor('audit.Entry',id),history);
committed(await invoke('archive_entry',{entry:{id,version:'1'}}));
const archived=await store.load('audit.Entry',id);
assert.equal(archived.version,2);
assert.deepEqual(archived.data,{title:'Archive me',archived:true,archived_by:{id:member.user.user_id},archive_recorded_at:new Date(FIXED_NOW).toISOString()});
assert.equal(probe.historyFor('audit.Entry',id).length,history.length+1);
committed(await invoke('Tag.create',{title:'Second owning invariant'}));
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
fn native_first_budget_publishes_complete_numeric_invariant_and_original_user_lock() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let primary = Path::new("/Users/vince/Projects/canlang");
    let native_owner = if primary
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        primary
    } else {
        root
    };
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/native-first-budget.can");
    let source_hash = "bf83e642141e4b827d02ae99e5388496d44ac3b3e87ad2c223a2fd4ec1ee2ac4";
    assert_eq!(
        canlang_compiler::source::sha256_hex(source.as_bytes()),
        source_hash
    );
    let input = scratch.path().join("native-first-budget.can");
    std::fs::write(&input, source.as_bytes()).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_owner.join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&input)
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
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let module = artifact["modules"][0]["path"].as_str().unwrap();
    assert_eq!(
        artifact["modelPolicies"],
        serde_json::json!([
            {"abi":"state.owner-model-policies@1", "model":"FirstSources.Budget",
             "ownerPackage":"FirstSources", "module":module,
             "rules":[{"kind":"invariant", "id":"FirstSources.Budget.require.1", "dependencies":[]},
                      {"kind":"lock", "id":"FirstSources.Budget.lock.1", "fields":["account"]}],
             "hooks":[]}
        ]),
        "User lock must not suppress or partially certify the owning model"
    );
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "FirstSources.generate")
        .unwrap();
    let origin = &operation["result"]["disclosure"]["source"];
    assert_eq!(origin["path"], input.to_str().unwrap());
    assert_eq!(origin["sha256"], source_hash);
    assert_eq!(origin["module"], module);
    let runner = scratch.path().join("budget-policy.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2],owner=process.argv[3];
const require=createRequire(resolve(root,'package.json')),ownerRequire=createRequire(resolve(owner,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {decodeValue}=await load('@canlang/values');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8')),sourcePath=process.argv[5];
const source=readFileSync(sourcePath,'utf8'),hash=createHash('sha256').update(source).digest('hex');assert.equal(hash,process.argv[4]);
const descriptor=artifact.modelPolicies[0];assert.equal(descriptor.abi,'state.owner-model-policies@1');
assert.deepEqual(descriptor.rules.map(rule=>[rule.kind,rule.id]),[['invariant','FirstSources.Budget.require.1'],['lock','FirstSources.Budget.lock.1']]);
assert.deepEqual(descriptor.rules[1].fields,['account']);
const origin=artifact.operations.find(operation=>operation.name==='FirstSources.generate').result.disclosure.source;
assert.deepEqual(origin,{path:sourcePath,sha256:hash,module:descriptor.module});
const budget=artifact.models.find(model=>model.name===descriptor.model),account=budget.fields.find(field=>field.name==='account');
assert.equal(account.field.kind,'user');
const assembly=await assembleModules({artifact,sourcePath},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const module=await importVerifiedAssemblyModule(assembly,descriptor.module,artifact),registry=module.canApp();
const origins=module.appDefinition.modelRuleOrigins.filter(origin=>origin.model===descriptor.model&&['invariant','lock'].includes(origin.kind));
assert.equal(origins.length,2);
for(const origin of origins) assert.deepEqual(origin.source,{path:sourcePath,sha256:hash,module:descriptor.ownerPackage});
const expected=descriptor.rules.map(rule=>({id:rule.id,kind:rule.kind,module:descriptor.module,ownerPackage:descriptor.ownerPackage,model:descriptor.model}));
assert.equal(registry.modelPolicyBindings.length,2);
assert.deepEqual(registry.modelPolicyBindings.map(({evaluate,...identity})=>identity),expected);
const [invariant,lock]=descriptor.rules.map(rule=>registry.modelPolicyBindings.find(binding=>binding.id===rule.id));
const invariantKey=invariant.id.slice(descriptor.ownerPackage.length+1),lockKey=lock.id.slice(descriptor.ownerPackage.length+1);
assert.equal(typeof registry.invariants[invariantKey],'function');assert.deepEqual(registry.locks[lockKey].fields,['account']);
assert.equal(Object.hasOwn(registry.locks[lockKey],'when'),false,'original User lock has no predicate');
// Only pure native predicates are evaluated. These numeric inputs carry no
// State row identity, framework context, mutation session or grant authority.
for(const [spent,held,cap,running,parallel,accepted] of [['2','3','5','1','2',true],['2','3','4','1','2',false],['2','3','5','3','2',false]]){
 const row=Object.freeze({spent:decodeValue('int',spent),held:decodeValue('int',held),cap:decodeValue('int',cap),running:decodeValue('int',running),parallel:decodeValue('int',parallel)});
 assert.equal(await invariant.evaluate(undefined,row),accepted);
 assert.equal(await registry.invariants[invariantKey](undefined,row),accepted);
}
assert.equal(await lock.evaluate(undefined,Object.freeze({})),true,'unconditional lock does not evaluate a User predicate');
console.log('Original bounded Budget: verified native CLI emits complete ordered numeric invariant and account:user lock with matching registry identities; owner activation remains unqualified');
"#).unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(native_owner)
        .arg(source_hash)
        .arg(&input)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}

#[test]
fn checked_query_derive_and_context_rules_keep_complete_certificates() {
    for predicate in ["count(Item)>0", "positive(row.quantity)", "actor==actor"] {
        let scratch = tempfile::tempdir().unwrap();
        let source = SOURCE.replace(
            " invariant Item: row.quantity>=0",
            &format!(" derive positive(value:int):bool = value>0\n invariant Item: {predicate}"),
        );
        let artifact = compile(&source, scratch.path());
        let js = artifact["modules"][0]["js"].as_str().unwrap();
        let policies = artifact["modelPolicies"]
            .as_array()
            .expect("checked source profile");
        if predicate == "actor==actor" {
            assert_eq!(policies.len(), 1);
            assert_eq!(
                policies[0]["model"], "PolicyProducer.Other",
                "unrelated complete policy survives an unsupported Item context rule"
            );
            assert!(
                js.contains("invariants:["),
                "unsupported Item rule remains visible for activation refusal"
            );
            continue;
        }
        assert_eq!(policies.len(), 2);
        assert_eq!(policies[0]["rules"].as_array().unwrap().len(), 3);
        assert!(js.contains("modelPolicyBindings:"));
        if predicate.starts_with("count") {
            assert_eq!(
                policies[0]["rules"][0]["dependencies"][0]["model"],
                "PolicyProducer.Item"
            );
            assert!(js.contains("queryModels:[\"PolicyProducer.Item\"]"));
        }
    }
}

#[test]
fn original_profile_publishes_duration_invariant_and_complete_seven_field_lock() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let primary = Path::new("/Users/vince/Projects/canlang");
    let installed = if primary
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        primary
    } else {
        root
    };
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/source-profile-scalars.can");
    let hash = "06e8633f8d0b8d1b7b57333447a4bda47db36676db8b43bab5259f6064693995";
    assert_eq!(
        canlang_compiler::source::sha256_hex(source.as_bytes()),
        hash
    );
    let input = scratch.path().join("source-profile-scalars.can");
    std::fs::write(&input, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(installed.join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&input)
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
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let module = artifact["modules"][0]["path"].as_str().unwrap();
    assert_eq!(
        artifact["modelPolicies"],
        serde_json::json!([{
            "abi":"state.owner-model-policies@1", "model":"SourceProfileScalars.Profile",
            "ownerPackage":"SourceProfileScalars", "module":module,
            "rules":[{"kind":"invariant","id":"SourceProfileScalars.Profile.require.1","dependencies":[]},
                {"kind":"lock","id":"SourceProfileScalars.Profile.lock.1","fields":["name","provider_key","policy_revision","system_prompt","input_tokens","output_tokens","duration"]}],
            "hooks":[]
        }])
    );
    let runner = scratch.path().join("profile-policy.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2],installed=process.argv[3],sourcePath=process.argv[4];
const require=createRequire(resolve(root,'package.json')),ownerRequire=createRequire(resolve(installed,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {decodeValue}=await load('@canlang/values');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const hash=createHash('sha256').update(readFileSync(sourcePath)).digest('hex');assert.equal(hash,process.argv[5]);
const [descriptor]=artifact.modelPolicies;
assert.equal(artifact.sources.filter(source=>source.path===sourcePath&&source.sha256===hash).length,1);
const profile=artifact.models.find(model=>model.name===descriptor.model);
assert.equal(profile.fields.find(field=>field.name==='duration').field.kind,'duration');
const assembly=await assembleModules({artifact,sourcePath},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const module=await importVerifiedAssemblyModule(assembly,descriptor.module,artifact),registry=module.canApp();
const origins=module.appDefinition.modelRuleOrigins.filter(origin=>origin.model===descriptor.model&&['invariant','lock'].includes(origin.kind));
assert.equal(origins.length,2);
for(const origin of origins) assert.deepEqual(origin.source,{path:sourcePath,sha256:hash,module:descriptor.ownerPackage});
const expected=descriptor.rules.map(rule=>({id:rule.id,kind:rule.kind,module:descriptor.module,ownerPackage:descriptor.ownerPackage,model:descriptor.model}));
assert.deepEqual(registry.modelPolicyBindings.map(({evaluate,...identity})=>identity),expected);
const [invariant,lock]=registry.modelPolicyBindings;
const ruleKey=invariant.id.slice(descriptor.ownerPackage.length+1),lockKey=lock.id.slice(descriptor.ownerPackage.length+1);
assert.deepEqual(registry.locks[lockKey].fields,descriptor.rules[1].fields);
assert.equal(Object.hasOwn(registry.locks[lockKey],'when'),false);
// This genuine installed native callback is pure. Domain mutation/current-row
// activation and update/remove lock enforcement belong to the native owner run.
for(const [milliseconds,accepted] of [['999',false],['1000',true],['600000',true],['600001',false]]) {
 const row=Object.freeze({duration:decodeValue('duration',milliseconds)});
 assert.equal(await invariant.evaluate(undefined,row),accepted);
 assert.equal(await registry.invariants[ruleKey](undefined,row),accepted);
}
assert.equal(await lock.evaluate(undefined,Object.freeze({})),true);
"#).unwrap();
    let run = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(installed)
        .arg(&input)
        .arg(hash)
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

#[test]
fn stored_lock_targets_retain_the_complete_checked_field_profile() {
    for field in ["text?", "money", "Other"] {
        let scratch = tempfile::tempdir().unwrap();
        let artifact = compile(
            &SOURCE.replace("label:text", &format!("label:{field}")),
            scratch.path(),
        );
        let policies = artifact["modelPolicies"]
            .as_array()
            .expect("source-sealed stored lock profile");
        assert_eq!(policies.len(), 2, "{field}");
        let lock = policies[0]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["kind"] == "lock")
            .unwrap();
        assert_eq!(lock["fields"], serde_json::json!(["label"]), "{field}");
        assert!(
            artifact["modules"][0]["js"]
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
    assert!(js.contains("const {data,...meta}=row;return {...data,...meta};"));
    assert!(js.contains("after:$hookRow($hookCtx.after)"));
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
