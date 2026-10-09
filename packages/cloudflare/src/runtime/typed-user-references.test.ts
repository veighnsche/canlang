import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { MutationEnvelope } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import {
  FIXED_NOW, asId, asModel, asOperation, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { loadArtifactFile } from '@canlang/cloudflare/runtime/artifact';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedUserReferences';
const MODEL = asModel(`${APP}.Entry`);
let sequence = 0;
function envelope(operation: string, inputs: MutationEnvelope['inputs'] = {}): MutationEnvelope {
  return { operation: `${APP}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}
function committed(outcome: MutationOutcome, status = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  return outcome.result;
}
function rejected(outcome: MutationOutcome, code: string) {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.error.code, code);
}
async function openD1(dir: string) {
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-user-references' }, d1Persist: dir });
  try {
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    return { worker, store: createD1Storage(database) };
  } catch (error) {
    try { await worker.dispose(); } catch { /* Preserve the acquisition failure. */ }
    throw error;
  }
}

test('compiled UserRefs preserve actor equality and closed wire shapes through D1 and replay', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-user-references.json');
  const { artifact } = loadArtifactFile(path);
  const dir = await mkdtemp(join(tmpdir(), 'can-user-references-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  // Membership/identity are fixtures. Both supplied users are active in this
  // selected team; this case makes no user-directory or tenant-partition claim.
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const colleague = await seedMember(memberships, { isOwner: false, teamId: member.team.team_id });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const actor = { id: member.user.user_id };
  const peer = { id: colleague.user.user_id };
  const anonymous = makeIdentity({ actor: null, team: null, membership: null });
  const otherTeam = await memberships.createTeam('UTC');
  const wrongTeam = makeIdentity({ membership: member.membership, team: otherTeam,
    userId: member.user.user_id, email: member.user.email });
  const options = { memberships, now: () => FIXED_NOW };
  const receiptIdentity = (request: MutationEnvelope) => ({ app: APP,
    owner: identity.team!.team_id, principal: identity.actor!.user_id,
    operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(artifact, asm, d1.store, options);
    const create = envelope('Entry.create');
    const born = committed(await invoker.invokeMutation(create, identity));
    assert.equal(born.result, null);
    assert.equal(born.records?.length, 1);
    const row = born.records![0] as { id: string; data: Record<string, unknown> };
    assert.deepEqual(row.data, { owner: actor, assignee: null, users: [], maybeUsers: null });
    const createReceipt = await d1.store.readReceipt(receiptIdentity(create));
    assert.deepEqual(createReceipt?.resolvedDefaults['owner'], actor);
    assert.equal(createReceipt?.resolvedDefaults['assignee'], null);
    assert.equal(createReceipt?.resolvedDefaults['maybeUsers'], null);
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const populate = envelope('Entry.update', {
      record: ref(1), assignee: peer, users: [actor, peer], maybeUsers: [peer],
    });
    committed(await invoker.invokeMutation(populate, identity));
    const setUser = envelope('setUser', { entry: ref(2), who: actor });
    assert.deepEqual(committed(await invoker.invokeMutation(setUser, identity)).result, actor);
    const stored = await d1.store.load(MODEL, asId(row.id));
    assert.equal(stored?.version, 3);
    assert.deepEqual(stored?.data, { owner: actor, assignee: actor, users: [actor, peer], maybeUsers: [peer] });
    assert.equal(stored?.createdBy, actor.id);
    assert.equal(stored?.updatedBy, actor.id);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('attribution', { entry: ref(3) }), identity)).result,
      [actor, actor]);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('users', { entry: ref(3) }), identity)).result,
      [actor, peer]);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('maybeUsers', { entry: ref(3) }), identity)).result,
      [peer]);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('echo', { who: peer }), identity)).result, peer);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('echoUsers', { value: [actor, peer] }), identity)).result,
      [actor, peer]);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('echoUsers'), identity)).result, []);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('echoMaybe', { who: peer }), identity)).result, peer);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('echoMaybeUsers', { value: [peer] }), identity)).result,
      [peer]);
    const omitted = envelope('echoMaybe');
    assert.equal(committed(await invoker.invokeMutation(omitted, identity)).result, null);
    const omittedReceipt = await d1.store.readReceipt(receiptIdentity(omitted));
    assert.deepEqual(omittedReceipt?.resolvedDefaults, { who: null });
    const explicitNull = envelope('echoMaybe', { who: null });
    assert.equal(committed(await invoker.invokeMutation(explicitNull, identity)).result, null);
    assert.deepEqual((await d1.store.readReceipt(receiptIdentity(explicitNull)))?.resolvedDefaults, {});
    assert.equal(committed(await invoker.invokeMutation(envelope('echoMaybeUsers'), identity)).result, null);
    assert.equal(committed(await invoker.invokeMutation(envelope('echoMaybeUsers', { value: null }), identity)).result, null);
    const nativeCreate = envelope('born');
    assert.deepEqual(committed(await invoker.invokeMutation(nativeCreate, identity)).result, actor);
    const rows = await d1.store.query({ model: MODEL, authority: 'owner' });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((entry) => entry.id !== row.id)?.data,
      { owner: actor, assignee: null, users: [actor], maybeUsers: null });
    const history = await d1.store.historyFor(MODEL, asId(row.id));
    // Native {kind,id} is valid only inside a handler. Every incoming user
    // scalar or array element must have the exact wire shape {id}.
    for (const who of ['not-a-user', { id: '' }, { id: peer.id, kind: 'user' },
      { id: peer.id, kind: 'user', email: colleague.user.email },
      { id: peer.id, email: colleague.user.email }, { id: peer.id, version: '1' }]) {
      rejected(await invoker.invokeMutation(envelope('echo', { who }), identity), 'validation');
      rejected(await invoker.invokeMutation(envelope('echoUsers', { value: [who] }), identity), 'validation');
      rejected(await invoker.invokeMutation(envelope('Entry.update', {
        record: ref(3), assignee: who,
      }), identity), 'validation');
      rejected(await invoker.invokeMutation(envelope('Entry.update', {
        record: ref(3), users: [who],
      }), identity), 'validation');
    }
    rejected(await invoker.invokeMutation(envelope('echoUsers', { value: [{ ...peer, role: 'owner' }] }), identity), 'validation');
    rejected(await invoker.invokeMutation(envelope('Entry.create', { owner: peer }), identity), 'validation');
    // Admission wins before native decoding of this otherwise invalid user wire.
    for (const denied of [anonymous, wrongTeam]) {
      rejected(await invoker.invokeMutation(envelope('echo', { who: { id: peer.id, kind: 'user' } }), denied), 'forbidden');
    }
    assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner' }), rows);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    await d1.worker.dispose();
    d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    const reopened = buildInvoker(artifact, asm, d1.store, options);
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(create)), createReceipt);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(omitted)), omittedReceipt);
    const revision = await d1.store.readRevision();
    assert.deepEqual(committed(await reopened.invokeMutation(create, identity), 'replayed').result, born.result);
    assert.deepEqual(committed(await reopened.invokeMutation(setUser, identity), 'replayed').result, actor);
    assert.deepEqual(committed(await reopened.invokeMutation(nativeCreate, identity), 'replayed').result, actor);
    assert.equal(committed(await reopened.invokeMutation(omitted, identity), 'replayed').result, null);
    assert.equal(committed(await reopened.invokeMutation(explicitNull, identity), 'replayed').result, null);
    assert.equal(await d1.store.readRevision(), revision);
    assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner' }), rows);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    assert.doesNotThrow(() => JSON.stringify([rows, history, createReceipt, omittedReceipt]));
  } finally {
    try { await d1?.worker.dispose(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
