import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const local = path => import(pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href);
const { prepareLocalPreviewCapture } = await local('dev/preview-inputs.js');
const { captureSingleFileSource, verifyCompilerSources } = await local('dev/source-capture.js');
const { compileCapturedSingleFile } = await local('dev/compiler-check.js');
const { createLocalPreviewBuilder } = await local('dev/preview-builder.js');
const { preflightLocalPreviewActivation, localPreviewActivationVerdict, produceInstalledPortableBundle, seedLocalPreviewActors } = await local('dev/preview-host.js');
const { deriveCsrfToken } = await import(pathToFileURL(require.resolve('@canlang/identity')).href);
const { hashInputs } = await import(pathToFileURL(require.resolve('@canlang/state/invocation/replay')).href);
const output = join(root, 'test-results/can-dev-server/office-business-result.json');
const sha = value => createHash('sha256').update(value).digest('hex');
function operationId() {
  const time = Date.now().toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}
const facts = { schema: 'office-business-local.v1', outcome: 'incomplete', operations: [] };
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
    result[name]={count:rows.length,sha256:sha(JSON.stringify(rows.map(row=>JSON.stringify(row)).sort())),
      ...(name==='fence'?{revision:rows[0]?.revision}: {})};
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
async function noEffects(before, after, operation, callId, code, expected) {
  const changed = changes(before, after);
  if (changed.length === 0) return;
  assert.ok(operation && callId && code && expected, 'unexpected non-mutation D1 effect');
  let rejectedReceipts = 0;
  let rejectedOwnerLabel;
  for (const [owner, db] of ownerDbs) {
    const label = ownerLabels.get(owner);
    if (!changed.includes(`${label}:receipts`)) continue;
    const receipts = (await db.prepare('SELECT * FROM receipts').all()).results;
    const matching = receipts.filter(row => row.operation_id === callId);
    assert.equal(matching.length, 1, 'one engine rejection receipt');
    const receipt = matching[0];
    const outcome = JSON.parse(receipt.outcome);
    assert.equal(receipt.app, 'OfficeSupplies');
    assert.equal(receipt.owner, owner);
    assert.equal(receipt.owner, expected.owner, 'rejection stays in invoking team owner');
    assert.equal(receipt.principal, expected.principal, 'rejection belongs to exact authenticated caller');
    assert.equal(receipt.operation_id, callId);
    assert.equal(receipt.input_hash, await hashInputs(expected.inputs), 'rejection hashes exact submitted inputs');
    assert.deepEqual(JSON.parse(receipt.resolved_defaults), {}, 'rejection stores no resolved defaults');
    assert.equal(receipt.operation, `OfficeSupplies.Supply.${operation}`);
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.code, code);
    assert.equal(after[`${label}:receipts`].count, before[`${label}:receipts`].count + 1);
    assert.equal(sha(JSON.stringify(receipts.filter(row => row.operation_id !== callId).map(row => JSON.stringify(row)).sort())),
      before[`${label}:receipts`].sha256, 'pre-existing receipts unchanged');
    assert.equal(after[`${label}:fence`].revision, before[`${label}:fence`].revision + 1);
    assert.equal(receipt.committed_revision, after[`${label}:fence`].revision);
    assert.equal(after[`${label}:fence_log`].count, before[`${label}:fence_log`].count + 1);
    const fence = await db.prepare('SELECT operation, at FROM fence_log WHERE revision = ?').bind(receipt.committed_revision).first();
    assert.equal(fence?.operation, receipt.operation);
    assert.equal(fence?.at, receipt.created_at, 'receipt and fence belong to one canonical batch');
    const logs = (await db.prepare('SELECT * FROM fence_log').all()).results;
    assert.equal(sha(JSON.stringify(logs.filter(row => row.revision !== receipt.committed_revision).map(row => JSON.stringify(row)).sort())),
      before[`${label}:fence_log`].sha256, 'pre-existing fence log unchanged');
    for (const table of changed.filter(name => name.startsWith(`${label}:`))) {
      assert.ok(['receipts', 'fence', 'fence_log'].includes(table.slice(label.length + 1)), 'rejection changed domain/effect table');
    }
    rejectedReceipts++;
    rejectedOwnerLabel = label;
  }
  assert.equal(rejectedReceipts, 1, 'changes must be one verified rejected-receipt batch');
  assert.ok(changed.every(name => name.startsWith(`${rejectedOwnerLabel}:`) &&
    ['receipts', 'fence', 'fence_log'].includes(name.split(':')[1])), 'refusal changed another admitted resource');
}
function readRecords(result) {
  assert.equal(result.status, 200, 'authorized MCP read status');
  assert.notEqual(result.body.result?.isError, true, 'authorized MCP read refused');
  const records = result.body.result?.structuredContent?.records;
  assert.ok(Array.isArray(records), 'canonical MCP read records projection');
  return records;
}
function deniedRead(result, label) {
  assert.ok(result.status >= 400 || result.body.result?.isError === true || result.body.error, `${label} read must refuse`);
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
  const user=await identityDb.prepare('SELECT user_id FROM identity_users WHERE email_lc=?').bind(actor.email.toLowerCase()).first();
  assert.ok(user?.user_id,'actual seeded Identity principal');
  return { label:actor.label, appCookie, csrf, team, userId:user.user_id };
}
async function http(actor, operation, inputs, label, checkDenied=false) {
  const before = checkDenied ? await snapshot() : null;
  const callId = operationId();
  const response = await fetch(`${origin}/api/operations/OfficeSupplies.Supply.${operation}`, {method:'POST',headers:{cookie:[bridgeCookie,actor?.appCookie].filter(Boolean).join('; '),origin,'content-type':'application/json',...(actor?.csrf?{'x-csrf-token':actor.csrf}:{})},body:JSON.stringify({operation_id:callId,inputs})});
  let body;
  try {body=await response.json();}catch{body={parse:'invalid_json'};}
  const after = checkDenied ? await snapshot() : null;
  const entry = {label,actor:actor?.label??'Public',operation,status:response.status,code:body.code??body.error?.code??null,outcome:body.status??null,changedTables:checkDenied?changes(before,after):undefined,receiptTables:checkDenied?Object.fromEntries(changes(before,after).map(name=>[name,{before:before[name]?.count,after:after[name]?.count}])):undefined};
  facts.operations.push(entry);
  if (checkDenied) {
    assert.ok(response.status >= 400, `${label} must refuse`);
    assert.ok(entry.code, `${label} must expose an owning refusal code`);
    if (label.startsWith('O01.')) {
      assert.equal(response.status, 400, `${label} validation status`);
      assert.equal(entry.code, 'validation', `${label} validation code`);
      // Blank text passes closed-shape admission; trim/min validation runs in
      // State and commits its canonical rejected receipt, with no domain writes.
      if (label !== 'O01.blank-name') {
        assert.deepEqual(changes(before, after), [], `${label} closed create admission has zero writes`);
      } else {
        assert.ok(changes(before,after).length>0,'blank-name must reach canonical rejection commit');
      }
    }
    await noEffects(before, after, operation, callId, entry.code, {owner:actor?.team,principal:actor?.userId,inputs});
  } else {
    assert.equal(response.status, 200, `${label} status`);
    assert.equal(body.status, 'committed', `${label} canonical commit`);
  }
  return {entry,body};
}
async function grant(actor) {
  const response=await fetch(`${origin}/mcp/grants`,{method:'POST',headers:{cookie:`${bridgeCookie}; ${actor.appCookie}`,origin,'content-type':'application/json'},body:JSON.stringify({client_id:'office-business-evaluator'})});
  const body=await response.json();
  if(response.status!==200||!body.token) {
    const error = new Error(`MCP grant unavailable HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.code ?? body.error?.code ?? 'grant_unavailable';
    throw error;
  }
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
        assert.ok(error.status === 401 || error.status === 403, 'grant failure must be an actual admission refusal');
        const after = checkDenied ? await snapshot() : null;
        facts.operations.push({label,actor:actor.label,operation:'mcp.read',status:error.status,errorCode:error.code,changedTables:checkDenied?changes(before,after):undefined});
        if (checkDenied) await noEffects(before, after);
        return {status:error.status,body:{error:{code:error.code}},grantDenied:true};
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
  if (checkDenied) await noEffects(before, after);
  return result;
}
try {
  const request=prepareLocalPreviewCapture({checkoutRoot:root,appPath:'tests/integration/can-dev-server/OfficeSupplies.can',compilerPath:'compiler/target/debug/can',catalogPath:'packages/values/dist/catalog.json',helpIndexPath:'docs/specification/CONSTRUCT-HELP.md'});
  const capture=await captureSingleFileSource(request);
  const compiled = await compileCapturedSingleFile(capture);
  assert.equal(compiled.kind, 'artifact', 'captured Office compile: ' + (compiled.reason ?? compiled.kind));
  const { artifact, artifactBytes: bytes } = compiled;
  facts.sourceSha256 = capture.sourceSha256;
  facts.artifactSha256 = sha(bytes);
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
  assert.ok(ava.team && ben.team && cal.team, 'real member teams');
  assert.deepEqual(facts.teams, { avaBenSame: true, calOther: true, deeNone: true });
  // O01: source-declared create shape, defaults, and exact persisted record.
  await http(ava,'create',{},'O01.missing-name',true);
  await http(ava,'create',{name:'   '},'O01.blank-name',true);
  await http(ava,'create',{name:'Override',available:false},'O01.closed-available',true);
  const paper=await http(ava,'create',{name:'Paper'},'O01.paper');
  const paperRow=paper.body.records?.find(row=>row.data?.name==='Paper');
  if(!paperRow)throw new Error('O01 Paper create produced no row');
  facts.paper=summary(await stored(paperRow.id,ava.team));
  const paperStored = await stored(paperRow.id, ava.team);
  assert.equal(paperStored.data.name, 'Paper');
  assert.equal(paperStored.data.quantity, null);
  assert.equal(paperStored.data.available, true);
  const avaInitialRecords = readRecords(await read(ava,'O01.ava-read'));
  assert.equal(avaInitialRecords.length, 1);
  assert.ok(avaInitialRecords.some(row => row.id === paperRow.id && row.data.name === 'Paper' &&
    row.data.quantity === null && row.data.available === true));
  // O02/O03: shared Cedar item through canonical operations.
  const pens=await http(ava,'create',{name:'Pens',quantity:'4'},'O02.pens');
  const pensRow=pens.body.records?.find(row=>row.data?.name==='Pens');
  if(!pensRow)throw new Error('O02 Pens create produced no row');
  facts.pensCreated=summary(await stored(pensRow.id,ava.team));
  assert.equal((await stored(pensRow.id,ava.team)).data.quantity, '4');
  const benRead=await read(ben,'O02.ben-read');
  facts.benReadContainsPens=JSON.stringify(benRead.body).includes(pensRow.id);
  assert.ok(readRecords(benRead).some(row => row.id === pensRow.id && row.data.name === 'Pens' && row.data.quantity === '4'));
  const edit=await http(ben,'update',{record:{id:pensRow.id,version:String(pensRow.version)},name:'Blue pens',quantity:'8'},'O02.ben-edit');
  const pensEdited=await stored(pensRow.id,ava.team);
  facts.pensEdited={...summary(pensEdited),expectedValues:pensEdited?.data.name==='Blue pens'&&pensEdited?.data.quantity==='8'};
  assert.equal(facts.pensEdited.expectedValues, true);
  assert.ok(readRecords(await read(ben,'O02.ben-read-edited')).some(row => row.id === pensRow.id &&
    row.data.name === 'Blue pens' && row.data.quantity === '8'));
  const restock=await http(ben,'update',{record:{id:pensRow.id,version:String(facts.pensEdited.version)},available:false},'O03.restock');
  facts.pensRestock=summary(await stored(pensRow.id,ava.team));
  assert.equal(facts.pensRestock.available, false);
  assert.ok(readRecords(await read(ava,'O03.ava-read-restock')).some(row => row.id === pensRow.id && row.data.available === false));
  const available=await http(ben,'update',{record:{id:pensRow.id,version:String(facts.pensRestock.version)},available:true},'O03.available');
  facts.pensAvailable=summary(await stored(pensRow.id,ava.team));
  assert.equal(facts.pensAvailable.available, true);
  const beforeRemoveRecords = readRecords(await read(ava,'O03.ava-read-available'));
  assert.ok(beforeRemoveRecords.some(row => row.id === pensRow.id && row.data.available === true &&
    row.data.name === 'Blue pens' && row.data.quantity === '8'));
  // O04: ordinary archive and absence in authorized read, before cross-team probes.
  const removed=await http(ava,'delete',{record:{id:pensRow.id,version:String(facts.pensAvailable.version)}},'O04.remove');
  facts.pensAfterRemove=summary(await stored(pensRow.id,ava.team));
  assert.equal(facts.pensAfterRemove.archived, true);
  const afterRead=await read(ben,'O04.ben-read-after-remove');
  facts.afterReadContainsPens=JSON.stringify(afterRead.body).includes(pensRow.id);
  assert.equal(facts.afterReadContainsPens, false);
  assert.equal(readRecords(afterRead).length, beforeRemoveRecords.length - 1);
  assert.ok(readRecords(afterRead).some(row => row.id === paperRow.id));
  const cedarBeforeDenials = { paper: await stored(paperRow.id,ava.team), pens: await stored(pensRow.id,ava.team) };
  // O06: every denied mutation snapshots all D1 tables. Cal's create is scoped to Oak.
  grants.set(cal.label,await grant(cal));
  const calRead=await read(cal,'O06.cal-read',true);
  facts.calReadContainsCedar=JSON.stringify(calRead.body).includes(paperRow.id)||JSON.stringify(calRead.body).includes(pensRow.id);
  facts.calReadResultCode=calRead.body.result?.structuredContent?.code??calRead.body.error?.code??null;
  assert.equal(facts.calReadContainsCedar, false);
  assert.deepEqual(readRecords(calRead), []);
  const deeRead=await read(dee,'O06.dee-read',true);
  const publicRead=await read(null,'O06.public-read',true);
  deniedRead(deeRead, 'Dee');
  deniedRead(publicRead, 'Public');
  for(const actor of [dee,null,cal]) {
    const label=actor?.label??'Public';
    if(actor===cal) {
      const own=await http(cal,'create',{name:'Oak own item'},'O06.cal-oak-create');
      const oakRow=own.body.records?.find(row=>row.data?.name==='Oak own item');
      facts.calOakCreated=!!oakRow&&!!(await stored(oakRow.id,cal.team));
      assert.equal(facts.calOakCreated, true);
      assert.equal((await stored(oakRow.id,cal.team)).data.name, 'Oak own item');
      const oakRead=await read(cal,'O06.cal-own-oak-read',true);
      facts.calReadContainsOwnOak=!!oakRow&&JSON.stringify(oakRead.body).includes(oakRow.id);
      facts.calOwnReadContainsCedar=JSON.stringify(oakRead.body).includes(paperRow.id)||JSON.stringify(oakRead.body).includes(pensRow.id);
      assert.equal(facts.calReadContainsOwnOak, true);
      assert.equal(facts.calOwnReadContainsCedar, false);
      assert.ok(readRecords(oakRead).some(row => row.id === oakRow.id && row.data.name === 'Oak own item'));
      const avaRead=await read(ava,'O06.ava-read-after-oak',true);
      facts.avaReadContainsOak=!!oakRow&&JSON.stringify(avaRead.body).includes(oakRow.id);
      assert.equal(facts.avaReadContainsOak, false);
      assert.ok(readRecords(avaRead).every(row => row.id !== oakRow.id));
    } else await http(actor,'create',{name:'Denied item'},`O06.${label}-create`,true);
    let target=await stored(paperRow.id,ava.team);
    await http(actor,'update',{record:{id:paperRow.id,version:String(target.version)},name:'Denied edit'},`O06.${label}-edit`,true);
    target=await stored(paperRow.id,ava.team);
    await http(actor,'update',{record:{id:paperRow.id,version:String(target.version)},available:false},`O06.${label}-status`,true);
    target=await stored(paperRow.id,ava.team);
    await http(actor,'delete',{record:{id:paperRow.id,version:String(target.version)}},`O06.${label}-delete`,true);
  }
  facts.cedarAfterDenials={paper:summary(await stored(paperRow.id,ava.team)),pens:summary(await stored(pensRow.id,ava.team))};
  assert.deepEqual({ paper: await stored(paperRow.id,ava.team), pens: await stored(pensRow.id,ava.team) }, cedarBeforeDenials);
  // Business MCP: discover actual operation and make a closed-create refusal.
  const token=await grant(ava);
  const listed=await mcp(token,'tools/list',{});
  facts.mcpTools={status:listed.status,count:listed.body.result?.tools?.length??0};
  assert.equal(listed.status, 200);
  const tool=listed.body.result?.tools?.find(item=>item.name==='OfficeSupplies.Supply.create');
  if(!tool)throw new Error('MCP Supply.create tool absent');
  const beforeMcp=await snapshot();
  const mcpOverride=await mcp(token,'tools/call',{name:tool.name,arguments:{operation_id:operationId(),name:'MCP override',available:false}});
  const afterMcp=await snapshot();
  facts.mcpClosedCreate={status:mcpOverride.status,isError:mcpOverride.body.result?.isError??null,errorCode:mcpOverride.body.result?.structuredContent?.code??mcpOverride.body.error?.code??null,changedTables:changes(beforeMcp,afterMcp)};
  assert.equal(facts.mcpClosedCreate.errorCode, -32602, 'closed MCP create InvalidParams');
  assert.deepEqual(facts.mcpClosedCreate.changedTables, []);
  // Consume the authored compiled rows twice; each runner call creates fresh
  // row scopes from this exact installed preview bundle, independently of the
  // serving owner databases inspected throughout the business journey.
  const {loadInstalledExampleTestkit,runCompiledExamples}=await local('dev/example-runner.js');
  const applicationTestkit=await loadInstalledExampleTestkit(root);
  facts.examples=[];
  for(let attempt=1;attempt<=2;attempt++) {
    const beforeExamples=await snapshot();
    const result=await runCompiledExamples({...preview.exampleInput(),testkit:applicationTestkit,runId:operationId()});
    const changedTables=changes(beforeExamples,await snapshot());
    facts.examples.push({attempt,ok:result.ok,executed:result.executed,summary:result.report.summary,changedTables});
    assert.equal(result.executed,2,'both authored Office rows execute');
    assert.equal(result.report.summary.total,2);
    assert.equal(result.report.summary.passed,2);
    assert.equal(result.report.summary.failed,0);
    assert.equal(result.report.summary.setupFailed,0);
    assert.equal(result.report.summary.unsupported,0);
    assert.equal(result.ok,true,'authored shared-team update and forbidden outsider pass');
    assert.deepEqual(changedTables,[],'fresh example scopes leave every serving D1 table unchanged');
  }
  facts.outcome = 'passed';
} catch(error) {facts.outcome='failed';facts.error={name:error?.name??'Error',code:error?.code??null,message:String(error?.message??error).split('\n',1)[0].slice(0,400)};process.exitCode=1;}
finally {
  try { await preview?.dispose(); }
  catch(error) {facts.outcome='failed';facts.cleanupError={name:error?.name??'Error',message:String(error?.message??error).split('\n',1)[0].slice(0,250)};process.exitCode=1;}
  await mkdir(dirname(output), { recursive:true });
  await writeFile(output, JSON.stringify(facts,null,2)+'\n', {mode:0o600});
  console.log(JSON.stringify(facts,null,2));
}
