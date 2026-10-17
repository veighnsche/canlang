import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root,artifactPath,scratch,profile]=process.argv.slice(2);
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile}=await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {invokeMutationCanonical,queryPageRowsCanonical}=await load('@canlang/cloudflare/runtime/invoke');
const {createTestDeps,createGrantFixture}=await load('@canlang/interfaces/testing');
const {resolveIdentity}=await load('@canlang/identity');
const {createMemoryStorage}=await load('@canlang/state/storage/memory');
const {uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const {encodeValue,datetime}=await load('@canlang/values');
const {collectionFilterName}=await load('@canlang/contracts');
const {catalogFromArtifactOperations}=await load('@canlang/interfaces/http/operations');
const {buildPresentationContext,buildPageSourceContext}=await import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/presentation.js')));
const {createSourceFormBindings}=await import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/form-binding.js')));
const input=loadArtifactFile(artifactPath),artifact=input.artifact;
const asm=await assembleModules(input,{workDir:resolve(scratch,'table-time-modules'),
  stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const generated=await importVerifiedAssemblyModule(asm,artifact.modules[0].path,artifact);
const page=generated.appDefinition.pages[0];assert.equal(page.path,'/table-time');
const {identity}=await createTestDeps({descriptors:[page]});
const {token}=await createGrantFixture(identity);
const principal=await resolveIdentity(identity.store,{mcp_grant_token:token});
const instant=Date.parse(principal.admitted_at);assert.ok(Number.isFinite(instant));
const canonicalNow=encodeValue('datetime',buildPageSourceContext(principal).now);
assert.match(canonicalNow,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
const store=createMemoryStorage();let sequence=0;
const nextId=()=>uuidv7(instant,++sequence);
const options={artifact,asm,app:'TableTime',identity:principal,source:'worker',store,
  memberships:identity.store,now:()=>instant};
const calendarId=nextId();
const calendar=await invokeMutationCanonical({...options,operation:'TableTime.Calendar.create',operationId:calendarId,inputs:{title:'Real admitted calendar'}});
assert.equal(calendar.status,'committed');
for(const [delta,state] of [[-60000,'closed'],[0,'open'],[60000,'open']]) {
  const from=new Date(instant+delta).toISOString();
  const seeded=await invokeMutationCanonical({...options,operation:'TableTime.Window.create',operationId:nextId(),
    inputs:{parent:{id:calendarId,version:'1'},from,until:from,state,available:true,rank:'1'}});
  assert.equal(seeded.status,'committed','genuine generated child CRUD creates real contained rows');
}
const catalog=catalogFromArtifactOperations(artifact);
const formBindings=await createSourceFormBindings(new Uint8Array(32).fill(43),'table-time-fixture');
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
const decode=value=>value.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const refusal=new Error('original row preparer refused');
async function render({url='https://example.test/table-time?retained=yes',preference,failForm=false,sourceOverride=false,trace=[]}={}) {
  const queries=[],preparations=[];
  const source={...buildPageSourceContext(principal),...(preference===undefined?{}:{preferences:{TableTime:{window_state:preference}},preferenceVersions:{TableTime:{window_state:'2'}}}),
    ...(sourceOverride?{now:datetime('0001-01-01T00:00:00.000Z')}:{})};
  const context=buildPresentationContext({request:new Request(url),pathname:'/table-time',isPartial:true,
    appDefaultLocale:'en',csrfToken:'',principal,source,catalog,formBindings,appId:'TableTime',
    sessionToken:'table-time-session',clock:{nowMs:()=>instant+86400000},
    query:async(invocation,model,args)=>{
      assert.equal(invocation,principal);trace.push(`query:${model}`);
      if(model==='TableTime.Window') {
        assert.equal(args.parent,undefined,'original Upcoming/Past selects the model domain directly');
        assert.equal(args.page,undefined,'time cursor profile remains unpaged');
        assert.match(args.occurrence,/^can-collection-f\d+-s\d+-/);
        const predicates=args.where.op==='and'?args.where.args:[args.where];
        const time=predicates.find(predicate=>predicate.field==='from');assert.ok(time);
        assert.ok(time.op==='gte'||time.op==='lt');assert.equal(time.value,canonicalNow);
        assert.equal(typeof time.value,'string');assert.notEqual(time.value,'0001-01-01T00:00:00.000Z');
        assert.deepEqual(args.order,time.op==='gte'?['from']:['-from']);
      }
      const query={model,args};queries.push(query);
      const result=await queryPageRowsCanonical({...options,model,args});
      query.result=result;return result;
    }});
  assert.equal(encodeValue('datetime',context.now),canonicalNow,'identity admission wins over source override and preparer clock');
  const rendering={...context,prepareForm:request=>{trace.push(`prepare:${request.operation}`);preparations.push(request);
    if(failForm)throw refusal;return context.prepareForm(request);}};
  const bindings=await page.admit(rendering);
  const html=await page.render(rendering,bindings);
  return {html,context,queries:queries.filter(query=>query.model==='TableTime.Window'),preparations};
}
const first=await render({sourceOverride:true});
if(profile==='gated') {
  assert.equal(first.queries.length,1,'authored false gate omits upcoming time predicate/query and protected body');
  assert.deepEqual(first.queries[0].args.where,{op:'lt',field:'from',value:canonicalNow});
  assert.equal(first.preparations.length,0);
  console.log('table-time authored gate: no upcoming query or row preparation');
} else {
  assert.equal(first.queries.length,2);
  const upcoming=first.queries.find(query=>query.args.where.op==='gte');
  const past=first.queries.find(query=>query.args.where.op==='lt');assert.ok(upcoming&&past);
  assert.equal(upcoming.result.rows.length,2);assert.equal(past.result.rows.length,1);
  assert.equal(upcoming.result.rows[0].fields.from,canonicalNow,'gte includes exact admitted boundary');
  assert.ok(upcoming.result.rows.every(row=>Date.parse(row.fields.from)>=instant));
  assert.ok(past.result.rows.every(row=>Date.parse(row.fields.from)<instant));
  const occurrences=first.queries.map(query=>query.args.occurrence);assert.equal(new Set(occurrences).size,2);
  const defaults=await render({preference:'open'});
  for(const query of defaults.queries) {
    assert.equal(query.args.where.op,'and');assert.deepEqual(query.args.where.args[1],{op:'eq',field:'state',value:'open'});
  }
  assert.equal(defaults.queries.find(query=>query.args.where.args[0].op==='lt').result.rows.length,0);
  const upcomingIndex=first.queries.indexOf(upcoming);
  const filterUrl=new URL('https://example.test/table-time?retained=yes');
  filterUrl.searchParams.set(collectionFilterName(occurrences[upcomingIndex],'state'),'');
  const cleared=await render({url:filterUrl.href,preference:'open'});
  assert.deepEqual(cleared.queries[upcomingIndex].args.where,{op:'gte',field:'from',value:canonicalNow});
  const selection=[...first.html.matchAll(/<a\b[^>]*>/g)].map(match=>attrs(match[0]).href).filter(Boolean)
    .map(href=>new URL(decode(href),'https://example.test/table-time'))
    .find(url=>[...url.searchParams].some(([key,value])=>key===`can-row:${upcoming.args.occurrence}`&&value===upcoming.result.rows[0].id));assert.ok(selection);
  const selected=await render({url:selection.href});
  assert.deepEqual(selected.preparations.map(request=>request.fields),[['available'],['rank']]);
  const own=upcoming.result.rows[0];assert.ok(selected.preparations.every(request=>request.arguments.record.id===own.id&&request.arguments.record.version===BigInt(own.version)));
  const forms=[...selected.html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match=>match[0]).filter(form=>attrs(form.split('>')[0]).method==='post');assert.equal(forms.length,2);
  for(const form of forms) {
    const seal=[...form.matchAll(/<input\b[^>]*>/g)].map(match=>attrs(match[0])).find(input=>input.name==='form_binding');assert.ok(seal);
    const claims=JSON.parse(Buffer.from(decode(seal.value).split('.')[0],'base64url').toString('utf8'));
    assert.deepEqual(claims.bound,{record:{id:own.id,version:own.version}});
  }
  const failed=[];await assert.rejects(render({url:selection.href,failForm:true,trace:failed}),error=>error===refusal);
  assert.deepEqual(failed.filter(item=>item.startsWith('prepare:')),['prepare:TableTime.Window.update']);
  assert.deepEqual(selected.queries.map(query=>query.args.occurrence),occurrences);
  console.log('table time: original CLI/verified modules, actual Identity/Memory query, canonical gte/lt/default/clear, protected row and first failure passed');
}
