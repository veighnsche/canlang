//! Original Chat policy producer and verified pure callbacks only.
//! Native owner activation, row identity, grants and mutation enforcement are separate.
use std::{path::Path, process::Command};

const SOURCE: &str = include_str!("fixtures/original-a850/CanChat.can");
const SOURCE_HASH: &str = "8eb79dd397aa801d97692aa195e24ad9ee29977b4e102e7cbc35e21c9fdd0ad3";

#[test]
fn unchanged_chat_retains_exact_policy_outputs_while_full_compilation_refuses() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    assert_eq!(
        canlang_compiler::source::sha256_hex(SOURCE.as_bytes()),
        SOURCE_HASH
    );
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("CanChat.can");
    std::fs::write(&input, SOURCE.as_bytes()).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root.join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&input)
        .current_dir(root)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    // The public CLI retains the unrelated whole-app native refusals and
    // must not publish an artifact with only a subset of its checked behavior.
    assert_eq!(
        compiled.status.code(),
        Some(10),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let refusal: serde_json::Value = serde_json::from_slice(&compiled.stdout).unwrap();
    assert!(refusal.get("modules").is_none());
    let refusal_diagnostics = refusal["diagnostics"].as_array().unwrap();
    assert!(!refusal_diagnostics.is_empty());
    assert!(
        refusal_diagnostics
            .iter()
            .all(|diagnostic| diagnostic["code"] == "E6008")
    );
    assert!(
        refusal_diagnostics
            .iter()
            .any(|diagnostic| diagnostic["message"].as_str().unwrap().contains("chat.ask"))
    );

    // Exercise only this test's policy-producer boundary. The emitter retains
    // sibling policy outputs for diagnostics/editor consumers even when an
    // unrelated scenario refuses; these scratch modules are never published.
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    use canlang_compiler::diagnostic::DiagnosticResult;
    use canlang_compiler::source::{SourceDb, Span};
    let mut db = SourceDb::new();
    let file = db.add(input.to_string_lossy().into_owned(), SOURCE.into());
    let catalog_path = root.join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) =
        canlang_compiler::analysis::check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut result = DiagnosticResult::new(env!("CARGO_PKG_VERSION"), "1.0", 1);
    result.add_sources(&db);
    let mut options = EmitOptions::new();
    options.native_scenario_receipts = true;
    let (partial, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options,
        },
    );
    assert!(!diagnostics.is_empty());
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code == "E6008"),
        "{diagnostics:?}"
    );
    let policy_output = canlang_compiler::codegen::artifact::to_json(&partial);
    let artifact: serde_json::Value = serde_json::from_str(&policy_output).unwrap();
    let module = artifact["modelPolicies"][0]["module"]
        .as_str()
        .expect("complete original Chat policy census");
    assert_eq!(
        artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["path"] == module)
            .count(),
        1
    );
    let expected = serde_json::json!([
        {"abi":"state.owner-model-policies@1","model":"chat.Profile","ownerPackage":"chat","module":module,
         "rules":[{"kind":"invariant","id":"chat.Profile.require.1","dependencies":[]},
                  {"kind":"lock","id":"chat.Profile.lock.1","fields":["name","provider_key","policy_revision","system_prompt","input_tokens","output_tokens","duration"]}],"hooks":[]},
        {"abi":"state.owner-model-policies@1","model":"chat.Allowance","ownerPackage":"chat","module":module,
         "rules":[{"kind":"invariant","id":"chat.Allowance.require.1","dependencies":[]},
                  {"kind":"lock","id":"chat.Allowance.lock.1","fields":["account"]}],"hooks":[]},
        {"abi":"state.owner-model-policies@1","model":"chat.Conversation","ownerPackage":"chat","module":module,
         "rules":[{"kind":"lock","id":"chat.Conversation.lock.1","fields":["account"]}],"hooks":[]},
        {"abi":"state.owner-model-policies@1","model":"chat.Branch","ownerPackage":"chat","module":module,
         "rules":[{"kind":"lock","id":"chat.Branch.lock.1","fields":["profile","prefix","origin"]}],"hooks":[]},
        {"abi":"state.owner-model-policies@1","model":"chat.Turn","ownerPackage":"chat","module":module,
         "rules":[{"kind":"invariant","id":"chat.Turn.require.1","dependencies":[]},
                  {"kind":"lock","id":"chat.Turn.lock.1","fields":["position","role","content","attachments","run"]}],"hooks":[]},
        {"abi":"state.owner-model-policies@1","model":"chat.Run","ownerPackage":"chat","module":module,
         "rules":[{"kind":"invariant","id":"chat.Run.require.1","dependencies":[]},
                  {"kind":"lock","id":"chat.Run.lock.1","fields":["account","allowance","request_value","reserved","request"]}],"hooks":[]}
    ]);
    assert_eq!(artifact["modelPolicies"], expected);
    std::fs::write(scratch.path().join("artifact.json"), &policy_output).unwrap();
    std::fs::write(
        scratch.path().join("expected.json"),
        serde_json::to_vec(&expected).unwrap(),
    )
    .unwrap();
    assert_eq!(std::fs::read(&input).unwrap(), SOURCE.as_bytes());
    let runner = scratch.path().join("chat-policies.mjs");
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
const {decodeValue}=await import(own('@canlang/values'));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const expected=JSON.parse(readFileSync(resolve(base,'expected.json'),'utf8'));
const source=readFileSync(sourcePath);
assert.equal(createHash('sha256').update(source).digest('hex'),process.argv[4]);
assert.deepEqual(artifact.modelPolicies,expected);
assert.equal(expected.length,6);
const rules=expected.flatMap(descriptor=>descriptor.rules);
assert.equal(rules.filter(rule=>rule.kind==='invariant').length,4);
assert.equal(rules.filter(rule=>rule.kind==='lock').length,6);
for(const rule of rules.filter(rule=>rule.kind==='invariant')) assert.deepEqual(rule.dependencies,[]);
const assembly=await assembleModules({artifact,sourcePath},{workDir:resolve(base,'modules'),stdlibUrl:own('@canlang/cloudflare/runtime/stdlib').href});
const module=await importVerifiedAssemblyModule(assembly,expected[0].module,artifact);
assert.equal(typeof module.canApp,'function');
const registry=module.canApp(),bindings=registry.modelPolicyBindings;
for(const descriptor of expected){
 const declared=module.appDefinition.models[descriptor.model];assert.ok(declared);
 const local=rule=>rule.id.slice(descriptor.ownerPackage.length+1);
 assert.deepEqual(declared.invariants??[],descriptor.rules.filter(rule=>rule.kind==='invariant').map(local));
 assert.deepEqual(declared.locks??[],descriptor.rules.filter(rule=>rule.kind==='lock').map(local));
}
const identities=expected.flatMap(descriptor=>descriptor.rules.map(rule=>({id:rule.id,model:descriptor.model,
 ownerPackage:descriptor.ownerPackage,module:descriptor.module,kind:rule.kind})));
assert.equal(bindings.length,10);
assert.deepEqual(bindings.map(({evaluate,...identity})=>identity),identities,'same complete owning descriptor/binding order');
const byId=new Map(bindings.map(binding=>[binding.id,binding]));
assert.equal(byId.size,10);
for(const descriptor of expected){
 assert.deepEqual(descriptor.hooks,[]);
 for(const rule of descriptor.rules){
  const binding=byId.get(rule.id),key=rule.id.slice(descriptor.ownerPackage.length+1);
  assert.equal(typeof binding.evaluate,'function');
  if(rule.kind==='invariant') assert.equal(typeof registry.invariants[key],'function');
  else {
   assert.deepEqual(registry.locks[key].fields,rule.fields);
   assert.equal(Object.hasOwn(registry.locks[key],'when'),false,'original locks are unconditional');
   assert.equal(await binding.evaluate(undefined,Object.freeze({})),true);
  }
 }
}
// Real verified generated pure callbacks receive only scalar test values.
// These inputs issue no framework context, row identity, State session or grant.
const evaluate=async(id,fields)=>{
 const row=Object.freeze(fields),key=id.slice('chat.'.length);
 const result=await byId.get(id).evaluate(undefined,row);
 assert.equal(typeof result,'boolean');
 assert.equal(await registry.invariants[key](undefined,row),result);
 return result;
};
for(const [role,accepted] of [['user',true],['assistant',true],['system',false],['tool',false]]){
 assert.equal(await evaluate('chat.Turn.require.1',{role}),accepted);
}
for(const [milliseconds,accepted] of [['999',false],['1000',true],['600000',true],['600001',false]]){
 assert.equal(await evaluate('chat.Profile.require.1',{duration:decodeValue('duration',milliseconds)}),accepted);
}
for(const [spent,held,cap,running,parallel,accepted] of [
 ['2','3','5','1','2',true],['2','3','4','1','2',false],['2','3','5','3','2',false]]){
 const fields=Object.fromEntries(Object.entries({spent,held,cap,running,parallel}).map(([name,value])=>[name,decodeValue('int',value)]));
 assert.equal(await evaluate('chat.Allowance.require.1',fields),accepted);
}
for(const [used,reserved,accepted] of [[null,'8',true],['0','1',true],['8','8',true],['9','8',false]]){
 assert.equal(await evaluate('chat.Run.require.1',{used:used===null?null:decodeValue('int',used),reserved:decodeValue('int',reserved)}),accepted);
}
assert.equal(createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),process.argv[4]);
console.log('Unchanged Chat: complete six-model/four-invariant/six-lock descriptors and verified pure callbacks agree; native owner activation unqualified');
"#).unwrap();
    let executed = Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(&input)
        .arg(SOURCE_HASH)
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
