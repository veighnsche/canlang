import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  FIXED_NOW, asModel, asOperationId, createMemoryIdentityStore, makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedContextScopes';
const MODEL = asModel(`${APP}.Trace`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-context-scopes.json');
let sequence = 0;
function envelope(operation: string, inputs: MutationEnvelope['inputs'] = {}): MutationEnvelope {
  return { operation: `${APP}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}
function committed(outcome: MutationOutcome) {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  return outcome.result;
}
function rejected(outcome: MutationOutcome, code: string) {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.error.code, code);
}

test('actual generated operations observe admitted actor, team, clock and operation facts', async () => {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  // State, membership and identity are explicit memory fixtures. Wrong scope
  // here means a missing live membership in the selected team, not a storage partition.
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const team = await memberships.createTeam('Europe/Brussels');
  const member = await seedMember(memberships, { teamId: team.team_id, isOwner: false });
  const identity = makeIdentity({ membership: member.membership, team, email: member.user.email });
  const otherTeam = await memberships.createTeam('America/New_York');
  const wrongScope = makeIdentity({ membership: member.membership, team: otherTeam,
    userId: member.user.user_id, email: member.user.email });
  const anonymous = makeIdentity({ actor: null, team: null, membership: null });
  const dir = await mkdtemp(join(tmpdir(), 'can-context-scopes-'));
  try {
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: dir, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    let clock = FIXED_NOW;
    const worker = buildInvoker(artifact, asm, store, { memberships, source: 'worker', now: () => clock });
    const mcp = buildInvoker(artifact, asm, store, { memberships, source: 'mcp', now: () => clock });
    for (const [source, invoker] of [['worker', worker], ['mcp', mcp]] as const) {
      const request = envelope('capture');
      assert.equal(committed(await invoker.invokeMutation(request, identity)).result, request.operation_id);
      const rows = await store.query({ model: MODEL, authority: 'owner' });
      const row = rows.find((row) => row.data['invocation'] === request.operation_id);
      assert.ok(row);
      assert.deepEqual(row.data, {
        who: member.user.user_id, scope: team.team_id, zone: team.timezone, origin: source,
        invocation: request.operation_id, instant: new Date(clock).toISOString(),
      });
      assert.equal(row.created, clock);
      assert.equal(row.createdBy, member.user.user_id);
      const history = await store.historyFor(MODEL, row.id);
      assert.equal(history[0]?.actor, member.user.user_id);
      assert.equal(history[0]?.operation, request.operation);
      assert.equal(history[0]?.operationId, request.operation_id);
      clock += 1000;
    }
    assert.equal(committed(await worker.invokeMutation(envelope('identify'), identity)).result, member.user.user_id);
    // Authenticated scope needs the verified actor; it does not require membership.
    assert.equal(committed(await worker.invokeMutation(envelope('identify'), wrongScope)).result, member.user.user_id);
    rejected(await worker.invokeMutation(envelope('capture'), wrongScope), 'forbidden');
    rejected(await worker.invokeMutation(envelope('capture'), anonymous), 'forbidden');
    rejected(await worker.invokeMutation(envelope('identify'), anonymous), 'forbidden');
    assert.equal(committed(await mcp.invokeMutation(envelope('anonymous'), anonymous)).result, true);
    assert.equal(committed(await mcp.invokeMutation(envelope('anonymous'), identity)).result, false);
    assert.equal(committed(await mcp.invokeMutation(envelope('source'), anonymous)).result, 'mcp');
    assert.equal(committed(await mcp.invokeMutation(envelope('clock'), anonymous)).result, new Date(clock).toISOString());
    const beforeForged = await store.query({ model: MODEL, authority: 'owner' });
    rejected(await worker.invokeMutation(envelope('capture', {
      actor: { id: 'forged' }, team: { id: otherTeam.team_id, timezone: 'UTC' },
      now: '2000-01-01T00:00:00.000Z', operation: { id: 'forged', source: 'forged' },
    }), identity), 'validation');
    assert.deepEqual(await store.query({ model: MODEL, authority: 'owner' }), beforeForged);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
