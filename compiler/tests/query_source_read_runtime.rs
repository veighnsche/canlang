//! Generic nongrant query-source opt-in through canonical Memory reads.
//! This separate cohort does not admit the original workbench or native receipts.
#![cfg(unix)]

use std::{path::Path, process::Command};

const SOURCE: &str = r#"app QueryRead uses=[workbench]
package rent_catalog
 Given
  export Location {name:text}
  policy Location read=members
 When
  crud Location by=members fields=name
 Then
package todo
 use rent_catalog {Location}
 Given
  export Task {location:Location?,title:text,description:text?,due:datetime?,priority:enum(low,normal,high)=normal,done:bool=false}
  policy Task read=members
 When
  crud Task by=members fields=location,title,description,due,priority,done
 Then
package workbench
 use rent_catalog {Location}
 use todo {Task}
 Given
  contract Scope {targets:Task[]! min=1 max=10}
  export contract Fact {task:Task,version:int min=1,title:Task.title max=2000,description:Task.description max=8000,due:Task.due,priority:Task.priority,done:bool}
 When
  scenario context(location:Location,targets:Scope.targets) read=true -> Fact[] by=members
   require count(targets)>0
   do
    let visible=Task as task where task in targets and task.location==location
    require count(visible)==count(targets)
    return visible as task select Fact {task,version=task.version,title=task.title,description=task.description,due=task.due,priority=task.priority,done=task.done}
 Then
"#;

#[test]
fn nongrant_query_source_opt_in_preserves_actual_read_result_and_live_admission() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // Verify only the three retained statements, not original guard admission.
    let original = include_str!("../../draft/CanWorkbench.can");
    let body: Vec<_> = SOURCE
        .lines()
        .filter(|line| {
            line.starts_with("    let visible=")
                || line.starts_with("    require count(visible)")
                || line.starts_with("    return visible")
        })
        .collect();
    assert_eq!(body.len(), 3);
    for line in body {
        assert!(original.lines().any(|authored| authored == line));
    }
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("query-read.can");
    std::fs::write(&input, SOURCE).unwrap();
    for native in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
        command.args(["compile", "--format=json"]);
        if native {
            command.arg("--native-scenario-receipts");
        }
        let compiled = command
            .arg("--catalog")
            .arg(root.join("packages/values/dist/catalog.json"))
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
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == "workbench.context")
            .unwrap();
        assert_eq!(operation["kind"], "read");
        assert_eq!(operation["result"]["type"], "workbench.Fact[]");
        assert!(operation["result"].get("disclosure").is_none());
        assert!(operation.get("disclosure").is_none());
        let modules = artifact["modules"].as_array().unwrap();
        for module in modules {
            let js = module["js"].as_str().unwrap();
            for helper in [
                "executeScenarioReceiptQuery",
                "bindScenarioReceiptQueryResult",
                "observeScenarioReceiptQueryDependency",
            ] {
                assert!(
                    !js.contains(helper),
                    "nongrant module must not activate {helper}"
                );
            }
        }
        assert_eq!(
            modules.iter().any(|module| module["js"]
                .as_str()
                .unwrap()
                .contains("export function canScenarioQuerySources()")),
            native
        );
        std::fs::write(
            scratch.path().join(if native {
                "native.json"
            } else {
                "ordinary.json"
            }),
            compiled.stdout,
        )
        .unwrap();
    }
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
// Observe genuine helpers without replacing values, membership, or execution.
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {records as nativeRecords,same as nativeSame} from ${JSON.stringify(seamUrl)};
export async function records(...args){const rows=await nativeRecords(...args);globalThis.queryReadTrace.rows.push({model:args[1],rows});return rows;}
export function same(...args){const result=nativeSame(...args);globalThis.queryReadTrace.equal.push({left:args[0],right:args[1],result});return result;}
`);
for(const native of [false,true]){
 const artifact=JSON.parse(readFileSync(resolve(base,native?'native.json':'ordinary.json'),'utf8'));
 const asm=await assembleModules({artifact,sourcePath:resolve(base,'query-read.can')},{
  workDir:resolve(base,native?'native-modules':'ordinary-modules'),stdlibUrl:pathToFileURL(shim).href,
  uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
 });
 if(native){
  const sourceModule=artifact.modules.find(module=>module.js.includes('export function canScenarioQuerySources()'));
  // Import the actual assembled module, including its genuine stdlib mapping.
  const entry=await import(asm.moduleUrls[sourceModule.path]);
  const first=entry.canScenarioQuerySources();
  assert.deepEqual(Object.keys(first),['workbench.context']);
  assert.equal(first['workbench.context'].queries[0].model,'todo.Task');
  assert.equal(first['workbench.context'].returns[0].projection.fields.length,7);
  first['workbench.context'].queries[0].model='foreign.Task';
  assert.equal(entry.canScenarioQuerySources()['workbench.context'].queries[0].model,'todo.Task','source data is fresh');
 }
 const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
 const member=await seedMember(memberships,{isOwner:false});
 const identity=makeIdentity({membership:member.membership,email:member.user.email});
 const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
 const trace={rows:[],equal:[]};globalThis.queryReadTrace=trace;let sequence=0;
 async function create(model,inputs){
  const outcome=await invoker.invokeMutation({operation:`${model}.create`,operation_id:uuidv7(FIXED_NOW,++sequence),inputs},identity);
  assert.ok('result'in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
  assert.equal(outcome.result.result,null);assert.equal(outcome.result.records.length,1);return outcome.result.records[0];
 }
 const location=await create('rent_catalog.Location',{name:'selected workplace'});
 const otherLocation=await create('rent_catalog.Location',{name:'other workplace'});
 const due='2031-03-04T05:06:07.000Z';
 const one=await create('todo.Task',{location:{id:location.id,version:String(location.version)},title:'first',description:null,due:null,priority:'high',done:false});
 const two=await create('todo.Task',{location:{id:location.id,version:String(location.version)},title:'second',description:'details',due,priority:'low',done:true});
 const unselected=await create('todo.Task',{location:null,title:'unselected',description:null,due:null,priority:'normal',done:false});
 const rows=[location,otherLocation,one,two,unselected];
 const models=['rent_catalog.Location','rent_catalog.Location','todo.Task','todo.Task','todo.Task'];
 const revision=await store.readRevision();
 const history=await Promise.all(rows.map((row,index)=>store.historyFor(models[index],row.id)));
 async function unchanged(operationId){
  assert.equal(await store.readRevision(),revision,'read has no commit or receipt');
  assert.deepEqual(await Promise.all(rows.map((row,index)=>store.historyFor(models[index],row.id))),history);
  assert.equal(await store.readReceipt({app:'QueryRead',owner:identity.team.team_id,principal:identity.actor.user_id,
   operation:'workbench.context',operationId}),null,'read never writes a receipt');
 }
 async function read(targets,at=location,who=identity){
  trace.rows.length=0;trace.equal.length=0;const operationId=uuidv7(FIXED_NOW,++sequence);
  const outcome=await invoker.invokeRead({operation:'workbench.context',
   inputs:{location:{id:at.id},targets}},who);await unchanged(operationId);return outcome;
 }
 // Exercise real null/reference predicates before the still-required nominal result.
 const nullLocation=await read([{id:unselected.id}]);
 assert.ok('error'in nullLocation,JSON.stringify(nullLocation));assert.equal(nullLocation.error.code,'rule_failed');
 assert.ok(trace.equal.some(event=>event.left.id===unselected.id&&event.result),'real true membership');
 const selected=[two,one];
 const outcome=await read(selected.map(row=>({id:row.id})));
 const fetch=trace.rows.filter(event=>event.model==='todo.Task');assert.equal(fetch.length,1);
 assert.ok(fetch[0].rows.every(row=>selected.some(selected=>selected.id===row.id)),'records returns the selected domain');
 assert.ok(trace.equal.some(event=>event.left.id===unselected.id&&!event.result),'real false membership');
 assert.ok('result'in outcome,JSON.stringify(outcome));
 const domain=fetch[0].rows.filter(row=>selected.some(selected=>selected.id===row.id));
 assert.equal(domain.length,2);
 const expected=domain.map(view=>{
  const row=selected.find(row=>row.id===view.id);
  return {task:{id:row.id,version:String(row.version)},version:String(row.version),title:row.data.title,
   description:row.data.description,due:row.data.due,priority:row.data.priority,done:row.data.done};
 });
 assert.deepEqual(outcome.result,{result:expected,revision},'nominal Fact[] follows evaluated query order and actual reference versions');
 async function refused(targets,at,who,code){const result=await read(targets,at,who);assert.ok('error'in result,JSON.stringify(result));assert.equal(result.error.code,code);}
 await refused([{id:one.id}],otherLocation,identity,'rule_failed');
 await refused([{id:one.id},{id:one.id}],location,identity,'rule_failed');
 await refused([],location,identity,'validation');
 await refused(Array.from({length:11},()=>({id:one.id})),location,identity,'validation');
 const outsider=makeIdentity({userId:'nonmember',team:member.team,membership:null});
 await refused([{id:one.id}],location,outsider,'forbidden');assert.equal(trace.rows.length,0);
 await memberships.removeMembership(member.membership.membership_id);
 await refused([{id:one.id}],location,identity,'forbidden');assert.equal(trace.rows.length,0);
}
console.log('nongrant query source opt-in: actual ordered Fact[] read, false membership, bounds, no receipts, and live admission passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
