import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { parseArtifactText } from '/workspace/canlang/packages/cloudflare/dist/runtime/artifact.js';
import { prepareLocalPreviewCapture } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-inputs.js';
import { captureSingleFileSource, verifyCompilerSources } from '/workspace/canlang/packages/cloudflare/dist/dev/source-capture.js';
import { createLocalPreviewBuilder } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-builder.js';
import { preflightLocalPreviewActivation, localPreviewActivationVerdict, produceInstalledPortableBundle, seedLocalPreviewActors } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-host.js';
import { deriveCsrfToken } from '/workspace/canlang/packages/identity/dist/src/sessions/csrf.js';
const root = '/workspace/canlang';
const artifactPath = '/workspace/.canlang-env/logs/dev-server-office-compile.json';
const bytes = readFileSync(artifactPath);
const sha = value => createHash('sha256').update(value).digest('hex');
function operationId() {
  const time = Date.now().toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}
const facts = { sourceSha256: sha(readFileSync(`${root}/tests/integration/can-dev-server/OfficeSupplies.can`)), artifactSha256: sha(bytes), operations: [] };
let preview, identityDb;
const ownerDbs=new Map();
const ownerLabels=new Map();
let origin, bridgeCookie;
async function dbSnapshot(db) {
  const names=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map(row=>row.name).filter(name=>!name.startsWith('_cf_'));
  const result={};
  for(const name of names) {
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('unexpected D1 table name');
    const rows=(await db.prepare(`SELECT * FROM "${name}"`).all()).results;
    result[name]={count:rows.length,sha256:sha(JSON.stringify(rows.map(row=>JSON.stringify(row)).sort()))};
  }
  return result;
}
async function snapshot() {
  if(!identityDb||ownerDbs.size!==2)throw new Error('actual serving D1 handles unavailable');
  const result={};
  for(const [label,db] of [['Identity',identityDb], ...[...ownerDbs].map(([owner,db])=>[ownerLabels.get(owner),db])]) {
    if(!label)throw new Error('owner D1 label unavailable');
    for(const [name,value] of Object.entries(await dbSnapshot(db)))result[`${label}:${name}`]=value;
  }
  return result;
}
function changes(before,after) {
  return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(name=>JSON.stringify(before[name])!==JSON.stringify(after[name]));
}
async function stored(id,team) {
  const db=ownerDbs.get(team);
  if(!db)throw new Error('selected team has no observed serving owner D1');
  const row=await db.prepare("SELECT id, version, owner, archived_at, data FROM records WHERE model = 'OfficeSupplies.Supply' AND id = ?").bind(id).first();
  return row&&{id:row.id,version:row.version,owner:row.owner,archived:row.archived_at!==null,data:JSON.parse(row.data)};
}
function summary(row) {
  return row===null?{present:false}:{present:true,version:row.version,archived:row.archived,hasName:typeof row.data.name==='string',available:row.data.available,quantityDefault:row.data.quantity===null};
}
async function login(actor) {
  const descriptor = await fetch(`${origin}/auth/login`, { headers:{cookie:bridgeCookie} });
  const form = await descriptor.json();
  const response = await fetch(`${origin}/auth/login`, { method:'POST', headers:{cookie:bridgeCookie,origin,'content-type':'application/json'}, body:JSON.stringify({email:actor.email,password:actor.password,_presession:form.preSessionToken}) });
  const appCookie = response.headers.getSetCookie().find(value=>value.startsWith('can_session='))?.split(';',1)[0];
  if (response.status!==200 || !appCookie) throw new Error(`${actor.label} ordinary login failed HTTP ${response.status}`);
  const csrf = await deriveCsrfToken(appCookie.split('=',2)[1]);
  const teamsResponse = await fetch(`${origin}/auth/teams`, { headers:{cookie:`${bridgeCookie}; ${appCookie}`} });
  const teams = await teamsResponse.json();
  if (teamsResponse.status!==200) throw new Error(`${actor.label} ordinary team listing failed HTTP ${teamsResponse.status}`);
  let team = null;
  if (teams.teams?.length) {
    team = teams.teams[0].team_id;
    const selected = await fetch(`${origin}/auth/select-team`, {method:'POST',headers:{cookie:`${bridgeCookie}; ${appCookie}`,origin,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({team,_csrf:csrf})});
    if (selected.status!==200) throw new Error(`${actor.label} ordinary team selection failed HTTP ${selected.status}`);
  }
  facts.operations.push({label:`identity.${actor.label}`,login:response.status,listedTeams:teams.teams?.length??null,selected:team!==null});
  return { label:actor.label, appCookie, csrf, team };
}
async function http(actor, operation, inputs, label, checkDenied=false) {
  const before = checkDenied ? await snapshot() : null;
  const response = await fetch(`${origin}/api/operations/OfficeSupplies.Supply.${operation}`, {method:'POST',headers:{cookie:[bridgeCookie,actor?.appCookie].filter(Boolean).join('; '),origin,'content-type':'application/json',...(actor?.csrf?{'x-csrf-token':actor.csrf}:{})},body:JSON.stringify({operation_id:operationId(),inputs})});
  let body;
  try {body=await response.json();}catch{body={parse:'invalid_json'};}
  const after = checkDenied ? await snapshot() : null;
  const entry = {label,actor:actor?.label??'Public',operation,status:response.status,code:body.code??body.error?.code??null,outcome:body.status??null,changedTables:checkDenied?changes(before,after):undefined,receiptTables:checkDenied?Object.fromEntries(changes(before,after).map(name=>[name,{before:before[name]?.count,after:after[name]?.count}])):undefined};
  facts.operations.push(entry);
  return {entry,body};
}
async function grant(actor) {
  const response=await fetch(`${origin}/mcp/grants`,{method:'POST',headers:{cookie:`${bridgeCookie}; ${actor.appCookie}`,origin,'content-type':'application/json'},body:JSON.stringify({client_id:'office-business-evaluator'})});
  const body=await response.json();
  if(response.status!==200||!body.token)throw new Error(`MCP grant unavailable HTTP ${response.status}`);
  return body.token;
}
async function mcp(token, method, params) {
  const response=await fetch(`${origin}/mcp`,{method:'POST',headers:{cookie:bridgeCookie,origin,'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:operationId(),method,params})});
  return {status:response.status,body:await response.json()};
}
const grants = new Map();
async function read(actor,label,checkDenied=false) {
  const before=checkDenied?await snapshot():null;
  let token=null;
  if(actor!==null) {
    token=grants.get(actor.label);
    if(!token) {
      try {token=await grant(actor);grants.set(actor.label,token);}
      catch(error) {
        facts.operations.push({label,actor:actor.label,operation:'mcp.read',status:403,errorCode:'grant_unavailable',changedTables:checkDenied?changes(before,await snapshot()):undefined});
        return {status:403,body:{error:{code:'forbidden'}}};
      }
    }
  }
  let result;
  if(actor===null) {
    const response=await fetch(`${origin}/mcp`,{method:'POST',headers:{cookie:bridgeCookie,origin,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:operationId(),method:'tools/call',params:{name:'OfficeSupplies.Supply.read',arguments:{}}})});
    result={status:response.status,body:await response.json()};
  } else {
    result=await mcp(token,'tools/call',{name:'OfficeSupplies.Supply.read',arguments:{}});
  }
  const after=checkDenied?await snapshot():null;
  facts.operations.push({label,actor:actor?.label??'Public',operation:'mcp.read',status:result.status,
    isError:result.body.result?.isError??null,errorCode:result.body.result?.structuredContent?.code??result.body.error?.code??null,
    changedTables:checkDenied?changes(before,after):undefined});
  return result;
}
try {
  const artifact=parseArtifactText(bytes.toString('utf8'),'office').artifact;
  const request=prepareLocalPreviewCapture({checkoutRoot:root,appPath:'tests/integration/can-dev-server/OfficeSupplies.can',compilerPath:'compiler/target/debug/can',catalogPath:'packages/values/dist/catalog.json',helpIndexPath:'docs/specification/CONSTRUCT-HELP.md'});
  const capture=await captureSingleFileSource(request);
  const exact=verifyCompilerSources(capture,{complete:true,sources:artifact.sources});
  if(!exact.ok)throw new Error(`artifact source ${exact.reason}`);
  facts.capture={sourceRevision:capture.sourceRevision,epochMaterial:capture.epochMaterial,inputs:capture.inputs.length,source:capture.compilerOperand};
  const build=createLocalPreviewBuilder({resources:{d1:{binding:'DB',availability:'real_local'},identity:{backingBinding:'DB',availability:'real_local'}},activationVerdict:preflightLocalPreviewActivation,confirmRunningActivation:async (artifact,capture,ownerDb,id,owner,identities)=>{identityDb=identities;ownerDbs.set(owner,ownerDb);return localPreviewActivationVerdict(artifact,capture,ownerDb,id,owner,identities)},produceBundle:produceInstalledPortableBundle,seedLocalActors:async handle=>{const seed=await seedLocalPreviewActors(handle);for(const row of seed.owners)ownerLabels.set(row.owner,row.binding==='STATE_CEDAR_DB'?'Cedar':'Oak');return seed}});
  preview=await build(artifact,capture,bytes);
  const bootstrap=await fetch(preview.issueOpenUrl(),{redirect:'manual'});
  origin=new URL(bootstrap.url).origin;
  bridgeCookie=bootstrap.headers.get('set-cookie')?.split(';',1)[0];
  if(bootstrap.status!==303||!bridgeCookie||!identityDb||ownerDbs.size!==2)throw new Error('preview bootstrap or observed serving D1s unavailable');
  facts.preview={ready:true,bootstrap:303,assetsVerifiedByBuilder:true,servingD1s:1+ownerDbs.size};
  const actors=preview.issueLocalActors();
  const ava=await login(actors.find(item=>item.label==='Ava'));
  const ben=await login(actors.find(item=>item.label==='Ben'));
  const cal=await login(actors.find(item=>item.label==='Cal'));
  const dee=await login(actors.find(item=>item.label==='Dee'));
  facts.teams={avaBenSame:ava.team===ben.team,calOther:cal.team!==ava.team,deeNone:dee.team===null};
  // O01: source-declared create shape, defaults, and exact persisted record.
  await http(ava,'create',{},'O01.missing-name',true);
  await http(ava,'create',{name:'   '},'O01.blank-name',true);
  await http(ava,'create',{name:'Override',available:false},'O01.closed-available',true);
  const paper=await http(ava,'create',{name:'Paper'},'O01.paper');
  const paperRow=paper.body.records?.find(row=>row.data?.name==='Paper');
  if(!paperRow)throw new Error('O01 Paper create produced no row');
  facts.paper=summary(await stored(paperRow.id,ava.team));
  await read(ava,'O01.ava-read');
  // O02/O03: shared Cedar item through canonical operations.
  const pens=await http(ava,'create',{name:'Pens',quantity:'4'},'O02.pens');
  const pensRow=pens.body.records?.find(row=>row.data?.name==='Pens');
  if(!pensRow)throw new Error('O02 Pens create produced no row');
  facts.pensCreated=summary(await stored(pensRow.id,ava.team));
  const benRead=await read(ben,'O02.ben-read');
  facts.benReadContainsPens=JSON.stringify(benRead.body).includes(pensRow.id);
  const edit=await http(ben,'update',{record:{id:pensRow.id,version:String(pensRow.version)},name:'Blue pens',quantity:'8'},'O02.ben-edit');
  const pensEdited=await stored(pensRow.id,ava.team);
  facts.pensEdited={...summary(pensEdited),expectedValues:pensEdited?.data.name==='Blue pens'&&pensEdited?.data.quantity==='8'};
  const restock=await http(ben,'update',{record:{id:pensRow.id,version:String(facts.pensEdited.version)},available:false},'O03.restock');
  facts.pensRestock=summary(await stored(pensRow.id,ava.team));
  const available=await http(ben,'update',{record:{id:pensRow.id,version:String(facts.pensRestock.version)},available:true},'O03.available');
  facts.pensAvailable=summary(await stored(pensRow.id,ava.team));
  // O04: ordinary archive and absence in authorized read, before cross-team probes.
  const removed=await http(ava,'delete',{record:{id:pensRow.id,version:String(facts.pensAvailable.version)}},'O04.remove');
  facts.pensAfterRemove=summary(await stored(pensRow.id,ava.team));
  const afterRead=await read(ben,'O04.ben-read-after-remove');
  facts.afterReadContainsPens=JSON.stringify(afterRead.body).includes(pensRow.id);
  // O06: every denied mutation snapshots all D1 tables. Cal's create is scoped to Oak.
  grants.set(cal.label,await grant(cal));
  const calRead=await read(cal,'O06.cal-read',true);
  facts.calReadContainsCedar=JSON.stringify(calRead.body).includes(paperRow.id)||JSON.stringify(calRead.body).includes(pensRow.id);
  facts.calReadResultCode=calRead.body.result?.structuredContent?.code??calRead.body.error?.code??null;
  const deeRead=await read(dee,'O06.dee-read',true);
  const publicRead=await read(null,'O06.public-read',true);
  for(const actor of [dee,null,cal]) {
    const label=actor?.label??'Public';
    if(actor===cal) {
      const own=await http(cal,'create',{name:'Oak own item'},'O06.cal-oak-create');
      const oakRow=own.body.records?.find(row=>row.data?.name==='Oak own item');
      facts.calOakCreated=!!oakRow&&!!(await stored(oakRow.id,cal.team));
      const oakRead=await read(cal,'O06.cal-own-oak-read',true);
      facts.calReadContainsOwnOak=!!oakRow&&JSON.stringify(oakRead.body).includes(oakRow.id);
      facts.calOwnReadContainsCedar=JSON.stringify(oakRead.body).includes(paperRow.id)||JSON.stringify(oakRead.body).includes(pensRow.id);
      const avaRead=await read(ava,'O06.ava-read-after-oak',true);
      facts.avaReadContainsOak=!!oakRow&&JSON.stringify(avaRead.body).includes(oakRow.id);
    } else await http(actor,'create',{name:'Denied item'},`O06.${label}-create`,true);
    let target=await stored(paperRow.id,ava.team);
    await http(actor,'update',{record:{id:paperRow.id,version:String(target.version)},name:'Denied edit'},`O06.${label}-edit`,true);
    target=await stored(paperRow.id,ava.team);
    await http(actor,'update',{record:{id:paperRow.id,version:String(target.version)},available:false},`O06.${label}-status`,true);
    target=await stored(paperRow.id,ava.team);
    await http(actor,'delete',{record:{id:paperRow.id,version:String(target.version)}},`O06.${label}-delete`,true);
  }
  facts.cedarAfterDenials={paper:summary(await stored(paperRow.id,ava.team)),pens:summary(await stored(pensRow.id,ava.team))};
  // Business MCP: discover actual operation and make a closed-create refusal.
  const token=await grant(ava);
  const listed=await mcp(token,'tools/list',{});
  facts.mcpTools={status:listed.status,count:listed.body.result?.tools?.length??0};
  const tool=listed.body.result?.tools?.find(item=>item.name==='OfficeSupplies.Supply.create');
  if(!tool)throw new Error('MCP Supply.create tool absent');
  const beforeMcp=await snapshot();
  const mcpOverride=await mcp(token,'tools/call',{name:tool.name,arguments:{operation_id:operationId(),name:'MCP override',available:false}});
  const afterMcp=await snapshot();
  facts.mcpClosedCreate={status:mcpOverride.status,isError:mcpOverride.body.result?.isError??null,errorCode:mcpOverride.body.result?.structuredContent?.code??mcpOverride.body.error?.code??null,changedTables:changes(beforeMcp,afterMcp)};
} catch(error) {facts.error={name:error?.name??'Error',code:error?.code??null,message:String(error?.message??error)};}
finally {await preview?.dispose();console.log(JSON.stringify(facts,null,2));}
