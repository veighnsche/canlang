/** Original CanCustomer recover, its actual imported helpers and source policies.
 * Canonical snapshots are setup only. Every exercised mutation is the compiler's
 * unchanged recover method, through the installed State/Identity/D1 graph.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, CommitBatch, ModelName, MutationEnvelope, RecordId, StoredRow, StoragePort } from '@canlang/contracts';
import type { MutationOutcome } from '../src/worker/assembly.js';
import { prepareCustomerRecoverSource } from './customer-recover-source.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
const APP = 'CanCustomer', OPERATION = 'customer.recover';
const CUSTOMER = 'customer.Customer' as ModelName, ROLE = 'customer.CompanyRole' as ModelName;
const EMPLOYEE = 'employee.Employee' as ModelName, LOCATION = 'rent_catalog.Location' as ModelName;
const ref = (row: StoredRow) => ({ id: row.id, version: String(row.version) });
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, status); return outcome.result;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(names.success, true);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    tables[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return tables;
}

test('original Customer recover creates or reactivates administrator with current staff/custom-role authority and no-effect refusals/replay',
  { timeout: 600000 }, async () => {
    const directory = await mkdtemp(join(root, '.can-native-customer-recover-'));
    let worker: Miniflare | undefined;
    try {
      const fixture = await prepareCustomerRecoverSource(directory);
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker, createTeamOwnerStorageBoundary } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { materializeCanonicalExampleSnapshots } = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { nativeScenarioRequire } = await nodeImport(installed('runtime/native-scenario-require.js')) as typeof import('../src/runtime/native-scenario-require.js');
      const { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
      const { createD1OwnerRouter } = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
      const { uuidv7 } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const inventory = installedLocalPreviewInputInventory(root, compilerPath);
      const capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixture.sourcePath, compilerPath,
        catalogPath: process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'),
        profile: 'native-original-customer-recover', helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'), ...inventory,
        extraInputPaths: [...inventory.extraInputPaths, ...fixture.originalInputPaths.map(path => ({ name: `customer-recover-original:${relative(root, path)}`, path }))],
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      const compiled = await promisify(execFile)(compilerPath, ['compile', '--format=json', '--native-scenario-receipts',
        `--catalog=${capture.inputs.find(input => input.name === 'catalog')!.requestedPath}`, capture.compilerOperand],
        { cwd: root, maxBuffer: 32 * 1024 * 1024 });
      const artifact: CompileArtifact = JSON.parse(compiled.stdout);
      assert.equal(await captureIsCurrent(capture), true);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.ok(artifact.operations?.some(operation => operation.name === OPERATION), 'original recover is callable');
      assert.deepEqual(artifact.operations?.filter(operation => operation.kind !== 'read').map(operation => operation.name), [OPERATION], 'no replacement/setup methods');
      assert.ok(fixture.source.includes(fixture.recover));
      const asm = await assembleModules({ artifact, sourcePath: fixture.sourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}', d1Persist: join(directory, 'd1'),
        d1Databases: { IDENTITY: 'customer-recover-identity', OWNER: 'customer-recover-owner' } });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb);
      const now = Date.parse('2026-10-18T12:00:00Z'), clock = { nowMs: () => now }; let sequence = 1000;
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(name: string, role?: string) {
        const user = await identities.createUser({ email: `${name}@customer-recover.example.test`, password_hash: 'unused', email_verified: true });
        const roles = role === undefined ? [] : [{ role, granted_at: new Date(now).toISOString(), granted_by: user.user_id }];
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles });
        const token = `customer-recover-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { user, membership, roles, current, identity: await current() };
      }
      const manager = await actor('manager', 'customer.customer_manager');
      const noStaff = await actor('missing-staff', 'customer.customer_manager');
      const reader = await actor('wrong-role', 'customer.customer_reader');
      const subject = await actor('subject');
      const batches: CommitBatch[] = [];
      let onOwnerRoleQuery: (() => Promise<void>) | undefined;
      const router = createD1OwnerRouter({ resolveBinding: scope => scope.app === APP && scope.owner === team.team_id
        ? { ...scope, db: ownerDb, initializeFresh: true } : null });
      let retained: StoragePort | undefined;
      const boundary = await createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities, router: {
        async ownerScopedStoragePort(scope) {
          const checked = await router.ownerScopedStoragePort(scope);
          if (retained === undefined) retained = { ...checked,
            async query(spec) {
              const rows = await checked.query(spec);
              if (spec.model === ROLE && spec.authority === 'owner' && onOwnerRoleQuery !== undefined) {
                const reached = onOwnerRoleQuery; onOwnerRoleQuery = undefined; await reached();
              }
              return rows;
            },
            async commit(batch) { const result = await checked.commit(batch); batches.push(batch); return result; },
          };
          return retained;
        },
      } });
      const store = await boundary.forIdentity(manager.identity);
      const id = () => uuidv7(now, ++sequence) as RecordId;
      const siteId = id(), otherSiteId = id(), companyId = id(), previousCompanyId = id(), individualId = id();
      const secondLocationCompanyId = id(), emptyLocationCompanyId = id(), managerEmployeeId = id();
      const previousId = id(), bookerId = id();
      const location = (name: string) => ({ name, address: '1 Example Road', timezone: 'Europe/Brussels', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true });
      const company = (name: string, kind = 'company') => ({ name, kind, locations: [{ id: siteId }], active: true });
      const employee = (user: string) => ({ user: { id: user }, home: { id: siteId }, locations: [{ id: siteId }], operator_wide: false,
        active: true, start: '2026-10-01', role: 'directory operator', skills: [] });
      await materializeCanonicalExampleSnapshots({ asm, artifact, store, identity: manager.identity, now, operationId: uuidv7(now, ++sequence), snapshots: [
        { model: LOCATION, id: siteId, data: location('Main') }, { model: LOCATION, id: otherSiteId, data: location('Other') },
        { model: EMPLOYEE, id: managerEmployeeId, data: employee(manager.user.user_id) }, { model: EMPLOYEE, id: id(), data: employee(reader.user.user_id) },
        { model: CUSTOMER, id: companyId, data: company('Create company') },
        { model: CUSTOMER, id: previousCompanyId, data: company('Reactivate company') },
        { model: CUSTOMER, id: individualId, data: company('Individual', 'individual') },
        { model: CUSTOMER, id: secondLocationCompanyId, data: { ...company('Second location succeeds'), locations: [{ id: otherSiteId }, { id: siteId }] } },
        { model: CUSTOMER, id: emptyLocationCompanyId, data: { ...company('No customer locations'), locations: [] } },
        { model: ROLE, id: previousId, parent: { model: CUSTOMER, id: previousCompanyId }, data: { account: { id: subject.user.user_id }, role: 'administrator', locations: [{ id: otherSiteId }], active: false } },
        { model: ROLE, id: bookerId, parent: { model: CUSTOMER, id: previousCompanyId }, data: { account: { id: subject.user.user_id }, role: 'booker', locations: [{ id: otherSiteId }], active: false } },
      ] });
      batches.length = 0;
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage: boundary });
      const row = async (model: ModelName, recordId: RecordId) => { const found = await store.load(model, recordId); assert.ok(found); return found; };
      const envelope = async (org = companyId, reason = 'Reviewed administrator recovery'): Promise<MutationEnvelope> => ({
        operation: OPERATION, operation_id: uuidv7(now, ++sequence), inputs: { org: ref(await row(CUSTOMER, org)), account: { id: subject.user.user_id }, reason },
      });
      const resources = async () => ({ identity: await snapshot(identityDb), owner: await snapshot(ownerDb) });
      const forgedBefore = await resources(); let forgedCalled = false;
      await assert.rejects(() => nativeScenarioRequire(Object.freeze({ context: manager.identity, store, artifact }),
        async () => { forgedCalled = true; return true; }, Object.freeze({ org: { id: companyId }, account: { id: subject.user.user_id }, reason: 'forged' })),
      /actual installed mutation reader/);
      assert.equal(forgedCalled, false); assert.deepEqual(await resources(), forgedBefore);
      function onlyRejectedReceipt(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>,
        batch: CommitBatch, code: string) {
        for (const key of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const) assert.deepEqual(batch[key] ?? [], []);
        assert.ok(batch.receipt); assert.equal(batch.receipt.identity.operation, OPERATION);
        assert.equal(batch.receipt.outcome.status, 'rejected');
        if (batch.receipt.outcome.status !== 'rejected') throw new Error('Expected the established empty rejection receipt.');
        assert.equal(batch.receipt.outcome.code, code);
        for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (!['receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name)) assert.deepEqual(after[name], before[name], name);
        }
      }
      async function noEffects(input: MutationEnvelope, identity = manager.identity, code = 'forbidden', allowRejectedReceipt = false) {
        const before = await resources(), count = batches.length, revision = await store.readRevision();
        const outcome = await invoker.invokeMutation(input, identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, code, JSON.stringify(outcome));
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        if (batches.length === count) { assert.deepEqual(after.owner, before.owner); assert.equal(await store.readRevision(), revision); }
        else {
          assert.equal(allowRejectedReceipt, true, 'admission refusal must not commit'); assert.equal(batches.length, count + 1);
          onlyRejectedReceipt(before.owner, after.owner, batches[count]!, code); assert.equal(await store.readRevision(), revision + 1);
        }
        return outcome;
      }
      await noEffects(await envelope(), reader.identity, 'forbidden');
      await noEffects(await envelope(), noStaff.identity, 'forbidden', true);
      await noEffects(await envelope(emptyLocationCompanyId), manager.identity, 'forbidden', true);
      await noEffects(await envelope(companyId, '   '), manager.identity, 'rule_failed', true);
      await noEffects(await envelope(individualId), manager.identity, 'rule_failed', true);
      const refusalBatches = batches.length;
      const beforeBooker = await row(ROLE, bookerId), beforePrevious = await row(ROLE, previousId);
      const createInput = await envelope(), createRevision = await store.readRevision();
      committed(await invoker.invokeMutation(createInput, manager.identity));
      assert.equal(await store.readRevision(), createRevision + 1); assert.equal(batches.length, refusalBatches + 1);
      const created = (await store.query({ model: ROLE, authority: 'owner' })).filter(value => value.parent?.id === companyId);
      assert.equal(created.length, 1);
      assert.deepEqual(created[0]!.data, { account: { id: subject.user.user_id }, role: 'administrator', locations: [{ id: siteId }], active: true });
      assert.equal(created[0]!.version, 1); assert.equal((await store.historyFor(ROLE, created[0]!.id)).length, 1);
      const reactivateInput = await envelope(previousCompanyId), reactivateRevision = await store.readRevision();
      committed(await invoker.invokeMutation(reactivateInput, manager.identity));
      assert.equal(await store.readRevision(), reactivateRevision + 1); assert.equal(batches.length, refusalBatches + 2);
      const restored = await row(ROLE, previousId);
      assert.equal(restored.version, beforePrevious.version + 1);
      assert.deepEqual(restored.data, { ...beforePrevious.data, active: true, locations: [{ id: siteId }] });
      assert.deepEqual(await row(ROLE, bookerId), beforeBooker);
      assert.equal((await store.query({ model: ROLE, authority: 'owner' })).filter(value => value.parent?.id === previousCompanyId).length, 2);
      assert.equal((await store.historyFor(ROLE, previousId)).length, 1);
      // The first can_work is false. The next reference-array element must
      // evaluate the same imported Employee query again and succeed.
      const secondLocationInput = await envelope(secondLocationCompanyId);
      committed(await invoker.invokeMutation(secondLocationInput, manager.identity));
      assert.equal(batches.length, refusalBatches + 3);
      const secondLocationRows = (await store.query({ model: ROLE, authority: 'owner' })).filter(value => value.parent?.id === secondLocationCompanyId);
      assert.equal(secondLocationRows.length, 1);
      assert.deepEqual(secondLocationRows[0]!.data.locations, [{ id: otherSiteId }, { id: siteId }]);
      for (const input of [createInput, reactivateInput, secondLocationInput]) {
        const before = await resources(), count = batches.length;
        committed(await invoker.invokeMutation(input, manager.identity), 'replayed');
        committed(await invoker.invokeRetainedMutation(input, manager.identity), 'replayed');
        assert.deepEqual(await resources(), before); assert.equal(batches.length, count);
      }
      // Revoke after admission has entered an actual owner source query;
      // only the established framework rejection receipt may be committed.
      const lateBefore = await snapshot(ownerDb), lateCount = batches.length, lateRevision = await store.readRevision(); let lateReached = false;
      onOwnerRoleQuery = async () => { lateReached = true; await identities.setMembershipRoles(manager.membership.membership_id, []); };
      const late = await invoker.invokeMutation(await envelope(), manager.identity);
      assert.equal(lateReached, true, 'late revocation reached the actual owning source query');
      assert.ok('error' in late, JSON.stringify(late)); assert.equal(late.error.code, 'forbidden');
      const lateAfter = await snapshot(ownerDb);
      if (batches.length === lateCount) { assert.deepEqual(lateAfter, lateBefore); assert.equal(await store.readRevision(), lateRevision); }
      else {
        assert.equal(batches.length, lateCount + 1); onlyRejectedReceipt(lateBefore, lateAfter, batches[lateCount]!, 'forbidden');
        assert.equal(await store.readRevision(), lateRevision + 1);
      }
      await identities.setMembershipRoles(manager.membership.membership_id, manager.roles);
      // Current row/field grants still apply to saved outcomes. Membership
      // and the manager role remain active while its Employee is deactivated.
      const employeeBefore = await row(EMPLOYEE, managerEmployeeId);
      await materializeCanonicalExampleSnapshots({ asm, artifact, store, identity: manager.identity, now,
        operationId: uuidv7(now, ++sequence), snapshots: [{ model: EMPLOYEE, id: managerEmployeeId, data: { ...employeeBefore.data, active: false } }] });
      const inactiveStaffBefore = await resources(), inactiveStaffCount = batches.length;
      for (const input of [createInput, reactivateInput, secondLocationInput]) {
        for (const outcome of [await invoker.invokeMutation(input, manager.identity), await invoker.invokeRetainedMutation(input, manager.identity)]) {
          const replay = committed(outcome, 'replayed'); assert.equal(replay.result, null); assert.deepEqual(replay.records ?? [], []);
        }
      }
      assert.deepEqual(await resources(), inactiveStaffBefore); assert.equal(batches.length, inactiveStaffCount);
      // Stale resolved identities cannot retain a custom role or active membership.
      await identities.setMembershipRoles(manager.membership.membership_id, []);
      await noEffects(await envelope(), manager.identity, 'forbidden');
      await identities.setMembershipRoles(manager.membership.membership_id, manager.roles);
      await identities.removeMembership(manager.membership.membership_id);
      await noEffects(await envelope(), manager.identity, 'forbidden');
      const replayBefore = await resources(), replayCount = batches.length;
      for (const input of [createInput, reactivateInput]) {
        const outcome = await invoker.invokeRetainedMutation(input, await manager.current());
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', 'retained recovery requires the current manager role and active membership');
      }
      assert.deepEqual(await resources(), replayBefore); assert.equal(batches.length, replayCount);
      assert.equal(await captureIsCurrent(capture), true);
      for (let index = 0; index < fixture.originalInputPaths.length; index++) assert.deepEqual(await readFile(fixture.originalInputPaths[index]!), fixture.originalBytes[index]);
    } finally { try { await worker?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
