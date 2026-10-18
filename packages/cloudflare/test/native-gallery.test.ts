/** Original compiled Gallery, real page admission, installed File census and bytes. */
import assert from 'node:assert/strict';
import {test} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileFunction, constants as vmConstants} from 'node:vm';
import {Miniflare} from 'miniflare';
import type {D1Database} from '@cloudflare/workers-types';
import type {CompileArtifact, MutationEnvelope, PageReadScope} from '@canlang/contracts';
import type {PageHttpDeps, UploadDeps} from '@canlang/interfaces';
import type {SqliteFileStore} from '@canlang/files/host/sqlite';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url))), APP='NativeGallery';
const nodeImport=compileFunction('return import(url)',['url'],{importModuleDynamically:vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
const PNG=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII=','base64'));
const JPEG=new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAAX/2Q==','base64'));
async function tables(db:D1Database) {
 const names=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
 assert.equal(names.success,true);const rows:Record<string,Record<string,unknown>[]>={};
 for(const {name} of names.results){const result=await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string,unknown>>();
  assert.equal(result.success,true);rows[name]=result.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}
 return rows;
}
function gate(){let begin!:()=>void,release!:()=>void;
 return {started:new Promise<void>(done=>{begin=done;}),released:new Promise<void>(done=>{release=done;}),begin:()=>begin(),release:()=>release()};}
test('original Gallery retains ordered protected images across full/partial pages and current policy controls',
 {timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'can-native-gallery-'));
 let worker:Miniflare|undefined,physical:SqliteFileStore|undefined,held:ReturnType<typeof gate>|undefined;
 const pendingCalls:Promise<unknown>[]=[],openScopes:PageReadScope[]=[];
 try {
  // Every private producer and all Can runtime consumers use the installed loader.
  const require=createRequire(import.meta.url),installed=(path:string)=>pathToFileURL(join(root,'packages/cloudflare/dist',path)).href;
  const packageUrl=(name:string)=>pathToFileURL(require.resolve(name)).href;
  const {distribution}=await nodeImport(packageUrl('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
  const {assembleModules,importVerifiedAssemblyModule}=await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const {assembleWorker,buildInvoker}=await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const {createNativeFileRetirementBinding}=await nodeImport(installed('runtime/file-retirement.js')) as typeof import('../src/runtime/file-retirement.js');
  const {createBoundFileHandler,createCanonicalFileBinding,createBoundFileReadResolver}=await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
  const {createPageReadScopeCanonical}=await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
  const {handlePageRequest,resolveRequestIdentity,buildPageSourceContext}=await nodeImport(packageUrl('@canlang/interfaces')) as typeof import('@canlang/interfaces');
  const {createFileJourneyKernel}=await nodeImport(packageUrl('@canlang/interfaces/uploads/kernel')) as typeof import('@canlang/interfaces/uploads/kernel');
  const {ensureSchema}=await nodeImport(packageUrl('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
  const {asId,asModel,asOperationId,FIXED_NOW,uuidv7}=await nodeImport(packageUrl('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
  const {createD1IdentityStore,ensureIdentitySchema,issueMcpGrant,resolveIdentity,buildSessionCookie,sha256HexText}=
   await nodeImport(packageUrl('@canlang/identity')) as typeof import('@canlang/identity');
  const {createSqliteFileStore}=await nodeImport(packageUrl('@canlang/files/host/sqlite')) as typeof import('@canlang/files/host/sqlite');
  const {sha256Hex}=await nodeImport(packageUrl('@canlang/files/upload')) as typeof import('@canlang/files/upload');
  const {blobKeyForFile}=await nodeImport(packageUrl('@canlang/files/finalize')) as typeof import('@canlang/files/finalize');
  const source=join(root,'packages/cloudflare/test/fixtures/native-gallery.can'),compiler=join(root,'compiler/target/debug/can'),catalog=fileURLToPath(distribution.catalog);
  const paths=[source,compiler,catalog],hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
  const hashes=await Promise.all(paths.map(async path=>hash(await readFile(path))));
  const env={...process.env};delete env.CAN_CATALOG;
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--catalog',catalog,source],
   {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,originalArtifact=JSON.stringify(artifact);
  assert.ok(artifact.sources.some(value=>resolve(value.path)===source&&value.sha256===hashes[0]));
  assert.equal(artifact.pages.length,1);assert.equal(artifact.pages[0]!.path,'/images');
  const RUN=asModel(`${APP}.Run`),OUTPUT=asModel(`${APP}.Output`);
  const image=artifact.models!.find(model=>model.name===OUTPUT)!.fields.find(field=>field.name==='image')!;
  assert.equal(image.field.kind,'file');assert.equal(image.valueType,'file');assert.equal(image.required,true);
  assert.equal(image.nullable===true,false);assert.equal(image.array,undefined);
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:join(dir,'modules'),stdlibUrl:installed('runtime/stdlib.js'),uiUrl:packageUrl('@canlang/ui')});
  const namespace=await importVerifiedAssemblyModule(asm,artifact.pages[0]!.module,artifact);
  assert.ok(namespace!==null&&typeof namespace==='object');
  assert.ok(Object.getOwnPropertyDescriptor(namespace,artifact.pages[0]!.export)?.value);
  worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
   d1Databases:{IDENTITY:'gallery-identity',OWNER:'gallery-owner'},d1Persist:join(dir,'d1')});
  const identityDb=await worker.getD1Database('IDENTITY') as unknown as D1Database,db=await worker.getD1Database('OWNER') as unknown as D1Database;
  await ensureIdentitySchema(identityDb);await ensureSchema(db);
  const clock={nowMs:()=>FIXED_NOW},identities=createD1IdentityStore(identityDb,{clock});
  const team=await identities.createTeam({timezone:'UTC'}),foreignTeam=await identities.createTeam({timezone:'UTC'});
  const users=await Promise.all(['owner','partial','foreign'].map(name=>identities.createUser({email:`${name}@gallery.example.test`,password_hash:'unused',email_verified:true})));
  const memberships=await Promise.all(users.map((user,index)=>identities.createMembership({user_id:user.user_id,team_id:index===2?foreignTeam.team_id:team.team_id,is_owner:index!==1,roles:[]})));
  const replacementOwner = await identities.createUser({ email: 'replacement-owner@gallery.example.test', password_hash: 'unused', email_verified: true });
  await identities.createMembership({ team_id: team.team_id, user_id: replacementOwner.user_id, is_owner: true, roles: [] });
  const grant=await issueMcpGrant(identities,{user_id:users[0]!.user_id,team_id:team.team_id,client_id:'native-gallery'},{clock});
  const currentOwner=()=>resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
  const retention={unattachedHorizonMs:120000,retentionMs:600000};physical=createSqliteFileStore(join(dir,'files.sqlite'));
  const native=await createNativeFileRetirementBinding({artifact,asm,scope:{app:APP,ownerPackage:APP,owner:team.team_id},identities,db,stateStoreId:'native-gallery',physicalSqliteFileStore:physical,
   initializeFresh:true,clock,intentTtlMs:60000,urlBase:'https://gallery.invalid',retention,maxRows:100,maxReferences:100});
  assert.ok(await native.store.readFileReferenceInventory(APP));
  const genuineKernel=createFileJourneyKernel(native.bindings);let byteReads=0;
  const kernel={...genuineKernel,async readCurrentSnapshot(...args:Parameters<typeof genuineKernel.readCurrentSnapshot>){byteReads++;
   const value=await genuineKernel.readCurrentSnapshot(...args);if(held){const original=held;original.begin();await original.released;}return value;}};
  const upload:UploadDeps&{kernel:typeof kernel}={app:{appId:APP,brand:APP,appDefaultLocale:'en',ownerLabels:new Map()},files:{usesFiles:()=>true},kernel,clock,logger:{log:()=>{}},
   identity:{store:identities,clock,mail:{sendMail:async()=>{}},verifyBaseUrl:'',recoveryBaseUrl:'',inviteBaseUrl:'',sessionMaxAgeSeconds:3600}};
  const fileOptions={artifact,asm,store:native.store,memberships:identities,identityStore:identities,clock,upload,physicalFiles:physical.files,retention,fileReferenceBounds:{maxRows:100,maxReferences:100}};
  const handler=createBoundFileHandler({...fileOptions,ownerStorage:native.ownerStorage});
  const invoker=buildInvoker(artifact,asm,native.store,{appId:APP,memberships:identities,now:clock.nowMs,ownerStorage:native.ownerStorage,files:createCanonicalFileBinding(genuineKernel,retention)});
  let sequence=0;const nextId=()=>asOperationId(uuidv7(FIXED_NOW,++sequence));
  const mutate=async(envelope:MutationEnvelope)=>{const result=await invoker.invokeMutation(envelope,await currentOwner());assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');};
  const runId=nextId();await mutate({operation:`${RUN}.create`,operation_id:runId,inputs:{name:'Ordered <images>'}});
  const run=await native.store.load(RUN,asId(runId));assert.ok(run);
  const parent={id:run.id,version:String(run.version)};
  const uploadImage=async(uploadId:string,bytes:Uint8Array,type:string)=>{
   const request=(path:string,method:string,body:string|Uint8Array)=>new Request(new URL(path,'https://gallery.invalid'),{method,
    headers:{authorization:`Bearer ${grant.token}`,'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json',...(method==='PUT'?{'upload-offset':'0'}:{})},body});
   const start=await handler(request('/files/intents','POST',JSON.stringify({upload_id:uploadId,operation:`${OUTPUT}.create`,field:'/image',arguments:{parent,position:'0'},name:uploadId,type,size:String(bytes.length)})));
   assert.equal(start.status,200,await start.clone().text());const intent=await start.json() as {content:string;finalize:string};
   const appended=await handler(request(intent.content,'PUT',bytes));assert.equal(appended.status,200,await appended.clone().text());
   const end=await handler(request(intent.finalize,'POST',JSON.stringify({upload_id:uploadId,bytes_digest:sha256Hex(bytes)})));
   assert.equal(end.status,200,await end.clone().text());const file=(await end.json() as {file:string}).file;assert.ok(physical!.files.get(file));return file;
  };
  const png=await uploadImage('gallery-png',PNG,'image/png'),jpeg=await uploadImage('gallery-jpeg',JPEG,'image/jpeg');
  const rows=[];
  // Creation order differs from the authored position order; duplicate physical
  // refs remain distinct original row occurrences.
  for(const [position,ref] of [[2,jpeg],[0,png],[1,png]] as const){const id=nextId();await mutate({operation:`${OUTPUT}.create`,operation_id:id,inputs:{parent,position:String(position),image:{id:ref}}});
   const row=await native.store.load(OUTPUT,asId(id));assert.ok(row);assert.deepEqual(row.parent,{model:RUN,id:run.id});rows.push(row);}
  const cookies:string[]=[],sessions=[];
  for(const [index,user] of users.entries()){const token=`native-gallery-${index}`;
   sessions.push(await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),expires_at:new Date(FIXED_NOW+3600000).toISOString(),last_team_id:index===2?foreignTeam.team_id:team.team_id}));
   cookies.push(buildSessionCookie(token,{secure:false,maxAgeSeconds:3600}).split(';')[0]!);}
  const request=(path='/images',index=0,partial=false)=>new Request(new URL(path,'https://gallery.invalid'),{headers:{cookie:cookies[index]!,...(partial?{'HX-Request':'true'}:{})}});
  const resources=async()=>({owner:await tables(db),identity:await tables(identityDb),files:physical!.files.listAll(),intents:physical!.intents.listAll(),
   bytes:await Promise.all(physical!.files.listAll().map(async file=>[file.file.id,Array.from(await physical!.blobs.read(blobKeyForFile(file.file.id))??[])]))});
  const pageReads={scope:{app:APP,ownerPackage:APP,owner:team.team_id},sourceIdentity:artifact.sources.find(value=>resolve(value.path)===source)!.sha256};
  let pageDeps:PageHttpDeps|undefined;
  const actual=await assembleWorker(artifact,asm,{store:native.store,identityStore:identities,now:clock.nowMs,ownerStorage:native.ownerStorage,pageReads,
   files:{usesFiles:true,kernel,fetch:handler,canonical:createCanonicalFileBinding(genuineKernel,retention),readOptions:{upload,physicalFiles:physical.files,retention,fileReferenceBounds:{maxRows:100,maxReferences:100}}},
   http:{createPageHandler:deps=>{pageDeps=deps as PageHttpDeps;return request=>handlePageRequest(pageDeps!,request);}}},{active:true});
  const ordered=[rows[1]!,rows[2]!,rows[0]!],refs=[png,png,jpeg];
  const previews=ordered.map((row,index)=>`/files/preview/${OUTPUT}/${row.id}/image/${refs[index]}`),originals=ordered.map((row,index)=>`/files/read/${OUTPUT}/${row.id}/image/${refs[index]}`);
  const before=await resources();
  for(const partial of [false,true]){const response=await actual.fetch(request('/images',0,partial));assert.equal(response.status,200,await response.clone().text());const html=await response.text();
   assert.match(html,/data-can-gallery/);assert.ok(html.includes('Ordered &lt;images&gt;'));assert.equal((html.match(/data-can-gallery-thumb src=/g)??[]).length,3);
   for(const [index,url] of previews.entries()){assert.equal(html.split(`src="${url}"`).length-1,1);assert.ok(html.includes(`href="${originals[index]}"`));if(index>0)assert.ok(html.indexOf(previews[index-1]!)<html.indexOf(url));}
   assert.equal(html.includes('unused.png'),false);assert.deepEqual(await resources(),before);}
  for(const [index,path] of originals.entries()){const response=await actual.fetch(request(path));assert.equal(response.status,200);
   assert.equal(response.headers.get('content-type'),index===2?'image/jpeg':'image/png');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),index===2?JPEG:PNG);}
  const preview=await actual.fetch(request(previews[0]!));assert.equal(preview.status,200);assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),PNG);
  assert.deepEqual(await resources(),before);
  // Partial field policies do not expose a File merely because the physical row
  // and ref exist. Full and partial routes fail before physical image reads.
  const readCount=byteReads;
  for(const partial of [false,true]){const denied=await actual.fetch(request('/images',1,partial));assert.equal(denied.status,422,await denied.clone().text());
   const body=await denied.text();assert.ok(!body.includes('/files/'));assert.ok(!body.includes(png));}
  assert.equal(byteReads,readCount);assert.deepEqual(await resources(),before);
  const hidden=await actual.fetch(request(originals[0]!,1));assert.equal(hidden.status,404);assert.equal(byteReads,readCount);
  const wrong=await actual.fetch(request(originals[0]!.replace(png,jpeg)));assert.equal(wrong.status,404);
  const foreign=await actual.fetch(request(originals[0]!,2));assert.ok(foreign.status>=400);assert.deepEqual(await resources(),before);
  // Native resolver requires the exact original RowView, correct singular field
  // and active scope; trusted File URLs never replace those private facts.
  const credential=request(),caller=async()=> (await resolveRequestIdentity(identities,credential,{clock})).identity;
  const admitted=await caller(),reads=createBoundFileReadResolver(fileOptions);
  const scope:PageReadScope=createPageReadScopeCanonical({artifact,asm,store:native.store,identity:admitted,memberships:identities,now:clock.nowMs,
   pageSource:buildPageSourceContext(admitted),pageFiles:{read:reads.read,resolveCaller:caller}});
  openScopes.push(scope);
  const query=await scope.query(admitted,OUTPUT,{order:['position']});assert.equal(query.rows.length,3);const row=query.rows[0]!;
  assert.ok(scope.resolveFileImage);assert.deepEqual(await scope.resolveFileImage({model:OUTPUT,record:row,field:'image'}),{previewUrl:previews[0],originalUrl:originals[0]});
  assert.equal(await scope.resolveFileImage({model:OUTPUT,record:{...row},field:'image'}),null);
  assert.equal(await scope.resolveFileImage({model:OUTPUT,record:row,field:'position'}),null);
  assert.equal(await scope.resolveFileImage({model:'Foreign.Output',record:row,field:'image'}),null);
  await scope.close?.();assert.equal(await scope.resolveFileImage({model:OUTPUT,record:row,field:'image'}),null);
  assert.deepEqual(await resources(),before);
  // Close during actual physical observation: no result escapes its page scope.
  const pendingScope=createPageReadScopeCanonical({artifact,asm,store:native.store,identity:admitted,memberships:identities,now:clock.nowMs,
   pageSource:buildPageSourceContext(admitted),pageFiles:{read:reads.read,resolveCaller:caller}});
  openScopes.push(pendingScope);
  const pendingRows=await pendingScope.query(admitted,OUTPUT,{order:['position']});held=gate();
  const pending=pendingScope.resolveFileImage!({model:OUTPUT,record:pendingRows.rows[0]!,field:'image'});
  pendingCalls.push(pending);
  await held.started;await pendingScope.close?.();held.release();held=undefined;assert.equal(await pending,null);assert.deepEqual(await resources(),before);
  // A current source predicate withholds image while retaining the declared
  // member-readable position; replay of the old protected link is reauthorized.
  const changed=await native.store.load(OUTPUT,ordered[0]!.id);assert.ok(changed);
  await mutate({operation:`${OUTPUT}.update`,operation_id:nextId(),inputs:{record:{id:changed.id,version:String(changed.version)},position:'-1'}});
  const sourceHiddenBefore=await resources(),sourceHiddenReads=byteReads;
  const sourceHidden=await actual.fetch(request('/images'));assert.equal(sourceHidden.status,422);
  assert.equal(byteReads,sourceHiddenReads);assert.equal((await actual.fetch(request(originals[0]!))).status,404);assert.deepEqual(await resources(),sourceHiddenBefore);
  // Revoked original credentials cannot retain page or download authority.
  await identities.revokeSession(sessions[0]!.session_id);const revokedBefore=await resources();
  assert.equal((await actual.fetch(request(originals[1]!))).status,401);assert.equal((await actual.fetch(request('/images'))).status,403);
  assert.deepEqual(await resources(),revokedBefore);
  assert.equal(JSON.stringify(artifact),originalArtifact);assert.deepEqual(await Promise.all(paths.map(async path=>hash(await readFile(path)))),hashes);
  await identities.removeMembership(memberships[0]!.membership_id);const membershipBefore=await resources();
  const lostMembership=await actual.fetch(new Request(new URL(originals[1]!,'https://gallery.invalid'),{headers:{authorization:`Bearer ${grant.token}`}}));
  assert.ok(lostMembership.status>=400);assert.deepEqual(await resources(),membershipBefore);
 }finally{held?.release();await Promise.allSettled(openScopes.map(scope=>scope.close?.()));
  await Promise.allSettled(pendingCalls);physical?.close();await worker?.dispose();await rm(dir,{recursive:true,force:true});}
});
