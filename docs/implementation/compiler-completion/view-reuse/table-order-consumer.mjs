import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root, artifactPath, scratch] = process.argv.slice(2);
const require = createRequire(resolve(root,'package.json'));
const load = path => import(pathToFileURL(resolve(root, path)));
const {loadArtifactFile} = require('@canlang/cloudflare/runtime/artifact');
const {assembleModules, importVerifiedAssemblyModule} = require('@canlang/cloudflare/runtime/modules');
const {buildPresentationContext} = await load('packages/interfaces/dist/src/http/presentation.js');
const {createSourceFormBindings} = await load('packages/interfaces/dist/src/http/form-binding.js');
const {catalogFromArtifactOperations} = await import('@canlang/interfaces/http/operations');
const {makeIdentity, FIXED_NOW, uuidv7} = await import('@canlang/state/testing/invocation/fixtures');
const loaded = loadArtifactFile(artifactPath);
const assembly = await assembleModules(loaded, {workDir:resolve(scratch,'table-modules'),
  stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href, uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const entry = Object.entries(assembly.moduleUrls).find(([,url])=>url===assembly.entryUrl)?.[0];
assert.ok(entry);
const generated = await importVerifiedAssemblyModule(assembly,entry,loaded.artifact);
const page = generated.appDefinition.pages[0];
assert.equal(page.path,'/windows');
const catalog = catalogFromArtifactOperations(loaded.artifact);
const identity = makeIdentity({actor:null,team:null,membership:null});
const protection = await createSourceFormBindings(new Uint8Array(32).fill(58),'table-order-fixture');
const calendar = {id:uuidv7(FIXED_NOW,101),version:'3',fields:{title:'Owning <calendar>'}};
const window = {id:uuidv7(FIXED_NOW,102),version:'5',fields:{from:'2030-01-02T10:00:00.000Z',until:'2030-01-02T11:00:00.000Z',available:true,rank:'7',day:'2030-01-02',state:'open'}};
const columns = Object.entries(generated.appDefinition.models['TableOrder.Window'].fields)
  .map(([field,declaration])=>({field,label:field,type:declaration.type}));
const expectedOrders = [['from'],['-from','rank','day'],['rank','-day']];
const attrs = tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
const decode = value=>value.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const refusal = new Error('owning table preparation refused');
async function render({url='https://example.test/windows?retained=yes',missingColumn=false,failForm=false,trace=[]}={}) {
  const queries=[], preparations=[];
  const context=buildPresentationContext({request:new Request(url),pathname:'/windows',isPartial:true,
    appDefaultLocale:'en',csrfToken:'',principal:identity,catalog,formBindings:protection,
    appId:'TableOrder',sessionToken:'table-session',clock:{nowMs:()=>FIXED_NOW},
    query:async(invocation,model,args)=>{
      assert.equal(invocation,identity);
      queries.push({model,args}); trace.push(`query:${model}`);
      if(model==='TableOrder.Calendar') {
        assert.equal(args.parent,undefined);
        return {rows:[calendar],columns:[{field:'title',label:'title',type:'text'}]};
      }
      assert.equal(model,'TableOrder.Window');
      assert.equal(args.parent.id,calendar.id);
      assert.equal(args.parent.version,3n,'nested query keeps the source row version');
      const index=queries.filter(query=>query.model==='TableOrder.Window').length-1;
      assert.deepEqual(args.order,expectedOrders[index],'query receives authored signed field-relative selectors in order');
      assert.equal(args.where,undefined); assert.equal(args.search,undefined);
      if(index<2) {
        assert.equal(args.page,true);
        assert.match(args.occurrence,/^can-collection-f\d+-s\d+-/);
      } else assert.equal(args.page,undefined);
      return {rows:[window],columns:missingColumn&&index===1?columns.filter(column=>column.field!=='day'):columns};
    }});
  const renderingContext={...context,prepareForm:request=>{
    preparations.push(request);trace.push(`prepare:${request.operation}`);
    if(failForm) throw refusal;
    return context.prepareForm(request);
  }};
  const bindings=await page.admit(renderingContext);
  const html=await page.render(renderingContext,bindings);
  return {queries,preparations,html,context};
}
const plain=await render();
assert.deepEqual(plain.queries.map(query=>query.model),['TableOrder.Calendar','TableOrder.Window','TableOrder.Window','TableOrder.Window']);
assert.equal(plain.preparations.length,0,'unselected split row never prepares forms');
assert.ok(plain.html.includes('Owning &lt;calendar&gt;'));
const selection=[...plain.html.matchAll(/<a\b[^>]*>/g)].map(match=>attrs(match[0]).href).filter(Boolean)
  .map(href=>new URL(decode(href),'https://example.test/windows'))
  .find(url=>[...url.searchParams].some(([key,value])=>key.startsWith('can-row:')&&value===window.id));
assert.ok(selection,'actual installed table produces its selection URL');
const selected=await render({url:selection.href});
assert.deepEqual(selected.queries.map(query=>query.args.order),plain.queries.map(query=>query.args.order));
assert.deepEqual(selected.queries.map(query=>query.args.occurrence),plain.queries.map(query=>query.args.occurrence));
assert.deepEqual(selected.preparations.map(request=>request.fields),[['available'],['rank']]);
assert.ok(selected.preparations.every(request=>request.operation==='TableOrder.Window.update'));
assert.ok(selected.preparations.every(request=>request.arguments.record.id===window.id&&request.arguments.record.version===5n));
const forms=[...selected.html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match=>match[0]);
assert.equal(forms.length,2);
for(const form of forms) {
  const inputs=[...form.matchAll(/<input\b[^>]*>/g)].map(match=>attrs(match[0]));
  const seal=inputs.find(input=>input.name==='form_binding'); assert.ok(seal);
  const claims=JSON.parse(Buffer.from(decode(seal.value).split('.')[0],'base64url').toString('utf8'));
  assert.deepEqual(claims.bound,{record:{id:window.id,version:'5'}},'actual protected form binds original row/version');
}
const failed=[];
await assert.rejects(render({url:selection.href,failForm:true,trace:failed}),error=>error===refusal);
assert.deepEqual(failed.filter(item=>item.startsWith('prepare:')),['prepare:TableOrder.Window.update'],
  'first owning preparation failure prevents the later authored sibling from executing');
const missing=[];
await assert.rejects(render({url:selection.href,missingColumn:true,trace:missing}),/missing columns: day/);
assert.equal(missing.filter(item=>item.startsWith('prepare:')).length,0,'column admission precedes protected body evaluation');
console.log('table order: authored selectors, parent/page, protected row/version and first preparation refusal passed');
