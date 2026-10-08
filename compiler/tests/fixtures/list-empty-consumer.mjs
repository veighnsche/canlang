import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [root, artifactPath, scratch] = process.argv.slice(2);
const load = path => import(pathToFileURL(resolve(root,path)));
const {loadArtifactFile} = await load('packages/cloudflare/dist/runtime/artifact.js');
const {assembleModules} = await load('packages/cloudflare/dist/runtime/modules.js');
const {queryPageRowsCanonical} = await load('packages/cloudflare/dist/runtime/invoke.js');
const {createTestMemoryStorage} = await load('packages/state/dist/src/storage/memory.js');
const {buildPresentationContext} = await load('packages/interfaces/dist/src/http/presentation.js');
const loaded = loadArtifactFile(artifactPath), artifact = loaded.artifact;
const asm = await assembleModules(loaded, {workDir:resolve(scratch,'modules'),
 stdlibUrl:pathToFileURL(resolve(root,'packages/cloudflare/dist/runtime/stdlib.js')).href,
 uiUrl:pathToFileURL(resolve(root,'packages/ui/dist/src/index.js')).href});
const {store} = createTestMemoryStorage();
const identity={actor:null,team:null,membership:null,binding:{kind:'none'},admitted_at:new Date().toISOString()};
const memberships={findMembership:async()=>null};
let queries=0;
const context=buildPresentationContext({request:new Request('https://example.test/',{headers:{'Accept-Language':'nl'}}),
 pathname:'/',isPartial:false,appDefaultLocale:'en',csrfToken:'',principal:identity,
 query:async(invocation,model,args)=>{
  queries++; assert.equal(invocation,identity); assert.equal(model,'Images.Job');
  const result=await queryPageRowsCanonical({asm,artifact,model,args,identity:invocation,store,memberships});
  assert.equal(result.rows.length,0); return result;
 }});
const reference=artifact.pages[0], entry=await import(asm.moduleUrls[reference.module]);
const page=entry[reference.export];
const bindings=await page.admit(context);
const html=await page.render(context,bindings);
assert.equal(queries,1,'one canonical authorized empty query');
assert.ok(html.includes('Nog geen taken'),'authored localized caption reaches strict actual UI sink');
assert.ok(!html.includes('No jobs yet'));
console.log('explicit empty message: canonical empty query and real UI list passed');
