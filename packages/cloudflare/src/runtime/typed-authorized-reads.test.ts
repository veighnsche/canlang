import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
import { createMemoryIdentityStore as createFullIdentityStore } from '@canlang/identity/testing';
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
    for (const identity of [ownerIdentity, auditorIdentity]) {
      assert.equal(committed(await invoker.invokeMutation(envelope('filtered', { minimum: '2' }), identity)).result,
        '9007199254740993');
    }
    assert.equal(committed(await invoker.invokeMutation(envelope('filteredSecret'), ownerIdentity)).result, '2');
    for (const identity of [auditorIdentity, memberIdentity, anonymous]) {
      assert.equal(committed(await invoker.invokeMutation(envelope('filteredSecret'), identity)).result, '0');
    }
    assert.equal(committed(await invoker.invokeMutation(envelope('filtered', { minimum: '0' }), memberIdentity)).result, '0');
    assert.equal(committed(await invoker.invokeMutation(envelope('staged', { count: '7' }), ownerIdentity)).result,
      '9007199254741001');
    rows = await store.query({ model: MODEL, authority: 'owner' });
    assert.equal(rows.length, 3);
    assert.equal(committed(await invoker.invokeMutation(envelope('filteredStaged', { count: '13', accept: true }), ownerIdentity)).result, '13');
    rows = await store.query({ model: MODEL, authority: 'owner' });
    assert.equal(rows.length, 4);
    assert.equal(rows.filter(row => row.data.count === '14').length, 1);
    const beforeRollback = rows;
    const rollbackHistory = await Promise.all(rows.map(row => store.historyFor(MODEL, row.id)));
    const rejected = await invoker.invokeMutation(envelope('filteredStaged', { count: '17', accept: false }), ownerIdentity);
    assert.ok('error' in rejected, JSON.stringify(rejected));
    assert.equal(rejected.error.code, 'rule_failed');
    assert.deepEqual(await store.query({ model: MODEL, authority: 'owner' }), beforeRollback);
    assert.deepEqual(await Promise.all(rows.map(row => store.historyFor(MODEL, row.id))), rollbackHistory);

    // The defining memory Identity port removes only the read role after the
    // actual D1 scan. Public operation admission still succeeds independently.
    const roleIdentities = createFullIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const roleTeam = await roleIdentities.createTeam({ timezone: 'UTC' });
    for (const minimum of ['0', '9007199254740994']) {
      const roleUser = await roleIdentities.createUser({ email: `filtered-${minimum}@example.test`, email_verified: true, password_hash: 'unused' });
      const roleMember = await roleIdentities.createMembership({ team_id: roleTeam.team_id, user_id: roleUser.user_id,
        is_owner: false, roles: [{ role: `${APP}.auditor`, granted_at: new Date(FIXED_NOW).toISOString(), granted_by: roleUser.user_id }] });
      const roleIdentity = makeIdentity({ membership: roleMember, team: roleTeam, email: roleUser.email });
      let roleRemoved = false;
      const roleStore: StoragePort = { ...store, async query(spec) {
        const scanned = await store.query(spec);
        if (!roleRemoved && spec.model === MODEL && spec.authority === 'viewer') {
          roleRemoved = true;
          await roleIdentities.setMembershipRoles(roleMember.membership_id, []);
        }
        return scanned;
      } };
      const revision = await store.readRevision();
      const histories = await Promise.all(rows.map(row => store.historyFor(MODEL, row.id)));
      const revokedFilter = await buildInvoker(artifact, asm, roleStore, { memberships: roleIdentities, now: () => FIXED_NOW })
        .invokeMutation(envelope('filteredEffect', { minimum }), roleIdentity);
      assert.equal(roleRemoved, true);
      assert.equal((await roleIdentities.findMembership(roleTeam.team_id, roleUser.user_id))?.status, 'active');
      assert.deepEqual((await roleIdentities.findMembership(roleTeam.team_id, roleUser.user_id))?.roles, []);
      assert.ok('error' in revokedFilter, JSON.stringify(revokedFilter));
      assert.equal(revokedFilter.error.code, 'forbidden');
      assert.equal(await store.readRevision(), revision);
      assert.deepEqual(await store.query({ model: MODEL, authority: 'owner' }), rows);
      assert.deepEqual(await Promise.all(rows.map(row => store.historyFor(MODEL, row.id))), histories);
    }
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
