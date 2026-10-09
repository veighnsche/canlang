import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { deriveCsrfToken } from '/workspace/canlang/packages/identity/dist/src/sessions/csrf.js';
import { parseArtifactText } from '/workspace/canlang/packages/cloudflare/dist/runtime/artifact.js';
import { prepareLocalPreviewCapture } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-inputs.js';
import { captureSingleFileSource, verifyCompilerSources } from '/workspace/canlang/packages/cloudflare/dist/dev/source-capture.js';
import { createLocalPreviewBuilder } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-builder.js';
import { preflightLocalPreviewActivation, localPreviewActivationVerdict, produceInstalledPortableBundle, seedLocalPreviewActors } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-host.js';
const root='/workspace/canlang';
const source='examples/Generation.can';
const bytes=readFileSync('/workspace/.canlang-env/logs/generation-consumer/generation-mcp-fresh-artifact.json');
const sha=value=>createHash('sha256').update(value).digest('hex');
const out={sourceSha256:sha(readFileSync(`${root}/${source}`)),artifactSha256:sha(bytes)};
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
  const artifact=parseArtifactText(bytes.toString('utf8'),'generation').artifact;
  const request=prepareLocalPreviewCapture({checkoutRoot:root,appPath:source,compilerPath:'compiler/target/debug/can',catalogPath:'packages/values/dist/catalog.json',helpIndexPath:'docs/specification/CONSTRUCT-HELP.md'});
  const capture=await captureSingleFileSource(request);
  const sourceMatch=verifyCompilerSources(capture,{complete:true,sources:artifact.sources});
  if(!sourceMatch.ok)throw new Error(`artifact source mismatch ${sourceMatch.reason}`);
  out.capture={sourceRevision:capture.sourceRevision,epochMaterial:capture.epochMaterial,inputs:capture.inputs.length,source:capture.compilerOperand};
  const build=createLocalPreviewBuilder({resources:{d1:{binding:'DB',availability:'real_local'},identity:{backingBinding:'DB',availability:'real_local'}},activationVerdict:preflightLocalPreviewActivation,produceBundle:produceInstalledPortableBundle,seedLocalActors:async db=>{const seed=await seedLocalPreviewActors(db);for(const row of seed.owners)ownerLabels.set(row.owner,row.binding==='STATE_CEDAR_DB'?'Cedar':'Oak');return seed},confirmRunningActivation:async (artifact,capture,ownerDb,id,owner,identities)=>{identityDb=identities;ownerDbs.set(owner,ownerDb);return localPreviewActivationVerdict(artifact,capture,ownerDb,id,owner,identities)}});
  preview=await build(artifact,capture,bytes);
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
  const csrf=await deriveCsrfToken(appCookie.split('=',2)[1]);
  const selection=await fetch(`${origin}/auth/select-team`,{method:'POST',headers:{cookie:`${bridgeCookie}; ${appCookie}`,origin,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({team,_csrf:csrf})});
  if(selection.status!==200)throw new Error(`ordinary team selection failed HTTP ${selection.status}`);
  out.identity={login:login.status,teams:teams.status,selected:selection.status};
  const grant=await fetch(`${origin}/mcp/grants`,{method:'POST',headers:{cookie:`${bridgeCookie}; ${appCookie}`,origin,'content-type':'application/json'},body:JSON.stringify({client_id:'generation-owner-probe'})}),grantBody=await grant.json();
  if(grant.status!==200||!grantBody.token)throw new Error('ordinary MCP member grant failed');
  const mcp=async (method,params)=>{const response=await fetch(`${origin}/mcp`,{method:'POST',headers:{cookie:bridgeCookie,origin,'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${grantBody.token}`},body:JSON.stringify({jsonrpc:'2.0',id:operationId(),method,params})});return{http:response.status,body:await response.json()};};
  const listed=await mcp('tools/list',{}),tools=listed.body.result?.tools??[];
  out.mcpTools={http:listed.http,count:tools.length,create:tools.some(t=>t.name==='Generation.Job.create'),read:tools.some(t=>t.name==='Generation.Job.read')};
  if(!out.mcpTools.create||!out.mcpTools.read)throw new Error('Generation MCP create/read tools unavailable');
  const created=await mcp('tools/call',{name:'Generation.Job.create',arguments:{operation_id:operationId(),prompt:'G1 MCP owner probe'}});
  const payload=created.body.result?.structuredContent??created.body.result;
  const job=payload?.records?.find(r=>r.data?.prompt==='G1 MCP owner probe');
  out.mcpCreate={http:created.http,...safeOutcome(created.body),ownerStored:!!job&&!!(await stored(team,job.id))};
  if(created.http!==200||payload?.status!=='committed'||!job?.id)throw new Error('canonical MCP Generation.Job.create failed');
  const read=await mcp('tools/call',{name:'Generation.Job.read',arguments:{}});
  out.mcpRead={http:read.http,containsCreated:JSON.stringify(read.body).includes(job.id),...safeOutcome(read.body)};
  const ownerRow=await stored(team,job.id);
  out.ownerRow={present:!!ownerRow,version:ownerRow?.version??null,idle:ownerRow?.status==='idle'};
}catch(error){out.error={name:error?.name??'Error',code:error?.code??null,message:String(error?.message??error)};}
finally{await preview?.dispose();process.stdout.write(JSON.stringify(out,null,2)+'\n');}
