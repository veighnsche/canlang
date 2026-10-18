/** Actual, private local qualification of the finite authored HelpOffice fixture.
 * No card is returned from declaration inventory or an unexecuted example. */
import assert from 'node:assert/strict';
import { RuntimeExampleResources } from './runtime-host-example-resources.js';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, deriveCsrfToken, resolveIdentity } from '@canlang/identity';
import { hashInputs } from '@canlang/state/invocation/replay';
import { compileCapturedSingleFile } from './compiler-check.js';
import { loadInstalledExampleTestkit, runCompiledExamples } from './example-runner.js';
import { createLocalPreviewBuilder, type LocalPreviewWithActors } from './preview-builder.js';
import { localPreviewActivationVerdict, preflightLocalPreviewActivation, produceInstalledPortableBundle,
  seedLocalPreviewActors, localPreviewWorkerVars } from './preview-host.js';
import { loadInstalledChromium, prepareLocalPreviewCapture } from './preview-inputs.js';
import { qualifyFirstProfileBrowser, type FirstProfileBrowserInput } from './first-profile-browser.js';
import { FIRST_PROFILE, parseCompilerConstructCandidates, type QualifiedConstructProof } from './construct-help.js';
import { captureIsCurrent, capturedProducerInputsAreCurrent, captureSingleFileSource, verifyCompilerSources, type SingleFileCapture } from './source-capture.js';

/** Trusted runtime evidence, never accepted from control callers. */
export interface FirstProfileConstructQualification {
  readonly resourceProfile: string;
  readonly authoringProfile: typeof FIRST_PROFILE;
  readonly indexRevision: string;
  readonly compilerSha256: string;
  /** Hash of exact captured producer identities, independent of application source. */
  readonly producerInputsDigest: string;
  /** Finite owning normalized diagnostic branches qualified for bounded ranking. */
  readonly messageKinds: readonly string[];
  readonly proofs: readonly QualifiedConstructProof[];
}

export interface FirstProfileConstructQualificationRequest {
  readonly resourceProfile: string;
  readonly authoringProfile: typeof FIRST_PROFILE;
  readonly indexRevision: string;
  readonly compilerSha256: string;
  readonly producerInputsDigest: string;
  readonly inputs: SingleFileCapture["inputs"];
  /** Private trusted runtime input, never an external ranking packet. */
  readonly capture: SingleFileCapture;
}

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

/** Qualify the current diagnostic branch from the captured native producer.
 * Compiler owns semantic checking and the complete collection inventory. */
async function qualifyCurrentCollectionBranch(capture: SingleFileCapture, signal?: AbortSignal): Promise<readonly string[]> {
  signal?.throwIfAborted();
  const compiled = await compileCapturedSingleFile(capture,signal);
  signal?.throwIfAborted();
  assert.equal(await captureIsCurrent(capture),true); signal?.throwIfAborted();
  if (compiled.kind !== 'diagnostics' || compiled.envelope.complete !== true ||
      object(compiled.envelope).omitted !== 0 || compiled.envelope.diagnostics.length !== 1) return Object.freeze([]);
  const diagnostic = object(compiled.envelope.diagnostics[0]);
  const routing = parseCompilerConstructCandidates(diagnostic.construct_candidates), context = routing.context;
  if (diagnostic.code !== 'E2001' || diagnostic.severity !== 'error' || routing.disposition !== 'exact' ||
      !routing.complete || routing.slot !== 'then.collection-presentation' ||
      [...routing.ids].sort().join(',') !== 'can.v1.ui.list,can.v1.ui.table' ||
      context?.messageKind !== 'unknown_collection_presentation' || context.section !== 'Then' ||
      !context.exactSourceSpan || !context.recoveryComplete || !context.nameFilterComplete ||
      context.structuralRecovery || !context.materialIntentChoice || context.evidenceSufficient ||
      context.unsupportedBehaviorProven) return Object.freeze([]);
  const span = object(diagnostic.primary), bytes = Buffer.from(capture.sourceText,'utf8');
  if (span.file !== 0 || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
      Number(span.start) < 0 || Number(span.end) <= Number(span.start) || Number(span.end) > bytes.length ||
      !bytes.subarray(Number(span.start),Number(span.end)).equals(Buffer.from(context.guess))) return Object.freeze([]);
  return Object.freeze(['unknown_collection_presentation']);
}
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
  const renameOperation = `${app}.rename`;
  const rename = compiled.artifact.operations?.find(item=>item.name===renameOperation); assert.ok(rename);
  assert.equal(rename.kind,'scenario'); assert.equal(rename.result?.type,'void');
  const renamePlan = rename.result?.disclosure; assert.ok(renamePlan);
  const renameCallable = compiled.artifact.callables.find(item=>item.id===renameOperation && item.kind==='operation'); assert.ok(renameCallable);
  assert.equal(renameCallable.inputStyle,'parameters'); assert.equal(renameCallable.module,renamePlan.source.module);
  assert.ok(compiled.artifact.modules.some(item=>item.path===renameCallable.module));
  assert.ok(renamePlan.returns.some(result=>result.intrinsics?.some(intrinsic=>
    intrinsic.kind==='admitted-input' && intrinsic.parameter==='name' && intrinsic.type==='text')));
  const qualified = new Map<string, Qualification>();
  const pass = (ids: readonly string[], runtimeCheck: string, exampleCheck?: string) => {
    check(); for (const id of ids) qualified.set(id, Object.freeze({ id, runtimeCheck, ...(exampleCheck ? { exampleCheck } : {}) }));
  };
  const owners = new Map<string, D1Database>();
  let identities: D1Database | undefined, preview: LocalPreviewWithActors | undefined;
  const resources = new RuntimeExampleResources(), previewKey = {}, preflightKey = {};
  const release = () => resources.drain();
  const build = createLocalPreviewBuilder({ onAllocated: dispose => resources.retain(previewKey, dispose), resources: { d1: { binding: 'DB', availability: 'real_local' },
    identity: { backingBinding: 'DB', availability: 'real_local' } }, activationVerdict: (artifact, source) => preflightLocalPreviewActivation(artifact, source, {},
      dispose => resources.retain(preflightKey, dispose)),
    produceBundle: produceInstalledPortableBundle, seedLocalActors: db => seedLocalPreviewActors(db),
    workerVarsForOrigin: localPreviewWorkerVars,
    confirmRunningActivation: async (artifact, source, db, id, owner, identityDb) => {
      check(); assert.ok(owner && identityDb); owners.set(owner, db); identities = identityDb;
      const verdict = await localPreviewActivationVerdict(artifact, source, db, id, owner, identityDb);
      check(); return verdict;
    } });
  try {
    check(); preview = await build(compiled.artifact, fixture, compiled.artifactBytes, qualificationBuildContext(signal)); check();
    resources.retain(previewKey, () => preview!.dispose());
    assert.ok(preview.issueOpenUrl && identities); assert.equal(owners.size, 2);
    const bootstrap = await fetch(preview.issueOpenUrl(), { redirect: 'manual', ...(signal===undefined?{}:{signal}) });
    assert.equal(bootstrap.status, 303);
    const bridgeCookie = bootstrap.headers.getSetCookie().find(value => value.startsWith('can_dev_preview='))?.split(';',1)[0];
    assert.ok(bridgeCookie); const origin = new URL(bootstrap.url).origin;
    const request = async (actor: Actor | null, path: string, body?: unknown, token?: string, additionalCookie?: string) => {
      check(); return fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', ...(signal===undefined?{}:{signal}),
        headers: { cookie: [bridgeCookie, actor?.cookie, additionalCookie].filter(Boolean).join('; '), origin,
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
      const preSessionToken = string(pre.preSessionToken); assert.ok(preSessionToken);
      const preSessionCookies = form.headers.getSetCookie().filter(value => value.startsWith('can_presession='));
      assert.equal(preSessionCookies.length,1);
      const preSessionCookie = preSessionCookies[0]!.split(';',1)[0];
      assert.ok(preSessionCookie && preSessionCookie !== 'can_presession=');
      const response = await request(null, '/auth/login', { email: seed.email, password: seed.password, _presession: preSessionToken }, undefined, preSessionCookie);
      assert.equal(response.status,200);
      const sessionCookies = response.headers.getSetCookie().filter(value => value.startsWith('can_session='));
      assert.equal(sessionCookies.length,1);
      const cookie = sessionCookies[0]!.split(';',1)[0]; assert.ok(cookie && cookie !== 'can_session=');
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
    // State's D1 adapter leaves this legacy row column empty; the actual
    // owner boundary is its persisted physical database pin and route.
    assert.equal(row.owner,'');
    for (const owner of [ava.owner,cal.owner]) {
      const handle = owners.get(owner)!; assert.ok(handle);
      assert.deepEqual(await handle.prepare('SELECT app,owner FROM state_owner_pin WHERE id=1').first(),{app,owner});
    }
    assert.equal(await owners.get(cal.owner)!.prepare('SELECT id FROM records WHERE model=? AND id=?').bind(model,row.id).first(),null,
      'the created row belongs only to its actual pinned owner database');
    assert.equal(row.version,1); assert.equal(row.archived_at,null);
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
    // The actual second member executes Compiler's checked Set/void scenario
    // on the existing nullable row, using its original admitted reference.
    const renameEntry = await stored(string(nullableProjection.id)); assert.ok(renameEntry); assert.equal(renameEntry.version,1);
    const renameInputs = {supply:{id:renameEntry.id,version:'1'},name:'Shared nullable paper'};
    const beforeRename = await snapshot(), renamedScenario = await invoke(ben,renameOperation,renameInputs);
    assert.equal(renamedScenario.status,200); assert.equal(renamedScenario.body.status,'committed');
    assert.equal(renamedScenario.body.result,null);
    const renameCurrent = await stored(renameEntry.id); assert.ok(renameCurrent); assert.equal(renameCurrent.version,2);
    assert.deepEqual(JSON.parse(renameCurrent.data),{...JSON.parse(renameEntry.data),name:renameInputs.name});
    assert.ok(Array.isArray(renamedScenario.body.records));
    const renameProjection = renamedScenario.body.records.map(object).find(value=>value.id===renameEntry.id); assert.ok(renameProjection);
    assert.equal(String(renameProjection.version),'2'); assert.deepEqual(renameProjection.data,JSON.parse(renameCurrent.data));
    assert.equal(JSON.stringify(renamedScenario.body).includes('scenario-result/v1'),false);
    const renameReceipt = await db.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(renamedScenario.id).first<Record<string,unknown>>(); assert.ok(renameReceipt);
    assert.equal(renameReceipt.app,app); assert.equal(renameReceipt.owner,ben.owner); assert.equal(renameReceipt.principal,ben.principal);
    assert.equal(renameReceipt.operation,renameOperation); assert.equal(renameReceipt.input_hash,await hashInputs(renameInputs));
    assert.deepEqual(JSON.parse(string(renameReceipt.resolved_defaults)),{});
    const savedRename = object(JSON.parse(string(renameReceipt.outcome))); assert.equal(savedRename.status,'committed'); assert.equal(savedRename.result,null);
    const association = object(savedRename.scenario); assert.equal(association.kind,'scenario-result/v1');
    assert.deepEqual(association.plan,renamePlan); assert.equal(association.resultType,'void');
    assert.ok(Array.isArray(association.intrinsics));
    const selectedRenameReturn = renamePlan.returns.find(value=>value.id===association.returnId); assert.ok(selectedRenameReturn);
    const renameInputDependency = selectedRenameReturn.intrinsics?.find(value=>value.kind==='admitted-input' && value.parameter==='name'); assert.ok(renameInputDependency);
    assert.ok(association.intrinsics.some(value=>{const intrinsic=object(value);return intrinsic.dependencyId===renameInputDependency.id && intrinsic.kind==='admitted-input' && intrinsic.wire===renameInputs.name;}));
    const afterRename = await snapshot(), ownBefore = beforeRename[ava.owner]!, ownAfter = afterRename[ava.owner]!;
    assert.equal(ownAfter.receipts!.length,ownBefore.receipts!.length+1);
    assert.deepEqual(ownAfter.receipts!.filter(value=>object(JSON.parse(value)).operation_id!==renamedScenario.id),ownBefore.receipts);
    assert.equal(ownAfter.records!.length,ownBefore.records!.length);
    const originalStored = ownBefore.records!.map(value=>object(JSON.parse(value))).find(value=>value.model===model && value.id===renameEntry.id); assert.ok(originalStored);
    const currentStored = ownAfter.records!.map(value=>object(JSON.parse(value))).find(value=>value.model===model && value.id===renameEntry.id); assert.ok(currentStored);
    assert.deepEqual(currentStored,{...originalStored,version:2,data:renameCurrent.data,updated:renameReceipt.created_at,updated_by:ben.principal});
    assert.ok(Array.isArray(association.changed)); assert.equal(association.changed.length,1);
    const savedChanged = object(association.changed[0]); assert.equal(savedChanged.model,model);
    assert.equal(object(savedChanged.row).id,renameEntry.id); assert.equal(object(savedChanged.row).version,2);
    assert.deepEqual(object(savedChanged.row).data,JSON.parse(renameCurrent.data));
    assert.deepEqual(savedRename.recordVersions,[{model,id:renameEntry.id,version:2}]);
    assert.deepEqual(ownAfter.records!.filter(value=>object(JSON.parse(value)).id!==renameEntry.id),ownBefore.records!.filter(value=>object(JSON.parse(value)).id!==renameEntry.id));
    assert.equal(ownAfter.history!.length,ownBefore.history!.length+1);
    assert.deepEqual(ownAfter.history!.filter(value=>object(JSON.parse(value)).operation_id!==renamedScenario.id),ownBefore.history);
    const history = ownAfter.history!.map(value=>object(JSON.parse(value))).filter(value=>value.operation_id===renamedScenario.id);
    assert.equal(history.length,1); assert.equal(history[0]!.model,model); assert.equal(history[0]!.record_id,renameEntry.id);
    assert.equal(history[0]!.version,2); assert.equal(history[0]!.operation,renameOperation); assert.equal(history[0]!.actor,ben.principal);
    assert.deepEqual(JSON.parse(string(history[0]!.before)),JSON.parse(renameEntry.data));
    assert.deepEqual(JSON.parse(string(history[0]!.after)),JSON.parse(renameCurrent.data));
    const fence = object(JSON.parse(ownBefore.fence![0]!)), nextFence = object(JSON.parse(ownAfter.fence![0]!));
    assert.deepEqual(nextFence,{...fence,revision:Number(fence.revision)+1}); assert.equal(renameReceipt.committed_revision,nextFence.revision);
    assert.equal(ownAfter.fence_log!.length,ownBefore.fence_log!.length+1);
    assert.deepEqual(ownAfter.fence_log!.filter(value=>object(JSON.parse(value)).revision!==nextFence.revision),ownBefore.fence_log);
    assert.deepEqual(ownAfter.fence_log!.map(value=>object(JSON.parse(value))).find(value=>value.revision===nextFence.revision),
      {revision:nextFence.revision,operation:renameOperation,at:renameReceipt.created_at});
    const changedTables = new Set(['records','receipts','history','fence','fence_log']);
    assert.deepEqual(Object.keys(afterRename),Object.keys(beforeRename));
    for(const [owner,tables] of Object.entries(beforeRename)) {
      assert.deepEqual(Object.keys(afterRename[owner]!),Object.keys(tables));
      for(const [name,rows] of Object.entries(tables)) if(owner!==ava.owner || !changedTables.has(name)) assert.deepEqual(afterRename[owner]![name],rows);
    }
    const renameReplay = await invoke(ben,renameOperation,renameInputs,renamedScenario.id);
    assert.equal(renameReplay.status,200); assert.equal(renameReplay.body.status,'replayed');
    assert.equal(renameReplay.body.result,null); assert.deepEqual(renameReplay.body.records,renamedScenario.body.records);
    assert.deepEqual(await snapshot(),afterRename,'same scenario envelope preserves original receipt/history and all resources');
    const foreignRename = await invoke(cal,renameOperation,{supply:{id:renameEntry.id,version:'2'},name:'Foreign rename'});
    assert.ok(foreignRename.status>=400); assert.equal(foreignRename.body.code,'not_found');
    assert.deepEqual(await snapshot(),afterRename,'foreign-owner scenario reference refuses before any write');
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
    const sharedRename = content.records.map(object).find(value=>value.id===renameEntry.id); assert.ok(sharedRename);
    assert.equal(String(sharedRename.version),'2'); assert.deepEqual(sharedRename.data,JSON.parse(renameCurrent.data));
    pass(['can.v1.when.scenario.user'],'HelpOffice: Ben executes checked rename Set/void with admitted name on original nullable version1; one version2/history/receipt, shared readback, exact replay and foreign-owner refusal preserve all unrelated resources');
    const beforeReadDenials = await snapshot();
    const foreignRead = await read(`${model}.read`,cal,calToken); assert.equal(foreignRead.status,200);
    assert.notEqual(object(foreignRead.body.result).isError,true);
    assert.deepEqual(object(object(foreignRead.body.result).structuredContent).records,[]);
    const outsiderGrant = await request(dee,'/mcp/grants',{client_id:'first-profile-qualification'});
    assert.equal(outsiderGrant.status,403,'authenticated nonmember read grant must refuse');
    assert.deepEqual(object(await outsiderGrant.json()),{error:'mcp-grant needs an active team membership'},
      'consume the actual grant-admission envelope, not the operation business-error shape');
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
      for (const rowIndex of [0,1,2]) {
        check(); const result = await runCompiledExamples({...preview.exampleInput(),testkit,...(signal===undefined?{}:{signal}),runId:callId(),
          selectedRow:{operation:`${model}.update`,rowIndex}});
        assert.deepEqual(await snapshot(),before,'actual isolated authored rows preserve all serving resources');
        const failedRows = result.report.cases.flatMap(entry => entry.kind==='table' ? entry.rows
          .filter(row=>row.outcome!=='passed').map(({rowIndex,outcome,detail,mismatches})=>
            ({operation:entry.operation,rowIndex,outcome,detail,mismatches})) : []);
        assert.equal(result.ok,true,`selected actual authored CRUD row must pass: ${JSON.stringify(failedRows)}`);
        assert.equal(result.executed,1); assert.equal(result.report.summary.total,1); assert.equal(result.report.summary.passed,1);
        assert.equal(result.report.summary.failed,0); assert.equal(result.report.summary.setupFailed,0); assert.equal(result.report.summary.unsupported,0);
        const tables = result.report.cases.filter(entry=>entry.kind==='table'); assert.equal(tables.length,1);
        const table = tables[0]!; assert.equal(table.operation,`${model}.update`); assert.equal(table.rows.length,1);
        const selected = table.rows[0]!; assert.equal(selected.rowIndex,rowIndex); assert.equal(selected.outcome,'passed');
        assert.equal(selected.caller.authenticated,true); assert.equal(selected.caller.team,'current');
        // Testkit's owning provisionRowAccounts derives these opaque accounts
        // from the original authored row index and suite recipe name.
        assert.equal(selected.caller.account,rowIndex===1 ? 'row-1-user-person' : `row-${rowIndex}-${rowIndex===0 ? 'other' : 'outsider'}`);
        assert.deepEqual(selected.caller.roles,rowIndex===1 ? [`${app}.reviewer`] : rowIndex===0 ? ['members'] : []);
        if(rowIndex===2) assert.deepEqual(selected.rejection,{error:'forbidden',sideEffectsAbsent:true});
        else { assert.equal(selected.rejection,undefined); assert.equal(selected.mismatches?.length ?? 0,0); }
        pass(rowIndex===0 ? ['can.v1.examples.table.crud','can.v1.fixture.model'] :
          rowIndex===1 ? ['can.v1.fixture.user'] : ['can.v1.examples.table.error'],
          rowIndex===0 ? 'HelpOffice: actual compiled Supply.update other-member row observes A4 paper/8 in isolated D1/Identity'
            : rowIndex===1 ? 'HelpOffice: actual compiled Supply.update person row authenticates row-1-user-person in current team with HelpOffice.reviewer and observes Reviewed paper/6 in isolated D1/Identity'
            : 'HelpOffice: actual compiled Supply.update outsider row authenticates without roles and observes exact forbidden with sideEffectsAbsent in isolated D1/Identity',
          `${model}.update#${rowIndex}: passed`);
      }
      check(); const scenarioRow = await runCompiledExamples({...preview.exampleInput(),testkit,...(signal===undefined?{}:{signal}),runId:callId(),
        selectedRow:{operation:renameOperation,rowIndex:0}});
      assert.deepEqual(await snapshot(),before,'actual isolated authored rename row preserves all serving resources');
      const scenarioFailures = scenarioRow.report.cases.flatMap(entry=>entry.kind==='table' ? entry.rows
        .filter(row=>row.outcome!=='passed').map(({rowIndex,outcome,detail,mismatches})=>
          ({operation:entry.operation,rowIndex,outcome,detail,mismatches})) : []);
      assert.equal(scenarioRow.ok,true,`selected actual authored rename row must pass: ${JSON.stringify(scenarioFailures)}`);
      assert.equal(scenarioRow.executed,1); assert.equal(scenarioRow.report.summary.total,1); assert.equal(scenarioRow.report.summary.passed,1);
      assert.equal(scenarioRow.report.summary.failed,0); assert.equal(scenarioRow.report.summary.setupFailed,0); assert.equal(scenarioRow.report.summary.unsupported,0);
      pass(['can.v1.examples.table.scenario'],'HelpOffice: actual compiled rename row uses other member and editable model fixture, observes New paper after checked Set in isolated D1/Identity',`${renameOperation}#0: passed`);
    }
    // The optional Node producer never supplies an outcome by availability alone.
    const chromium = await loadInstalledChromium(capture.root); check();
    if (chromium !== null) {
      const availability = await chromium.producer.chromiumAvailability(); check();
      const producerInput = fixture.inputs.find(item=>item.name==='extra:browser:producer');
      assert.equal(producerInput?.canonicalPath,chromium.entryPath);
      for (const browserInput of fixture.inputs.filter(item=>item.name.startsWith('extra:browser:'))) {
        assert.deepEqual(capture.inputs.find(item=>item.name===browserInput.name),browserInput,
          'browser producer belongs to the original full capture');
      }
      if (availability.available) {
        const pages = compiled.artifact.pages?.filter(page=>page.path==='/') ?? [];
        assert.equal(pages.length,1,'browser qualification requires one actual compiled root page descriptor');
        const page = pages[0]!;
        assert.equal(page.owner,app,'browser preference owner must be the compiled HelpOffice declaring package');
        const preferenceOwner = page.owner;
        const driver = fixture.inputs.find(item=>item.canonicalPath===availability.identity.driverEntryPath);
        const executable = fixture.inputs.find(item=>item.name==='extra:browser:executable');
        assert.ok(driver?.state==='present');
        assert.equal(executable?.requestedPath,availability.identity.executablePath);
        assert.equal(await captureIsCurrent(fixture),true); check();
        const lease = await chromium.producer.acquireChromium(signal===undefined ? {} : {signal});
        resources.retain(lease, () => lease.close());
        const browserPreview = preview;
        await resources.using(lease, async () => {
          check(); assert.deepEqual(lease.identity,availability.identity);
          const browserActors = new Map<string,Actor>();
          const expectedActors = {Ava:ava,Ben:ben,Cal:cal,Dee:dee};
          const browserInput: FirstProfileBrowserInput = {
            browser:lease.browser,preview:browserPreview,...(signal===undefined?{}:{signal}),expectedActors,snapshot,
            initialVisible:(await db.prepare('SELECT data FROM records WHERE model=? AND archived_at IS NULL').bind(model)
              .all<{data:string}>()).results.map(row=>{
                const data=object(JSON.parse(row.data)); return {name:string(data.name),
                  quantity:data.quantity===null ? null : string(data.quantity),available:data.available===true};
              }),
            onAuthenticated:async(label,facts)=>{
              check(); const token=decodeURIComponent(facts.cookie.slice('can_session='.length));
              const identity=await resolveIdentity(createD1IdentityStore(identities!),{session_token:token});
              const expected=expectedActors[label];
              assert.equal(identity.actor?.user_id,expected.principal);
              assert.equal(identity.team?.team_id ?? null,expected.owner);
              assert.equal(identity.membership?.status ?? null,expected.owner===null ? null : 'active');
              assert.equal(facts.csrf,await deriveCsrfToken(token));
              const actor={...expected,cookie:facts.cookie,csrf:facts.csrf}; browserActors.set(label,actor);
              if(label==='Cal') await refusal(actor,'update',{record:{id:renameEntry.id,version:'2'},name:'Foreign browser'},'not_found',false);
              if(label==='Dee') await refusal(actor,'create',{name:'Forbidden browser'},'forbidden',false);
              check();
            },
            preference:async(label,value,action)=>{
              const before=await snapshot(); await action(); check(); const after=await snapshot();
              const old=before.Identity!.page_preferences!, current=after.Identity!.page_preferences!;
              const actor=browserActors.get(label)!;
              const matches=(entry:string)=>{const row=object(JSON.parse(entry)); return row.app_id===app &&
                row.actor_user_id===actor.principal && row.team_id===actor.owner && row.owner===preferenceOwner && row.field==='view';};
              const previous=old.filter(matches), selected=current.filter(matches); assert.equal(selected.length,1);
              assert.deepEqual(object(JSON.parse(selected[0]!)),{app_id:app,actor_user_id:actor.principal,
                team_id:actor.owner,owner:preferenceOwner,field:'view',value,version:previous.length ? Number(object(JSON.parse(previous[0]!)).version)+1 : 1});
              assert.deepEqual(current.filter(entry=>!matches(entry)),old.filter(entry=>!matches(entry)));
              for(const [owner,tables] of Object.entries(before)) for(const [name,rows] of Object.entries(tables))
                if(owner!=='Identity' || name!=='page_preferences') assert.deepEqual(after[owner]?.[name],rows);
            },
            mutation:async(label,kind,expected,action)=>{
              const before=await snapshot(); await action(); check(); const after=await snapshot();
              const actor=browserActors.get(label)!; assert.equal(actor.owner,ava.owner);
              const ownBefore=before[actor.owner!]!, ownAfter=after[actor.owner!]!;
              const added=ownAfter.receipts!.filter(entry=>!ownBefore.receipts!.includes(entry)); assert.equal(added.length,1);
              const receipt=object(JSON.parse(added[0]!)), outcome=object(JSON.parse(string(receipt.outcome)));
              assert.equal(receipt.operation,`${model}.${kind}`); assert.equal(receipt.principal,actor.principal);
              assert.equal(receipt.app,app); assert.equal(receipt.owner,actor.owner); assert.equal(outcome.status,'committed');
              assert.equal(ownAfter.receipts!.length,ownBefore.receipts!.length+1);
              assert.deepEqual(ownAfter.receipts!.filter(entry=>!added.includes(entry)),ownBefore.receipts);
              const changed=ownAfter.records!.filter(entry=>!ownBefore.records!.includes(entry)); assert.equal(changed.length,1);
              const current=object(JSON.parse(changed[0]!)); assert.equal(current.model,model);
              const original=ownBefore.records!.map(entry=>object(JSON.parse(entry))).find(entry=>entry.id===current.id);
              const data={name:expected.name,quantity:expected.quantity,available:expected.available,stock:'0',locked:false};
              const reference=original ? {id:string(original.id),version:String(original.version)} : undefined;
              const submitted=kind==='create' ? {name:expected.name,...(expected.quantity===null ? {} : {quantity:expected.quantity})}
                : kind==='delete' ? {record:reference}
                : {record:reference,name:expected.name,quantity:expected.quantity,available:expected.available};
              assert.equal(receipt.input_hash,await hashInputs(submitted),'generated form preserves exact source inputs');
              assert.deepEqual(JSON.parse(string(current.data)),data);
              assert.equal(current.version,kind==='create' ? 1 : Number(original!.version)+1);
              assert.equal(current.updated_by,actor.principal); assert.equal(current.updated,receipt.created_at);
              if(kind==='delete') assert.equal(current.archived_at,receipt.created_at); else assert.equal(current.archived_at,null);
              if(kind==='create') {assert.equal(original,undefined);assert.equal(ownAfter.records!.length,ownBefore.records!.length+1);}
              else {assert.ok(original);assert.equal(original.archived_at,null);assert.equal(ownAfter.records!.length,ownBefore.records!.length);
                const expectedStored:Record<string,unknown>={...original,data:JSON.stringify(data),version:Number(original.version)+1,
                  updated:receipt.created_at,updated_by:actor.principal,...(kind==='delete'?{archived_at:receipt.created_at}:{})};
                assert.deepEqual(current,expectedStored);}
              assert.deepEqual(ownAfter.records!.filter(entry=>object(JSON.parse(entry)).id!==current.id),
                ownBefore.records!.filter(entry=>object(JSON.parse(entry)).id!==current.id));
              const history=ownAfter.history!.map(entry=>object(JSON.parse(entry))).filter(entry=>entry.operation_id===receipt.operation_id);
              assert.equal(history.length,1); assert.equal(history[0]!.model,model); assert.equal(history[0]!.record_id,current.id);
              assert.equal(history[0]!.operation,receipt.operation);assert.equal(history[0]!.version,current.version);assert.equal(history[0]!.actor,actor.principal);
              assert.deepEqual(history[0]!.before===null ? null : JSON.parse(string(history[0]!.before)),original ? JSON.parse(string(original.data)) : null);
              assert.deepEqual(JSON.parse(string(history[0]!.after)),data);
              assert.equal(ownAfter.history!.length,ownBefore.history!.length+1);
              assert.deepEqual(ownAfter.history!.filter(entry=>object(JSON.parse(entry)).operation_id!==receipt.operation_id),ownBefore.history);
              const fence=object(JSON.parse(ownBefore.fence![0]!)), next=object(JSON.parse(ownAfter.fence![0]!));
              assert.deepEqual(next,{...fence,revision:Number(fence.revision)+1});assert.equal(receipt.committed_revision,next.revision);
              assert.equal(ownAfter.fence_log!.length,ownBefore.fence_log!.length+1);
              assert.deepEqual(ownAfter.fence_log!.filter(entry=>object(JSON.parse(entry)).revision!==next.revision),ownBefore.fence_log);
              assert.deepEqual(ownAfter.fence_log!.map(entry=>object(JSON.parse(entry))).find(entry=>entry.revision===next.revision),
                {revision:next.revision,operation:receipt.operation,at:receipt.created_at});
              assert.deepEqual(outcome.recordVersions,[{model,id:current.id,version:current.version}]);
              const writes=new Set(['records','receipts','history','fence','fence_log']);
              for(const [owner,tables] of Object.entries(before)) for(const [name,rows] of Object.entries(tables))
                if(owner!==actor.owner || !writes.has(name)) assert.deepEqual(after[owner]?.[name],rows);
              const replay=await invoke(actor,`${model}.${kind}`,submitted,string(receipt.operation_id));
              assert.equal(replay.status,200);assert.equal(replay.body.status,'replayed');
              assert.deepEqual(await snapshot(),after,'the actual browser operation envelope replays without resource writes');
            },
          };
          const browserChecks=await qualifyFirstProfileBrowser(browserInput); check();
          for(const result of browserChecks) pass([result.id],result.runtimeCheck);
        });
        assert.equal(lease.browser.isConnected(),false,'qualification owns browser cleanup');
      }
    }
    check(); assert.equal(await captureIsCurrent(fixture),true); assert.equal(await captureIsCurrent(capture),true);
    await release();
    check();
    assert.equal(await captureIsCurrent(fixture),true,'qualification fixture remained current through cleanup');
    assert.equal(await captureIsCurrent(capture),true,'caller capture remained current through cleanup');
    check();
    return Object.freeze([...qualified.values()]);
  } catch (error) {
    return resources.fail(error);
  }
}

/** Daemon-owned provider; callers cannot supply proof records or select branches.
 * Completed outcomes, including unknown after an unchanged producer refusal,
 * are retained for at most four tuples. Cancellation/races retain nothing.
 */
export function createInstalledFirstProfileQualification() {
  const completed = new Map<string, FirstProfileConstructQualification | null>();
  return async (request: FirstProfileConstructQualificationRequest,
    signal?: AbortSignal): Promise<FirstProfileConstructQualification | null> => {
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
      assert.equal(await capturedProducerInputsAreCurrent(capture),true); signal?.throwIfAborted();
      const cached = completed.get(key)!;
      if (cached === null) return null;
      return Object.freeze({...cached,messageKinds:await qualifyCurrentCollectionBranch(capture,signal)});
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
    const result: FirstProfileConstructQualification=Object.freeze({ resourceProfile:request.resourceProfile,
      authoringProfile:FIRST_PROFILE,indexRevision:request.indexRevision,compilerSha256:request.compilerSha256,
      producerInputsDigest:request.producerInputsDigest,messageKinds:Object.freeze([]),
      proofs:Object.freeze(actual.map(record=>Object.freeze({ ...record,indexRevision:request.indexRevision,
        profile:FIRST_PROFILE,compilerSha256:request.compilerSha256,
        compilerCheck:`compiler/tests/construct_help.rs::first_profile_compiler_cards_have_checked_source_and_emitted_owners[${record.id}]; executed captured native compile ${fixturePath} sha256:${fixtureIdentity.sha256}; complete source identity verified; ${record.exampleCheck ? 'emitted compiled example suite consumed by owning Testkit' : record.runtimeCheck.startsWith('HelpOffice Chromium:') ? 'emitted HelpOffice page/preferences/derive declarations consumed by protected Chromium' : record.id==='can.v1.when.scenario.read' || record.id==='can.v1.builtin.count' ? 'emitted HelpOffice.total read descriptor consumed by public MCP' : record.id==='can.v1.when.scenario.user' ? 'emitted HelpOffice.rename checked Set/disclosure and parameter callable consumed by public runtime' : 'emitted Supply CRUD/model descriptors consumed by public runtime'}` }))) });
    signal?.throwIfAborted(); completed.set(key,result);
    while(completed.size>4) completed.delete(completed.keys().next().value!);
    return Object.freeze({...result,messageKinds:await qualifyCurrentCollectionBranch(capture,signal)});
  };
}

function qualificationBuildContext(signal?: AbortSignal) {
  return signal === undefined ? undefined : { signal };
}
