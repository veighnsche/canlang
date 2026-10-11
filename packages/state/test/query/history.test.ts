import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelName, RecordParent, StoragePort } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { queryRecordHistoryForViewer } from '../../src/query/history.js';
import { StateError } from '../../src/errors.js';
import { FenceConflictError } from '../../src/storage/port.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { beginOwnerMutation, runMutationWrites, type MutationWrite } from '../../src/mutation/pipeline.js';
import { buildModelTable } from '../../src/mutation/models.js';
import type { ByPredicate, MembershipReader } from '../../src/policy/roles.js';
import { field, modelDef, pipelineContext } from '../mutation/fixtures.js';
import { asId, asModel, asOperation, makeBatch, FIXED_NOW } from '../invocation/fixtures.js';
import { grant, modelPolicy, policyTable } from './fixtures.js';

const MODEL = asModel('CanBook.Book');
const PARENT = asModel('CanBook.Shelf');
const ID = asId('book');
const TEAM = 'team';
const ROLE = 'CanBook.reviewer';
const isCode = (code: StateError['code']) => (error: unknown) => error instanceof StateError && error.code === code;

async function setup() {
  const identity = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await identity.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  await identity.createMembership({ team_id: TEAM, user_id: 'reviewer', is_owner: false,
    roles: [{ role: ROLE, granted_at: new Date(FIXED_NOW).toISOString(), granted_by: 'caller' }] });
  const store = createMemoryStorage();
  const table = buildModelTable([
    modelDef(MODEL, { fields: { title: field(), details: field(), credential: field(), note: field() }, deleteMode: 'remove' }),
    modelDef(PARENT, { fields: { title: field() }, deleteMode: 'remove' }),
  ]);
  let instant = FIXED_NOW;
  const context = () => pipelineContext({ operation: 'CanBook.change', actor: 'caller', teamId: TEAM, now: instant++ });
  async function write(write: MutationWrite, secrets: readonly string[] | undefined = []) {
    const revision = await store.readRevision();
    const effects = await runMutationWrites({ table, store, context: context(), writes: [write],
      ...(secrets === undefined ? {} : { secretFields: new Map([[MODEL, secrets], [PARENT, []]]) }) });
    await store.commit(makeBatch(revision, { ...effects }));
    return effects;
  }
  const create = (data: Record<string, unknown>, secrets: readonly string[] | undefined = [], parent?: RecordParent) =>
    write({ op: 'create', model: MODEL, id: ID, data, ...(parent === undefined ? {} : { parent }) }, secrets);
  const update = (data: Record<string, unknown>, secrets: readonly string[] | undefined = []) =>
    write({ op: 'update', model: MODEL, id: ID, data }, secrets);
  const policy = (fields: readonly string[] = ['title', 'details.label'], secrets: readonly string[] = [], by: ByPredicate = 'members') =>
    policyTable(modelPolicy(MODEL, { grants: [grant(by, fields)], secretFields: secrets }),
      modelPolicy(PARENT, { grants: [grant('members', ['title'])] }));
  const input = () => ({ model: MODEL, recordId: ID, store, memberships: identity, policy: policy(),
    readPolicies: new Map<ModelName, { by: ByPredicate; parent?: ModelName }>([[MODEL, { by: 'members' }]]),
    context: { actorUserId: 'caller', teamId: TEAM } });
  return { identity, caller, store, table, context, write, create, update, policy, input };
}

describe('finite viewer record history over genuine pipeline history', () => {
  it('projects leaf grants, nullable prefixes and real attribution while withholding writer metadata', async () => {
    const s = await setup();
    await s.create({ title: 'First', details: null, credential: 'original plaintext', note: 'hidden' }, ['credential']);
    await s.update({ title: 'Second', details: { label: 'visible', sibling: 'hidden' } }, ['credential']);
    const result = await queryRecordHistoryForViewer({ ...s.input(), policy: s.policy(['title', 'details.label', 'id', 'created']) });
    assert.deepEqual(result.entries.map(entry => entry.before), [null, { title: 'First' }]);
    assert.deepEqual(result.entries.map(entry => entry.after), [{ title: 'First' }, { title: 'Second', details: { label: 'visible' } }]);
    assert.deepEqual(result.entries.map(entry => [entry.change, entry.version, entry.actor]), [['create', 1, 'caller'], ['update', 2, 'caller']]);
    for (const entry of result.entries) {
      assert.equal(entry.model, MODEL); assert.equal(entry.recordId, ID);
      assert.equal(Object.hasOwn(entry, 'auditProjection'), false);
      assert.equal(Object.hasOwn(entry.after!, 'id'), false);
      assert.equal(Object.hasOwn(entry.after!, 'created'), false);
    }
    assert.equal(result.revision, await s.store.readRevision());
  });

  it('uses the whole-chain original secret union after a secret becomes ordinary text', async () => {
    const s = await setup();
    await s.create({ title: 'First', credential: 'old secret', details: { label: 'public', private: 'old private' } }, ['credential', 'details.private']);
    await s.update({ credential: 'now text', details: { label: 'new public', private: 'now text' } }, []);
    const result = await queryRecordHistoryForViewer({ ...s.input(), policy: s.policy(['title', 'credential', 'details']) });
    assert.deepEqual(result.entries[1]?.before, { title: 'First', details: { label: 'public' } });
    assert.deepEqual(result.entries[1]?.after, { title: 'First', details: { label: 'new public' } });
    const currentSecret = await queryRecordHistoryForViewer({ ...s.input(), policy: s.policy(['title', 'details'], ['details.label']) });
    assert.deepEqual(currentSecret.entries[1]?.after, { title: 'First', details: {} });
    assert.ok(!JSON.stringify(result).includes('old secret'));
    assert.ok(!JSON.stringify(result).includes('auditProjection'));
  });

  it('preserves genuine canonical owner-stage chronology at a shared reserved version', async () => {
    const s = await setup(); await s.create({ title: 'First' });
    const session = await beginOwnerMutation({ table: s.table, store: s.store, context: s.context(),
      bounds: { maxRows: 4, maxWork: 200 }, secretFields: new Map([[MODEL, []]]) });
    const root = session.views.context;
    for (const [title, operation] of [['Middle', 'CanBook.first'], ['Last', 'CanBook.second']] as const) {
      await session.stage({ op: 'update', model: MODEL, id: ID, data: { title } },
        { cause: 'scenario', context: Object.freeze({ ...root, operation: asOperation(operation) }) });
    }
    const effects = await session.finalize();
    await s.store.commit(makeBatch(await s.store.readRevision(), { ...effects }));
    const result = await queryRecordHistoryForViewer(s.input());
    assert.deepEqual(result.entries.map(entry => [entry.version, entry.after?.title]), [[1, 'First'], [2, 'Middle'], [2, 'Last']]);
    assert.deepEqual(result.entries.slice(1).map(entry => entry.operation), ['CanBook.first', 'CanBook.second']);
    assert.equal(result.entries[2]?.before?.title, 'Middle');
  });

  it('refuses legacy, recreated and discontinuous actual history rather than inventing evidence', async () => {
    for (const kind of ['legacy', 'recreated', 'discontinuous'] as const) {
      const s = await setup();
      if (kind === 'legacy') {
        // Omit the producer inventory deliberately: this is real legacy output.
        const effects = await runMutationWrites({ table: s.table, store: s.store, context: s.context(),
          writes: [{ op: 'create', model: MODEL, id: ID, data: { title: 'Legacy' } }] });
        await s.store.commit(makeBatch(await s.store.readRevision(), { ...effects }));
      } else {
        await s.create({ title: 'First' });
        if (kind === 'recreated') {
          await s.write({ op: 'remove', model: MODEL, id: ID });
          await s.create({ title: 'Recreated' });
        } else {
          const effects = await runMutationWrites({ table: s.table, store: s.store, context: s.context(),
            secretFields: new Map([[MODEL, []]]), writes: [{ op: 'update', model: MODEL, id: ID, data: { title: 'Missing audit stage' } }] });
          await s.store.commit(makeBatch(await s.store.readRevision(), { ...effects, history: [] }));
        }
      }
      await assert.rejects(queryRecordHistoryForViewer(s.input()), isCode('validation'));
    }
  });

  it('requires current row visibility, checked readBy and actual parent existence before history fetch', async () => {
    const s = await setup(); await s.create({ title: 'Visible' });
    let reads = 0; const original = s.store.historyReadBounded!;
    const store: StoragePort = { ...s.store, historyReadBounded: async request => { reads++; return original(request); } };
    await assert.rejects(queryRecordHistoryForViewer({ ...s.input(), store,
      policy: s.policy(['title'], [], 'owner') }), isCode('not_found'));
    await assert.rejects(queryRecordHistoryForViewer({ ...s.input(), store,
      readPolicies: new Map([[MODEL, { by: 'owner' as const }]]) }), isCode('not_found'));
    await assert.rejects(queryRecordHistoryForViewer({ ...s.input(), store, recordId: asId('missing') }), isCode('not_found'));
    assert.equal(reads, 0);
    const p = await setup();
    await p.write({ op: 'create', model: PARENT, id: asId('shelf'), data: { title: 'Shelf' } });
    await p.create({ title: 'Contained' }, [], { model: PARENT, id: asId('shelf') });
    const parent = await p.store.load(PARENT, asId('shelf')); assert.ok(parent);
    // Deliberately corrupt containment through the raw store: the reader must
    // refuse the genuinely absent parent, even with a valid child audit chain.
    await p.store.commit(makeBatch(await p.store.readRevision(), {
      writes: [{ kind: 'remove', model: PARENT, id: parent.id, expectedVersion: parent.version }],
    }));
    await assert.rejects(queryRecordHistoryForViewer({ ...p.input(),
      readPolicies: new Map([[MODEL, { by: 'members' as const, parent: PARENT }], [PARENT, { by: 'members' as const }]]) }), isCode('not_found'));
  });

  it('refuses actual membership revocation and State revision drift during the bounded history await', async () => {
    for (const change of ['membership', 'revision'] as const) {
      const s = await setup(); await s.create({ title: 'Visible' });
      const original = s.store.historyReadBounded!; const before = await s.store.readRevision();
      const store: StoragePort = { ...s.store, historyReadBounded: async request => {
        const entries = await original(request);
        if (change === 'membership') await s.identity.removeMembership(s.caller.membership_id);
        else await s.store.commit(makeBatch(await s.store.readRevision()));
        return entries;
      } };
      await assert.rejects(queryRecordHistoryForViewer({ ...s.input(), store }),
        change === 'membership' ? isCode('forbidden') : error => error instanceof FenceConflictError);
      if (change === 'membership') assert.equal(await s.store.readRevision(), before);
    }
  });

  it('uses genuine coherent membership snapshots and refuses corrupted observations', async () => {
    const s = await setup(); await s.create({ title: 'Visible' });
    let snapshots = 0;
    const memberships: MembershipReader = { ...s.identity, findMembershipsSnapshot: async (team, users) => {
      snapshots++; return s.identity.findMembershipsSnapshot(team, users);
    } };
    const input = { ...s.input(), memberships,
      policy: s.policy(['title'], [], { roleSubject: { role: ROLE, person: 'reviewer' } }) };
    assert.equal((await queryRecordHistoryForViewer(input)).entries.length, 1);
    assert.ok(snapshots >= 2);
    await assert.rejects(queryRecordHistoryForViewer({ ...input, memberships: { ...memberships,
      findMembershipsSnapshot: async (team, users) => {
        const snapshot = await s.identity.findMembershipsSnapshot(team, users);
        return { ...snapshot, entries: snapshot.entries.slice(1) };
      } } }), isCode('validation'));
  });

  it('refuses bounded overflow or missing bounded capability without reading raw history', async () => {
    const s = await setup(); await s.create({ title: 'First' }); await s.update({ title: 'Second' });
    let rawReads = 0;
    const store: StoragePort = { ...s.store, historyFor: async () => { rawReads++; throw Error('Raw history fallback'); } };
    await assert.rejects(queryRecordHistoryForViewer({ ...s.input(), store, limit: 1 }), isCode('validation'));
    const { historyReadBounded: _bounded, ...withoutBounded } = store;
    await assert.rejects(queryRecordHistoryForViewer({ ...s.input(), store: withoutBounded }), isCode('validation'));
    assert.equal(rawReads, 0);
  });
});
