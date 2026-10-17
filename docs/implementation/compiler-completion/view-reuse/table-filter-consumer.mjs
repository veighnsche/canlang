import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root,artifactPath,scratch]=process.argv.slice(2);
const require=createRequire(resolve(root,'package.json'));
const load=path=>import(pathToFileURL(resolve(root,path)));
const {loadArtifactFile}=require('@canlang/cloudflare/runtime/artifact');
const {assembleModules,importVerifiedAssemblyModule}=require('@canlang/cloudflare/runtime/modules');
const {buildPresentationContext,buildPageSourceContext}=await load('packages/interfaces/dist/src/http/presentation.js');
const {createSourceFormBindings}=await load('packages/interfaces/dist/src/http/form-binding.js');
const {catalogFromArtifactOperations}=require('@canlang/interfaces/http/operations');
const {makeIdentity,FIXED_NOW,uuidv7}=require('@canlang/state/testing/invocation/fixtures');
const {collectionFilterName}=require('@canlang/contracts');
const loaded=loadArtifactFile(artifactPath);
const assembly=await assembleModules(loaded,{workDir:resolve(scratch,'table-filter-modules'),
  stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const entry=Object.entries(assembly.moduleUrls).find(([,url])=>url===assembly.entryUrl)?.[0];assert.ok(entry);
const generated=await importVerifiedAssemblyModule(assembly,entry,loaded.artifact);
const page=generated.appDefinition.pages[0];
assert.equal(page.path,'/table-filters');
assert.deepEqual(page.preferenceFields,[{name:'window_state',options:['open','closed'],defaultValue:null,nullable:true,
  optionLabels:{open:{source:'Open <window>',variants:{nl:'Open venster'},sourceLocale:'en'},
    closed:{source:'Closed window',variants:{nl:'Gesloten venster'},sourceLocale:'en'}}}]);
const identity=makeIdentity({actor:null,team:null,membership:null});
const catalog=catalogFromArtifactOperations(loaded.artifact);
const formBindings=await createSourceFormBindings(new Uint8Array(32).fill(49),'table-filter-fixture');
const calendar={id:uuidv7(FIXED_NOW,201),version:'3',fields:{title:'Owning <calendar>'}};
const window={id:uuidv7(FIXED_NOW,202),version:'5',fields:{from:'2030-01-02T10:00:00.000Z',until:'2030-01-02T11:00:00.000Z',state:'open',available:true,rank:'7'}};
const columns=Object.entries(generated.appDefinition.models['TableFilters.Window'].fields).map(([field,declaration])=>({
  field,type:declaration.type,label:declaration.label?.text??declaration.label??field,
  ...(declaration.label?.values===undefined?{}:{valueLabels:declaration.label.values}),
}));
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
const decode=value=>value.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const refusal=new Error('owning table body preparation refused');
async function render({url='https://example.test/table-filters?retained=yes',preference,empty=false,
  missingField=false,missingMeta=false,failForm=false,locale='en',trace=[]}={}) {
  const queries=[],preparations=[];
  const source={...buildPageSourceContext(identity),...(preference===undefined?{}:{
    preferences:{TableFilters:{window_state:preference}},preferenceVersions:{TableFilters:{window_state:'7'}},
  })};
  const context=buildPresentationContext({request:new Request(url,{headers:{'Accept-Language':locale}}),
    pathname:'/table-filters',isPartial:true,appDefaultLocale:'en',csrfToken:'',principal:identity,source,
    catalog,formBindings,appId:'TableFilters',sessionToken:'table-filter-session',clock:{nowMs:()=>FIXED_NOW},
    query:async(invocation,model,args)=>{
      assert.equal(invocation,identity);trace.push(`query:${model}`);queries.push({model,args});
      if(model==='TableFilters.Calendar') return {rows:[calendar],columns:[{field:'title',type:'text',label:'title'}]};
      assert.equal(model,'TableFilters.Window');assert.equal(args.parent.id,calendar.id);assert.equal(args.parent.version,3n);
      assert.equal(args.page,true);assert.match(args.occurrence,/^can-collection-f\d+-s\d+-/);
      const index=queries.filter(query=>query.model==='TableFilters.Window').length-1;
      assert.deepEqual(args.order,index===0?['from']:['-from']);
      const first=index===0;
      return {rows:empty?[]:[missingField&&first?{...window,fields:Object.fromEntries(Object.entries(window.fields).filter(([name])=>name!=='state'))}:window],
        columns:empty?[]:missingMeta&&first?columns.filter(column=>column.field!=='state'):columns,
        ...(empty?{emptyDeclarations:columns.map(({field,type})=>({field,type}))}:{}),
      };
    }});
  const renderingContext={...context,prepareForm:request=>{
    trace.push(`prepare:${request.operation}`);preparations.push(request);
    if(failForm) throw refusal;
    return context.prepareForm(request);
  }};
  const bindings=await page.admit(renderingContext);
  assert.equal(bindings.preferences.TableFilters.window_state,preference??null);
  const html=await page.render(renderingContext,bindings);
  return {html,queries:queries.filter(query=>query.model==='TableFilters.Window'),preparations,context};
}
const initial=await render();
assert.equal(initial.queries.length,2);assert.ok(initial.queries.every(query=>query.args.where===undefined));
const occurrences=initial.queries.map(query=>query.args.occurrence);assert.equal(new Set(occurrences).size,2);
assert.equal(initial.preparations.length,0,'unselected split row has no protected body evaluation');
assert.ok(initial.html.includes('Open &lt;window&gt;')&&!initial.html.includes('Open <window>'));
const selects=[...initial.html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].map(match=>match[0]);
assert.equal(selects.length,2);
for(const select of selects) assert.deepEqual([...select.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map(match=>match[1]),['','open','closed']);
const filterName=index=>collectionFilterName(occurrences[index],'state');
const urlFor=(index,value)=>{const url=new URL('https://example.test/table-filters?retained=yes');url.searchParams.set(filterName(index),value);return url;};
const defaulted=await render({preference:'open'});
assert.deepEqual(defaulted.queries.map(query=>query.args.where),[{op:'eq',field:'state',value:'open'},{op:'eq',field:'state',value:'open'}]);
const chosen=await render({url:urlFor(0,'closed').href,preference:'open'});
assert.deepEqual(chosen.queries.map(query=>query.args.where),[{op:'eq',field:'state',value:'closed'},{op:'eq',field:'state',value:'open'}]);
const clear=await render({url:urlFor(0,'').href,preference:'open'});
assert.equal(clear.queries[0].args.where,undefined);assert.deepEqual(clear.queries[1].args.where,{op:'eq',field:'state',value:'open'});
assert.equal(clear.context.preferences.TableFilters.window_state,'open','view clear does not save preference null');
assert.equal(chosen.context.pollUrl,urlFor(0,'closed').pathname+urlFor(0,'closed').search);
assert.ok(chosen.context.pollContext.includes('retained=yes'));
const dutch=await render({locale:'nl'});assert.ok(dutch.html.includes('Open venster')&&dutch.html.includes('Gesloten venster'));
assert.deepEqual(dutch.queries.map(query=>query.args.occurrence),occurrences);
const selection=[...initial.html.matchAll(/<a\b[^>]*>/g)].map(match=>attrs(match[0]).href).filter(Boolean)
  .map(href=>new URL(decode(href),'https://example.test/table-filters'))
  .find(url=>[...url.searchParams].some(([key,value])=>key.startsWith('can-row:')&&value===window.id));assert.ok(selection);
const selected=await render({url:selection.href});
assert.deepEqual(selected.preparations.map(request=>request.fields),[['available'],['rank']]);
assert.ok(selected.preparations.every(request=>request.arguments.record.id===window.id&&request.arguments.record.version===5n));
assert.equal(new Set(selected.preparations.map(request=>request.occurrence)).size,2,'authored form sites execute once in order');
const postForms=[...selected.html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match=>match[0])
  .filter(form=>attrs(form.split('>')[0]).method==='post');assert.equal(postForms.length,2);
for(const form of postForms) {
  const seal=[...form.matchAll(/<input\b[^>]*>/g)].map(match=>attrs(match[0])).find(input=>input.name==='form_binding');assert.ok(seal);
  const claims=JSON.parse(Buffer.from(decode(seal.value).split('.')[0],'base64url').toString('utf8'));
  assert.deepEqual(claims.bound,{record:{id:window.id,version:'5'}});
}
for(const options of [{failForm:true},{missingField:true},{missingMeta:true}]) {
  const trace=[];await assert.rejects(render({...options,url:selection.href,trace}),error=>options.failForm?error===refusal:/missing (projected filter|authorized filter) field/.test(error.message));
  assert.deepEqual(trace.filter(item=>item.startsWith('prepare:')),options.failForm?['prepare:TableFilters.Window.update']:[],
    'filter/projection admission precedes body, first failed preparer stops later sibling');
}
for(const mutate of [
  url=>url.searchParams.set(filterName(0),'foreign'),
  url=>{url.searchParams.append(filterName(0),'open');url.searchParams.append(filterName(0),'closed');},
  url=>url.searchParams.set(`can-filter:${encodeURIComponent(occurrences[0])}:unknown`,'open'),
]) {
  const url=new URL('https://example.test/table-filters');mutate(url);const trace=[];
  await assert.rejects(render({url:url.href,trace}));
  assert.equal(trace.filter(item=>item==='query:TableFilters.Window').length,1,'malformed own selection refuses before its query while sibling keeps its scope');
  assert.equal(trace.filter(item=>item.startsWith('prepare:')).length,0);
}
const empty=await render({empty:true,preference:'open'});
assert.equal(empty.preparations.length,0);assert.ok(!empty.html.includes('<select')&&!empty.html.includes('<option'));
assert.equal([...empty.html.matchAll(/data-can-table-filters/g)].length,2,'no-row state emits only accepted clear affordances');
assert.ok(empty.html.includes('value=""')&&empty.html.includes('No records.'));
console.log('table filters: exact enum/default/null/clear/occurrence/parent/order/poll and protected row/first refusal passed');
