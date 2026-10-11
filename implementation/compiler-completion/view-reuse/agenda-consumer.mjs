import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root, artifactPath, scratch] = process.argv.slice(2);
registerHooks({resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(candidate)) return {url:candidate.href, shortCircuit:true};
  }
  return next(specifier, context);
}});
const load = path => import(pathToFileURL(resolve(root, path)));
const {loadArtifactFile} = await load('packages/cloudflare/src/runtime/artifact.ts');
const {assembleModules} = await load('packages/cloudflare/src/runtime/modules.ts');
const {buildPresentationContext, buildPageSourceContext} = await load('packages/interfaces/dist/src/http/presentation.js');
const {createSourceFormBindings} = await load('packages/interfaces/dist/src/http/form-binding.js');
const {catalogFromArtifactOperations} = await import('@canlang/interfaces/http/operations');
const {makeIdentity, FIXED_NOW, uuidv7} = await import('@canlang/state/testing/invocation/fixtures');
const uiUrl = import.meta.resolve('@canlang/ui');
const ui = await import(uiUrl);
const loaded = loadArtifactFile(artifactPath);
const assembly = await assembleModules(loaded, {
  workDir:resolve(scratch, 'agenda-modules'),
  stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl,
});
const generated = await import(assembly.entryUrl);
const page = generated.appDefinition.pages[0];
const cases = ['pending','confirmed','cancelled','attended','no_show','unavailable'];
assert.equal(page.path, '/agenda');
assert.deepEqual(page.preferenceFields, [{name:'appointment_state',options:cases,defaultValue:null,nullable:true}],
  'actual page descriptor preserves the receiving nullable owned enum and implicit null');
const catalog = catalogFromArtifactOperations(loaded.artifact);
const identity = makeIdentity({actor:null, team:null, membership:null});
const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(87), 'agenda-fixture');
const rows = [
  {id:uuidv7(FIXED_NOW, 31),version:'3',fields:{from:'2030-01-03T10:00:00Z',until:'2030-01-03T10:30:00Z',state:'pending',host_ok:true,room_ok:false,duration:1800000n,reason:'Later <visit>'}},
  {id:uuidv7(FIXED_NOW, 32),version:'4',fields:{from:'2030-01-02T10:00:00Z',until:'2030-01-02T10:30:00Z',state:'confirmed',host_ok:false,room_ok:true,duration:1800000n,reason:'Earlier <visit>'}},
];
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
const decode = value => value.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const columns = Object.entries(generated.appDefinition.models['AgendaWorkflow.Visit'].fields)
  .map(([field, declaration])=>({field,label:field,type:declaration.type}));
const refusal = new Error('owning current row query refused');
async function render({url='https://example.test/agenda?retained=yes', preference, empty=false, deny=false,
  missingEndpoint=false, protection=true, version=true, failForm=false, trace=[], locale='fr'}={}) {
  const queries = [];
  const formCalls = [];
  const source = {...buildPageSourceContext(identity), ...(preference === undefined ? {} : {
    preferences:{AgendaWorkflow:{appointment_state:preference}},
    preferenceVersions:{AgendaWorkflow:{appointment_state:'7'}},
  })};
  const context = buildPresentationContext({
    request:new Request(url,{headers:{'Accept-Language':locale}}), pathname:'/agenda', isPartial:true,
    appDefaultLocale:'en',csrfToken:'',principal:identity,source,catalog,
    ...(protection ? {formBindings} : {}),appId:'AgendaWorkflow',sessionToken:'agenda-session',clock:{nowMs:()=>FIXED_NOW},
    query:async (invocation,model,args)=>{
      assert.equal(invocation,identity,'actual query retains the dispatcher identity');
      assert.equal(model,'AgendaWorkflow.Visit','no hidden model/field refetch');
      assert.equal(args.parent,undefined,'original agenda has no parent binding');
      assert.equal(args.page,true);
      assert.match(args.occurrence,/^can-collection-f\d+-s\d+-/);
      queries.push({model,args}); trace.push('query');
      if (deny) throw refusal;
      return {rows:empty?[]:rows.map((row,index)=>({id:row.id,...(version?{version:row.version}:{}),fields:
        missingEndpoint && index===1 ? Object.fromEntries(Object.entries(row.fields).filter(([name])=>name!=='until')):row.fields})),columns};
    },
  });
  const renderingContext = {...context,prepareForm:request=>{
    trace.push(request.operation); formCalls.push(request);
    if(failForm) throw refusal;
    return context.prepareForm(request);
  }};
  const bindings = await page.admit(renderingContext);
  assert.equal(bindings.preferences.AgendaWorkflow.appointment_state,preference??null);
  const html = await page.render(renderingContext,bindings);
  return {html,context,queries,formCalls};
}
const first = await render();
assert.equal(first.queries.length,2);
const occurrences=first.queries.map(item=>item.args.occurrence);
assert.equal(new Set(occurrences).size,2,'two authored calendars have distinct occurrences');
assert.ok(first.queries.every(item=>item.args.where===undefined),'null initial default omits a predicate');
assert.ok(first.html.includes('Later &lt;visit&gt;') && first.html.includes('Earlier &lt;visit&gt;'));
assert.ok(!first.html.includes('<visit>'),'actual authored text is escaped');
assert.ok(first.html.indexOf('Earlier &lt;visit&gt;')<first.html.indexOf('Later &lt;visit&gt;'),
  'chronological display may regroup while preparation keeps actual query order');
assert.deepEqual(first.formCalls.map(call=>[call.operation,call.arguments.appointment.id]),[
  ['AgendaWorkflow.attendance',rows[0].id],['AgendaWorkflow.cancel',rows[0].id],
  ['AgendaWorkflow.attendance',rows[1].id],['AgendaWorkflow.cancel',rows[1].id],
]);
const forms=[...first.html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match=>match[0]);
const operationForms=forms.filter(form=>attributes(form.split('>')[0]).method==='post');
assert.equal(operationForms.length,4);
const controlIds=[];
for(const form of operationForms){
  const attrs=attributes(form.split('>')[0]);
  const meta=JSON.parse(decode(attrs['data-can-generated-form']));
  const inputs=[...form.matchAll(/<input\b[^>]*>/g)].map(match=>attributes(match[0]));
  const token=inputs.find(input=>input.name==='form_binding');
  assert.ok(token,'native protected form has its real source-binding seal');
  const claims=JSON.parse(Buffer.from(decode(token.value).split('.')[0],'base64url').toString('utf8'));
  const bound=claims.bound.appointment;
  const row=rows.find(row=>row.id===bound.id);
  assert.ok(row);
  assert.deepEqual(bound,{id:row.id,version:row.version});
  assert.ok(!inputs.some(input=>input.name===ui.fieldInputName('scenario','appointment')));
  if(meta.derived.operation==='AgendaWorkflow.attendance'){
    assert.deepEqual(meta.renderedInputs,['attend','reason']);
    const attend=inputs.filter(input=>input.name===ui.fieldInputName('scenario','attend'));
    assert.equal(attend.length,1); assert.equal(attend[0].type,'checkbox');
    const reason=[...form.matchAll(/<textarea\b[^>]*>/g)].map(match=>attributes(match[0]))
      .filter(input=>input.name===ui.fieldInputName('scenario','reason'));
    assert.equal(reason.length,1);
    assert.ok(form.indexOf(`id="${attend[0].id}"`)<form.indexOf(`id="${reason[0].id}"`));
    assert.ok(form.includes('Attendance reason') && form.includes('Attendance'));
    controlIds.push(attend[0].id,reason[0].id);
  }
}
assert.equal(new Set(controlIds).size,4,'distinct rows keep distinct native controls');
const {collectionFilterName}=await import('@canlang/contracts');
const filterName=occurrence=>collectionFilterName(occurrence,'state');
const urlFor=(occurrence,value)=>{
  const url=new URL('https://example.test/agenda?retained=yes');
  url.searchParams.set(filterName(occurrence),value);return url;
};
const defaulted=await render({preference:'confirmed'});
assert.deepEqual(defaulted.queries.map(item=>item.args.where),[
  {op:'eq',field:'state',value:'confirmed'},{op:'eq',field:'state',value:'confirmed'},
]);
const selected=await render({url:urlFor(occurrences[0],'cancelled').href,preference:'confirmed'});
assert.deepEqual(selected.queries.map(item=>item.args.where),[
  {op:'eq',field:'state',value:'cancelled'},{op:'eq',field:'state',value:'confirmed'},
]);
const cleared=await render({url:urlFor(occurrences[0],'').href,preference:'confirmed'});
assert.equal(cleared.queries[0].args.where,undefined,'present empty clears rather than is_null or saved default');
assert.deepEqual(cleared.queries[1].args.where,{op:'eq',field:'state',value:'confirmed'});
assert.equal(cleared.context.preferences.AgendaWorkflow.appointment_state,'confirmed','view clear does not save null');
assert.equal(selected.context.pollUrl,new URL(urlFor(occurrences[0],'cancelled')).pathname+new URL(urlFor(occurrences[0],'cancelled')).search);
assert.ok(selected.context.pollContext.includes('retained=yes'),'complete query remains in polling identity');
const dutch=await render({locale:'nl'});
assert.deepEqual(dutch.queries.map(item=>item.args.occurrence),occurrences,'rerender preserves source occurrences');
assert.deepEqual(dutch.formCalls.map(call=>call.occurrence),first.formCalls.map(call=>call.occurrence));
for(const options of [{protection:false},{version:false}]){
  const withheld=await render(options);
  assert.ok(!withheld.html.includes('name="form_binding"'),'unavailable protection/version cannot publish protected row forms');
}
for(const options of [{deny:true},{missingEndpoint:true},{failForm:true}]){
  const trace=[];
  await assert.rejects(render({...options,trace}),error=>options.missingEndpoint ? /missing projected field/.test(error.message):error===refusal);
  assert.deepEqual(trace,options.failForm?['query','query','AgendaWorkflow.attendance']:['query','query'],
    'first owning row refusal prevents later form/row preparation in its collection');
}
for(const mutate of [
  url=>url.searchParams.set(filterName(occurrences[0]),'foreign'),
  url=>{url.searchParams.append(filterName(occurrences[0]),'pending');url.searchParams.append(filterName(occurrences[0]),'confirmed');},
  url=>url.searchParams.set('can-filter:'+encodeURIComponent(occurrences[0])+':unknown','pending'),
]){
  const url=new URL('https://example.test/agenda');mutate(url);const trace=[];
  await assert.rejects(render({url:url.href,trace}));
  assert.deepEqual(trace,['query'],'invalid own-occurrence state refuses before its query/body; independent sibling keeps its own scope');
}
const empty=await render({empty:true});
assert.equal(empty.formCalls.length,0,'empty query never prepares row body');
assert.ok(empty.html.includes('No records.'));
console.log(JSON.stringify({consumer:'real CLI → verified modules → installed agenda/Interfaces/prepared forms',
  checkedNullableEnumDescriptor:true,initialNullOmitsPredicate:true,ownOccurrenceSelectionAndClear:true,
  completePollQuery:true,queryOrderBeforeChronologicalDisplay:true,protectedCompleteRowForms:true,
  distinctStableOccurrences:true,emptyAndUnavailableProtection:true,firstFailureStopsLaterWork:true,
  noHiddenFieldRefetch:true}));
