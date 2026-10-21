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
const source = join(root, 'packages/cloudflare/test/fixtures/agreements-notice-transport-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');

it('runs the original notice Rule with the due event Term and its owner parent',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-event-notice-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });
      assert.ok((artifact.modules[0]?.js ?? '').includes('sendWhen:'), 'the original handler Rule is emitted');

      const ready = { active: true, executed: true, snapshot: 'Signed lease', terminated: false,
        expired: false, suppressed: false, revision: '1', changeRow: false,
        tamperLocale: false, expected: 0 };
      for (const testCase of [
        { ...ready, name: 'current', expected: 1 },
        { ...ready, name: 'stale revision', revision: '2' },
        { ...ready, name: 'not executed', executed: false },
        { ...ready, name: 'no signed snapshot', snapshot: null },
        { ...ready, name: 'terminated', terminated: true },
        { ...ready, name: 'expired', expired: true },
        { ...ready, name: 'suppressed', suppressed: true },
        { ...ready, name: 'inactive parent', active: false },
        { ...ready, name: 'changed Term after scheduling', changeRow: true },
        { ...ready, name: 'mutated app locale', tamperLocale: true },
      ]) {
        const now = Date.now(), clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const scope = { app: 'NoticeProbe', owner: team.team_id, ownerPackage: 'agreements' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'notice-state', fileStoreId: 'notice-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const agreementId = asId('agreement-1'), termId = asId('term-1');
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: asModel('agreements.Agreement'),
            row: { ...makeRow({ id: agreementId, data: { email: 'owner@example.test', active: testCase.active } }), parent: null } },
          { kind: 'insert', model: asModel('agreements.Term'),
            row: { ...makeRow({ id: termId, data: { executed: testCase.executed,
              snapshot: testCase.snapshot === null ? null : { title: testCase.snapshot },
              terminated: testCase.terminated, expired: testCase.expired,
              notice_suppressed: testCase.suppressed } }),
              parent: { model: asModel('agreements.Agreement'), id: agreementId } } },
        ] }));
        const due = { key: 'term-1', scope, occurrenceId: 'notice-1', event: 'agreements.Notice', at: now - 1 };
        const payload = { term: { id: termId, version: '1' }, revision: testCase.revision };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'agreements.notice',
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
            handler: 'agreements.notice', due: { ...due, occurrenceId: 'not-the-issued-head' },
            store, identities, now: () => now });
          assert.equal(forged.status, 'refused', 'an unissued Work occurrence cannot invoke the handler');
          assert.equal(probe.outboxAll().length, 0);
        }
        if (testCase.changeRow) {
          const current = await store.load(asModel('agreements.Term'), termId);
          assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: asModel('agreements.Term'), id: current.id, expectedVersion: current.version,
            row: { ...current, version: asVersion(current.version + 1),
              updated: now, data: { ...current.data, terminated: true } } }] }));
        }
        if (testCase.tamperLocale) {
          const callable = artifact.callables.find(entry => entry.id === 'agreements.notice');
          assert.ok(callable);
          const generated = await import(asm.moduleUrls[callable.module]!) as {
            readonly __canlangAppDefaultLocale: string;
            readonly appDefinition: { appDefaultLocale: string };
          };
          const original = generated.appDefinition.appDefaultLocale;
          assert.equal(generated.__canlangAppDefaultLocale, original);
          generated.appDefinition.appDefaultLocale = 'nl';
          try {
            await assert.rejects(invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
              handler: 'agreements.notice', due, store, identities, now: () => now }),
            /Due handler lacks its exact private invocation\/event\/scope declaration/);
            assert.equal(probe.outboxAll().length, 0);
            assert.equal(await store.load(asModel('work.occurrence'), asId(due.occurrenceId)), null);
          } finally { generated.appDefinition.appDefaultLocale = original; }
          continue;
        }
        const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
          handler: 'agreements.notice', due, store, identities, now: () => now });
        assert.equal(result.status, 'completed', `${testCase.name}: ${JSON.stringify(result)}`);
        assert.equal(probe.outboxAll().length, testCase.expected, `${testCase.name}: outbox`);
        if (testCase.name === 'current') {
          const request = probe.outboxAll()[0]?.arguments['arguments'] as Record<string, unknown> | undefined;
          assert.equal(request?.['subject'], 'Agreement notice deadline');
          assert.equal(request?.['body'], 'Signed lease');
        }
        const notices = await store.query({ model: asModel('agreements.NoticeDelivery'), authority: 'owner' });
        assert.equal(notices.length, testCase.expected, `${testCase.name}: saved NoticeDelivery`);
        assert.equal(notices[0] === undefined ? null : String(notices[0].data['revision']),
          testCase.expected ? testCase.revision : null);
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

it('reopens an exact legacy full-void File profile and rejects a changed original plan',
  { timeout: 120000 }, async () => {
    const legacySource = join(root, 'packages/cloudflare/test/fixtures/agreements-due-transport-probe.can');
    const directory = await mkdtemp(join(tmpdir(), 'can-legacy-void-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, legacySource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: legacySource }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });
      const handler = 'agreements.due';
      const callable = artifact.callables.find(entry => entry.id === handler);
      assert.ok(callable);
      const module = await import(asm.moduleUrls[callable.module]!);
      const operation = module.appDefinition.operations[handler].invocation;
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      const privateLoaded = loaded.producers.registry.loadArtifactDescriptors(
        { ...artifact, operations: [operation] }, { by: () => 'owner' });
      const loadedDef = privateLoaded.registry.get(handler);
      assert.ok(loadedDef && 'descriptor' in loadedDef);
      const canonical = loadedDef.descriptor;
      assert.equal(canonical.result?.type, 'void');
      assert.deepEqual(canonical.result, operation.result);
      for (const altered of [false, true]) {
        const now = Date.now(), clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const scope = { app: 'DueProbe', owner: team.team_id, ownerPackage: 'agreements' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'due-state', fileStoreId: 'due-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        const legacyStore = { ...store, installFileReferenceInventory: async (
          input: Parameters<typeof store.installFileReferenceInventory>[0]) => {
          const request = structuredClone(input);
          const declaration = request.inventory.opaqueDeclarationSets?.[0]?.declarations.find(
            candidate => candidate.id === `${handler}:result`);
          assert.ok(declaration && declaration.profile.kind === 'void');
          const result = structuredClone(canonical.result) as Record<string, unknown>;
          if (altered) result['disclosure'] = {
            ...(result['disclosure'] as Record<string, unknown>), changedOriginalPlan: true };
          Object.assign(declaration, { profile: { kind: 'void', canonical: result,
            artifact: structuredClone(result) } });
          return store.installFileReferenceInventory(request);
        } };
        const installation = { artifact, asm, authority, scope, now: () => now,
          verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } };
        await installNativeFileInventory({ ...installation, store: legacyStore });
        const before = await store.readFileReferenceInventory(scope.ownerPackage);
        assert.ok(before);
        if (altered) {
          await assert.rejects(installNativeFileInventory({ ...installation, store }),
            /original installed declaration closure changed|storage declarations changed/);
        } else {
          await installNativeFileInventory({ ...installation, store });
          assert.deepEqual(await store.readFileReferenceInventory(scope.ownerPackage), before);
          assert.ok(loaded.valueTypes);
          const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage,
            artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
            operations: new Map([[handler, { canonical, artifact: operation }]]), scope,
            verify: async () => {} });
          assert.ok(opaque);
          assert.deepEqual(opaque.callable(handler).canonical.result, canonical.result);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
