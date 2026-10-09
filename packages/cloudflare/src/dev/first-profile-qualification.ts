/** Actual, private local qualification of the finite authored HelpOffice fixture.
 * No card is returned from declaration inventory or an unexecuted example. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import { deriveCsrfToken } from '@canlang/identity';
import { hashInputs } from '@canlang/state/invocation/replay';
import { compileCapturedSingleFile } from './compiler-check.js';
import { loadInstalledExampleTestkit, runCompiledExamples } from './example-runner.js';
import { createLocalPreviewBuilder, type LocalPreviewWithActors } from './preview-builder.js';
import { localPreviewActivationVerdict, preflightLocalPreviewActivation, produceInstalledPortableBundle,
  seedLocalPreviewActors } from './preview-host.js';
import { prepareLocalPreviewCapture } from './preview-inputs.js';
import { FIRST_PROFILE } from './construct-help.js';
import type { SessionConstructQualification, SessionConstructQualificationRequest } from './session-service.js';
import { captureIsCurrent, capturedProducerInputsAreCurrent, captureSingleFileSource, verifyCompilerSources, type SingleFileCapture } from './source-capture.js';

type Qualification = { readonly id: string; readonly runtimeCheck: string; readonly exampleCheck?: string };
type Actor = { readonly cookie: string; readonly csrf: string; readonly owner: string | null; readonly principal: string };
type Row = { id: string; version: number; owner: string; archived_at: number | null; data: string };
type Snapshot = Record<string, Record<string, readonly string[]>>;
const fixturePath = 'compiler/tests/fixtures/construct-help-first-profile.can';
const app = 'HelpOffice', model = `${app}.Supply`;
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Native Invoke accepts UUIDv7 operation identities, rather than UUIDv4.
const callId = () => {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomUUID().replaceAll('-', '');
  return `${time.slice(0,8)}-${time.slice(8,12)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(8,20)}`;
};

export async function qualifyInstalledFirstProfile(capture: SingleFileCapture, signal?: AbortSignal): Promise<readonly Qualification[]> {
  const check = () => signal?.throwIfAborted();
  check(); assert.equal(await captureIsCurrent(capture), true, 'qualification requires the current caller capture');
  for (const [name,path] of [['extra:construct-profile:fixture',fixturePath],
    ['extra:construct-profile:compiler-test','compiler/tests/construct_help.rs']] as const) {
    const owned = capture.inputs.find(item => item.name===name);
    assert.ok(owned?.state==='present' && owned.sha256 && owned.canonicalPath===join(capture.root,path),
      'qualification requires captured owning fixture and released compiler case');
  }
  const input = (name: string) => {
    const found = capture.inputs.find(item => item.name === name);
    assert.ok(found?.state === 'present' && found.canonicalPath);
    return found.canonicalPath;
  };
  const fixture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: capture.root,
    appPath: join(capture.root, fixturePath), compilerPath: input('compiler'), catalogPath: input('catalog'),
    helpIndexPath: input('help-index'), semanticOptions: capture.semanticOptions }));
  check();
  assert.ok(capture.inputs.some(item => item.canonicalPath === fixture.appPath && item.sha256 === fixture.sourceSha256) ||
    capture.appPath === fixture.appPath && capture.sourceSha256 === fixture.sourceSha256,
  'owning qualification fixture must belong to the caller capture');
  const compiled = await compileCapturedSingleFile(fixture, signal);
  check();
  assert.equal(compiled.kind, 'artifact', 'owning HelpOffice fixture must compile with current native producer');
  if (compiled.kind !== 'artifact') throw new Error('HelpOffice qualification compilation failed');
  assert.equal(verifyCompilerSources(fixture, { complete: true, sources: compiled.artifact.sources }).ok, true);
  const supply = compiled.artifact.models?.find(item => item.name===model); assert.ok(supply);
  assert.equal(supply.fields.length,5);
  const field = (name: string) => { const declared=supply.fields.find(item=>item.name===name); assert.ok(declared); return declared; };
  assert.equal(field('name').field.kind,'string'); assert.equal(field('name').trim,true);
  assert.equal(field('quantity').field.kind,'integer'); assert.equal(field('quantity').nullable,true);
  assert.equal(field('available').field.kind,'boolean'); assert.deepEqual(field('available').default,{kind:'literal',value:true});
  for (const kind of ['create','update','delete','read'] as const)
    assert.ok(compiled.artifact.operations?.some(item=>item.name===`${model}.${kind}` && item.kind===kind));
  const total = compiled.artifact.operations?.find(item=>item.name===`${app}.total`); assert.ok(total);
  assert.equal(total.kind,'read'); assert.equal(total.result?.type,'int');
  const qualified = new Map<string, Qualification>();
  const pass = (ids: readonly string[], runtimeCheck: string, exampleCheck?: string) => {
    check(); for (const id of ids) qualified.set(id, Object.freeze({ id, runtimeCheck, ...(exampleCheck ? { exampleCheck } : {}) }));
  };
  const owners = new Map<string, D1Database>();
  let identities: D1Database | undefined, preview: LocalPreviewWithActors | undefined;
  const build = createLocalPreviewBuilder({ resources: { d1: { binding: 'DB', availability: 'real_local' },
    identity: { backingBinding: 'DB', availability: 'real_local' } }, activationVerdict: preflightLocalPreviewActivation,
    produceBundle: produceInstalledPortableBundle, seedLocalActors: seedLocalPreviewActors,
    confirmRunningActivation: async (artifact, source, db, id, owner, identityDb) => {
      check(); assert.ok(owner && identityDb); owners.set(owner, db); identities = identityDb;
      const verdict = await localPreviewActivationVerdict(artifact, source, db, id, owner, identityDb);
      check(); return verdict;
    } });
  try {
    check(); preview = await build(compiled.artifact, fixture, compiled.artifactBytes); check();
    assert.ok(preview.issueOpenUrl && identities); assert.equal(owners.size, 2);
    const bootstrap = await fetch(preview.issueOpenUrl(), { redirect: 'manual', ...(signal===undefined?{}:{signal}) });
    assert.equal(bootstrap.status, 303);
    const bridgeCookie = bootstrap.headers.getSetCookie().find(value => value.startsWith('can_dev_preview='))?.split(';',1)[0];
    assert.ok(bridgeCookie); const origin = new URL(bootstrap.url).origin;
    const request = async (actor: Actor | null, path: string, body?: unknown, token?: string) => {
      check(); return fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', ...(signal===undefined?{}:{signal}),
        headers: { cookie: [bridgeCookie, actor?.cookie].filter(Boolean).join('; '), origin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(actor ? { 'x-csrf-token': actor.csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(path === '/mcp' ? { accept: 'application/json, text/event-stream' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const actors = preview.issueLocalActors();
    const login = async (label: string): Promise<Actor> => {
      const seed = actors.find(actor => actor.label === label); assert.ok(seed);
      const form = await request(null, '/auth/login'); assert.equal(form.status,200);
      const pre = object(await form.json());
      const response = await request(null, '/auth/login', { email: seed.email, password: seed.password, _presession: pre.preSessionToken });
      assert.equal(response.status,200);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('can_session='))?.split(';',1)[0]; assert.ok(cookie);
      const principal = await identities!.prepare('SELECT user_id FROM identity_users WHERE email_lc=?').bind(seed.email.toLowerCase()).first<{user_id:string}>(); assert.ok(principal);
      const actor: Actor = { cookie, csrf: await deriveCsrfToken(decodeURIComponent(cookie.slice('can_session='.length))), owner: null, principal: principal.user_id };
      const listing = await request(actor, '/auth/teams'); assert.equal(listing.status,200);
      const teams = object(await listing.json()); assert.ok(Array.isArray(teams.teams));
      const owner = teams.teams.length ? string(object(teams.teams[0]).team_id) : null;
      if (owner) assert.equal((await request(actor, '/auth/select-team', { team: owner, _csrf: actor.csrf })).status,200);
      return { ...actor, owner };
    };
    const ava = await login('Ava'), ben = await login('Ben'), cal = await login('Cal'), dee = await login('Dee');
    assert.ok(ava.owner && cal.owner); assert.equal(ava.owner,ben.owner); assert.notEqual(ava.owner,cal.owner); assert.equal(dee.owner,null);
    const db = owners.get(ava.owner)!; assert.ok(db);
    const snapshot = async (): Promise<Snapshot> => {
      check(); const result: Snapshot = {};
      for (const [label, handle] of [['Identity', identities!], ...owners] as Array<[string,D1Database]>) {
        const names = (await handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{name:string}>()).results;
        const tables: Record<string, readonly string[]> = {};
        for (const {name} of names) {
          if (name.startsWith('_cf_')) continue;
          assert.match(name,/^[A-Za-z_][A-Za-z0-9_]*$/);
          tables[name] = (await handle.prepare(`SELECT * FROM "${name}"`).all()).results.map(row => JSON.stringify(row)).sort();
        }
        result[label] = tables;
      }
      return result;
    };
    const stored = (id: string) => db.prepare('SELECT id,version,owner,archived_at,data FROM records WHERE model=? AND id=?').bind(model,id).first<Row>();
    const invoke = async (actor: Actor | null, operation: string, inputs: Record<string, unknown>, id=callId()) => {
      const response = await request(actor, `/api/operations/${operation}`, { operation_id: id, inputs });
      return { status: response.status, body: object(await response.json()), id, inputs, operation };
    };
    const commit = async (operation: string, inputs: Record<string, unknown>, id=callId()) => {
      const outcome = await invoke(ava, `${model}.${operation}`, inputs, id);
      assert.equal(outcome.status,200); assert.equal(outcome.body.status,'committed'); return outcome;
    };
    // A refusal may change exactly one canonical rejected receipt/fence batch.
    const refusal = async (actor: Actor | null, operation: string, inputs: Record<string,unknown>, code: string, engine: boolean) => {
      const before = await snapshot(), outcome = await invoke(actor, `${model}.${operation}`,inputs), after = await snapshot();
      assert.ok(outcome.status>=400); assert.equal(outcome.body.code,code);
      if (!engine) { assert.deepEqual(after,before); return; }
      assert.ok(actor?.owner); const handle = owners.get(actor.owner)!;
      const receipt = await handle.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(outcome.id).first<Record<string,unknown>>(); assert.ok(receipt);
      assert.equal(receipt.app,app); assert.equal(receipt.owner,actor.owner); assert.equal(receipt.principal,actor.principal);
      assert.equal(receipt.operation,`${model}.${operation}`); assert.equal(receipt.operation_id,outcome.id);
      assert.equal(receipt.input_hash,await hashInputs(inputs)); assert.deepEqual(JSON.parse(string(receipt.resolved_defaults)),{});
      const rejected = object(JSON.parse(string(receipt.outcome))); assert.equal(rejected.status,'rejected'); assert.equal(rejected.code,code);
      const ownerBefore = before[actor.owner]!, ownerAfter = after[actor.owner]!;
      assert.equal(ownerAfter.receipts!.length,ownerBefore.receipts!.length+1);
      assert.deepEqual(ownerAfter.receipts!.filter(value => object(JSON.parse(value)).operation_id!==outcome.id),ownerBefore.receipts);
      const fence = object(JSON.parse(ownerBefore.fence![0]!)), next = object(JSON.parse(ownerAfter.fence![0]!));
      assert.deepEqual(next,{...fence,revision:Number(fence.revision)+1}); assert.equal(receipt.committed_revision,next.revision);
      assert.equal(ownerAfter.fence_log!.length,ownerBefore.fence_log!.length+1);
      const added = ownerAfter.fence_log!.map(value => object(JSON.parse(value))).find(value => value.revision===next.revision); assert.ok(added);
      assert.deepEqual(added,{revision:next.revision,operation:receipt.operation,at:receipt.created_at});
      assert.deepEqual(ownerAfter.fence_log!.filter(value => object(JSON.parse(value)).revision!==next.revision),ownerBefore.fence_log);
      const allowed = new Set(['receipts','fence','fence_log']);
      for (const [owner,tables] of Object.entries(before)) for (const [name,rows] of Object.entries(tables))
        if (owner!==actor.owner || !allowed.has(name)) assert.deepEqual(after[owner]?.[name],rows);
      assert.deepEqual(Object.keys(after),Object.keys(before));
      for (const owner of Object.keys(before)) assert.deepEqual(Object.keys(after[owner]!),Object.keys(before[owner]!));
    };
    const created = await commit('create',{name:'  Paper  ',quantity:'4'});
    assert.ok(Array.isArray(created.body.records));
    const createdProjection = created.body.records.map(object).find(value => object(value.data).name==='Paper'); assert.ok(createdProjection);
    const row = await stored(string(createdProjection.id)); assert.ok(row);
    assert.equal(row.owner,ava.owner); assert.equal(row.version,1); assert.equal(row.archived_at,null);
    assert.deepEqual(JSON.parse(row.data),{name:'Paper',quantity:'4',available:true,stock:'0',locked:false});
    const beforeReplay = await snapshot(), replay = await invoke(ava,`${model}.create`,created.inputs,created.id);
    assert.equal(replay.status,200); assert.equal(replay.body.status,'replayed'); assert.deepEqual(replay.body.result,created.body.result);
    assert.deepEqual(replay.body.records,created.body.records);
    assert.deepEqual(await snapshot(),beforeReplay);
    pass(['can.v1.app.implicit','can.v1.section.given','can.v1.section.when','can.v1.model','can.v1.schema','can.v1.field',
      'can.v1.field.trim','can.v1.field.default','can.v1.type.builtin.text','can.v1.type.builtin.int','can.v1.type.builtin.bool','can.v1.when.crud'],
    'HelpOffice: authenticated create trims text, admits int64 wire, applies defaults; identical envelope replays without resource writes');
    await refusal(ava,'create',{name:'   '},'validation',true); pass(['can.v1.field.min'],'HelpOffice: blank trimmed create rejects with one exact canonical bookkeeping batch');
    const maximum = await commit('create',{name:'x'.repeat(160),quantity:null});
    assert.ok(Array.isArray(maximum.body.records));
    const maxProjection = maximum.body.records.map(object).find(value => object(value.data).name==='x'.repeat(160)); assert.ok(maxProjection);
    const maxData = JSON.parse((await stored(string(maxProjection.id)))!.data);
    assert.equal(maxData.name.length,160); assert.equal(maxData.quantity,null);
    await refusal(ava,'create',{name:'x'.repeat(161)},'validation',true);
    pass(['can.v1.field.max'],'HelpOffice: 160 text characters commit; 161 reject without domain/effect writes');
    const nullable = await commit('create',{name:'Nullable'}); assert.ok(Array.isArray(nullable.body.records));
    const nullableProjection = nullable.body.records.map(object).find(value => object(value.data).name==='Nullable'); assert.ok(nullableProjection);
    assert.equal(JSON.parse((await stored(string(nullableProjection.id)))!.data).quantity,null);
    pass(['can.v1.type.nullable'],'HelpOffice: explicit null and omitted nullable int persist as native wire null');
    await refusal(ava,'create',{name:'Closed',available:false},'validation',false);
    for (const actor of [dee,null]) await refusal(actor,'create',{name:'Forbidden'},'forbidden',false);
    await refusal(cal,'update',{record:{id:row.id,version:'1'},name:'Foreign'},'not_found',false);
    const reference = {id:row.id,version:'1'};
    await refusal(ava,'update',{record:reference,stock:'-1'},'rule_failed',true);
    pass(['can.v1.invariant'],'HelpOffice: negative stock rejects and preserves records/history/effects, other owner and Identity');
    await commit('update',{record:reference,locked:true});
    const locked = await stored(row.id); assert.ok(locked); assert.equal(locked.version,2); assert.equal(JSON.parse(locked.data).locked,true);
    await refusal(ava,'update',{record:{id:row.id,version:'2'},name:'Blocked'},'rule_failed',true);
    await commit('update',{record:{id:row.id,version:'2'},locked:false});
    const unlocked = await stored(row.id); assert.ok(unlocked); assert.equal(unlocked.version,3);
    assert.deepEqual(JSON.parse(unlocked.data),{...JSON.parse(locked.data),locked:false});
    await commit('update',{record:{id:row.id,version:'3'},name:'Unlocked paper'});
    const renamed = await stored(row.id); assert.ok(renamed); assert.equal(renamed.version,4);
    assert.deepEqual(JSON.parse(renamed.data),{...JSON.parse(unlocked.data),name:'Unlocked paper'});
    pass(['can.v1.lock'],'HelpOffice: entry-locked name change rejects with exact canonical bookkeeping; unlock changes only locked, then next transaction changes name');
    const grant = await request(ben,'/mcp/grants',{client_id:'first-profile-qualification'}); assert.equal(grant.status,200);
    const token = string(object(await grant.json()).token);
    const calGrant = await request(cal,'/mcp/grants',{client_id:'first-profile-qualification'}); assert.equal(calGrant.status,200);
    const calToken = string(object(await calGrant.json()).token);
    const read = async (name: string, actor: Actor | null=ben, bearer: string | undefined=token) => {
      const response = await request(actor,'/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}},bearer);
      return {status:response.status,body:object(await response.json())};
    };
    const listed = await read(`${model}.read`); assert.equal(listed.status,200);
    const content = object(object(listed.body.result).structuredContent); assert.ok(Array.isArray(content.records));
    assert.ok(content.records.some(value=>object(value).id===row.id));
    const beforeReadDenials = await snapshot();
    const foreignRead = await read(`${model}.read`,cal,calToken); assert.equal(foreignRead.status,200);
    assert.notEqual(object(foreignRead.body.result).isError,true);
    assert.deepEqual(object(object(foreignRead.body.result).structuredContent).records,[]);
    const outsiderGrant = await request(dee,'/mcp/grants',{client_id:'first-profile-qualification'});
    assert.ok(outsiderGrant.status===401 || outsiderGrant.status===403,'nonmember read grant must refuse');
    assert.equal(object(await outsiderGrant.json()).code,'forbidden');
    // No bearer is sent for the actual anonymous read; session cookies do not substitute MCP authority.
    const publicRead = await read(`${model}.read`,null,'');
    assert.ok(publicRead.status===401 || publicRead.status===403);
    assert.deepEqual(await snapshot(),beforeReadDenials,'read/grant refusals and foreign-owner read preserve every D1 resource');
    pass(['can.v1.policy'],'HelpOffice: actual member Supply.read succeeds, foreign-owner read is empty, nonmember grant/public read and unauthorized writes refuse without resource writes');
    const beforeCount = await snapshot(), counted = await read(`${app}.total`);
    assert.deepEqual(await snapshot(),beforeCount);
    assert.equal(counted.status,200); assert.equal(counted.body.error,undefined);
    const countedResult = object(counted.body.result);
    assert.notEqual(countedResult.isError,true,'actual readonly total must use the public read consumer');
    assert.equal(object(countedResult.structuredContent).result,'3');
    pass(['can.v1.when.scenario.read','can.v1.builtin.count'],'HelpOffice: actual member MCP readonly total returns three visible supplies without resource writes');
    await commit('delete',{record:{id:row.id,version:'4'}});
    const archived = await stored(row.id); assert.ok(archived); assert.notEqual(archived.archived_at,null); assert.equal(archived.version,5);
    const afterArchive = await read(`${model}.read`);
    assert.equal(afterArchive.status,200);
    const visible = object(object(afterArchive.body.result).structuredContent); assert.ok(Array.isArray(visible.records));
    assert.equal(visible.records.some(value=>object(value).id===row.id),false);
    // Browser delete/page/form cards remain unqualified: this is an HTTP CRUD check.
    // Absence is an honest unqualified example surface, not a fabricated runner.
    // A present producer's load/runtime errors remain failures.
    if (fixture.inputs.some(item => item.state==='present' && item.name.startsWith('package:@canlang/testkit@'))) {
      const testkit = await loadInstalledExampleTestkit(capture.root); check();
      const before = await snapshot();
      for (const rowIndex of [0,1]) {
        check(); const result = await runCompiledExamples({...preview.exampleInput(),testkit,...(signal===undefined?{}:{signal}),runId:callId(),
          selectedRow:{operation:`${model}.update`,rowIndex}});
        assert.deepEqual(await snapshot(),before,'actual isolated authored rows preserve all serving resources');
        assert.equal(result.ok,true,'selected actual authored CRUD row must pass');
        assert.equal(result.executed,1); assert.equal(result.report.summary.total,1); assert.equal(result.report.summary.passed,1);
        assert.equal(result.report.summary.failed,0); assert.equal(result.report.summary.setupFailed,0); assert.equal(result.report.summary.unsupported,0);
        pass(rowIndex===0 ? ['can.v1.examples.table.crud','can.v1.fixture.model'] : ['can.v1.examples.table.error'],
          rowIndex===0 ? 'HelpOffice: actual compiled Supply.update model fixture row observes its successful changes in isolated D1/Identity'
            : 'HelpOffice: actual compiled Supply.update outsider row observes forbidden and no effects in isolated D1/Identity',
          `${model}.update#${rowIndex}: passed`);
      }
    }
    check(); assert.equal(await captureIsCurrent(fixture),true); assert.equal(await captureIsCurrent(capture),true);
    return Object.freeze([...qualified.values()]);
  } finally {
    await preview?.dispose();
    assert.equal(await captureIsCurrent(fixture),true,'qualification fixture remained current through cleanup');
    assert.equal(await captureIsCurrent(capture),true,'caller capture remained current through cleanup');
    check();
  }
}

/** Daemon-owned provider; callers cannot supply proof records or select branches.
 * Completed outcomes, including unknown after an unchanged producer refusal,
 * are retained for at most four tuples. Cancellation/races retain nothing.
 */
export function createInstalledFirstProfileQualification() {
  const completed = new Map<string, SessionConstructQualification | null>();
  return async (request: SessionConstructQualificationRequest & { readonly capture: SingleFileCapture },
    signal?: AbortSignal): Promise<SessionConstructQualification | null> => {
    signal?.throwIfAborted();
    const capture = request.capture;
    assert.equal(request.producerInputsDigest,sha(JSON.stringify(capture.inputs)));
    assert.deepEqual(request.inputs,capture.inputs);
    assert.equal(request.authoringProfile,FIRST_PROFILE);
    assert.equal(request.resourceProfile,capture.profile);
    assert.equal(await capturedProducerInputsAreCurrent(capture),true);
    signal?.throwIfAborted();
    const compiler = capture.inputs.find(item=>item.name==='compiler');
    assert.equal(compiler?.state,'present'); assert.equal(compiler?.sha256,request.compilerSha256);
    for (const [name,path] of [['extra:construct-profile:fixture',fixturePath],
      ['extra:construct-profile:compiler-test','compiler/tests/construct_help.rs']] as const) {
      const owned=capture.inputs.find(item=>item.name===name);
      assert.ok(owned?.state==='present' && owned.sha256 && owned.canonicalPath===join(capture.root,path),
        'qualification requires the exact captured owning fixture and compiler case');
      assert.ok(request.inputs.some(item=>item.name===name && item.sha256===owned.sha256 && item.canonicalPath===owned.canonicalPath));
    }
    const key=sha(JSON.stringify([capture.root,request.resourceProfile,request.authoringProfile,
      request.indexRevision,request.compilerSha256,request.producerInputsDigest,capture.semanticOptions,
      capture.inputs.filter(item=>item.name.startsWith('extra:construct-profile:'))]));
    if(completed.has(key)) {
      assert.equal(await capturedProducerInputsAreCurrent(capture),true); signal?.throwIfAborted(); return completed.get(key)!;
    }
    let actual: readonly Qualification[];
    try { actual=await qualifyInstalledFirstProfile(capture,signal); }
    catch(error) {
      if (!signal?.aborted && await captureIsCurrent(capture) && !signal?.aborted) {
        completed.set(key,null);
        while(completed.size>4) completed.delete(completed.keys().next().value!);
      }
      throw error;
    }
    signal?.throwIfAborted(); assert.equal(await capturedProducerInputsAreCurrent(capture),true); signal?.throwIfAborted();
    const fixtureIdentity=capture.inputs.find(item=>item.name==='extra:construct-profile:fixture')!;
    const result: SessionConstructQualification=Object.freeze({ resourceProfile:request.resourceProfile,
      authoringProfile:FIRST_PROFILE,indexRevision:request.indexRevision,compilerSha256:request.compilerSha256,
      producerInputsDigest:request.producerInputsDigest,messageKinds:Object.freeze([]),
      proofs:Object.freeze(actual.map(record=>Object.freeze({ ...record,indexRevision:request.indexRevision,
        profile:FIRST_PROFILE,compilerSha256:request.compilerSha256,
        compilerCheck:`compiler/tests/construct_help.rs::first_profile_compiler_cards_have_checked_source_and_emitted_owners[${record.id}]; executed captured native compile ${fixturePath} sha256:${fixtureIdentity.sha256}; complete source identity verified; ${record.exampleCheck ? 'emitted compiled example suite consumed by owning Testkit' : record.id==='can.v1.when.scenario.read' || record.id==='can.v1.builtin.count' ? 'emitted HelpOffice.total read descriptor consumed by public MCP' : 'emitted Supply CRUD/model descriptors consumed by public runtime'}` }))) });
    signal?.throwIfAborted(); completed.set(key,result);
    while(completed.size>4) completed.delete(completed.keys().next().value!);
    return result;
  };
}
