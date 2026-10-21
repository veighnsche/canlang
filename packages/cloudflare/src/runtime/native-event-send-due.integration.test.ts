/** A private due Work source carries its original typed event row into a guarded SEND. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity } from '@canlang/identity';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { installNativeFileInventory } from './file-inventory.js';
import { invokeDueScheduleCanonical, loadCanonicalDescriptors } from './invoke.js';
import { assembleModules } from './modules.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/agreements-due-transport-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');

it('runs the original obligation due Rule with its current Term and Agreement ancestors',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-event-due-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });
      assert.ok((artifact.modules[0]?.js ?? '').includes('sendWhen:'), 'the original handler Rule is emitted');

      for (const testCase of [
        { name: 'current', active: true, terminated: false, done: false, revision: '1', changeRow: false, expected: 1 },
        { name: 'stale revision', active: true, terminated: false, done: false, revision: '2', changeRow: false, expected: 0 },
        { name: 'completed obligation', active: true, terminated: false, done: true, revision: '1', changeRow: false, expected: 0 },
        { name: 'terminated Term', active: true, terminated: true, done: false, revision: '1', changeRow: false, expected: 0 },
        { name: 'inactive Agreement', active: false, terminated: false, done: false, revision: '1', changeRow: false, expected: 0 },
        { name: 'changed Obligation after scheduling', active: true, terminated: false, done: false, revision: '1', changeRow: true, expected: 0 },
      ]) {
        const now = Date.now(), clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const scope = { app: 'DueProbe', owner: team.team_id, ownerPackage: 'agreements' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'due-state', fileStoreId: 'due-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const agreementId = asId('agreement-1'), termId = asId('term-1'), obligationId = asId('obligation-1');
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: asModel('agreements.Agreement'),
            row: { ...makeRow({ id: agreementId, data: { email: 'owner@example.test', active: testCase.active } }), parent: null } },
          { kind: 'insert', model: asModel('agreements.Term'),
            row: { ...makeRow({ id: termId, data: { terminated: testCase.terminated,
              expired: false, notice_suppressed: false } }),
              parent: { model: asModel('agreements.Agreement'), id: agreementId } } },
          { kind: 'insert', model: asModel('agreements.Obligation'),
            row: { ...makeRow({ id: obligationId, data: { title: 'Insurance evidence', done: testCase.done } }),
              parent: { model: asModel('agreements.Term'), id: termId } } },
        ] }));
        const due = { key: 'obligation-1', scope, occurrenceId: 'due-1', event: 'agreements.ObligationDue', at: now - 1 };
        const payload = { obligation: { id: obligationId, version: '1' }, revision: testCase.revision };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'agreements.due',
          load: (model: Parameters<typeof store.load>[0], id: Parameters<typeof store.load>[1]) => store.load(model, id),
          query: (spec: Parameters<typeof store.query>[0]) => store.query(spec) };
        const loaded = await loadCanonicalDescriptors(asm, artifact);
        assert.ok(loaded.valueTypes);
        const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage,
          artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
          operations: new Map(), scope, verify: async () => {} });
        assert.ok(opaque);
        const declaration = opaque.event(due.event);
        const identity = await resolveIdentity(identities, { team_id: team.team_id }, { clock });
        const stageWithOrigin = async (request: typeof due & { readonly payload: Record<string, unknown> }) => {
          const first = await workSchedulePutCommand.stage(request, stageContext);
          const row = first.writes?.find(write => write.kind === 'insert' && write.model === 'work.schedule' &&
            write.row.id === request.occurrenceId);
          assert.ok(row && row.kind === 'insert');
          const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
            model: asModel('work.schedule'), row: row.row, field: 'payload', scope,
            origin: { kind: 'event-input', occurrenceId: request.occurrenceId,
              sourceOccurrence: request.occurrenceId, declaration,
              lineage: { kind: 'schedule', key: request.key, replaces: row.row.data['replaces'] as null },
              target: { kind: 'schedule' } },
            projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId },
            value: request.payload, identity });
          return workSchedulePutCommand.stage({ ...request, filePayloadOrigin }, stageContext);
        };
        if (testCase.name === 'current') {
          const beforeUnproven = await store.readRevision();
          await assert.rejects(async () => {
            const unproven = await stageWithOrigin({ ...due, key: 'unproven', occurrenceId: 'unproven-1',
              payload: { ...payload, unproven: true } });
            await store.commit(makeBatch(await store.readRevision(), {
              writes: unproven.writes ?? [], schedules: unproven.schedules ?? [],
            }));
          }, 'an extra undeclared event field cannot be installed as a due Work payload');
          assert.equal(await store.readRevision(), beforeUnproven);
          assert.equal(await store.load(asModel('work.schedule'), asId('unproven-1')), null);
        }
        const scheduled = await stageWithOrigin({ ...due, payload });
        await store.commit(makeBatch(await store.readRevision(), {
          writes: scheduled.writes ?? [], schedules: scheduled.schedules ?? [],
        }));
        if (testCase.name === 'current') {
          const forged = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
            handler: 'agreements.due', due: { ...due, occurrenceId: 'not-the-issued-head' },
            store, identities, now: () => now });
          assert.equal(forged.status, 'refused', 'an unissued Work occurrence cannot invoke the handler');
          assert.equal(probe.outboxAll().length, 0);
        }
        if (testCase.changeRow) {
          const current = await store.load(asModel('agreements.Obligation'), obligationId);
          assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: asModel('agreements.Obligation'), id: current.id, expectedVersion: current.version,
            row: { ...current, version: asVersion(current.version + 1),
              updated: now, data: { ...current.data, done: true } } }] }));
        }
        const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
          handler: 'agreements.due', due, store, identities, now: () => now });
        assert.equal(result.status, 'completed', `${testCase.name}: ${JSON.stringify(result)}`);
        assert.equal(probe.outboxAll().length, testCase.expected, `${testCase.name}: outbox`);
        const notices = await store.query({ model: asModel('agreements.NoticeDelivery'), authority: 'owner' });
        assert.equal(notices.length, testCase.expected, `${testCase.name}: saved NoticeDelivery`);
        assert.equal(notices[0] === undefined ? null : String(notices[0].data['revision']),
          testCase.expected ? testCase.revision : null);
        if (testCase.expected) assert.deepEqual(notices[0]!.data['obligation'], { id: obligationId });
        if (testCase.name === 'current') {
          const receipt = await store.load(asModel('work.occurrence'), asId(due.occurrenceId));
          assert.ok(receipt);
          await assert.rejects(store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: asModel('work.occurrence'), id: receipt.id, expectedVersion: receipt.version,
            row: { ...receipt, version: asVersion(receipt.version + 1), updated: now,
              data: { ...receipt.data, status: 'failed', code: 'forged', message: 'forged' } },
          }] })), /direct due result differs from its genuine terminal Work receipt/,
          'a retained direct-due origin cannot authorize a different terminal status');
          const schedule = await store.load(asModel('work.schedule'), asId(due.occurrenceId));
          assert.ok(schedule);
          await assert.rejects(store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: asModel('work.schedule'), id: schedule.id, expectedVersion: schedule.version,
            row: { ...schedule, version: asVersion(schedule.version + 1), updated: now,
              data: { ...schedule.data, payload: { ...payload, revision: '2' } } },
          }] })), /original scheduled event payload cannot change/,
          'a retained scheduled event header cannot authorize changed payload');
          assert.equal(probe.outboxAll().length, 1);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
