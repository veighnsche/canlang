//! Production source -> unchanged emitted example modules -> actual testkit
//! load/provision/observe and causal steps through an invocation port. These
//! checks do not run application operations against a state engine.

#[cfg(unix)]
#[test]
fn imported_example_helpers_use_actual_production_registry() {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let source = root
        .join("implementation/compiler-completion/bdd-facts/independent-review/sequence-alias.can");
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("imported-helpers.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadExampleSuite,createExampleHooks} from '@canlang/testkit';
const base=dirname(fileURLToPath(import.meta.url));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
assert.equal(artifact.tests.length,1);
// Preserve the production entry/package imports and example import paths.
// No generated body, registry or native helper is replaced.
for(const module of [...artifact.modules,...artifact.tests.map(test=>test.module)]){
 const path=resolve(base,module.path);
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);
}
let dispatched=0;
const hooks=createExampleHooks({
 dispatch:async()=>{dispatched++;return {ok:true};},
 readLive:()=>undefined,
});
const context={formatting:{appDefault:'en'},team:null};
const bindings={self:context,other:context,imported:null};
const suite=await loadExampleSuite(pathToFileURL(resolve(base,artifact.tests[0].module.path)).href,bindings,hooks);
assert.equal(suite.rows.length,1);
const row=suite.rows[0],scope={snapshot:async()=>null,dispose:async()=>{}};
await row.setup(scope);
await row.invoke(scope);
assert.equal(dispatched,1,'the authored echo step runs before the imported helper observation');
assert.deepEqual(await row.observe(scope),[]);
console.log('Actual production registry helper executed through unchanged emitted sequence and installed testkit');
"#,
    )
    .unwrap();
    let executed = Command::new("node").arg(runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}

#[cfg(unix)]
#[test]
fn authored_sequence_requests_reach_the_dispatch_adapter() {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let source = scratch.path().join("requests.can");
    std::fs::write(
        &source,
        r#"app SequenceRequests
Given
 Task { title:text }
 fixture class=Task {title="fixture"}
When
 scenario apply(task:Task,note:text) by=members
  do set task {title=note}
  examples seed=[class]
   do
    let get=1
    let __proto__=get
    call apply {task=class,note=class.title} by=self request={task={version=class.version}} -> error(conflict)
    call apply {task=class,note=class.title} by=other request={task={version=__proto__}} -> error(conflict)
    call apply {task=class,note=class.title} by=other
    get,__proto__ -> 1,1
Then
"#,
    )
    .unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("requests.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const testkit = process.env.CAN_TESTKIT_DIST
 ? pathToFileURL(resolve(process.env.CAN_TESTKIT_DIST,'index.js')).href
 : '@canlang/testkit';
const {loadExampleSuite,fixtureValuesOf,createExampleHooks} = await import(testkit);
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
assert.equal(artifact.tests.length,1);
const test=artifact.tests[0];
const modulePath=resolve(base,test.module.path);
mkdirSync(dirname(modulePath),{recursive:true});writeFileSync(modulePath,test.module.js);
const events=[],calls=[];
let fixture;
const hooks=createExampleHooks({
 dispatch:async call=>{
  events.push('dispatch');calls.push(call);
  assert.equal(call.operation,'SequenceRequests.apply');
  assert.equal(call.inputs.task,fixture,'business record identity remains unchanged');
  assert.equal(call.inputs.note,'fixture');
  if(calls.length<3){
   assert.deepEqual(call.request,{task:{version:calls.length===1?7n:1n}});
   return {ok:false,error:'conflict'};
  }
  assert.equal(Object.hasOwn(call,'request'),false,'absent override stays absent');
  return {ok:true};
 },
 readLive:()=>undefined,
});
const bindings={self:'self-context',other:'other-context',imported:null};
const suite=await loadExampleSuite(pathToFileURL(modulePath).href,bindings,hooks);
assert.equal(suite.rows.length,1);
const row=suite.rows[0],scope={snapshot:async()=>null,dispose:async()=>{}};
await row.setup(scope);
fixture=fixtureValuesOf(scope).get('class');
Object.defineProperty(fixture,'title',{get(){events.push('inputs');return 'fixture';}});
Object.defineProperty(fixture,'version',{configurable:true,get(){events.push('request');return 7n;}});
assert.deepEqual(await row.invoke(scope),{ok:true});
assert.equal(calls.length,3);
assert.deepEqual(calls.map(call=>call.caller),['self-context','other-context','other-context']);
assert.deepEqual(events,['inputs','request','dispatch','inputs','dispatch','inputs','dispatch']);
assert.equal(Object.hasOwn(fixture,'request'),false);
Object.defineProperty(fixture,'version',{get(){throw new Error('invalid override');}});
await assert.rejects(()=>row.invoke(scope),/example at index 0 step 2 request threw: invalid override/);
assert.equal(calls.length,3,'a failed request closure never dispatches');
console.log('Actual compiled sequence forwarded authored request overrides and preserved call order/absence');
"#,
    )
    .unwrap();
    let executed = Command::new("node").arg(runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}

#[cfg(unix)]
#[test]
fn fixture_bindings_and_suite_paths_execute_through_testkit() {
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = Scratch(std::env::temp_dir().join(format!("can-bdd-bindings-{}-{}",
        std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())));
    std::fs::create_dir_all(&scratch.0).unwrap();
    std::os::unix::fs::symlink(root.join("node_modules"), scratch.0.join("node_modules")).unwrap();
    let mut source = "app BddBindings\nGiven\n Task { title:text }\n Note in Task { body:text }\n policy Task read=members\n policy Note read=members\n".to_string();
    let names = [
        "ordinary",
        "class",
        "await",
        "default",
        "c",
        "s",
        "b",
        "self",
        "other",
        "imported",
        "__proto__",
    ];
    for name in names {
        source.push_str(&format!(" fixture {name}=Task {{title=\"{name}-é😀\"}}\n"));
    }
    source.push_str(" fixture child=Note {parent=class,body=\"child\"}\nWhen\n scenario echo(value:text) read=true -> text by=members\n  do return value\n");
    for name in names {
        source.push_str(&format!("  examples seed=[{name}] value=\"ordinary\"\n   value -> {name}.title\n   \"ordinary\" -> \"{name}-é😀\"\n"));
    }
    source.push_str("  examples seed=[child] value=\"ordinary\"\n   value -> class.title,child.body\n   \"ordinary\" -> \"class-é😀\",\"child\"\nThen\n");
    let source_file = scratch.0.join("source.can");
    std::fs::write(&source_file, source).unwrap();
    let compile = |input: &std::path::Path, output: &str| {
        let result = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "clean production compile: {}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        std::fs::write(scratch.0.join(output), result.stdout).unwrap();
    };
    compile(&source_file, "artifact.json");
    let collision_file = scratch.0.join("collision.can");
    let mut collision_source = "app Collisions uses=[alpha,ALPHA,alpha_echo]\n".to_string();
    for (owner, operation) in [
        ("alpha", "echo_value"),
        ("ALPHA", "echo_value"),
        ("alpha_echo", "value"),
    ] {
        collision_source.push_str(&format!("package {owner}\n Given\n  Task {{title:text}}\n  policy Task read=members\n  fixture class=Task {{title=\"{owner}\"}}\n When\n  scenario {operation}(value:text) read=true -> text by=members\n   do return value\n   examples seed=[class] value=\"{owner}\"\n    value -> class.title\n    \"{owner}\" -> \"{owner}\"\n Then\n"));
    }
    std::fs::write(&collision_file, collision_source).unwrap();
    compile(&collision_file, "collision.json");
    let sequence_file = scratch.0.join("sequence.can");
    std::fs::write(&sequence_file, "app BddSequence\nGiven\n contract Result { ok:bool }\nWhen\n scenario echo(value:text) read=true -> Result by=members\n  do return Result {ok=true}\n  examples\n   do\n    let class=\"é😀\"\n    let get=class\n    let size=get\n    let __proto__=size\n    call echo {value=__proto__} by=self as default\n    let later=default.ok\n    call flag {value=later} by=other\n    class,get,size,__proto__,later -> \"é😀\",\"é😀\",\"é😀\",\"é😀\",true\n scenario flag(value:bool) read=true -> bool by=members\n  do return value\nThen\n").unwrap();
    compile(&sequence_file, "sequence.json");
    let runner = scratch.0.join("check.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadExampleSuite,stashedRowOf} from '@canlang/testkit';
import {runSequenceSteps} from '@canlang/testkit/runner/steps';
const base=dirname(new URL(import.meta.url).pathname);
function stage(name){const artifact=JSON.parse(readFileSync(resolve(base,name+'.json'),'utf8'));for(const test of artifact.tests){const path=resolve(base,name,test.module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,test.module.js);}return artifact;}
const bindings={self:'self-context',other:'other-context',imported:null};
const artifact=stage('artifact');assert.equal(artifact.tests.length,1);
const test=artifact.tests[0];const url=pathToFileURL(resolve(base,'artifact',test.module.path));
const emitted=await import(url);const produced=emitted.exampleFixtures(bindings);
const names=['ordinary','class','await','default','c','s','b','self','other','imported','__proto__'];
assert.deepEqual(Object.keys(produced.fixtures),[...names,'child']);
assert.equal(Object.getPrototypeOf(produced.fixtures),Object.prototype);
assert(produced.fixtures.__proto__.model==='BddBindings.Task');
assert.equal(produced.fixtures.child.dependencies[0],produced.fixtures.class,'dependency keeps exact recipe identity');
const suite=await loadExampleSuite(url.href,bindings);assert.equal(suite.rows.length,names.length+1);
for(const [index,row]of suite.rows.entries()){
 const scope={snapshot:async()=>null,dispose:async()=>{}};
 await row.setup(scope,{self:'self-context',other:'other-context',outsider:'outsider',users:{}});
 const stash=stashedRowOf(scope);assert.equal(stash.inputs.value,'ordinary');
 const expected=index<names.length?[`${names[index]}-é😀`]:['class-é😀','child'];
 assert.deepEqual(stash.expectedValues,expected);assert.deepEqual(await row.observe(scope),expected);
}
const collisions=stage('collision');
assert.deepEqual(collisions.tests.map(test=>test.scope),['alpha.echo_value','ALPHA.echo_value','alpha_echo.value']);
const expectedOwners=['alpha','ALPHA','alpha_echo'];
const paths=collisions.tests.map(test=>test.module.path);
assert.equal(new Set(paths.map(path=>path.toLowerCase())).size,paths.length,'portable distinct owner paths');
for(const [index,test]of collisions.tests.entries()){const loaded=await loadExampleSuite(pathToFileURL(resolve(base,'collision',test.module.path)).href,bindings);assert.equal(loaded.rows.length,1);for(const row of loaded.rows){const scope={snapshot:async()=>null,dispose:async()=>{}};await row.setup(scope);assert.deepEqual(await row.observe(scope),[expectedOwners[index]]);}}
const sequence=stage('sequence');assert.equal(sequence.tests.length,1);
const calls=[];
const sequenceSuite=await loadExampleSuite(pathToFileURL(resolve(base,'sequence',sequence.tests[0].module.path)).href,bindings,{
 invokeCall:async request=>{calls.push([request.operation,request.by,request.inputs]);return {ok:true};}
});
const sequenceRow=sequenceSuite.rows[0];const sequenceScope={snapshot:async()=>null,dispose:async()=>{}};
await sequenceRow.setup(sequenceScope);assert.deepEqual(await sequenceRow.invoke(sequenceScope),{ok:true});
assert.deepEqual(calls,[['BddSequence.echo','self-context',{value:'é😀'}],['BddSequence.flag','other-context',{value:true}]]);
// Ordinary public Map-method closures keep working before an authored get/size
// binding exists. One facade observes every progressively published write.
let firstFacade;
const controlOutcome={ok:true};
const checks=[];
const steps=[
 {kind:'binding',name:'ordinary',value:async(c,s,b)=>{firstFacade=b;assert.equal(b.size,0);return 'ordinary';}},
 {kind:'binding',name:'copy',value:async(c,s,b)=>{assert.equal(b,firstFacade);assert.equal(b.get('ordinary'),'ordinary');assert.deepEqual([...b],[['ordinary','ordinary']]);return b.get('ordinary');}},
 {kind:'call',operation:'Control.copy',by:async(c,s,b)=>{assert.equal(b,firstFacade);return b.ordinary;},inputs:async(c,s,b)=>{assert.equal(b,firstFacade);return {value:b.copy};},bind:'returned'},
 {kind:'binding',name:'get',value:async(c,s,b)=>'authored-get'},
 {kind:'binding',name:'size',value:async(c,s,b)=>'authored-size'},
 {kind:'binding',name:'__proto__',value:async(c,s,b)=>'authored-proto'},
 {kind:'assertion',observations:async(c,s,b)=>{assert.equal(b,firstFacade);assert.equal(b.returned,controlOutcome);checks.push([b.copy,b.returned.ok,b.get,b.size,b.__proto__]);return [b.copy,b.returned.ok,b.get,b.size,b.__proto__];},expected:async(c,s,b)=>{assert.equal(b,firstFacade);return ['ordinary',true,'authored-get','authored-size','authored-proto'];},types:['text','bool','text','text','text']}
];
assert.deepEqual(await runSequenceSteps(steps,{callerBindings:bindings,provisioned:new Map(),invoke:async request=>{assert.equal(request.by,'ordinary');assert.deepEqual(request.inputs,{value:'ordinary'});return controlOutcome;},scope:sequenceScope,exampleIndex:0}),{ok:true});
assert.deepEqual(checks,[['ordinary',true,'authored-get','authored-size','authored-proto']]);
console.log('BDD bindings: reserved/context recipes, Unicode payloads, suite paths and progressive sequence property/Map reads executed');
"#).unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .output()
        .expect("Node is required for BDD runtime qualification");
    assert!(
        executed.status.success(),
        "actual testkit: {}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}
