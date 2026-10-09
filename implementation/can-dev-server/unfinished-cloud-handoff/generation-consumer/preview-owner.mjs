// Local Generation consumer; run only after installed outputs and native compiler are current.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const require=createRequire(join(root,'package.json'));
const installed=path=>import(pathToFileURL(join(root,'packages/cloudflare/dist',path)).href);
const source='examples/Generation.can';
const resultPath=join(root,'test-results/can-dev-server/generation-consumer/preview-owner.json');
const sha=value=>createHash('sha256').update(value).digest('hex');
const out={scope:'local Generation',sourceSha256:sha(readFileSync(join(root,source)))};
let stage='installed prerequisites';
const ownerDbs=new Map(),ownerLabels=new Map();
let identityDb,preview;
function operationId(){const t=Date.now().toString(16).padStart(12,'0'),r=randomBytes(10).toString('hex');return `${t.slice(0,8)}-${t.slice(8,12)}-7${r.slice(0,3)}-8${r.slice(4,7)}-${r.slice(7,19)}`;}
async function snapshotDb(db){
  const names=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map(r=>r.name).filter(n=>!n.startsWith('_cf_'));
  const result={};
  for(const name of names){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('invalid D1 table name');const rows=(await db.prepare(`SELECT * FROM "${name}"`).all()).results;result[name]={count:rows.length,hash:sha(JSON.stringify(rows.map(r=>JSON.stringify(r)).sort()))};}
  return result;
}
async function snapshot(){
  if(!identityDb||ownerDbs.size!==2)throw new Error('serving D1 owners unavailable');
  const result={};
  for(const [label,db] of [['Identity',identityDb],...[...ownerDbs].map(([owner,db])=>[ownerLabels.get(owner),db])]){
    if(!label)throw new Error('owner D1 label unavailable');
    for(const [table,value] of Object.entries(await snapshotDb(db)))result[`${label}:${table}`]=value;
  }
  return result;
}
function changes(before,after){return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));}
function safeOutcome(body){const result=body?.result?.structuredContent??body?.result;return {status:result?.status??null,code:result?.error?.code??result?.code??body?.error?.code??body?.code??null,isError:body?.result?.isError??null};}
async function stored(team,id){const db=ownerDbs.get(team);if(!db)throw new Error('selected owner D1 unavailable');const row=await db.prepare("SELECT version, data, archived_at FROM records WHERE model='Generation.Job' AND id=?").bind(id).first();return row&&{version:row.version,status:JSON.parse(row.data).status,archived:row.archived_at!==null};}
try{
  const {deriveCsrfToken}=await import(pathToFileURL(require.resolve('@canlang/identity')).href);
  const {distribution}=await import(pathToFileURL(require.resolve('@canlang/values/distribution')).href);
  const {prepareLocalPreviewCapture}=await installed('dev/preview-inputs.js');
  const {captureSingleFileSource,verifyCompilerSources,captureIsCurrent}=await installed('dev/source-capture.js');
  const {compileCapturedSingleFile}=await installed('dev/compiler-check.js');
  const {createLocalPreviewBuilder}=await installed('dev/preview-builder.js');
  const {preflightLocalPreviewActivation,localPreviewActivationVerdict,produceInstalledPortableBundle,seedLocalPreviewActors}=await installed('dev/preview-host.js');
  stage='source-current native compile';
  const request=prepareLocalPreviewCapture({checkoutRoot:root,appPath:join(root,source),compilerPath:join(root,'compiler/target/debug/can'),catalogPath:fileURLToPath(distribution.catalog),helpIndexPath:join(root,'docs/specification/CONSTRUCT-HELP.md')});
  const capture=await captureSingleFileSource(request);
  assert.equal(await captureIsCurrent(capture),true,'capture must be source-current');
  const compiled=await compileCapturedSingleFile(capture);
  out.compileKind=compiled.kind;
  assert.equal(compiled.kind,'artifact','native compilation must produce an artifact');
  const {artifact,artifactBytes:bytes}=compiled;
  out.artifactSha256=sha(bytes);
  const sourceMatch=verifyCompilerSources(capture,{complete:true,sources:artifact.sources});
  if(!sourceMatch.ok)throw new Error(`artifact source mismatch ${sourceMatch.reason}`);
  out.capture={sourceRevision:capture.sourceRevision,epochMaterial:capture.epochMaterial,inputs:capture.inputs.length,source:capture.compilerOperand};
  stage='installed real preview activation';
  const build=createLocalPreviewBuilder({workerVarsForOrigin:()=>({CAN_FORM_BINDING_KEY:randomBytes(32).toString('base64url')}),resources:{d1:{binding:'DB',availability:'real_local'},identity:{backingBinding:'DB',availability:'real_local'}},activationVerdict:preflightLocalPreviewActivation,produceBundle:produceInstalledPortableBundle,seedLocalActors:async db=>{const seed=await seedLocalPreviewActors(db);for(const row of seed.owners)ownerLabels.set(row.owner,row.binding==='STATE_CEDAR_DB'?'Cedar':'Oak');return seed},confirmRunningActivation:async (artifact,capture,ownerDb,id,owner,identities)=>{identityDb=identities;ownerDbs.set(owner,ownerDb);return localPreviewActivationVerdict(artifact,capture,ownerDb,id,owner,identities)}});
  preview=await build(artifact,capture,bytes);
  stage='ordinary preview auth and business consumers';
  const open=await fetch(preview.issueOpenUrl(),{redirect:'manual'});
  const origin=new URL(open.url).origin,bridgeCookie=open.headers.get('set-cookie')?.split(';',1)[0];
  if(open.status!==303||!bridgeCookie||!identityDb||ownerDbs.size!==2)throw new Error('protected preview or serving D1 unavailable');
  out.preview={ready:true,bootstrap:open.status,servingD1s:3};
  const ava=preview.issueLocalActors().find(a=>a.label==='Ava');
  if(!ava)throw new Error('seeded member unavailable');
  const loginGet=await fetch(`${origin}/auth/login`,{headers:{cookie:bridgeCookie}}),loginForm=await loginGet.json();
  const login=await fetch(`${origin}/auth/login`,{method:'POST',headers:{cookie:bridgeCookie,origin,'content-type':'application/json'},body:JSON.stringify({email:ava.email,password:ava.password,_presession:loginForm.preSessionToken})});
  const appCookie=login.headers.getSetCookie().find(x=>x.startsWith('can_session='))?.split(';',1)[0];
  if(login.status!==200||!appCookie)throw new Error(`ordinary member login failed HTTP ${login.status}`);
  const teams=await fetch(`${origin}/auth/teams`,{headers:{cookie:`${bridgeCookie}; ${appCookie}`}}),teamList=await teams.json(),team=teamList.teams?.[0]?.team_id;
  if(teams.status!==200||!team)throw new Error(`ordinary team listing failed HTTP ${teams.status}`);
  const csrf=await deriveCsrfToken(decodeURIComponent(appCookie.split('=',2)[1]));
  const selection=await fetch(`${origin}/auth/select-team`,{method:'POST',headers:{cookie:`${bridgeCookie}; ${appCookie}`,origin,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({team,_csrf:csrf})});
  if(selection.status!==200)throw new Error(`ordinary team selection failed HTTP ${selection.status}`);
  out.identity={login:login.status,teams:teams.status,selected:selection.status};
  const create=await fetch(`${origin}/api/operations/Generation.Job.create`,{method:'POST',headers:{cookie:`${bridgeCookie}; ${appCookie}`,origin,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({operation_id:operationId(),inputs:{prompt:'G1 owner preview probe'}})}),created=await create.json();
  const job=created.records?.find(r=>r.data?.prompt==='G1 owner preview probe');
  out.create={http:create.status,outcome:created.status??null,ownerStored:!!job&&!!(await stored(team,job.id))};
  if(create.status!==200||created.status!=='committed'||!job?.id)throw new Error('canonical Generation.Job.create failed');
  assert.equal(out.create.ownerStored,true,'HTTP create persists in selected owner');
  const grant=await fetch(`${origin}/mcp/grants`,{method:'POST',headers:{cookie:`${bridgeCookie}; ${appCookie}`,origin,'content-type':'application/json'},body:JSON.stringify({client_id:'generation-owner-probe'})}),grantBody=await grant.json();
  if(grant.status!==200||!grantBody.token)throw new Error('ordinary MCP member grant failed');
  const mcp=async (method,params)=>{const response=await fetch(`${origin}/mcp`,{method:'POST',headers:{cookie:bridgeCookie,origin,'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${grantBody.token}`},body:JSON.stringify({jsonrpc:'2.0',id:operationId(),method,params})});return{http:response.status,body:await response.json()};};
  const listed=await mcp('tools/list',{}),tools=listed.body.result?.tools??[];
  out.mcpTools={http:listed.http,count:tools.length,queue:tools.some(t=>t.name==='Generation.queue'),read:tools.some(t=>t.name==='Generation.Job.read')};
  assert.equal(listed.http,200,'MCP tool listing');
  if(!out.mcpTools.queue||!out.mcpTools.read)throw new Error('Generation business MCP tools unavailable');
  const readBefore=await mcp('tools/call',{name:'Generation.Job.read',arguments:{}});
  out.readBefore={http:readBefore.http,containsCreated:JSON.stringify(readBefore.body).includes(job.id),...safeOutcome(readBefore.body)};
  assert.equal(out.readBefore.http,200);
  assert.equal(out.readBefore.containsCreated,true,'MCP read sees created owner row');
  const queued=await mcp('tools/call',{name:'Generation.queue',arguments:{operation_id:operationId(),job:{id:job.id,version:String(job.version)}}});
  const afterQueue=await stored(team,job.id);
  out.queue={http:queued.http,...safeOutcome(queued.body),ownerVersion:afterQueue?.version??null,queuedInOwner:afterQueue?.status==='queued'};
  assert.equal(out.queue.http,200);
  assert.equal(out.queue.status,'committed');
  assert.equal(out.queue.queuedInOwner,true,'queue commits to selected owner D1');
  assert.equal(Number(afterQueue.version),Number(job.version)+1,'queue advances canonical version');
  const readAfter=await mcp('tools/call',{name:'Generation.Job.read',arguments:{}});
  out.readAfter={http:readAfter.http,containsCreated:JSON.stringify(readAfter.body).includes(job.id),...safeOutcome(readAfter.body)};
  assert.equal(out.readAfter.http,200);
  assert.equal(out.readAfter.containsCreated,true);
  const beforeRule=await snapshot();
  const refused=await mcp('tools/call',{name:'Generation.queue',arguments:{operation_id:operationId(),job:{id:job.id,version:String(afterQueue.version)}}});
  const afterRule=await snapshot();
  const ruleChanges=changes(beforeRule,afterRule);
  const receipt=await ownerDbs.get(team).prepare('SELECT outcome FROM receipts ORDER BY rowid DESC LIMIT 1').first();
  let canonicalRejection=false;
  try {const r=JSON.parse(receipt?.outcome??'null');canonicalRejection=r?.status==='rejected'&&r?.code==='rule_failed';}catch{}
  out.ruleRefusal={http:refused.http,...safeOutcome(refused.body),changedTables:ruleChanges,canonicalRejection,domainEffects:ruleChanges.filter(k=>!['fence','fence_log','receipts'].map(table=>`${ownerLabels.get(team)}:${table}`).includes(k))};
  assert.equal(out.ruleRefusal.http,200);
  assert.equal(out.ruleRefusal.code,'rule_failed');
  assert.equal(out.ruleRefusal.canonicalRejection,true,'canonical rejected receipt');
  assert.deepEqual(out.ruleRefusal.domainEffects,[],'rule refusal cannot change domain or Identity tables');
  const beforePublic=await snapshot();
  const publicQueue=await fetch(`${origin}/api/operations/Generation.queue`,{method:'POST',headers:{cookie:bridgeCookie,origin,'content-type':'application/json'},body:JSON.stringify({operation_id:operationId(),inputs:{job:{id:job.id,version:String(afterQueue.version)}}})}),publicBody=await publicQueue.json();
  const afterPublic=await snapshot();
  out.publicQueue={http:publicQueue.status,code:publicBody.code??publicBody.error?.code??null,changedTables:changes(beforePublic,afterPublic)};
  assert.equal(out.publicQueue.http,403);
  assert.equal(out.publicQueue.code,'forbidden');
  assert.deepEqual(out.publicQueue.changedTables,[],'anonymous refusal changes no serving D1 table');
  const publicMcp=await fetch(`${origin}/mcp`,{method:'POST',headers:{cookie:bridgeCookie,origin,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:operationId(),method:'tools/call',params:{name:'Generation.Job.read',arguments:{}}})});
  out.publicRead={http:publicMcp.status};
  assert.equal(out.publicRead.http,401,'MCP read requires ordinary grant');
  assert.deepEqual(changes(afterPublic,await snapshot()),[],'anonymous MCP read changes no serving D1 table');
  const page=await fetch(`${origin}/`,{headers:{cookie:`${bridgeCookie}; ${appCookie}`}}),html=await page.text();
  out.page={http:page.status,hasPrompt:html.includes('G1 owner preview probe'),hasQueued:html.includes('Queued for generation')};
  assert.equal(out.page.http,200);
  assert.equal(out.page.hasPrompt,true);
  assert.equal(out.page.hasQueued,true);
  assert.ok(html.includes('/assets/browser/bootstrap.js'),'generated page loads bundled browser');
  out.assets=[];
  for(const path of ['/assets/browser/bootstrap.js','/assets/browser/can-style.css','/assets/browser/polling.js']){
    const response=await fetch(`${origin}${path}`,{headers:{cookie:`${bridgeCookie}; ${appCookie}`}});
    const size=(await response.arrayBuffer()).byteLength;
    assert.equal(response.status,200,path);
    assert.ok(response.headers.get('content-type')?.includes(path.endsWith('.css')?'text/css':'application/javascript'),path);
    assert.ok(size>0,path);
    out.assets.push({path,http:response.status,bytes:size});
  }
  stage='three authored compiled example rows';
  const beforeExamples=await snapshot();
  const {loadInstalledExampleTestkit,runCompiledExamples}=await installed('dev/example-runner.js');
  const examples=await runCompiledExamples({...preview.exampleInput(),testkit:await loadInstalledExampleTestkit(root)});
  out.examples={ok:examples.ok,executed:examples.executed,summary:examples.report.summary};
  assert.equal(examples.executed,3,'all authored Generation.queue rows execute');
  assert.equal(examples.ok,true,'authored success, rule refusal and forbidden rows pass');
  assert.deepEqual(changes(beforeExamples,await snapshot()),[],'example row isolation preserves serving D1');
  assert.equal(await captureIsCurrent(capture),true,'capture changed during consumer check');
}catch(error){process.exitCode=1;out.error={stage,name:error?.name??'Error',code:typeof error?.code==='string'?error.code:null};}
finally{
  try{await preview?.dispose();}catch{process.exitCode=1;out.disposalFailed=true;}
  mkdirSync(resolve(resultPath,'..'),{recursive:true});
  const json=JSON.stringify(out,null,2)+'\n';
  writeFileSync(resultPath,json,{mode:0o600});
  process.stdout.write(json);
}
