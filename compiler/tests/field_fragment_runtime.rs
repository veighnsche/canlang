//! Authored fragments from the original CanChat cap edit use the real prepared
//! CRUD schema, verified generated assembly and installed UI. Queried RowViews
//! and business errors are supplied presentation snapshots, not application or
//! native File authority qualification.
use std::path::Path;
use std::process::Command;

const SOURCE: &str = r#"app FieldFragments uses=[chat]
package chat
 Given
  role ai_manager label="AI administrator"@{nl="AI-beheerder"}
  Allowance { account:user unique, cap:int min=1, parallel:int=2 min=1 max=10, spent:int=0 min=0, held:int=0 min=0, running:int=0 min=0 max=10, active:bool=true } label="Token allowance"@{nl="Tokenbudget"}
  policy Allowance read=ai_manager or (members and row.account==actor)
  invariant Allowance: row.spent+row.held<=row.cap and row.running<=row.parallel
  lock Allowance fields=account
 When
  crud Allowance by=ai_manager fields=cap,parallel,active create_fields=account,cap,parallel delete=none
 Then
  page / title="Original cap placements"
   form Allowance.create
    input cap
    range parallel
   table Allowance columns=account,cap,parallel,spent,held,running,active empty="No token allowances"@{nl="Geen tokenbudgetten"}
    pagination
    edit fields=cap,parallel,active
     label cap
     input cap
     validator cap
     range parallel
     checkbox active
  page /caption title="Independent fragments"
   form Allowance.create
    label cap caption="Cap <&>"@{nl="Limiet <&>"}
    validator parallel
  page /group title="Fragment-only group"
   form Allowance.create
    fieldset "Cap group"
     label cap
     validator cap
  page /gated title="Gated form"
   card "Hidden form"
    require false
    form Allowance.create
     label cap
     validator cap
  page /row-gated title="Gated row"
   table Allowance columns=cap
    card "Active edit"
     require row.active
     edit fields=cap,parallel,active
      label cap
      input cap
      validator cap
      range parallel
      checkbox active
"#;

fn compile(source: &str, path: &Path) -> (std::process::Output, serde_json::Value) {
    std::fs::write(path, source).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let response = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    (output, response)
}

#[test]
fn original_cap_fragments_use_real_preparer_identities_and_generated_remainder() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("fragments.can");
    let (output, artifact) = compile(SOURCE, &source);
    assert!(output.status.success(), "{artifact}");
    std::fs::write(
        scratch.path().join("artifact.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    let runner = scratch.path().join("render.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=process.argv[2],base=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(root,'package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {createTestDeps,testRequest}=await load('@canlang/interfaces/testing');
const {catalogFromArtifactOperations,deriveOperationInputs}=await load('@canlang/interfaces/http/operations');
const {deriveCsrfToken,toInstant}=await load('@canlang/identity');
const {fieldInputId,fieldErrorOutletId}=await load('@canlang/ui');
const internals=name=>import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/'+name+'.js')));
const {resolveRequestIdentity}=await internals('context');
const {buildPresentationContext}=await internals('presentation');
const {createSourceFormBindings}=await internals('form-binding');
const {createOperationFormPreparer}=await internals('forms');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'fragments.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const catalog=catalogFromArtifactOperations(artifact);
const update=artifact.operations.find(op=>op.name==='chat.Allowance.update');assert(update);
const create=artifact.operations.find(op=>op.name==='chat.Allowance.create');assert(create);
assert.deepEqual(update.inputs.fields.map(field=>field.name),['record','cap','parallel','active']);
assert.deepEqual(create.inputs.fields.map(field=>field.name),['account','cap','parallel']);
const {deps,identity}=await createTestDeps();
const membership=await deps.identity.store.findMembership(identity.teamId,identity.userId);assert(membership);
await deps.identity.store.setMembershipRoles(membership.membership_id,[{role:'chat.ai_manager',granted_at:toInstant(deps.clock.nowMs()),granted_by:identity.userId}]);
const request=testRequest('/fragments',{cookie:identity.cookie});
const {identity:principal}=await resolveRequestIdentity(deps.identity.store,request,{clock:deps.clock,teamId:identity.teamId});
const service=await createSourceFormBindings(new Uint8Array(32).fill(93),'compiler-field-fragments');
const originalRows=[
 {id:'one',version:'7',fields:{account:{id:'one-user'},cap:100,parallel:2,spent:3,held:4,running:1,active:true}},
 {id:'two',version:'8',fields:{account:{id:'two-user'},cap:200,parallel:3,spent:4,held:5,running:1,active:false}},
];
let rows=originalRows,requests=[],prepared=[],trace=[],fault=null,fieldFault=null,unavailable=false;
const context=buildPresentationContext({request,pathname:'/',isPartial:false,appDefaultLocale:'en',
 csrfToken:await deriveCsrfToken(identity.sessionToken),principal,catalog,clock:deps.clock,
 formBindings:service,appId:deps.app.appId,sessionToken:identity.sessionToken,
 query:async(invocation,model,args)=>{
  assert.equal(model,'chat.Allowance');assert.equal(invocation,context.invocation);
  trace.push('query');return {rows,columns:[{field:'account',label:'Account',type:'user'},...['cap','parallel','spent','held','running'].map(field=>({field,label:field,type:'int'})),{field:'active',label:'Active',type:'bool'}],nextCursor:'next'};
 },
});
const genuine=createOperationFormPreparer(context,catalog,deps.clock,{
 service,appId:deps.app.appId,sessionToken:identity.sessionToken,identity:principal,
});
context.prepareForm=async function(spec){
 assert.equal(this,context);requests.push(spec);
 const id=spec.arguments?.record.id??'create';trace.push('prepare:start:'+id);await Promise.resolve();
 if(fault)throw fault;if(unavailable)return {status:'unavailable',message:'Unavailable <&>'};
 const ready=await genuine(spec);assert.equal(ready.status,'ready');
 trace.push('prepare:end:'+id);prepared.push(ready);
 assert.deepEqual(ready.derived,deriveOperationInputs(id==='create'?create:update));
 if(id!=='create'){
  const original=originalRows.find(row=>row.id===id);assert(original);
  assert.equal(spec.arguments.record.version,BigInt(original.version));
  assert.deepEqual(ready.props.record,{id,version:String(original.version)});
  assert.equal(ready.field('cap').field.value,original.fields.cap);
  assert.equal(typeof ready.props.sourceBinding,'string');
 }
 // Supplied business-error presentation snapshot shares the genuine prepared
 // field, IDs and mode. No dispatcher/business mutation acceptance is claimed.
 const errors=[{path:id==='create'?'/cap':'/changes/cap',code:'rule_failed',message:'Cap <bad>'},
  {path:id==='create'?'/parallel':'/changes/parallel',code:'rule_failed',message:'Parallel <bad>'}];
 return {...ready,props:{...ready.props,errors},field:path=>{
  trace.push('field:'+id+':'+path);if(fieldFault)throw fieldFault;
  const field=ready.field(path);assert.equal(field.context,context);
  assert.equal(field.authoredLabel,spec.authoredLabels?.includes(path)?true:undefined);
  assert.equal(field.authoredValidator,spec.authoredValidators?.includes(path)?true:undefined);
  return {...field,errors};
 }};
};
const render=async path=>{
 requests=[];prepared=[];trace=[];context.path=path;
 const page=entry.appDefinition.pages.find(page=>page.path===path);assert(page);
 return page.render(context,{});
};
const count=(html,value)=>html.split(value).length-1;
const fragmentIdentity=(html,ready,path)=>{
 const input=fieldInputId(ready.props.idPrefix,path),outlet=fieldErrorOutletId(ready.props.idPrefix,path);
 assert.equal(count(html,`for="${input}"`),1,'one owning label');
 assert.equal(count(html,`id="${input}"`),1,'one owning input');
 assert.equal(count(html,`id="${outlet}"`),1,'one owning validation outlet');
 assert(html.includes(`aria-describedby="${outlet}"`));
 return {input,outlet};
};
let html=await render('/');assert.equal(requests.length,3);assert.equal(prepared.length,3);
assert.deepEqual(requests[0].authoredFields,['cap','parallel']);
assert.equal(requests[0].authoredLabels,undefined);assert.equal(requests[0].authoredValidators,undefined);
assert(html.includes('name="inputs[account]"'),'unplaced account keeps generated entry');
for(let i=1;i<3;i++){
 assert.deepEqual(requests[i].fields,['cap','parallel','active']);
 assert.deepEqual(requests[i].authoredFields,['cap','parallel','active']);
 assert.deepEqual(requests[i].authoredLabels,['cap']);assert.deepEqual(requests[i].authoredValidators,['cap']);
 assert.equal(Object.isFrozen(prepared[i].props.authoredLabels),true);
 assert.equal(Object.isFrozen(prepared[i].props.authoredValidators),true);
 const {input,outlet}=fragmentIdentity(html,prepared[i],'cap');
 assert(html.indexOf(`for="${input}"`)<html.indexOf(`id="${input}"`));
 assert(html.indexOf(`id="${input}"`)<html.indexOf(`id="${outlet}"`));
}
assert.notEqual(prepared[1].props.idPrefix,prepared[2].props.idPrefix);
assert.notEqual(prepared[1].props.sourceBindingIdentity,prepared[2].props.sourceBindingIdentity);
assert.equal(count(html,'name="inputs[changes][cap]"'),2);
assert.equal(count(html,'name="inputs[changes][parallel]"'),2);
assert.equal(count(html,'name="inputs[changes][active]"'),2);
assert.equal(count(html,'Cap &lt;bad&gt;'),3,html);assert.equal(count(html,'Parallel &lt;bad&gt;'),3,html);
assert(!html.includes('Cap <bad>'));assert(html.includes('data-cursor="next"'));
assert.deepEqual(trace,[
 'prepare:start:create','prepare:end:create','field:create:cap','field:create:parallel','query',
 'prepare:start:one','prepare:end:one','field:one:cap','field:one:cap','field:one:cap','field:one:parallel','field:one:active',
 'prepare:start:two','prepare:end:two','field:two:cap','field:two:cap','field:two:cap','field:two:parallel','field:two:active',
]);
context.preferredLocales=['nl'];html=await render('/caption');
assert.equal(requests.length,1);assert.deepEqual(requests[0].authoredFields,[]);
assert.deepEqual(requests[0].authoredLabels,['cap']);assert.deepEqual(requests[0].authoredValidators,['parallel']);
assert(html.includes('Limiet &lt;&amp;&gt;')&&!html.includes('Cap &lt;&amp;&gt;'));
fragmentIdentity(html,prepared[0],'cap');fragmentIdentity(html,prepared[0],'parallel');
for(const path of ['account','cap','parallel'])assert.equal(count(html,`name="inputs[${path}]"`),1);
assert.equal(count(html,'Cap &lt;bad&gt;'),1);assert.equal(count(html,'Parallel &lt;bad&gt;'),1);
html=await render('/group');assert.deepEqual(requests[0].authoredFields,[]);
assert.deepEqual(requests[0].authoredLabels,['cap']);assert.deepEqual(requests[0].authoredValidators,['cap']);
fragmentIdentity(html,prepared[0],'cap');
for(const path of ['account','cap','parallel'])assert.equal(count(html,`name="inputs[${path}]"`),1);
html=await render('/gated');assert.equal(requests.length,0);assert.deepEqual(trace,[]);
html=await render('/row-gated');assert.equal(requests.length,1);assert.equal(requests[0].arguments.record.id,'one');
assert.deepEqual(trace,['query','prepare:start:one','prepare:end:one','field:one:cap','field:one:cap','field:one:cap','field:one:parallel','field:one:active']);
const firstPrepare=new Error('first-preparation');fault=firstPrepare;
await assert.rejects(render('/'),error=>error===firstPrepare);assert.deepEqual(trace,['prepare:start:create']);fault=null;
const firstField=new Error('first-field');fieldFault=firstField;
await assert.rejects(render('/caption'),error=>error===firstField);
assert.deepEqual(trace,['prepare:start:create','prepare:end:create','field:create:cap']);fieldFault=null;
unavailable=true;html=await render('/caption');assert(html.includes('Unavailable &lt;&amp;&gt;'));
assert.deepEqual(trace,['prepare:start:create']);unavailable=false;
rows=[];html=await render('/row-gated');assert.equal(requests.length,0);assert.deepEqual(trace,['query']);
"#).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let run = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
}

#[test]
fn fragments_refuse_foreign_missing_duplicate_nested_and_unsupported_source() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        (
            "foreign",
            SOURCE.replace("     label cap", "     label spent"),
        ),
        (
            "missing",
            SOURCE.replace("     validator cap", "     validator missing"),
        ),
        (
            "label-duplicate",
            SOURCE.replace("     label cap", "     label cap\n     label cap"),
        ),
        (
            "validator-duplicate",
            SOURCE.replace(
                "     validator cap",
                "     validator cap\n     validator cap",
            ),
        ),
        (
            "label-option",
            SOURCE.replace("     label cap", "     label cap size=lg"),
        ),
        (
            "validator-option",
            SOURCE.replace("     validator cap", "     validator cap caption=\"Bad\""),
        ),
        (
            "label-body",
            SOURCE.replace("     label cap", "     label cap\n      text \"Bad\""),
        ),
        (
            "validator-body",
            SOURCE.replace(
                "     validator cap",
                "     validator cap\n      text \"Bad\"",
            ),
        ),
        (
            "caption-type",
            SOURCE.replace("     label cap", "     label cap caption=1"),
        ),
        (
            "unowned",
            SOURCE.replace(
                "   form Allowance.create\n    input cap",
                "   label cap\n   form Allowance.create\n    input cap",
            ),
        ),
        (
            "nested-collection",
            SOURCE.replace(
                "     label cap",
                "     table Allowance columns=cap\n      label cap",
            ),
        ),
        (
            "bound-record",
            SOURCE.replace("     validator cap", "     validator record"),
        ),
        (
            "nested-path",
            SOURCE.replace("     label cap", "     label cap.value"),
        ),
        (
            "header-caption",
            SOURCE.replace("     label cap", "     label cap \"Bad\""),
        ),
    ] {
        let (output, response) = compile(&source, &scratch.path().join(format!("{name}.can")));
        assert!(
            !output.status.success(),
            "{name} unexpectedly accepted: {response}"
        );
        assert!(
            response["diagnostics"]
                .as_array()
                .is_some_and(|errors| !errors.is_empty()),
            "{name}: {response}"
        );
    }
}

#[test]
fn contextual_forms_bind_unique_ancestors_and_preserve_explicit_record_authority() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("context.can");
    let (output, artifact) = compile(
        r#"app ContextForms
Given
 Catalog {name:text}
 Entry in Catalog {title:text}
 Note in Entry {body:text}
 policy Catalog read=members
 policy Entry read=members
 policy Note read=members
When
 crud Catalog by=members fields=name
 crud Entry by=members fields=title
 crud Note by=members fields=body
 scenario attach(catalog:Catalog,entry:Entry,label:text) by=members
  do require true
Then
 page / title="Nested forms"
  list Catalog
   primary "Create Entry" action=Entry.create
   list row.Entry
    primary "Create Note" action=Note.create
    form Entry.create
    form attach arguments={entry=row}
 page /ambiguous title="Explicit parent"
  list Catalog as outer
   list Catalog as inner
    form Entry.create
    form Entry.create arguments={parent=outer}
 page /unbound title="No parent"
  form Entry.create
"#,
        &source,
    );
    assert!(output.status.success(), "{artifact}");
    std::fs::write(
        scratch.path().join("artifact.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    let runner = scratch.path().join("context.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=process.argv[2],base=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(root,'package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const {catalogFromArtifactOperations}=await load('@canlang/interfaces/http/operations');
const internal=name=>import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/'+name+'.js')));
const {buildPresentationContext}=await internal('presentation');
const {createSourceFormBindings}=await internal('form-binding');
const {createOperationFormPreparer}=await internal('forms');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'context.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,assembly,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const invoke=async(operation,inputs,operation_id=uuidv7(FIXED_NOW,++sequence))=>{
 const outcome=await invoker.invokeMutation({operation,operation_id,inputs},identity);
 assert('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');return outcome.result.records[0];
};
const ref=row=>({id:row.id,version:String(row.version)});
const catalogRow=await invoke('ContextForms.Catalog.create',{name:'Catalog'});
const otherCatalogRow=await invoke('ContextForms.Catalog.create',{name:'Other'});
const childRow=await invoke('ContextForms.Entry.create',{parent:ref(catalogRow),title:'Existing'});
const catalog=catalogFromArtifactOperations(artifact),clock={nowMs:()=>FIXED_NOW};
const service=await createSourceFormBindings(new Uint8Array(32).fill(97),'compiler-context-forms');
const appId='context-forms',sessionToken='context-session';
const queried=[],requests=[],ready=[];
const view=row=>({id:row.id,version:row.version,fields:row.data});
const context=buildPresentationContext({request:new Request('https://example.test/'),pathname:'/',isPartial:false,
 appDefaultLocale:'en',csrfToken:'csrf',principal:identity,catalog,clock,formBindings:service,appId,sessionToken,
 query:async(invocation,model,args)=>{
  assert.equal(invocation,context.invocation);queried.push(model);
  if(model==='ContextForms.Catalog')return {rows:[view(context.path==='/ambiguous'&&queried.length===2?otherCatalogRow:catalogRow)],columns:[]};
  assert.equal(model,'ContextForms.Entry');assert.equal(args.parent.id,catalogRow.id);
  assert.equal(args.parent.version,BigInt(catalogRow.version));return {rows:[view(childRow)],columns:[]};
 },
});
const prepare=createOperationFormPreparer(context,catalog,clock,{service,appId,sessionToken,identity});
context.prepareForm=async spec=>{requests.push(spec);const result=await prepare(spec);ready.push(result);return result;};
async function render(path){requests.length=0;ready.length=0;queried.length=0;context.path=path;
 return entry.appDefinition.pages.find(page=>page.path===path).render(context,{});}
let html=await render('/');
assert.deepEqual(queried,['ContextForms.Catalog','ContextForms.Entry'],'only authored queries run');
assert.deepEqual(requests.map(spec=>spec.operation),['ContextForms.Entry.create','ContextForms.Note.create','ContextForms.Entry.create','ContextForms.attach']);
assert.deepEqual(ready.map(form=>form.status),['ready','ready','ready','ready']);
assert(!html.includes('Operation form omits a required input.'));
for(const index of [0,2]){
 assert.equal(requests[index].arguments.parent.id,catalogRow.id,'Catalog survives bare row shadowing');
 assert.equal(requests[index].arguments.parent.version,BigInt(catalogRow.version));
 assert.deepEqual(requests[index].fields,['title']);
}
assert.equal(requests[1].arguments.parent.id,childRow.id);
assert.equal(requests[1].arguments.parent.version,BigInt(childRow.version));
assert.deepEqual(requests[1].fields,['body']);
assert.equal(requests[3].arguments.catalog.id,catalogRow.id);
assert.equal(requests[3].arguments.entry.id,childRow.id,'explicit argument remains authoritative');
assert.deepEqual(requests[3].fields,['label'],'bound records never become editable controls');
// Redeem the installed preparer's genuine protected refs, then invoke canonical
// CRUD. This exercises child creation without an inferred lookup or stale ID.
for(const [index,input,parent] of [[0,{title:'Created by form'},catalogRow],[1,{body:'Nested note'},childRow]]){
 const form=ready[index],spec=requests[index];assert.equal(typeof form.props.sourceBinding,'string');
 const restoreContext={appId,sessionToken,identity,derived:form.derived,
  operationId:form.props.operationId,nowMs:FIXED_NOW};
 assert.equal(await service.restore(restoreContext,form.props.sourceBinding,{...input,parent:ref(otherCatalogRow)}),null,'submitted parent cannot replace the protected binding');
 const restored=await service.restore(restoreContext,form.props.sourceBinding,input);
 assert(restored);assert.deepEqual(restored.parent,ref(parent));
 const created=await invoke(spec.operation,restored,form.props.operationId);
 assert.equal(created.parent.id,parent.id);assert.equal(created.parent.model,index===0?'ContextForms.Catalog':'ContextForms.Entry');assert.deepEqual(created.data,input);
}
// Optional-version parent linkage still enforces the rendered expected version
// at native admission; updating that parent must invalidate the old form.
await invoke('ContextForms.Catalog.update',{record:ref(catalogRow),name:'Updated'});
const stale=await invoker.invokeMutation({operation:'ContextForms.Entry.create',operation_id:uuidv7(FIXED_NOW,++sequence),
 inputs:{parent:ref(catalogRow),title:'Stale'}},identity);
assert('error' in stale);assert.equal(stale.error.code,'conflict');
html=await render('/ambiguous');
assert.deepEqual(queried,['ContextForms.Catalog','ContextForms.Catalog']);
assert.equal(requests[0].arguments,undefined,'two compatible lexical rows remain ambiguous');
assert.equal(ready[0].status,'unavailable');assert.equal(ready[0].message,'Operation form omits a required input.');
assert.equal(ready[1].status,'ready');assert.equal(requests[1].arguments.parent.id,catalogRow.id,'explicit outer overrides ambiguity');assert.notEqual(requests[1].arguments.parent.id,otherCatalogRow.id);
assert(html.includes('Operation form omits a required input.'));
await render('/unbound');assert.deepEqual(queried,[]);assert.equal(requests[0].arguments,undefined);
assert.equal(ready[0].status,'unavailable');assert.equal(ready[0].message,'Operation form omits a required input.');
"#).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
