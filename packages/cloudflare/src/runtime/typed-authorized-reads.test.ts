import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import {
  FIXED_NOW, asModel, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedAuthorizedReads';
const MODEL = asModel(`${APP}.Entry`);
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

test('compiled aggregates use authorized native row fields and live owner read grants', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-authorized-reads.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-authorized-reads-'));
  let worker: Miniflare | undefined;
  // Identity/membership are fixtures; only canonical State storage uses actual D1.
  const memberships = createMemoryIdentityStore();
  const owner = await seedMember(memberships, { isOwner: true });
  const member = await seedMember(memberships, { isOwner: false, teamId: owner.team.team_id });
  const auditor = await seedMember(memberships, {
    isOwner: false, teamId: owner.team.team_id, roles: [`${APP}.auditor`],
  });
  const ownerIdentity = makeIdentity({ membership: owner.membership, email: owner.user.email });
  const memberIdentity = makeIdentity({ membership: member.membership, email: member.user.email });
  const auditorIdentity = makeIdentity({ membership: auditor.membership, email: auditor.user.email });
  const anonymous = makeIdentity({ actor: null, team: null, membership: null });
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    const store = createD1Storage(database);
    const options = { memberships, now: () => FIXED_NOW };
    const invoker = buildInvoker(artifact, asm, store, options);
    committed(await invoker.invokeMutation(envelope('Entry.create'), ownerIdentity));
    committed(await invoker.invokeMutation(envelope('Entry.create', { count: '9007199254740993' }), ownerIdentity));
    let rows = await store.query({ model: MODEL, authority: 'owner' });
    assert.equal(rows.length, 2);
    const read = { operation: `${APP}.Entry.read`, inputs: {} };
    const ownerRead = await invoker.invokeRead(read, ownerIdentity);
    assert.ok('result' in ownerRead, JSON.stringify(ownerRead));
    assert.deepEqual((ownerRead.result as { records: Array<{ data: { count: string } }> }).records
      .map((row) => row.data.count).sort(), ['1', '9007199254740993']);
    assert.equal(committed(await invoker.invokeMutation(envelope('total'), ownerIdentity)).result, '9007199254740994');
    const auditorRead = await invoker.invokeRead(read, auditorIdentity);
    assert.ok('result' in auditorRead, JSON.stringify(auditorRead));
    const auditorRows = (auditorRead.result as { records: Array<{ data: Record<string, unknown> }> }).records;
    assert.deepEqual(auditorRows.map((row) => row.data.count).sort(), ['1', '9007199254740993']);
    assert.ok(auditorRows.every((row) => Object.keys(row.data).join() === 'count'));
    assert.equal(committed(await invoker.invokeMutation(envelope('total'), auditorIdentity)).result, '9007199254740994');
    assert.equal(committed(await invoker.invokeMutation(envelope('hidden'), auditorIdentity)).result, false);
    assert.equal(committed(await invoker.invokeMutation(envelope('hidden'), ownerIdentity)).result, true);
    for (const identity of [memberIdentity, anonymous]) {
      const deniedRead = await invoker.invokeRead(read, identity);
      assert.ok('result' in deniedRead, JSON.stringify(deniedRead));
      assert.deepEqual((deniedRead.result as { records: unknown[] }).records, []);
      assert.equal(committed(await invoker.invokeMutation(envelope('total'), identity)).result, '0');
    }
    assert.equal(committed(await invoker.invokeMutation(envelope('staged', { count: '7' }), ownerIdentity)).result,
      '9007199254741001');
    rows = await store.query({ model: MODEL, authority: 'owner' });
    assert.equal(rows.length, 3);
    // A stale identity snapshot cannot preserve owner reads after live membership removal.
    await memberships.removeMembership(owner.membership.membership_id);
    assert.equal(committed(await invoker.invokeMutation(envelope('total'), ownerIdentity)).result, '0');

    const secondOwner = await seedMember(memberships, { isOwner: true, teamId: owner.team.team_id });
    const secondIdentity = makeIdentity({ membership: secondOwner.membership, email: secondOwner.user.email });
    let revokeAfterScan = true;
    const revokingStore: StoragePort = {
      ...store,
      async query(spec) {
        const scanned = await store.query(spec);
        if (revokeAfterScan && spec.model === MODEL) {
          revokeAfterScan = false;
          await memberships.removeMembership(secondOwner.membership.membership_id);
        }
        return scanned;
      },
    };
    const beforeRevision = await store.readRevision();
    const beforeHistory = await Promise.all(rows.map((row) => store.historyFor(MODEL, row.id)));
    const revoked = await buildInvoker(artifact, asm, revokingStore, options)
      .invokeMutation(envelope('total'), secondIdentity);
    assert.equal(revokeAfterScan, false);
    assert.ok('error' in revoked, JSON.stringify(revoked));
    assert.equal(revoked.error.code, 'forbidden');
    assert.equal(await store.readRevision(), beforeRevision);
    assert.deepEqual(await store.query({ model: MODEL, authority: 'owner' }), rows);
    assert.deepEqual(await Promise.all(rows.map((row) => store.historyFor(MODEL, row.id))), beforeHistory);
  } finally {
    try { await worker?.dispose(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
