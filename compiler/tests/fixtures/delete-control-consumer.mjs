import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const [root,artifactPath,scratch]=process.argv.slice(2);
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {queryPageRowsCanonical}=await load('@canlang/cloudflare/runtime/invoke');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const {buildPresentationContext}=await load('@canlang/interfaces');
const artifact=JSON.parse(readFileSync(artifactPath,'utf8'));
// Observe the generated DeleteProps, then delegate to the actual UI renderer.
const uiUrl=pathToFileURL(require.resolve('@canlang/ui')).href;
const observer=resolve(scratch,'observed-ui.mjs');
writeFileSync(observer,`export * from ${JSON.stringify(uiUrl)};
import {deleteRecord as nativeDelete,text as nativeText} from ${JSON.stringify(uiUrl)};
export async function deleteRecord(props){globalThis.deleteControls.push(props.record);return nativeDelete(props);}
export function text(props){globalThis.deleteTextValues.push(props.values);return nativeText(props);}`);
const asm=await assembleModules({artifact,sourcePath:resolve(scratch,'delete-control.can')},{
 workDir:resolve(scratch,'modules'),uiUrl:pathToFileURL(observer).href,
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const mutate=(operation,inputs)=>invoker.invokeMutation({operation,operation_id:uuidv7(FIXED_NOW,++sequence),inputs},identity);
const committed=outcome=>{assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');return outcome.result.result;};
const model='DeleteControl.Item',operation=model+'.delete';
committed(await mutate(model+'.create',{title:'One',enabled:true}));
const currentRows=()=>queryPageRowsCanonical({asm,artifact,model,args:{},identity,store,memberships});
const born=(await currentRows()).rows[0];assert.ok(born);
const reference=artifact.pages[0],entry=await import(asm.moduleUrls[reference.module]),page=entry[reference.export];
let queries=0,synthetic;
const controls=[],textValues=[];globalThis.deleteControls=controls;globalThis.deleteTextValues=textValues;
const context=buildPresentationContext({request:new Request('https://example.test/'),pathname:'/',isPartial:false,
 appDefaultLocale:'en',csrfToken:'test-csrf',principal:identity,
 query:async(invocation,selectedModel,args)=>{queries++;assert.equal(invocation,identity);assert.equal(selectedModel,model);
  return synthetic===undefined?queryPageRowsCanonical({asm,artifact,model,args,identity:invocation,store,memberships}):{rows:[synthetic]};},
});
const render=async()=>page.render(context,await page.admit(context));
const hidden=(html,name)=>{const match=html.match(new RegExp(`name="${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}" value="([^"]*)"`));assert.ok(match,name);return match[1];};
const html=await render();
assert.equal(queries,1,'one authorized collection read');
assert.deepEqual(controls,[{id:born.id,version:String(born.version)}]);
assert.deepEqual(textValues.at(-1),[BigInt(born.version)+1n],'source version arithmetic remains native');
const wire={id:hidden(html,'inputs[record][id]'),version:hidden(html,'inputs[record][version]')};
assert.deepEqual(wire,{id:born.id,version:String(born.version)});
// Submit the exact protected form identity through actual canonical admission.
committed(await mutate(operation,{record:wire}));
const stale=await mutate(operation,{record:wire});assert.ok('error' in stale);assert.equal(stale.error.code,'conflict');
committed(await mutate(model+'.create',{title:'Two',enabled:true}));
const another=(await currentRows()).rows[0];assert.ok(another);
await memberships.removeMembership(member.membership.membership_id);
const denied=await mutate(operation,{record:{id:another.id,version:String(another.version)}});
assert.ok('error' in denied);assert.equal(denied.error.code,'forbidden','rendered controls confer no mutation authority');
// Presentation wire precision is wider than State's admitted stored-version
// domain. Exercise the renderer with an exact wire row, without store claims.
const exact='9007199254740993';
synthetic={id:'precision',version:exact,fields:{title:'Exact',enabled:true}};
controls.length=0;const precise=await render();
assert.deepEqual(controls,[{id:'precision',version:exact}]);
assert.equal(hidden(precise,'inputs[record][version]'),exact);
assert.deepEqual(textValues.at(-1),[9007199254740994n],'native arithmetic stays exact above 2^53');
synthetic={id:'gated',version:exact,fields:{title:'Hidden',enabled:false}};
controls.length=0;const gated=await render();assert.deepEqual(controls,[]);assert.ok(!gated.includes('inputs[record][version]'),'gate encloses the delete boundary');
console.log('delete control: native arithmetic, exact hidden wire versions, real UI render, canonical archive/stale/current-grant admission and gated omission passed');
