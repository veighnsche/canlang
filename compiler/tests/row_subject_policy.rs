//! Actual compiler row-subject metadata consumed by State's owning policy boundary.
//! Dev's native selector intake is separate; this qualifies the source/State join.
#![cfg(unix)]

use std::{path::Path, process::Command};

const SOURCE: &str = r#"app RowSubject
Given
 role auditor
 Entry {person:user,title:text}
 OptionalEntry {optional:user?,title:text}
 policy Entry read=auditor(row.person) fields=title
 policy OptionalEntry read=auditor(row.optional) fields=title
When
 crud Entry by=owner fields=person,title
 crud OptionalEntry by=owner fields=optional,title
Then
"#;

#[test]
fn emitted_row_subject_grants_select_actual_identity_subject_and_project_only_title() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("row-subject.can");
    std::fs::write(&input, SOURCE).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
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
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
assert.equal(Number(process.versions.node.split('.')[0]),24,'use the installed Node 24 runtime');
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const {buildPolicyTable}=await load('@canlang/state/policy/grants');
const {hasRole}=await load('@canlang/state/policy/roles');
const {queryRecords}=await load('@canlang/state/query');
const {createMemoryStorage}=await load('@canlang/state/storage/memory');
const {seedRows,FIXED_NOW}=await load('@canlang/state/testing/query/fixtures');
const {createMemoryIdentityStore,createFrozenClock}=await load('@canlang/identity/testing');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'row-subject.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const entry=await import(asm.entryUrl),app=entry.canApp();
assert.deepEqual(app.operations,artifact.operations);
const sourceJs=artifact.modules.map(module=>module.js).join('\n');
assert.ok(sourceJs.includes('hasRole(c,"RowSubject.auditor",row.person)'),'actual native row-role callable is retained');
assert.ok(sourceJs.includes('hasRole(c,"RowSubject.auditor",')&&sourceJs.includes('row.optional'),'nullable subject keeps native role evaluation');
const loaded=loadArtifactDescriptors(artifact,{by:'owner'});
// Each positive policy comes only from the generated model grant and the
// owning State loader's typed-secret and canonical declaration inventories.
const policies=loaded.models.map(model=>{
 const generated=entry.appDefinition.models[model.name];assert.ok(generated);
 const grants=generated.readGrants.map(grant=>{
  assert.equal(grant.by.length,1);assert.deepEqual(grant.fields,['title']);
  return {by:grant.by[0],fields:grant.fields};
 });
 assert.equal(grants.length,1);
 const field=model.name==='RowSubject.Entry'?'person':'optional';
 assert.deepEqual(grants[0].by,{roleSubject:{role:'RowSubject.auditor',person:{model:model.name,field}}});
 return {model:model.name,secretFields:[...(loaded.secretFields.get(model.name)??[])],grants};
});
const table=buildPolicyTable(policies,loaded.models);
const identity=createMemoryIdentityStore({clock:createFrozenClock(FIXED_NOW)});
const team=await identity.createTeam({timezone:'UTC'});
const user=async email=>identity.createUser({email,password_hash:'fixture-password-hash',email_verified:true});
const caller=await user('caller@example.test'),auditor=await user('auditor@example.test'),ordinary=await user('ordinary@example.test');
const role={role:'RowSubject.auditor',granted_at:new Date(FIXED_NOW).toISOString(),granted_by:caller.user_id};
await identity.createMembership({team_id:team.team_id,user_id:caller.user_id,is_owner:false,roles:[]});
const auditorMembership=await identity.createMembership({team_id:team.team_id,user_id:auditor.user_id,is_owner:false,roles:[role]});
await identity.createMembership({team_id:team.team_id,user_id:ordinary.user_id,is_owner:true,roles:[]});
const nullableRule=app.read['OptionalEntry.read.1'];
assert.equal(typeof nullableRule,'function');
const handlerRoleView={memberships:auditorMembership.roles.map(grant=>grant.role)};
for(const absent of [null,undefined]){
 let reads=0;
 const row={get optional(){reads++;return absent;}};
 assert.equal(await nullableRule(handlerRoleView,row),false,'actual compiled nullable rule never falls back to the auditor actor');
 assert.equal(reads,1,'actual compiled nullable subject is evaluated once');
}
assert.equal(await hasRole({actorUserId:caller.user_id,teamId:team.team_id,memberships:identity},role.role),false);
assert.equal(await hasRole({actorUserId:ordinary.user_id,teamId:team.team_id,memberships:identity},role.role),false,'owner is not an implicit declared auditor');
const store=createMemoryStorage();
const entryRows=await seedRows(store,'RowSubject.Entry',[
 {id:'auditor-entry',createdBy:caller.user_id,data:{person:{id:auditor.user_id},title:'auditor title'}},
 {id:'ordinary-entry',createdBy:caller.user_id,data:{person:{id:ordinary.user_id},title:'ordinary title'}},
]);
const optionalRows=await seedRows(store,'RowSubject.OptionalEntry',[
 {id:'auditor-optional',createdBy:caller.user_id,data:{optional:{id:auditor.user_id},title:'optional auditor title'}},
 {id:'ordinary-optional',createdBy:caller.user_id,data:{optional:{id:ordinary.user_id},title:'optional ordinary title'}},
 {id:'null-optional',createdBy:caller.user_id,data:{optional:null,title:'null title'}},
]);
const rows=[...entryRows.map(row=>({row,model:'RowSubject.Entry'})),...optionalRows.map(row=>({row,model:'RowSubject.OptionalEntry'}))];
const durable=async()=>({revision:await store.readRevision(),
 rows:await Promise.all(rows.map(({row,model})=>store.load(model,row.id))),
 history:await Promise.all(rows.map(({row,model})=>store.historyFor(model,row.id)))});
const baseline=await durable();
const snapshots=[];
const memberships={...identity,findMembershipsSnapshot:async(teamId,users)=>{
 const result=await identity.findMembershipsSnapshot(teamId,users);
 snapshots.push({teamId,users:[...users],result});return result;
}};
async function query(model,actor=caller.user_id,where){
 const before=await durable();snapshots.length=0;
 const result=await queryRecords({policy:table,model,modelDescriptor:loaded.models.find(declaration=>declaration.name===model),
  authority:'viewer',context:{actorUserId:actor,teamId:team.team_id},memberships,store,
  ...(where===undefined?{}:{where})});
 assert.deepEqual(await durable(),before,'viewer query commits no revision, row or history effects');
 assert.equal(result.revision,before.revision);
 assert.ok(snapshots.length>=2,'actual Identity snapshot establishes and rechecks authority');
 for(const snapshot of snapshots){
  assert.equal(snapshot.teamId,team.team_id);
  assert.ok(snapshot.users.includes(actor),'coherent observation includes the actual caller');
  assert.ok(snapshot.users.includes(auditor.user_id)&&snapshot.users.includes(ordinary.user_id),'coherent observation includes both actual row subjects');
  assert.deepEqual(snapshot.result.entries.map(entry=>entry.user_id),snapshot.users,'actual Identity producer preserves requested positions');
 }
 return result;
}
const result=await query('RowSubject.Entry');
assert.deepEqual(result.records.map(record=>({id:record.id,data:record.data})),[{id:'auditor-entry',data:{title:'auditor title'}}]);
assert.ok(result.records.every(record=>!Object.hasOwn(record.data,'person')),'row subject grants no subject-field projection');
const filtered=await query('RowSubject.Entry',caller.user_id,{op:'eq',field:'title',value:'auditor title'});
assert.deepEqual(filtered.records,result.records,'granted title remains available to the actual viewer filter');
const optional=await query('RowSubject.OptionalEntry');
assert.deepEqual(optional.records.map(record=>({id:record.id,data:record.data})),[{id:'auditor-optional',data:{title:'optional auditor title'}}]);
assert.ok(optional.records.every(record=>!Object.hasOwn(record.data,'optional')));
// With an auditor caller, nullable absence still cannot fall back to the actor.
const optionalAsAuditor=await query('RowSubject.OptionalEntry',auditor.user_id);
assert.deepEqual(optionalAsAuditor.records.map(record=>record.id),['auditor-optional']);
const nullOnly=await queryRecords({policy:table,model:'RowSubject.OptionalEntry',
 modelDescriptor:loaded.models.find(declaration=>declaration.name==='RowSubject.OptionalEntry'),authority:'viewer',
 context:{actorUserId:auditor.user_id,teamId:team.team_id},memberships:identity,store,
 where:{op:'eq',field:'id',value:'null-optional'}});
assert.deepEqual(nullOnly.records,[],'null row subject is false even when the actor has the requested role');
assert.deepEqual(await durable(),baseline);
// Refusal controls alter actual produced metadata/declarations only, and call
// the same owning State boundary that accepted the generated positive policy.
for(const mode of ['undefined','foreign','array','secret']){
 const alteredPolicies=structuredClone(policies),declarations=structuredClone(loaded.models);
 const policy=alteredPolicies.find(policy=>policy.model==='RowSubject.Entry');
 const declaration=declarations.find(declaration=>declaration.name===policy.model);
 if(mode==='undefined')declaration.fields.person.valueType=undefined;
 if(mode==='foreign')policy.grants[0].by.roleSubject.person.model='RowSubject.OptionalEntry';
 if(mode==='array')declaration.fields.person.array={required:false};
 if(mode==='secret')policy.secretFields.push('person');
 assert.throws(()=>buildPolicyTable(alteredPolicies,declarations),/row role subject/i,mode);
}
await identity.setMembershipRoles(auditorMembership.membership_id,[]);
assert.deepEqual((await query('RowSubject.Entry')).records,[],'revoked row subject changes the current result');
assert.deepEqual((await query('RowSubject.OptionalEntry')).records,[]);
assert.deepEqual(await durable(),baseline,'Identity revocation and all viewer queries leave Memory data untouched');
console.log('actual emitted row-subject policies: coherent Identity subjects, title-only projection, nullable absence, owning declaration refusals and current revocation passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
