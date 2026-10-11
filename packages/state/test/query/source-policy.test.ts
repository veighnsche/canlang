/** Literal installed-source component controls; these fixtures do not attest generated/native source. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUserRef } from '@canlang/values';
import type { ModelName } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { FenceConflictError } from '../../src/storage/port.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { openFenceScope } from '../../src/invocation/admission.js';
import { projectCurrentRecordForViewerSourcePolicies, type ViewerGenerationCallbackReadObservation,
  type ViewerGenerationCallbackSourceReadPolicy, type ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { bindReadPolicyMembershipProducer, evaluateReadPolicyMembership } from '../../src/receipt/read-policy-membership.js';
import { asId, asModel, asRevision, FIXED_NOW, makeBatch, makeRow, seedRow } from '../invocation/fixtures.js';
import { grant, modelPolicy, policyTable } from './fixtures.js';

const MODEL = asModel('Source.Document'), PARENT = asModel('Source.Folder'), TEAM = 'source-team', ID = asId('document');
const refuses = (error: unknown) => error instanceof StateError;
type Read = ViewerGenerationCallbackSourceReadPolicy['grants'][number]['read'];
function installedRead(body: (observation: ViewerGenerationCallbackReadObservation,
  member: (person: string, observation?: ViewerGenerationCallbackReadObservation) => Promise<boolean>) => Promise<boolean>,
  rule = 'Source.Document.read:0') {
  const source = { path: 'source.can', sha256: 'a'.repeat(64), module: 'source.mjs' };
  const team = Object.freeze({ teamId: TEAM, timezone: 'UTC' });
  const frames = new WeakMap<object, { person: ReturnType<typeof makeUserRef>; team: typeof team }>();
  let handles: ReturnType<typeof bindReadPolicyMembershipProducer>, captures = 0;
  const read: Read = async observation => body(observation, async (person, actual = observation) => {
    frames.set(actual, { person: makeUserRef(person), team });
    return evaluateReadPolicyMembership(actual, { site: handles[0]! });
  });
  handles = bindReadPolicyMembershipProducer(read, { source, rule, team: () => team,
    sites: [{ version: 1, source, owner: rule, node: { start: 10, end: 30 }, statement: { start: 9, end: 31 },
      stage: 'read-policy', position: [], calls: [{ source, node: { start: 11, end: 29 },
        target: { kind: 'builtin', id: 'active_member', overload: 0 },
        arguments: [{ node: { start: 12, end: 13 }, type: 'user' }, { node: { start: 14, end: 15 }, type: 'Team' }],
        slots: [0, 1], defaults: [], chain: [],
      }] }], capture: observation => {
        captures++; const pair = frames.get(observation); frames.delete(observation);
        if (pair === undefined) throw new StateError('validation', 'No actual private evaluated pair.');
        return pair;
      } });
  return { read, handles, get captures() { return captures; } };
}
async function setup() {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: true, roles: [] });
  const author = await memberships.createMembership({ team_id: TEAM, user_id: 'author', is_owner: false, roles: [] });
  const folder = await seedRow(store, PARENT, { id: 'folder', data: { title: 'Folder' } });
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: MODEL,
    row: { ...makeRow({ id: ID, data: { title: 'Document', author: 'author', info: { public: 'Visible', secret: 'SECRET' } } }),
      parent: { model: PARENT, id: folder.id } },
  }] }));
  const native = installedRead(async (observation, member) => {
    assert.equal(observation.row.id, ID); assert.notEqual(observation.context.memberships, memberships);
    return observation.context.actorUserId === 'caller' && await member(observation.row.data.author as string);
  });
  const current = { parent: PARENT, fields: ['title', 'author', 'info'], secretFields: ['info.secret'],
    grants: [{ fields: ['title', 'author', 'info'], read: native.read }] };
  const parent = { fields: ['title'], secretFields: [], grants: [{ fields: ['title'],
    read: async ({ context, row }: ViewerGenerationCallbackReadObservation) => row.id === 'folder' &&
      context.membership?.status === 'active' && context.membership.is_owner === true }] };
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>([[MODEL, current], [PARENT, parent]]);
  const input = { model: MODEL, id: ID, readPolicies, policy: policyTable(), store, memberships,
    context: { actorUserId: 'caller', teamId: TEAM } };
  return { store, memberships, caller, author, folder, current, parent, native, input };
}

test('current source projection unions each ordered true grant, omits typed secrets and verifies live parent at R', async () => {
  const s = await setup(), order: number[] = [], loads: { model: ModelName; revision: number }[] = [];
  const original = s.store.cohortLoad.bind(s.store), revision = await s.store.readRevision();
  const fence = openFenceScope(revision, TEAM);
  s.store.cohortLoad = async request => { loads.push({ model: request.model, revision: request.expectedRevision }); return original(request); };
  const native = installedRead(async (observation, member) => {
    order.push(0); assert.equal(observation.revision, revision); assert.equal(observation.fence, fence);
    return member(observation.row.data.author as string);
  });
  s.current.grants = [
    { fields: ['title'], read: native.read },
    { fields: ['author'], read: async () => { order.push(1); return false; } },
    { fields: ['info'], read: async () => { order.push(2); return true; } },
  ];
  const result = await projectCurrentRecordForViewerSourcePolicies({ ...s.input, fence });
  assert.equal(result.revision, revision); assert.ok(result.record);
  assert.deepEqual(result.record.data, { title: 'Document', info: { public: 'Visible' } });
  assert.deepEqual(order, [0, 1, 2, 0, 1, 2]);
  assert.ok(loads.some(load => load.model === PARENT));
  assert.ok(loads.every(load => load.revision === revision));
  assert.ok(fence.dependencies.some(dependency => dependency.kind === 'record' && dependency.model === PARENT));
  assert.ok(fence.dependencies.some(dependency => dependency.kind === 'membership' && dependency.userId === 'author'));
  assert.ok(Object.isFrozen(result.record.data));
});

test('missing, archived, denied, undeclared and foreign containment or account cannot disclose a source row', async () => {
  for (const mode of ['missing', 'archived', 'denied', 'undeclared', 'foreign', 'account', 'caller-revoked', 'subject-revoked'] as const) {
    const s = await setup();
    if (mode === 'missing') await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [
      { kind: 'remove', model: PARENT, id: s.folder.id, expectedVersion: s.folder.version },
    ] }));
    if (mode === 'archived') await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [
      { kind: 'update', model: PARENT, id: s.folder.id, expectedVersion: s.folder.version,
        row: { ...s.folder, version: (s.folder.version + 1) as typeof s.folder.version, archivedAt: FIXED_NOW } },
    ] }));
    if (mode === 'denied') s.parent.grants[0]!.read = async () => false;
    if (mode === 'undeclared') delete (s.current as Partial<typeof s.current>).parent;
    if (mode === 'foreign') s.current.parent = asModel('Foreign.Folder');
    if (mode === 'account') s.input.context.actorUserId = 'other-account';
    if (mode === 'caller-revoked') await s.memberships.removeMembership(s.caller.membership_id);
    if (mode === 'subject-revoked') {
      await s.memberships.removeMembership(s.author.membership_id);
      await s.memberships.createMembership({ team_id: 'other-team', user_id: 'author', is_owner: true, roles: [] });
    }
    assert.deepEqual(await projectCurrentRecordForViewerSourcePolicies(s.input), { record: null, revision: await s.store.readRevision() }, mode);
  }
});

test('source profile capture resists supplied map, selector and function mutation during its first await', async () => {
  const s = await setup(), fields = ['title'];
  s.current.grants = [{ fields, read: async () => {
    fields[0] = 'author'; s.current.secretFields.push('title');
    s.current.grants[1]!.read = async () => { assert.fail('mutated predicate must not execute'); };
    s.input.readPolicies.clear(); s.input.context.actorUserId = 'changed-account';
    await Promise.resolve(); return true;
  } }, { fields: ['info'], read: async () => true }];
  const result = await projectCurrentRecordForViewerSourcePolicies(s.input);
  assert.ok(result.record); assert.deepEqual(result.record.data, { title: 'Document', info: { public: 'Visible' } });
});

test('source reads require strict Bool and preserve original State R through read and transform awaits', async () => {
  for (const mode of ['boolean', 'stale-fence', 'read-state', 'transform-state', 'transform-caller', 'transform-subject'] as const) {
    const s = await setup(); let transforms = 0;
    const move = () => seedRow(s.store, MODEL, { id: 'new', data: { title: 'Moved' } });
    if (mode === 'boolean') s.current.grants[0]!.read = async () => 'true' as unknown as boolean;
    if (mode === 'read-state') s.current.grants[0]!.read = async () => { await move(); return true; };
    const input = mode === 'stale-fence' ? { ...s.input, fence: openFenceScope(asRevision(0), TEAM) } : s.input;
    await assert.rejects(projectCurrentRecordForViewerSourcePolicies(input, async result => {
      transforms++; assert.ok(result.record);
      if (mode === 'transform-state') await move();
      if (mode === 'transform-caller') await s.memberships.removeMembership(s.caller.membership_id);
      if (mode === 'transform-subject') await s.memberships.removeMembership(s.author.membership_id);
      return result;
    }), mode === 'read-state' || mode === 'transform-state' || mode === 'stale-fence'
      ? (error: unknown) => error instanceof FenceConflictError : refuses);
    if (mode === 'boolean' || mode === 'read-state' || mode === 'stale-fence') assert.equal(transforms, 0);
    else assert.equal(transforms, 1);
  }
});

test('source and legacy containment project the same live row without an ambient fallback', async () => {
  for (const mode of ['legacy', 'source-parent', 'source-child', 'absent-policy', 'absent-row'] as const) {
    const s = await setup();
    s.input.policy = policyTable(modelPolicy(MODEL, { grants: [grant('members', ['title', 'info'])], secretFields: ['info.secret'] }),
      modelPolicy(PARENT, { grants: [grant('owner', ['title'])] }));
    if (mode === 'legacy' || mode === 'source-parent') s.input.readPolicies.set(MODEL, { by: 'members', parent: PARENT });
    if (mode === 'legacy' || mode === 'source-child') s.input.readPolicies.set(PARENT, { by: 'owner' });
    if (mode === 'absent-policy') s.input.readPolicies.delete(PARENT);
    if (mode === 'absent-row') s.input.id = asId('missing');
    const result = await projectCurrentRecordForViewerSourcePolicies(s.input);
    if (mode === 'absent-policy' || mode === 'absent-row') assert.equal(result.record, null);
    else { assert.ok(result.record); assert.equal(result.record.data.title, 'Document'); assert.deepEqual(result.record.data.info, { public: 'Visible' }); }
  }
});

test('current containment refuses cyclic links and a foreign row returned by an ancestor reader', async () => {
  for (const mode of ['cycle', 'foreign-row'] as const) {
    const s = await setup();
    if (mode === 'cycle') {
      s.input.readPolicies.set(PARENT, { ...s.parent, parent: MODEL });
      await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [{ kind: 'update', model: PARENT,
        id: s.folder.id, expectedVersion: s.folder.version, row: { ...s.folder,
          version: (s.folder.version + 1) as typeof s.folder.version, parent: { model: MODEL, id: ID } },
      }] }));
    } else {
      const original = s.store.cohortLoad.bind(s.store);
      s.store.cohortLoad = async request => {
        const row = await original(request);
        return request.model === PARENT && row !== null ? { ...row, id: asId('foreign-folder') } : row;
      };
    }
    await assert.rejects(projectCurrentRecordForViewerSourcePolicies(s.input), refuses);
  }
});

test('membership source handles refuse copied and closed observations rather than issuing escaped authority', async () => {
  for (const copied of [false, true]) {
    const s = await setup(); let saved: ViewerGenerationCallbackReadObservation | undefined;
    const native = installedRead(async (observation, member) => {
      saved = observation;
      if (copied) { try { await member('author', { ...observation }); } catch (error) { assert.ok(refuses(error)); } return true; }
      return member('author');
    });
    s.current.grants[0]!.read = native.read;
    if (copied) await assert.rejects(projectCurrentRecordForViewerSourcePolicies(s.input), refuses);
    else {
      assert.ok((await projectCurrentRecordForViewerSourcePolicies(s.input)).record); assert.ok(saved);
      await assert.rejects(evaluateReadPolicyMembership(saved, { site: native.handles[0]! }), refuses);
    }
  }
});

function navigationInput(s: Awaited<ReturnType<typeof setup>>, observation: ViewerGenerationCallbackReadObservation,
  model = PARENT, id = s.folder.id) {
  return { ...s.input, model, id, observation, memberships: observation.context.memberships,
    context: { actorUserId: observation.context.actorUserId, teamId: observation.context.teamId },
    ...(observation.fence === undefined ? {} : { fence: observation.fence }) };
}

test('nested parent/root source navigation joins the original authority, ordered unions and secrets at R', async () => {
  const s = await setup(), ROOT = asModel('Source.Root');
  const root = await seedRow(s.store, ROOT, { id: 'root', data: {
    account: 'caller', active: true, author: 'author', info: { public: 'Root visible', secret: 'ROOT SECRET' },
  } });
  await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [{ kind: 'update', model: PARENT,
    id: s.folder.id, expectedVersion: s.folder.version, row: { ...s.folder,
      version: (s.folder.version + 1) as typeof s.folder.version, parent: { model: ROOT, id: root.id },
      data: { title: 'Folder', info: { public: 'Folder visible', secret: 'PARENT SECRET' } },
    } }] }));
  const revision = await s.store.readRevision(), fence = openFenceScope(revision, TEAM);
  const order: string[] = [], subjects: string[][] = [];
  const originalSnapshot = s.memberships.findMembershipsSnapshot!.bind(s.memberships);
  s.memberships.findMembershipsSnapshot = async (team, users) => {
    subjects.push([...users]); return originalSnapshot(team, users);
  };
  const rootRead = installedRead(async (observation, member) => {
    order.push('root:0'); assert.equal(observation.revision, revision); assert.equal(observation.fence, fence);
    return member(observation.row.data.author as string);
  }, 'Source.Root.read:0');
  s.input.readPolicies.set(ROOT, { fields: ['account', 'active', 'author', 'info'], secretFields: ['info.secret'], grants: [
    { fields: ['account', 'active'], read: rootRead.read },
    { fields: ['info'], read: async () => { order.push('root:1'); return true; } },
    { fields: ['author'], read: async () => { order.push('root:2'); return false; } },
  ] });
  s.input.readPolicies.set(PARENT, { parent: ROOT, fields: ['title', 'info'], secretFields: ['info.secret'], grants: [
    { fields: ['title'], read: async observation => {
      order.push('parent:0'); assert.ok(observation.row.parent);
      return projectCurrentRecordForViewerSourcePolicies(navigationInput(s, observation,
        observation.row.parent.model, observation.row.parent.id), result => {
        assert.ok(result.record); assert.deepEqual(result.record.data, {
          account: 'caller', active: true, info: { public: 'Root visible' },
        });
        return result.record.data.account === observation.context.actorUserId && result.record.data.active === true;
      });
    } },
    { fields: ['info'], read: async () => { order.push('parent:1'); return true; } },
  ] });
  s.current.grants[0]!.read = async observation => {
    assert.ok(observation.row.parent);
    const result = await projectCurrentRecordForViewerSourcePolicies(navigationInput(s, observation,
      observation.row.parent.model, observation.row.parent.id));
    assert.ok(result.record); assert.deepEqual(result.record.data, { title: 'Folder', info: { public: 'Folder visible' } });
    return true;
  };
  const result = await projectCurrentRecordForViewerSourcePolicies({ ...s.input, fence });
  assert.ok(result.record); assert.deepEqual(result.record.data, {
    title: 'Document', author: 'author', info: { public: 'Visible' },
  });
  assert.deepEqual(subjects, [['caller', 'author'], ['caller', 'author']], 'only the original reader captures/revalidates Identity');
  for (let index = 0; index < order.length; index++) {
    if (order[index] === 'root:0') assert.deepEqual(order.slice(index, index + 3), ['root:0', 'root:1', 'root:2']);
  }
  assert.ok(order.includes('parent:1')); assert.ok(rootRead.captures > 1);
  assert.ok(fence.dependencies.some(dependency => dependency.kind === 'record' && dependency.model === ROOT));
  assert.equal(await s.store.readRevision(), revision); assert.deepEqual(await s.store.outboxPending(), []);
});

test('borrowed navigation refuses copied, foreign or malformed authority even when its source catches refusal', async () => {
  for (const mode of ['copy', 'store', 'actor', 'team', 'memberships', 'fence', 'policy', 'row'] as const) {
    const s = await setup(), revision = await s.store.readRevision();
    s.current.grants[0]!.read = async observation => {
      const input = navigationInput(s, observation);
      if (mode === 'copy') input.observation = { ...observation };
      if (mode === 'store') input.store = createMemoryStorage();
      if (mode === 'actor') input.context.actorUserId = 'foreign';
      if (mode === 'team') input.context.teamId = 'foreign';
      if (mode === 'memberships') input.memberships = s.memberships;
      if (mode === 'fence') input.fence = openFenceScope(observation.revision, TEAM);
      if (mode === 'policy') input.readPolicies = new Map([[PARENT, { ...s.parent, secretFields: ['title'] }]]);
      if (mode === 'row') {
        const original = s.store.cohortLoad.bind(s.store);
        s.store.cohortLoad = async request => {
          const row = await original(request); return request.model === PARENT && row !== null ? { ...row, id: asId('foreign') } : row;
        };
      }
      try { await projectCurrentRecordForViewerSourcePolicies(input); assert.fail('borrowed read must refuse'); }
      catch (error) { assert.ok(refuses(error), mode); }
      return true;
    };
    await assert.rejects(projectCurrentRecordForViewerSourcePolicies(s.input), refuses, mode);
    assert.equal(await s.store.readRevision(), revision); assert.deepEqual(await s.store.outboxPending(), []);
  }
});

test('borrowed source metadata is captured before its first awaited revision checkpoint', async () => {
  const s = await setup(), fields = ['title']; let mutate: (() => void) | undefined, transforms = 0;
  const read = { fields: ['title'], secretFields: [] as string[], grants: [{ fields, read: async () => true }] };
  const supplied = new Map<ModelName, ViewerSourceReadPolicy>([[PARENT, read]]);
  const original = s.store.readRevision.bind(s.store);
  s.store.readRevision = async () => {
    const change = mutate; mutate = undefined;
    if (change !== undefined) { await Promise.resolve(); change(); }
    return original();
  };
  s.current.grants[0]!.read = async observation => {
    const input = { ...navigationInput(s, observation), readPolicies: supplied };
    mutate = () => {
      fields[0] = 'author'; read.secretFields.push('title');
      read.grants[0]!.read = async () => { assert.fail('mutated source callable must not execute'); };
      supplied.clear(); input.context.actorUserId = 'foreign'; input.memberships = s.memberships;
    };
    return projectCurrentRecordForViewerSourcePolicies(input, result => {
      transforms++; assert.deepEqual(result.record?.data, { title: 'Folder' }); return true;
    });
  };
  assert.ok((await projectCurrentRecordForViewerSourcePolicies(s.input)).record);
  assert.equal(transforms, 1); assert.deepEqual(await s.store.outboxPending(), []);
});

test('borrowed navigation requires current parent and closes with its original source lifetime', async () => {
  for (const mode of ['allowed', 'denied', 'missing', 'archived'] as const) {
    const s = await setup(); let saved: ViewerGenerationCallbackReadObservation | undefined;
    if (mode === 'denied') s.parent.grants[0]!.read = async () => false;
    if (mode === 'missing') await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [
      { kind: 'remove', model: PARENT, id: s.folder.id, expectedVersion: s.folder.version },
    ] }));
    if (mode === 'archived') await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [
      { kind: 'update', model: PARENT, id: s.folder.id, expectedVersion: s.folder.version,
        row: { ...s.folder, version: (s.folder.version + 1) as typeof s.folder.version, archivedAt: FIXED_NOW } },
    ] }));
    s.current.grants[0]!.read = async observation => {
      saved = observation;
      return (await projectCurrentRecordForViewerSourcePolicies(navigationInput(s, observation))).record !== null;
    };
    const result = await projectCurrentRecordForViewerSourcePolicies(s.input);
    assert.equal(result.record !== null, mode === 'allowed', mode); assert.ok(saved);
    await assert.rejects(projectCurrentRecordForViewerSourcePolicies(navigationInput(s, saved)), refuses);
  }
});

test('caught child membership misuse and recursive source navigation poison the entire owning read', async () => {
  for (const mode of ['wrong-handle', 'cycle'] as const) {
    const s = await setup(); let calls = 0;
    s.current.grants[0]!.read = async observation => {
      calls++;
      try { return (await projectCurrentRecordForViewerSourcePolicies(navigationInput(s, observation))).record !== null; }
      catch (error) { assert.ok(refuses(error)); return true; }
    };
    s.parent.grants[0]!.read = async observation => {
      calls++;
      try {
        if (mode === 'wrong-handle') await evaluateReadPolicyMembership(observation, { site: s.native.handles[0]! });
        else await projectCurrentRecordForViewerSourcePolicies(navigationInput(s, observation, MODEL, ID));
      } catch (error) { assert.ok(refuses(error)); }
      return true;
    };
    await assert.rejects(projectCurrentRecordForViewerSourcePolicies(s.input), refuses);
    assert.ok(calls < 6, 'refuse the in-flight dependency cycle without reusing an unfinished projection');
    assert.deepEqual(await s.store.outboxPending(), []);
  }
});

test('concurrent, unawaited or competing membership work cannot escape a borrowed source read', async () => {
  for (const mode of ['concurrent', 'unawaited', 'membership'] as const) {
    const s = await setup(); let pending: Promise<unknown> | undefined;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = s.store.cohortLoad.bind(s.store);
    s.store.cohortLoad = async request => { if (request.model === PARENT) { entered(); await gate; } return original(request); };
    const native = installedRead(async (observation, member) => {
      pending = projectCurrentRecordForViewerSourcePolicies(navigationInput(s, observation));
      void pending.catch(() => {}); await started;
      if (mode === 'unawaited') return true;
      try {
        if (mode === 'membership') await member('author');
        else await projectCurrentRecordForViewerSourcePolicies(navigationInput(s, observation));
        assert.fail('concurrent work must refuse');
      } catch (error) { assert.ok(refuses(error)); }
      release(); try { await pending; } catch (error) { assert.ok(refuses(error)); }
      return true;
    });
    s.current.grants[0]!.read = native.read;
    try { await assert.rejects(projectCurrentRecordForViewerSourcePolicies(s.input), refuses, mode); }
    finally { release(); }
    assert.ok(pending); await assert.rejects(pending, refuses);
    assert.deepEqual(await s.store.outboxPending(), []);
  }
});

test('borrowed transforms preserve the original final State and complete Identity checks', async () => {
  for (const mode of ['state', 'subject', 'caller'] as const) {
    const s = await setup(); let transforms = 0;
    const parent = installedRead(async (observation, member) => member('author'), 'Source.Folder.read:0');
    s.parent.grants[0]!.read = parent.read;
    s.current.grants[0]!.read = async observation => projectCurrentRecordForViewerSourcePolicies(
      navigationInput(s, observation), async result => {
        transforms++; assert.ok(result.record);
        if (mode === 'state') await seedRow(s.store, MODEL, { id: 'moved', data: { title: 'Moved' } });
        else await s.memberships.removeMembership((mode === 'caller' ? s.caller : s.author).membership_id);
        return true;
      });
    await assert.rejects(projectCurrentRecordForViewerSourcePolicies(s.input), mode === 'state'
      ? (error: unknown) => error instanceof FenceConflictError : refuses);
    assert.equal(transforms, 1); assert.deepEqual(await s.store.outboxPending(), []);
  }
});
