import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  FIXED_NOW, asId, asModel, asOperation, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedExactNumbers';
const MODEL = asModel(`${APP}.Ledger`);
const eur = (minor: string) => ({ minor, currency: 'EUR' });
let sequence = 0;
function envelope(operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope {
  return { operation: `${APP}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}
function committed(outcome: MutationOutcome, status = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  return outcome.result;
}
function rejected(outcome: MutationOutcome, code?: string) {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  if (code !== undefined) assert.equal(outcome.error.code, code);
  return outcome.error;
}

test('compiled decimal and money profiles retain exact native arithmetic and canonical wire receipts', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-exact-numbers.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  for (const [name, type] of [['add', 'decimal'], ['cash', 'money'], ['amounts', 'decimal[]'],
    ['coins', 'money[]'], ['maybeAmount', 'decimal?'], ['maybeCash', 'money?'],
    ['maybeAmounts', 'decimal[]?'], ['maybeCoins', 'money[]?']]) {
    assert.deepEqual(artifact.operations!.find((operation) => operation.name === `${APP}.${name}`)?.result, { type });
  }
  const dir = await mkdtemp(join(tmpdir(), 'can-exact-numbers-'));
  // Canonical memory State qualifies this profile's semantics, without a new persistence claim.
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const options = { memberships, now: () => FIXED_NOW };
  try {
    const assemblyOptions = { stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui') };
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      ...assemblyOptions, workDir: join(dir, 'modules'),
    });
    const invoker = buildInvoker(artifact, asm, store, options);
    const create = envelope('Ledger.create', { cash: eur('250'), seedCoins: [eur('10'), eur('20')] });
    const born = committed(await invoker.invokeMutation(create, identity));
    const row = born.result as { id: string; data: Record<string, unknown> };
    assert.deepEqual(row.data, {
      amount: '1.5', cash: eur('250'), amounts: [], coins: [], seedAmounts: ['0.1', '0.2'],
      seedCoins: [eur('10'), eur('20')], maybeAmount: null, maybeCash: null, maybeAmounts: null, maybeCoins: null,
    });
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const receiptIdentity = (request: MutationEnvelope) => ({ app: APP,
      owner: identity.team!.team_id, principal: identity.actor!.user_id,
      operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
    const createReceipt = await store.readReceipt(receiptIdentity(create));
    assert.equal(createReceipt?.resolvedDefaults['amount'], '1.5');
    assert.equal(Object.hasOwn(createReceipt!.resolvedDefaults, 'cash'), false);
    assert.equal(Object.hasOwn(createReceipt!.resolvedDefaults, 'seedCoins'), false);
    const defaults = envelope('defaults', { cash: eur('20'), coins: [eur('10')] });
    assert.deepEqual(committed(await invoker.invokeMutation(defaults, identity)).result, eur('30'));
    const defaultsReceipt = await store.readReceipt(receiptIdentity(defaults));
    assert.deepEqual(defaultsReceipt?.resolvedDefaults, {
      delta: '0.1', amounts: ['0.1', '0.2'],
    });
    assert.deepEqual(committed(await invoker.invokeMutation(defaults, identity), 'replayed').result, eur('30'));
    for (const [value, minor] of [['2.5', '250'], ['2.505', '250'], ['2.515', '252']]) {
      assert.deepEqual(committed(await invoker.invokeMutation(envelope('construct', { value }), identity)).result, eur(minor!));
    }
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('empty', { values: [] }), identity)).result, eur('0'));
    const request = envelope('add', {
      ledger: ref(1), delta: '9007199254740993.1', cash: eur('9007199254740993'),
      amounts: ['0.1', '0.2'], coins: [eur('20'), eur('30')], accept: true,
    });
    assert.equal(committed(await invoker.invokeMutation(request, identity)).result, '9007199254740995.2');
    assert.equal(committed(await invoker.invokeMutation(request, identity), 'replayed').result, '9007199254740995.2');
    const stored = await store.load(MODEL, asId(row.id));
    assert.equal(stored?.version, 2);
    assert.equal(stored?.data['amount'], '9007199254740995.2');
    assert.deepEqual(stored?.data['cash'], eur('9007199254741323'));
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('cash', { ledger: ref(2) }), identity)).result, eur('9007199254741323'));
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('amounts', { ledger: ref(2) }), identity)).result,
      ['0.3', '9007199254740995.2']);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('coins', { ledger: ref(2) }), identity)).result,
      [eur('20'), eur('30')]);
    for (const operation of ['maybeAmount', 'maybeCash', 'maybeAmounts', 'maybeCoins']) {
      assert.equal(committed(await invoker.invokeMutation(envelope(operation, { ledger: ref(2) }), identity)).result, null);
    }
    assert.equal(committed(await invoker.invokeMutation(envelope('optional', {
      ledger: ref(2), amount: '0.5', cash: eur('50'), amounts: ['0.6', '0.7'], coins: [eur('60'), eur('70')],
    }), identity)).result, '0.5');
    assert.equal(committed(await invoker.invokeMutation(envelope('maybeAmount', { ledger: ref(3) }), identity)).result, '0.5');
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('maybeCash', { ledger: ref(3) }), identity)).result, eur('50'));
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('maybeAmounts', { ledger: ref(3) }), identity)).result, ['0.6', '0.7']);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('maybeCoins', { ledger: ref(3) }), identity)).result, [eur('60'), eur('70')]);
    assert.equal(committed(await invoker.invokeMutation(envelope('optional', {
      ledger: ref(3),
    }), identity)).result, null);
    for (const operation of ['maybeAmount', 'maybeCash', 'maybeAmounts', 'maybeCoins']) {
      assert.equal(committed(await invoker.invokeMutation(envelope(operation, { ledger: ref(4) }), identity)).result, null);
    }
    const beforePartial = await store.load(MODEL, asId(row.id));
    committed(await invoker.invokeMutation(envelope('Ledger.update', {
      record: ref(4), amount: '2.2',
    }), identity));
    const beforeFailures = await store.load(MODEL, asId(row.id));
    assert.equal(beforeFailures?.version, 5);
    assert.deepEqual(beforeFailures?.data, { ...beforePartial?.data, amount: '2.2' });
    const history = await store.historyFor(MODEL, asId(row.id));
    const validInputs = { ledger: ref(5), delta: '0.1', cash: eur('1'), amounts: [], coins: [], accept: true };
    for (const invalid of [{ delta: 0.1 }, { delta: '1e3' }, { amounts: [0.1] },
      { cash: { minor: 1, currency: 'EUR' } }, { cash: { minor: '1', currency: 'XXX' } },
      { coins: [{ minor: '1', currency: 'EUR', extra: true }] }]) {
      rejected(await invoker.invokeMutation(envelope('add', { ...validInputs, ...invalid }), identity), 'validation');
    }
    for (const invalid of [{ amount: 1 }, { cash: { minor: 1, currency: 'EUR' } }]) {
      rejected(await invoker.invokeMutation(envelope('Ledger.update', {
        record: ref(5), ...invalid,
      }), identity), 'validation');
    }
    for (const mixed of [{ cash: { minor: '1', currency: 'USD' } },
      { coins: [{ minor: '1', currency: 'USD' }] }]) {
      const error = rejected(await invoker.invokeMutation(envelope('add', { ...validInputs, ...mixed }), identity));
      assert.match(error.message, /currenc/i);
    }
    rejected(await invoker.invokeMutation(envelope('add', { ...validInputs, accept: false }), identity));
    assert.deepEqual(await store.load(MODEL, asId(row.id)), beforeFailures);
    assert.deepEqual(await store.historyFor(MODEL, asId(row.id)), history);

    // Synthetic handler-only invalid native carrier exercises the checked field encoder.
    const invalidCarrier = structuredClone(artifact);
    invalidCarrier.modules[0]!.js += `
const originalCanApp = canApp;
canApp = function() {
  const registry = originalCanApp();
  registry["${APP}.add"] = async function(c, {ledger}) {
    await set(c, ledger, {amount: 1});
    return 1;
  };
  return registry;
};
`;
    const invalidAsm = await assembleModules({ artifact: invalidCarrier, sourcePath: path }, {
      ...assemblyOptions, workDir: join(dir, 'invalid-carrier'),
    });
    rejected(await buildInvoker(invalidCarrier, invalidAsm, store, options).invokeMutation(
      envelope('add', validInputs), identity,
    ), 'validation');
    assert.deepEqual(await store.load(MODEL, asId(row.id)), beforeFailures);
    assert.deepEqual(await store.historyFor(MODEL, asId(row.id)), history);
    assert.doesNotThrow(() => JSON.stringify([createReceipt, defaultsReceipt, stored, history]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
