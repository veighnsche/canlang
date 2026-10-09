/** Native policy ABI and real owner-session controls; no compiler/source acceptance claim. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OWNER_MODEL_POLICY_BINDINGS_MEMBER } from '@canlang/contracts';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../invocation/registry.js';
import type { CanonicalOwnerModelPolicies, DeleteMode, StoragePort } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { asId, asModel, asOperation, makeBatch, seedRow } from '../../test/invocation/fixtures.js';
import { field, modelDef, pipelineContext } from '../../test/mutation/fixtures.js';
import { buildModelTable } from './models.js';
import { bindArtifactOwnerModelPolicies, bindOwnerModelPolicies, type OwnerModelPolicyBinding } from './model-policies.js';
import { beginOwnerMutation, type MutationWritesResult } from './pipeline.js';

const ITEM = asModel('Policies.Item'), LIMIT = asModel('Policies.Limit'), CHILD = asModel('Policies.Child');
const identity = { module: 'policies.mjs', ownerPackage: 'Policies', model: ITEM };
const tableFor = (deleteMode: DeleteMode = 'remove') => buildModelTable([
  modelDef(ITEM, { fields: { label: field(), amount: field(), locked: field(), limit: field(), children: field() }, deleteMode }),
  modelDef(LIMIT, { fields: { cap: field() }, deleteMode: 'remove' }),
  modelDef(CHILD, { fields: { owner: field() }, deleteMode: 'remove' }),
]);
const descriptor = (rules: CanonicalOwnerModelPolicies['rules'], hooks: CanonicalOwnerModelPolicies['hooks'] = []): CanonicalOwnerModelPolicies => ({
  abi: 'state.owner-model-policies@1', ...identity, rules, hooks,
});
const predicate = (id: string, kind: 'lock' | 'invariant', evaluate: Extract<OwnerModelPolicyBinding, { kind: 'invariant' | 'lock' }>['evaluate']): OwnerModelPolicyBinding => ({
  ...identity, id, kind, evaluate,
});
const dependency = (id: string, select: Extract<OwnerModelPolicyBinding, { kind: 'dependency' }>['select']): OwnerModelPolicyBinding => ({
  ...identity, id, kind: 'dependency', select,
});
const isStateError = (code: string, message?: RegExp) => (error: unknown): boolean =>
  error instanceof StateError && error.code === code && (message === undefined || message.test(error.message));
const context = () => pipelineContext({ operation: 'Policies.change' });
async function commit(store: StoragePort, output: MutationWritesResult) {
  return store.commit(makeBatch(await store.readRevision(), output));
}
function fixture() {
  return {
    descriptors: [descriptor([
      { kind: 'lock', id: 'lock', fields: ['amount'] },
      { kind: 'invariant', id: 'valid', dependencies: [{ id: 'affected', model: LIMIT, maxTargets: 4 }] },
    ], [{ id: 'hook', op: 'update', operation: asOperation(`${ITEM}.update`) }])],
    bindings: [predicate('lock', 'lock', () => false), predicate('valid', 'invariant', () => true),
      dependency('affected', () => []), { ...identity, id: 'hook', kind: 'hook', run: candidate => candidate } as OwnerModelPolicyBinding],
  };
}

describe('owning model-policy loader', () => {
  it('binds the exact ABI and retains hook source order without exposing its installed map', () => {
    const input = fixture();
    input.descriptors[0] = descriptor([], [
      { id: 'second-name', op: 'update', operation: asOperation(`${ITEM}.update`) },
      { id: 'first-name', op: 'update', operation: asOperation(`${ITEM}.update`) },
    ]);
    input.bindings = ['second-name', 'first-name'].map(id => ({ ...identity, id, kind: 'hook', run: candidate => candidate }));
    const policies = bindOwnerModelPolicies({ table: tableFor(), ...input });
    assert.deepEqual(policies.hooks.get(ITEM)?.map(hook => hook.name), ['second-name', 'first-name']);
    (policies.hooks as Map<unknown, unknown>).clear();
    assert.equal(policies.hooks.get(ITEM)?.length, 2);
  });

  type RawFixture = { descriptors: any[]; bindings: any[] };
  const malformed: readonly [string, (input: RawFixture) => void][] = [
    ['unsupported ABI', x => { x.descriptors[0].abi = 'other'; }],
    ['unknown descriptor field', x => { x.descriptors[0].extra = true; }],
    ['duplicate model', x => { x.descriptors.push(x.descriptors[0]); }],
    ['unknown model', x => { x.descriptors[0].model = 'Policies.Missing'; }],
    ['duplicate binding', x => { x.bindings.push(x.bindings[0]); }],
    ['dangling rule', x => { x.descriptors[0].rules[0].id = 'missing'; }],
    ['unlinked binding', x => { x.bindings.push({ ...x.bindings[0], id: 'extra' }); }],
    ['wrong module', x => { x.bindings[0].module = 'other.mjs'; }],
    ['wrong package', x => { x.bindings[0].ownerPackage = 'Other'; }],
    ['wrong owning model', x => { x.bindings[0].model = LIMIT; }],
    ['wrong binding kind', x => { x.bindings[0].kind = 'invariant'; }],
    ['unknown binding kind', x => { x.bindings[0].kind = 'unknown'; }],
    ['nonfunction predicate', x => { x.bindings[0].evaluate = true; }],
    ['extra binding callback', x => { x.bindings[0].select = () => []; }],
    ['unknown binding field', x => { x.bindings[0].extra = true; }],
    ['duplicate rule link', x => { x.descriptors[0].rules.push(x.descriptors[0].rules[0]); }],
    ['unknown locked field', x => { x.descriptors[0].rules[0].fields = ['missing']; }],
    ['duplicate locked field', x => { x.descriptors[0].rules[0].fields = ['amount', 'amount']; }],
    ['empty locked fields', x => { x.descriptors[0].rules[0].fields = []; }],
    ['unknown rule kind', x => { x.descriptors[0].rules[0].kind = 'other'; }],
    ['unknown rule field', x => { x.descriptors[0].rules[0].extra = true; }],
    ['missing dependency plan', x => { delete x.descriptors[0].rules[1].dependencies; }],
    ['unknown dependency model', x => { x.descriptors[0].rules[1].dependencies[0].model = 'Policies.Missing'; }],
    ['invalid dependency bound', x => { x.descriptors[0].rules[1].dependencies[0].maxTargets = 0; }],
    ['unknown dependency field', x => { x.descriptors[0].rules[1].dependencies[0].extra = true; }],
    ['dangling dependency', x => { x.descriptors[0].rules[1].dependencies[0].id = 'missing'; }],
    ['unknown hook trigger', x => { x.descriptors[0].hooks[0].op = 'scenario'; }],
    ['wrong hook operation', x => { x.descriptors[0].hooks[0].operation = 'Policies.change'; }],
    ['unknown hook field', x => { x.descriptors[0].hooks[0].extra = true; }],
  ];
  for (const [name, mutate] of malformed) it(`refuses ${name}`, () => {
    const input = fixture();
    const raw: RawFixture = { descriptors: structuredClone(input.descriptors), bindings: input.bindings.map(binding => ({ ...binding })) };
    mutate(raw);
    assert.throws(() => bindOwnerModelPolicies({ table: tableFor(), ...raw }), isStateError('validation'));
  });

  it('rejects descriptor, rule, dependency, hook, binding and array accessors without evaluating them', () => {
    const paths: readonly (readonly (string | number)[])[] = [
      ['descriptors', 0, 'module'], ['descriptors', 0, 'rules', 0, 'fields'],
      ['descriptors', 0, 'rules', 1, 'dependencies', 0, 'model'],
      ['descriptors', 0, 'hooks', 0, 'op'], ['bindings', 0, 'evaluate'], ['descriptors', 0],
    ];
    let reads = 0;
    for (const path of paths) {
      const original = fixture();
      const input: RawFixture = { descriptors: structuredClone(original.descriptors), bindings: original.bindings.map(binding => ({ ...binding })) };
      let owner: any = input;
      for (const key of path.slice(0, -1)) owner = owner[key];
      Object.defineProperty(owner, path.at(-1)!, { enumerable: true, get: () => { reads++; throw new Error('getter ran'); } });
      assert.throws(() => bindOwnerModelPolicies({ table: tableFor(), ...input }), isStateError('validation', /accessor|element/));
    }
    assert.equal(reads, 0);
  });

  it('rejects caller-created policy facades before any owner session begins', async () => {
    const { store } = createTestMemoryStorage();
    await assert.rejects(beginOwnerMutation({ table: tableFor(), store, context: context(), bounds: { maxWork: 100, maxRows: 10 },
      policies: { beforeStage: async () => {}, finalize: async () => {}, hooks: new Map() } }), isStateError('validation', /Unverified/));
  });
});

describe('native rules through the actual owner mutation session', () => {
  it('evaluates final invariants in source order and returns the first error', async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor(); const calls: string[] = [];
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([
      { kind: 'invariant', id: 'z-first', dependencies: [] }, { kind: 'invariant', id: 'a-second', dependencies: [] },
    ])], bindings: [predicate('z-first', 'invariant', () => { calls.push('first'); throw new StateError('rule_failed', 'first rule'); }),
      predicate('a-second', 'invariant', () => { calls.push('second'); return false; })] });
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 100, maxRows: 10 }, policies });
    await session.stage({ op: 'create', model: ITEM, id: asId('one'), data: { amount: 1 } }, { cause: 'scenario' });
    await assert.rejects(session.finalize(), isStateError('rule_failed', /^first rule$/));
    assert.deepEqual(calls, ['first']); assert.equal(await store.load(ITEM, asId('one')), null);
  });

  for (const kind of ['lock', 'invariant'] as const) it(`requires an actual bool from ${kind}`, async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor();
    await seedRow(store, ITEM, { id: 'one', data: { amount: 1 } });
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor(kind === 'lock'
      ? [{ kind, id: 'bad', fields: ['amount'] }] : [{ kind, id: 'bad', dependencies: [] }])],
      bindings: [predicate('bad', kind, (() => 'truthy') as unknown as Extract<OwnerModelPolicyBinding, { kind: 'invariant' | 'lock' }>['evaluate'])] });
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 100, maxRows: 10 }, policies });
    if (kind === 'lock') await assert.rejects(session.stage({ op: 'update', model: ITEM, id: asId('one'), data: { label: 'new' } }, { cause: 'scenario' }), isStateError('validation', /bool/));
    else {
      await session.stage({ op: 'update', model: ITEM, id: asId('one'), data: { label: 'new' } }, { cause: 'scenario' });
      await assert.rejects(session.finalize(), isStateError('validation', /bool/));
    }
    assert.equal((await store.load(ITEM, asId('one')))!.data.label, undefined);
  });

  it('allows unrelated updates, unchanged locked fields and archive; refuses edits and hard removal', async () => {
    for (const mode of ['archive', 'remove'] as const) {
      const { store } = createTestMemoryStorage(); const table = tableFor(mode);
      await seedRow(store, ITEM, { id: 'one', data: { amount: { value: 1 }, label: 'old', locked: true } });
      const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'lock', id: 'frozen', fields: ['amount'] }])],
        bindings: [predicate('frozen', 'lock', (_ctx, row) => row.data.locked === true)] });
      const begin = () => beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 100, maxRows: 10 }, policies });
      const allowed = await begin();
      await allowed.stage({ op: 'update', model: ITEM, id: asId('one'), data: { amount: { value: 1 }, label: 'new' } }, { cause: 'scenario' });
      await commit(store, await allowed.finalize());
      assert.equal((await store.load(ITEM, asId('one')))!.data.label, 'new');
      const edit = await begin();
      await assert.rejects(edit.stage({ op: 'update', model: ITEM, id: asId('one'), data: { amount: { value: 2 } } }, { cause: 'scenario' }), isStateError('rule_failed', /Locked/));
      const removal = await begin();
      if (mode === 'remove') await assert.rejects(removal.stage({ op: 'remove', model: ITEM, id: asId('one') }, { cause: 'scenario' }), isStateError('rule_failed', /removed/));
      else {
        await removal.stage({ op: 'remove', model: ITEM, id: asId('one') }, { cause: 'scenario' });
        await commit(store, await removal.finalize());
        assert.notEqual((await store.load(ITEM, asId('one')))!.archivedAt, null);
      }
    }
  });

  it('uses entry state to establish a lock, and the next transaction enforces it', async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor(); const reads: unknown[] = [];
    await seedRow(store, ITEM, { id: 'one', data: { locked: false, amount: 1 } });
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'lock', id: 'frozen', fields: ['amount'] }])],
      bindings: [predicate('frozen', 'lock', async ({ read }, row) => {
        const entry = await read.get(ITEM, row.id); reads.push(entry?.data.locked); return entry?.data.locked === true;
      })] });
    const begin = () => beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 150, maxRows: 10 }, policies });
    const establishing = await begin();
    await establishing.stage({ op: 'update', model: ITEM, id: asId('one'), data: { locked: true, amount: 2 } }, { cause: 'scenario' });
    await establishing.stage({ op: 'update', model: ITEM, id: asId('one'), data: { amount: 3 } }, { cause: 'scenario' });
    await commit(store, await establishing.finalize()); assert.deepEqual(reads, [false, false]);
    const next = await begin();
    await assert.rejects(next.stage({ op: 'update', model: ITEM, id: asId('one'), data: { amount: 4 } }, { cause: 'scenario' }), isStateError('rule_failed'));
    assert.equal((await store.load(ITEM, asId('one')))!.data.amount, 3);
  });

  it('checks affected own rows once, deduplicates reverse targets and sorts their identities', async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor(); const evaluated: string[] = [];
    for (const id of ['a', 'b', 'z']) await seedRow(store, ITEM, { id, data: { amount: 1 } });
    await seedRow(store, LIMIT, { id: 'cap', data: { cap: 5 } });
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'invariant', id: 'valid', dependencies: [{ id: 'affected', model: LIMIT, maxTargets: 5 }] }])],
      bindings: [predicate('valid', 'invariant', (_ctx, row) => { evaluated.push(row.id); return row.data.amount === 2; }),
        dependency('affected', () => ['z', 'b', 'missing', 'a', 'a'].map(id => ({ model: ITEM, id: asId(id) })))] });
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 200, maxRows: 5 }, policies });
    await session.stage(['z', 'a', 'b'].map(id => ({ op: 'update' as const, model: ITEM, id: asId(id), data: { amount: 2 } })), { cause: 'scenario' });
    await session.stage({ op: 'update', model: ITEM, id: asId('z'), data: { amount: 2 } }, { cause: 'scenario' });
    await session.stage({ op: 'update', model: LIMIT, id: asId('cap'), data: { cap: 6 } }, { cause: 'scenario' });
    await session.finalize(); assert.deepEqual(evaluated, ['a', 'b', 'z']);
  });

  it('checks new own rows, skips removed and untouched own rows, and never calls unrelated selectors', async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor(); const evaluated: string[] = [];
    await seedRow(store, ITEM, { id: 'old', data: { amount: 0 } });
    await seedRow(store, ITEM, { id: 'untouched', data: { amount: 0 } });
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'invariant', id: 'valid', dependencies: [{ id: 'affected', model: LIMIT, maxTargets: 4 }] }])],
      bindings: [predicate('valid', 'invariant', (_ctx, row) => { evaluated.push(row.id); return row.data.amount === 1; }),
        dependency('affected', () => { throw new Error('Unchanged dependency selector ran.'); })] });
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 150, maxRows: 4 }, policies });
    await session.stage({ op: 'remove', model: ITEM, id: asId('old') }, { cause: 'scenario' });
    await session.stage({ op: 'create', model: ITEM, id: asId('new'), data: { amount: 1 } }, { cause: 'scenario' });
    await session.finalize(); assert.deepEqual(evaluated, ['new']);
    assert.notEqual(await store.load(ITEM, asId('old')), null);
    assert.equal(await store.load(ITEM, asId('new')), null);
  });

  it('reads final created, changed, removed and absent dependencies and final collection membership', async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor();
    await seedRow(store, ITEM, { id: 'one', data: { amount: 2, limit: 'cap', children: 1 } });
    await seedRow(store, CHILD, { id: 'old', data: { owner: 'one' } });
    const seen: unknown[] = [], selectedChanges: unknown[] = [];
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'invariant', id: 'valid', dependencies: [
      { id: 'limit-users', model: LIMIT, maxTargets: 4 }, { id: 'child-owners', model: CHILD, maxTargets: 4 },
    ] }])], bindings: [predicate('valid', 'invariant', async ({ read }, row) => {
      const cap = await read.get(LIMIT, asId(String(row.data.limit)));
      const children = await read.query({ model: CHILD, authority: 'owner', limit: 4, where: { op: 'eq', field: 'owner', value: row.id } });
      seen.push([cap?.data.cap ?? null, children.map(child => child.id)]);
      return cap !== null && Number(row.data.amount) <= Number(cap.data.cap) && children.length === row.data.children;
    }), dependency('limit-users', async (views, change) => {
      selectedChanges.push([change.before?.data.cap ?? null, change.after?.data.cap ?? null]);
      return (await views.final.query({ model: ITEM, authority: 'owner', limit: 4,
        where: { op: 'eq', field: 'limit', value: change.id } })).map(row => ({ model: ITEM, id: row.id }));
    }), dependency('child-owners', (_views, change) => [change.before, change.after].flatMap(row =>
      row === null ? [] : [{ model: ITEM, id: asId(String(row.data.owner)) }]))] });
    const begin = () => beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 300, maxRows: 4 }, policies });
    const absent = await begin();
    await absent.stage({ op: 'update', model: ITEM, id: asId('one'), data: { label: 'checked' } }, { cause: 'scenario' });
    await assert.rejects(absent.finalize(), isStateError('rule_failed'));
    assert.deepEqual(seen.pop(), [null, ['old']]);
    const created = await begin();
    await created.stage({ op: 'create', model: LIMIT, id: asId('cap'), data: { cap: 1 } }, { cause: 'scenario' });
    await created.stage({ op: 'update', model: LIMIT, id: asId('cap'), data: { cap: 3 } }, { cause: 'scenario' });
    await created.stage({ op: 'remove', model: CHILD, id: asId('old') }, { cause: 'scenario' });
    await created.stage({ op: 'create', model: CHILD, id: asId('new'), data: { owner: 'one' } }, { cause: 'scenario' });
    await commit(store, await created.finalize()); assert.deepEqual(seen.pop(), [3, ['new']]);
    assert.deepEqual(selectedChanges.pop(), [null, 3]);
    const revision = await store.readRevision();
    const removed = await begin();
    await removed.stage({ op: 'remove', model: LIMIT, id: asId('cap') }, { cause: 'scenario' });
    await assert.rejects(removed.finalize(), isStateError('rule_failed'));
    assert.deepEqual(seen.pop(), [null, ['new']]); assert.deepEqual(selectedChanges.pop(), [3, null]);
    assert.equal(await store.readRevision(), revision); assert.equal((await store.load(LIMIT, asId('cap')))!.data.cap, 3);
    const collection = await begin();
    await collection.stage({ op: 'remove', model: CHILD, id: asId('new') }, { cause: 'scenario' });
    await assert.rejects(collection.finalize(), isStateError('rule_failed'));
    assert.deepEqual(seen.pop(), [3, []]); assert.notEqual(await store.load(CHILD, asId('new')), null);
  });

  const invalidTargets: readonly [string, unknown, number, number][] = [
    ['wrong model', [{ model: LIMIT, id: 'one' }], 4, 4],
    ['nontext identity', [{ model: ITEM, id: 1 }], 4, 4],
    ['empty identity', [{ model: ITEM, id: '' }], 4, 4],
    ['extra target field', [{ model: ITEM, id: 'one', extra: true }], 4, 4],
    ['over selector bound', [{ model: ITEM, id: 'one' }, { model: ITEM, id: 'one' }], 1, 4],
    ['over owner row bound', [{ model: ITEM, id: 'one' }, { model: ITEM, id: 'two' }], 4, 1],
  ];
  for (const [name, targets, maxTargets, maxRows] of invalidTargets) it(`refuses ${name} through the actual finalizer`, async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor(); let calls = 0;
    await seedRow(store, LIMIT, { id: 'cap', data: { cap: 1 } });
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'invariant', id: 'valid', dependencies: [{ id: 'affected', model: LIMIT, maxTargets }] }])],
      bindings: [predicate('valid', 'invariant', () => { calls++; return true; }),
        dependency('affected', (() => targets) as unknown as Extract<OwnerModelPolicyBinding, { kind: 'dependency' }>['select'])] });
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 100, maxRows }, policies });
    await session.stage({ op: 'update', model: LIMIT, id: asId('cap'), data: { cap: 2 } }, { cause: 'scenario' });
    await assert.rejects(session.finalize(), isStateError('validation')); assert.equal(calls, 0);
    assert.equal((await store.load(LIMIT, asId('cap')))!.data.cap, 1);
  });

  it('refuses combined own and reverse targets beyond maxRows instead of partially evaluating', async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor(); let evaluated = 0;
    await seedRow(store, ITEM, { id: 'own', data: { amount: 1 } });
    await seedRow(store, ITEM, { id: 'reverse', data: { amount: 1 } });
    await seedRow(store, LIMIT, { id: 'cap', data: { cap: 1 } });
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'invariant', id: 'valid', dependencies: [{ id: 'affected', model: LIMIT, maxTargets: 1 }] }])],
      bindings: [predicate('valid', 'invariant', () => { evaluated++; return true; }),
        dependency('affected', () => [{ model: ITEM, id: asId('reverse') }])] });
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 150, maxRows: 1 }, policies });
    await session.stage({ op: 'update', model: ITEM, id: asId('own'), data: { amount: 2 } }, { cause: 'scenario' });
    await session.stage({ op: 'update', model: LIMIT, id: asId('cap'), data: { cap: 2 } }, { cause: 'scenario' });
    await assert.rejects(session.finalize(), isStateError('validation', /affected rows exceed/));
    assert.equal(evaluated, 0);
  });

  it('refuses returned target accessors before evaluating a getter or an invariant', async () => {
    const { store } = createTestMemoryStorage(); const table = tableFor(); let reads = 0, evaluated = 0;
    await seedRow(store, LIMIT, { id: 'cap', data: { cap: 1 } });
    const target = { model: ITEM, get id() { reads++; return asId('one'); } };
    const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor([{ kind: 'invariant', id: 'valid', dependencies: [{ id: 'affected', model: LIMIT, maxTargets: 1 }] }])],
      bindings: [predicate('valid', 'invariant', () => { evaluated++; return true; }), dependency('affected', () => [target])] });
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxWork: 100, maxRows: 4 }, policies });
    await session.stage({ op: 'update', model: LIMIT, id: asId('cap'), data: { cap: 2 } }, { cause: 'scenario' });
    await assert.rejects(session.finalize(), isStateError('validation', /accessor/));
    assert.equal(reads, 0); assert.equal(evaluated, 0);
  });
});


function transportedPolicyArtifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1,
    models: [{ name: ITEM, deleteMode: 'remove', fields: [{ name: 'amount', field: { kind: 'integer' }, required: false, serverOnly: false }] }],
    operations: [], modules: [{ path: identity.module, js: '/* Metadata test inventory: this loader does not evaluate module bytes. */',
      map: { version: 3, file: identity.module, sources: ['Policies.can'], sourcesContent: [''], names: [], mappings: '' } }],
    modelPolicies: [descriptor([{ kind: 'invariant', id: 'nonnegative', dependencies: [] }])] };
}
function transportedPolicyInput() {
  return { artifact: loadArtifactDescriptors(transportedPolicyArtifact(), { by: 'public' }), table: tableFor(),
    modules: [{ path: identity.module, registry: { [OWNER_MODEL_POLICY_BINDINGS_MEMBER]: [
      predicate('nonnegative', 'invariant', (_context, row) => typeof row.data.amount === 'number' && row.data.amount >= 0),
    ] } }] };
}

describe('source-verified module policy transport', () => {
  it('binds loaded claims through the private checked path and enforces the actual owner transaction', async () => {
    const input = transportedPolicyInput();
    input.modules.push({ path: 'unrelated.mjs', registry: { [OWNER_MODEL_POLICY_BINDINGS_MEMBER]: [] } });
    const policies = bindArtifactOwnerModelPolicies(input);
    assert.ok(policies);
    const { store } = createTestMemoryStorage();
    const begin = () => beginOwnerMutation({ table: input.table, store, context: context(), bounds: { maxWork: 100, maxRows: 10 }, policies });
    const rejected = await begin();
    await rejected.stage({ op: 'create', model: ITEM, id: asId('negative'), data: { amount: -1 } }, { cause: 'scenario' });
    await assert.rejects(rejected.finalize(), isStateError('rule_failed'));
    assert.equal(await store.load(ITEM, asId('negative')), null);
    const accepted = await begin();
    await accepted.stage({ op: 'create', model: ITEM, id: asId('positive'), data: { amount: 2 } }, { cause: 'scenario' });
    await commit(store, await accepted.finalize());
    assert.equal((await store.load(ITEM, asId('positive')))!.data.amount, 2);
  });

  it('preserves absent legacy metadata but refuses unclaimed native bindings', () => {
    const input = transportedPolicyInput();
    const legacy = transportedPolicyArtifact(); delete legacy.modelPolicies;
    input.artifact = loadArtifactDescriptors(legacy, { by: 'public' });
    assert.throws(() => bindArtifactOwnerModelPolicies(input), isStateError('validation', /Unclaimed/));
    input.modules[0]!.registry.modelPolicyBindings = [];
    assert.equal(bindArtifactOwnerModelPolicies(input), undefined);
  });

  it('refuses missing, duplicated, unlinked, foreign and malformed native transport identities', () => {
    const mutations: Array<(input: any) => void> = [
      x => { x.modules = []; }, x => { x.modules.push(x.modules[0]); },
      x => { x.modules[0].path = 'Policies'; },
      x => { x.modules[0].registry.modelPolicyBindings = []; },
      x => { x.modules[0].registry.modelPolicyBindings = null; },
      x => { x.modules[0].registry.modelPolicyBindings = undefined; },
      x => { const b = x.modules[0].registry.modelPolicyBindings; b.push(b[0]); },
      x => { x.modules[0].registry.modelPolicyBindings[0].id = 'unlinked'; },
      x => { x.modules[0].registry.modelPolicyBindings[0].ownerPackage = 'Foreign'; },
      x => { x.modules[0].registry.modelPolicyBindings[0].model = LIMIT; },
      x => { x.modules[0].registry.modelPolicyBindings[0].kind = 'lock'; },
      x => { x.modules[0].registry.modelPolicyBindings[0].evaluate = false; },
      x => { x.modules[0].registry = Object.create(x.modules[0].registry); },
      x => { x.artifact = Object.assign(Object.create({ modelPolicies: x.artifact.modelPolicies }), { registry: x.artifact.registry }); },
    ];
    for (const mutate of mutations) {
      const input = transportedPolicyInput(); mutate(input);
      assert.throws(() => bindArtifactOwnerModelPolicies(input), isStateError('validation'));
    }
  });

  it('never evaluates transport, array or callback getters during binding', () => {
    const paths: Array<Array<string | number>> = [
      ['artifact', 'modelPolicies'], ['modules', 0], ['modules', 0, 'registry'],
      ['modules', 0, 'registry', OWNER_MODEL_POLICY_BINDINGS_MEMBER],
      ['modules', 0, 'registry', OWNER_MODEL_POLICY_BINDINGS_MEMBER, 0, 'evaluate'],
    ];
    let reads = 0;
    for (const path of paths) {
      const input = transportedPolicyInput(); let target: any = input;
      for (const key of path.slice(0, -1)) target = target[key];
      Object.defineProperty(target, path.at(-1)!, { enumerable: true, get() { reads++; throw new Error('getter executed'); } });
      assert.throws(() => bindArtifactOwnerModelPolicies(input), isStateError('validation'));
    }
    assert.equal(reads, 0);
  });
});
