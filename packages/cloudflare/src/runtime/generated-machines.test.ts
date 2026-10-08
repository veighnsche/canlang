import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  FIXED_NOW, asId, asModel, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';
import { queryPageRowsCanonical } from '@canlang/cloudflare/runtime/invoke';

const APP = 'GeneratedMachines';
const MODEL = asModel(`${APP}.Job`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/generated-machines.json');
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
async function setup(syntheticBypass = false) {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  if (syntheticBypass) {
    // Synthetic handler override only: descriptors and machine metadata stay compiler output.
    artifact.modules[0]!.js += `
const originalCanApp = canApp;
canApp = function() {
  const registry = originalCanApp();
  registry["${APP}.start"] = async function(c, {job}) {
    await set(c, job, {status: "ready"});
    return 0n;
  };
  return registry;
};
`;
  }
  const dir = await mkdtemp(join(tmpdir(), 'can-generated-machines-'));
  const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
    workDir: dir, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
  // This owning test exercises canonical semantics over memory State, not persistence.
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const outsider = makeIdentity({ userId: 'nonmember', team: member.team, membership: null });
  const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
  return { artifact, store, identity, outsider, invoker,
    pageRows: () => queryPageRowsCanonical({ artifact, asm, store, identity,
      memberships, model: MODEL, args: {} }),
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('compiled flat machines compose staged transitions and integer writes with rollback and replay', async () => {
  const world = await setup();
  try {
    const status = world.artifact.models!.find((model) => model.name === MODEL)!.fields.find((field) => field.name === 'status');
    assert.equal(status?.machine?.initial, 'idle');
    assert.deepEqual(world.artifact.operations!.find((operation) => operation.name === `${APP}.start`)?.result, { type: 'int' });
    const create = async (label: string) => committed(await world.invoker.invokeMutation(
      envelope('Job.create', { label }), world.identity,
    )).result as { id: string; version: number; data: Record<string, unknown> };
    const first = await create('first');
    assert.deepEqual(first.data, { label: 'first', attempts: '0', status: 'idle' });
    assert.equal(first.version, 1);
    const idlePage = await world.pageRows();
    assert.equal(idlePage.rows.find((row) => row.id === first.id)?.fields['status'], 'idle');
    const ref = (id: string, version: number) => ({ id, version: String(version) });
    const request = envelope('start', { job: ref(first.id, 1), accept: true });
    assert.equal(committed(await world.invoker.invokeMutation(request, world.identity)).result, '1');
    const ready = await world.store.load(MODEL, asId(first.id));
    assert.deepEqual(ready?.data, { label: 'first', attempts: '1', status: 'ready' });
    assert.equal(ready?.version, 2);
    const readyPage = await world.pageRows();
    assert.equal(readyPage.rows.find((row) => row.id === first.id)?.fields['status'], 'ready');
    const history = await world.store.historyFor(MODEL, asId(first.id));
    assert.deepEqual(history.slice(-3).map((entry) => entry.version), [2, 2, 2]);
    assert.deepEqual(history.slice(-3).map((entry) => entry.after), [
      { label: 'first', attempts: '0', status: 'queued' },
      { label: 'first', attempts: '1', status: 'queued' },
      { label: 'first', attempts: '1', status: 'ready' },
    ]);
    const revision = await world.store.readRevision();
    assert.equal(committed(await world.invoker.invokeMutation(request, world.identity), 'replayed').result, '1');
    assert.equal(await world.store.readRevision(), revision);
    assert.deepEqual(await world.store.historyFor(MODEL, asId(first.id)), history);
    rejected(await world.invoker.invokeMutation(envelope('start', {
      job: ref(first.id, 1), accept: true,
    }), world.identity), 'conflict');

    const second = await create('rollback');
    const before = await world.store.load(MODEL, asId(second.id));
    const beforeHistory = await world.store.historyFor(MODEL, asId(second.id));
    rejected(await world.invoker.invokeMutation(envelope('start', {
      job: ref(second.id, 1), accept: false,
    }), world.identity));
    rejected(await world.invoker.invokeMutation(envelope('mismatch', {
      job: ref(second.id, 1),
    }), world.identity), 'rule_failed');
    rejected(await world.invoker.invokeMutation(envelope('start', {
      job: ref(second.id, 1), accept: true,
    }), world.outsider), 'forbidden');
    rejected(await world.invoker.invokeMutation(envelope('Job.update', {
      record: ref(second.id, 1), status: 'ready',
    }), world.identity), 'validation');
    rejected(await world.invoker.invokeMutation(envelope('Job.create', {
      label: 'forged status', status: 'ready',
    }), world.identity), 'validation');
    assert.deepEqual(await world.store.load(MODEL, asId(second.id)), before);
    assert.deepEqual(await world.store.historyFor(MODEL, asId(second.id)), beforeHistory);
  } finally { await world.cleanup(); }
});

test('synthetic handler bypass cannot set a managed machine field through canonical State', async () => {
  const world = await setup(true);
  try {
    const created = committed(await world.invoker.invokeMutation(envelope('Job.create', {
      label: 'protected',
    }), world.identity)).result as { id: string };
    const before = await world.store.load(MODEL, asId(created.id));
    const history = await world.store.historyFor(MODEL, asId(created.id));
    const error = rejected(await world.invoker.invokeMutation(envelope('start', {
      job: { id: created.id, version: '1' }, accept: true,
    }), world.identity), 'validation');
    assert.match(error.message, /Machine field.*transition/);
    assert.deepEqual(await world.store.load(MODEL, asId(created.id)), before);
    assert.deepEqual(await world.store.historyFor(MODEL, asId(created.id)), history);
  } finally { await world.cleanup(); }
});
