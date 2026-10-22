/** Scheduled reminders use current private owner sources before guarded delivery. */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority } from '@canlang/contracts';
import { decodeValue } from '@canlang/values';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS,
  createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { classifyFailure } from '@canlang/work/receipt';
import { newDispatchRow } from '@canlang/work/kernel/tables';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { buildInvoker } from '../worker/assembly.js';
import { createBoundMailDispatcher } from './bound-dispatch.js';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, invokeDueScheduleCanonical,
  loadCanonicalDescriptors, invokeRetainedHandlerOccurrenceCanonical } from './invoke.js';
import { assembleModules } from './modules.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';
import { createCanonicalFileBinding } from './bound-files.js';
import { createFileJourneyKernel, type FileJourneyBindings } from '@canlang/interfaces/uploads/kernel';
import { createUploadIntent, appendUploadContentAtOffset, completeUploadContent, sha256Hex, DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { authorizeAttach, blobKeyForFile, finalizeUpload, observeFinalizedFile, readCurrentFinalizedBytes,
  readCurrentFinalizedSnapshot, readFinalizedBytes, readFinalizedFile, recordAttachment,
  revalidateRetainedFinalizedFile } from '@canlang/files/finalize';
import { TestOnlyManualClock, TestOnlyCounterIntentIds, TestOnlyCounterFileIds,
  TestOnlyMemoryIntentStore, TestOnlyMemoryBlobStore, TestOnlyMemoryFinalizedStore } from '@canlang/files/ports';


const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/appointments-reminder-transport-probe.can');
const maintainSource = join(root, 'packages/cloudflare/test/fixtures/maintain-remind-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');

it('refuses altered reminder recipient and Notice source in the exact native profile',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(root, 'packages/cloudflare/test/fixtures/.reminder-refusal-'));
    try {
      const original = await readFile(source, 'utf8');
      const variants = [
        { name: 'recipient', changedSite: 'to=event.appointment.customer.email',
          originalSite: 'to=event.appointment.contact.email', source: original
          .replace('export Customer {name:text}', 'export Customer {name:text,email:email}')
          .replace('to=event.appointment.contact.email', 'to=event.appointment.customer.email') },
        { name: 'notice', changedSite: 'source="other"',
          originalSite: 'source=event.appointment.active_source', source: original
          .replace('source=event.appointment.active_source', 'source="other"') },
      ];
      for (const variant of variants) {
        assert.notEqual(variant.source, original, `${variant.name}: fixture mutation must apply`);
        assert.equal(variant.source.split(variant.changedSite).length, 2,
          `${variant.name}: changed source site must occur exactly once`);
        assert.ok(!variant.source.includes(variant.originalSite),
          `${variant.name}: original source site must be removed`);
        const path = join(directory, `${variant.name}.can`);
        await writeFile(path, variant.source);
        const result = spawnSync(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(result.status, 10, `${variant.name}: ${result.stderr || result.stdout}`);
        const report = JSON.parse(result.stdout) as { sources: { sha256: string }[];
          diagnostics: { code: string; message: string; primary: { file: number; start: number; end: number } }[] };
        assert.equal(report.sources[0]?.sha256,
          createHash('sha256').update(variant.source).digest('hex'),
          `${variant.name}: compiler must report the altered source`);
        const predicate = 'event.appointment.state==confirmed and event.appointment.version==event.revision';
        const guardStart = variant.source.indexOf(`when=${predicate}`) + 'when='.length;
        assert.ok(guardStart >= 'when='.length, `${variant.name}: original SEND guard must remain`);
        assert.deepEqual(report.diagnostics.map(({ code, message, primary }) => ({ code, message, primary })), [{ code: 'E6008',
          message: 'cannot lower send dispatch guard: original native SEND guard and frozen lexical transport are unavailable',
          primary: { file: 0, start: guardStart, end: guardStart + predicate.length } }],
        `${variant.name}: only this handler's unchanged SEND guard should lose its native source proof`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('sends a scheduled reminder from its current private Contact and Calendar rows',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-event-reminder-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
        uiUrl: import.meta.resolve('@canlang/ui') });
      assert.ok((artifact.modules[0]?.js ?? '').includes('sendWhen:'), 'the original reminder Rule is emitted');

      for (const testCase of [
        { name: 'current hidden rows', state: 'confirmed', revision: '1', changeBefore: false, race: false },
        { name: 'stale revision', state: 'confirmed', revision: '2', changeBefore: false, race: false },
        { name: 'cancelled appointment', state: 'cancelled', revision: '1', changeBefore: false, race: false },
        { name: 'changed appointment before due', state: 'confirmed', revision: '1', changeBefore: true, race: false },
        { name: 'contact changes before commit', state: 'confirmed', revision: '1', changeBefore: false, race: true },
      ]) {
        const now = Date.now(), clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const scope = { app: 'ReminderProbe', owner: team.team_id, ownerPackage: 'appointments' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'reminder-state', fileStoreId: 'reminder-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        const contactId = asId('contact-1'), appointmentId = asId('appointment-1');
        let injectContactChange = false;
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const customerId = asId('customer-1'), calendarId = asId('calendar-1'), typeId = asId('type-1');
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: asModel('customer.Customer'),
            row: { ...makeRow({ id: customerId, data: { name: 'Customer' } }), parent: null } },
          { kind: 'insert', model: asModel('customer.Contact'),
            row: { ...makeRow({ id: contactId, data: { email: 'hidden@example.test', hidden: true } }),
              parent: { model: asModel('customer.Customer'), id: customerId } } },
          { kind: 'insert', model: asModel('appointments.Calendar'),
            row: { ...makeRow({ id: calendarId, data: { instructions: 'Reception desk' } }), parent: null } },
          { kind: 'insert', model: asModel('appointments.Type'),
            row: { ...makeRow({ id: typeId, data: { name: 'Tour' } }),
              parent: { model: asModel('appointments.Calendar'), id: calendarId } } },
          { kind: 'insert', model: asModel('appointments.Appointment'),
            row: { ...makeRow({ id: appointmentId, data: { customer: { id: customerId },
              contact: { id: contactId }, state: testCase.state, active_source: 'booking-1', hidden: true } }),
              parent: { model: asModel('appointments.Type'), id: typeId } } },
        ] }));
        const due = { key: 'appointment-1', scope, occurrenceId: 'reminder-1',
          event: 'appointments.Reminder', at: now - 1 };
        const payload = { appointment: { id: appointmentId, version: '1' }, revision: testCase.revision };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'appointments.remind',
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
        const first = await workSchedulePutCommand.stage({ ...due, payload }, stageContext);
        const row = first.writes?.find(write => write.kind === 'insert' && write.model === 'work.schedule' &&
          write.row.id === due.occurrenceId);
        assert.ok(row && row.kind === 'insert');
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
          model: asModel('work.schedule'), row: row.row, field: 'payload', scope,
          origin: { kind: 'event-input', occurrenceId: due.occurrenceId,
            sourceOccurrence: due.occurrenceId, declaration,
            lineage: { kind: 'schedule', key: due.key, replaces: row.row.data['replaces'] as null },
            target: { kind: 'schedule' } },
          projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId },
          value: payload, identity });
        const scheduled = await workSchedulePutCommand.stage({ ...due, payload, filePayloadOrigin }, stageContext);
        await store.commit(makeBatch(await store.readRevision(), {
          writes: scheduled.writes ?? [], schedules: scheduled.schedules ?? [],
        }));
        if (testCase.changeBefore) {
          const appointment = await store.load(asModel('appointments.Appointment'), appointmentId);
          assert.ok(appointment);
          await store.commit(makeBatch(await store.readRevision(), { writes: [{
            kind: 'update', model: asModel('appointments.Appointment'), id: appointment.id,
            expectedVersion: appointment.version,
            row: { ...appointment, version: asVersion(appointment.version + 1), updated: now,
              data: { ...appointment.data, state: 'cancelled' } },
          }] }));
        }
        if (testCase.race) {
          const commit = store.commit.bind(store);
          store.commit = async batch => {
            if (injectContactChange) {
              injectContactChange = false;
              const contact = await store.load(asModel('customer.Contact'), contactId);
              assert.ok(contact);
              await commit(makeBatch(await store.readRevision(), { writes: [{
                kind: 'update', model: asModel('customer.Contact'), id: contact.id,
                expectedVersion: contact.version,
                row: { ...contact, version: asVersion(contact.version + 1), updated: now,
                  data: { ...contact.data, email: 'new@example.test' } },
              }] }));
            }
            return commit(batch);
          };
          injectContactChange = true;
        }
        const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
          handler: 'appointments.remind', due, store, identities, now: () => now });
        const intents = probe.outboxAll();
        const notices = await store.query({ model: asModel('appointments.Notice'), authority: 'owner' });
        if (testCase.race) {
          assert.equal(injectContactChange, false, 'a competing Contact update ran at commit');
          assert.ok(intents.length <= 1, 'a retry must not duplicate Mail');
          assert.equal(notices.length, intents.length, 'Mail and Notice commit atomically');
          for (const intent of intents) {
            const request = intent.arguments['arguments'] as Record<string, unknown>;
            assert.equal(request['to'], 'new@example.test', 'stale Contact email cannot be sent');
          }
          continue;
        }
        const expected = testCase.name === 'current hidden rows' ? 1 : 0;
        assert.equal(result.status, expected ? 'completed' : 'failed', testCase.name);
        assert.equal(intents.length, expected, `${testCase.name}: Mail intents`);
        assert.equal(notices.length, expected, `${testCase.name}: Notice writes`);
        if (expected) {
          const request = intents[0]?.arguments['arguments'] as Record<string, unknown> | undefined;
          assert.equal(request?.['to'], 'hidden@example.test');
          assert.equal(request?.['subject'], 'Appointment reminder');
          assert.equal(request?.['body'], 'Reception desk');
          assert.equal(notices[0]?.parent?.id, appointmentId);
          assert.equal(notices[0]?.data.kind, 'reminder');
          assert.equal(notices[0]?.data.source, 'booking-1');
          assert.ok(notices[0]?.data.delivery);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('refuses altered inspection reminder guards, source helpers and SET effect',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(root, 'packages/cloudflare/test/fixtures/.maintain-refusal-'));
    try {
      const original = await readFile(maintainSource, 'utf8');
      const replaceExact = (before: string, after: string, count = 1) => {
        assert.equal(original.split(before).length - 1, count, `original ${before}`);
        return original.replaceAll(before, after);
      };
      const superseded = 'derive inspection_superseded(inspection:Inspection):bool = any(inspection.parent.parent.Cancellation as change,matches_cancellation(change,inspection))';
      const variants = [
        { name: 'outer-if', source: replaceExact('if inspection_pending(inspection) and',
          'if inspection.result==pending and') },
        { name: 'send-when', source: replaceExact('when=inspection_pending(inspection) and',
          'when=inspection.result==pending and') },
        { name: 'event-revision', source: replaceExact('inspection.template_version==event.revision',
          'inspection.template_version==event.revision+1', 2) },
        { name: 'set-value', source: replaceExact('set inspection {reminded_at=now}',
          'set inspection {reminded_at=now+1m}') },
        { name: 'missing-cancellation-query', source: replaceExact(superseded,
          'derive inspection_superseded(inspection:Inspection):bool = false') },
      ];
      for (const variant of variants) {
        assert.notEqual(variant.source, original, variant.name);
        const path = join(directory, `${variant.name}.can`);
        await writeFile(path, variant.source);
        const result = spawnSync(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(result.status, 10, `${variant.name}: ${result.stderr || result.stdout}`);
        const report = JSON.parse(result.stdout) as { sources: { sha256: string }[];
          diagnostics: { code: string; message: string;
            primary: { file: number; start: number; end: number } }[] };
        assert.equal(report.sources[0]?.sha256,
          createHash('sha256').update(variant.source).digest('hex'), variant.name);
        const send = variant.source.match(/send Mail\.send [^\n]* when=([^\n]*?) as notice/);
        assert.ok(send, `${variant.name}: original guarded SEND is present`);
        const guard = send[1];
        assert.ok(guard, variant.name);
        const guardStart = variant.source.indexOf(`when=${guard}`) + 'when='.length;
        assert.ok(guardStart >= 'when='.length, variant.name);
        assert.ok(report.diagnostics.length > 0, `${variant.name}: emits diagnostics`);
        assert.ok(report.diagnostics.every(({ code }) => code === 'E6008'),
          `${variant.name}: all refusals are owner-proof diagnostics`);
        assert.ok(report.diagnostics.some(({ code, primary }) =>
          code === 'E6008' && primary.file === 0 && primary.start === guardStart &&
          primary.end === guardStart + guard.length),
        `${variant.name}: original SEND guard loses its exact source proof`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('queues only a current inspection reminder from hidden owner rows and fences stale changes',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-maintain-remind-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, maintainSource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: maintainSource }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
        uiUrl: import.meta.resolve('@canlang/ui') });
      assert.ok((artifact.modules[0]?.js ?? '').includes('sendWhen:'),
        'the original guarded Mail SEND is emitted');

      for (const mode of ['current-hidden', 'supersession-unrelated', 'stale-revision',
        'inspection-cancelled', 'inspection-completed', 'superseded-hidden',
        'plan-inactive', 'asset-retired', 'plan-epoch-stale', 'inspection-epoch-stale',
        'assignee-changed', 'not-yet-due', 'employee-inactive', 'employee-wrong-location',
        'technician-role-missing', 'inspection-cancelled-at-commit',
        'plan-revised-at-commit', 'employee-revoked-at-commit',
        'cancellation-added-at-commit'] as const) {
        const now = Date.now(), clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const technician = await identities.createUser({ email: `tech-${mode}@maintain.test`,
          password_hash: 'unused', email_verified: true });
        const viewer = await identities.createUser({ email: `viewer-${mode}@maintain.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: technician.user_id,
          is_owner: false, roles: mode === 'technician-role-missing' ? [] : [{
            role: 'maintain.technician', granted_at: new Date(now).toISOString(),
            granted_by: technician.user_id }] });
        await identities.createMembership({ team_id: team.team_id, user_id: viewer.user_id,
          is_owner: false, roles: [] });
        const token = `viewer-${mode}`;
        await identities.createSession({ user_id: viewer.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const viewerIdentity = await resolveIdentity(identities, { session_token: token }, { clock });
        const scope = { app: 'CanMaintain', owner: team.team_id, ownerPackage: 'maintain' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'maintain-state', fileStoreId: 'maintain-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });

        const locationId = asId('location-1'), otherLocationId = asId('location-2');
        const assetId = asId('asset-1'), planId = asId('plan-1'), inspectionId = asId('inspection-1');
        const employeeId = asId('employee-1');
        const dueDate = new Date(now + (mode === 'not-yet-due' ? 86400000 : -86400000))
          .toISOString().slice(0, 10);
        const cutoff = new Date(now - 3 * 86400000).toISOString().slice(0, 10);
        const writes = [
          { kind: 'insert' as const, model: asModel('rent_catalog.Location'), row: {
            ...makeRow({ id: locationId, data: { name: 'Main site', timezone: 'UTC', active: true } }), parent: null } },
          { kind: 'insert' as const, model: asModel('rent_catalog.Location'), row: {
            ...makeRow({ id: otherLocationId, data: { name: 'Other site', timezone: 'UTC', active: true } }), parent: null } },
          { kind: 'insert' as const, model: asModel('employee.Employee'), row: {
            ...makeRow({ id: employeeId, data: { user: { id: technician.user_id },
              home: { id: mode === 'employee-wrong-location' ? otherLocationId : locationId },
              locations: [], operator_wide: false, active: mode !== 'employee-inactive', hidden: true } }),
            parent: null } },
          { kind: 'insert' as const, model: asModel('maintain.Asset'), row: {
            ...makeRow({ id: assetId, data: { location: { id: locationId }, inspection_epoch: '0',
              retired: mode === 'asset-retired' } }), parent: null } },
          { kind: 'insert' as const, model: asModel('maintain.Plan'), row: {
            ...makeRow({ id: planId, data: { name: 'Cooling inspection',
              assignee: { id: mode === 'assignee-changed' ? viewer.user_id : technician.user_id },
              revision: '1', asset_epoch: mode === 'plan-epoch-stale' ? '1' : '0',
              active: mode !== 'plan-inactive', hidden: true } }),
            parent: { model: asModel('maintain.Asset'), id: assetId } } },
          { kind: 'insert' as const, model: asModel('maintain.Inspection'), row: {
            ...makeRow({ id: inspectionId, data: { cancelled: mode === 'inspection-cancelled',
              reminder_email: 'technician@example.test', reminded_at: null, due: dueDate,
              asset_epoch: mode === 'inspection-epoch-stale' ? '1' : '0', template_version: '1',
              inspector: { id: technician.user_id },
              result: mode === 'inspection-completed' ? 'passed' : 'pending', hidden: true } }),
            parent: { model: asModel('maintain.Plan'), id: planId } } },
        ];
        const cancellation = { ...makeRow({ id: asId('cancellation-1'), data: {
          plan: { id: planId }, through: '1', cutoff,
          reason: 'plan_revised', hidden: true } }),
          parent: { model: asModel('maintain.Asset'), id: assetId } };
        if (mode === 'superseded-hidden' || mode === 'supersession-unrelated') {
          writes.push({ kind: 'insert', model: asModel('maintain.Cancellation'),
            row: mode === 'supersession-unrelated' ? { ...cancellation,
              data: { ...cancellation.data, through: '0' } } : cancellation });
        }
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        if (mode === 'current-hidden') {
          const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
          for (const operation of ['employee.Employee.read', 'maintain.Plan.read',
            'maintain.Inspection.read'] as const) {
            const visible = await invoker.invokeRead({ operation, inputs: {} }, viewerIdentity);
            assert.ok('result' in visible, `${operation}: ${JSON.stringify(visible)}`);
            assert.equal((visible.result as { records: unknown[] }).records.length, 0, operation);
          }
        }

        const due = { key: inspectionId, scope, occurrenceId: 'maintain-reminder-1',
          event: 'maintain.Reminder', at: now - 1 };
        const payload = { inspection: { id: inspectionId, version: '1' },
          revision: mode === 'stale-revision' ? '2' : '1' };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'maintain.remind',
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
        const first = await workSchedulePutCommand.stage({ ...due, payload }, stageContext);
        const row = first.writes?.find(write => write.kind === 'insert' &&
          write.model === 'work.schedule' && write.row.id === due.occurrenceId);
        assert.ok(row && row.kind === 'insert');
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
          model: asModel('work.schedule'), row: row.row, field: 'payload', scope,
          origin: { kind: 'event-input', occurrenceId: due.occurrenceId,
            sourceOccurrence: due.occurrenceId, declaration,
            lineage: { kind: 'schedule', key: due.key, replaces: row.row.data['replaces'] as null },
            target: { kind: 'schedule' } },
          projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId },
          value: payload, identity });
        const scheduled = await workSchedulePutCommand.stage({ ...due, payload, filePayloadOrigin }, stageContext);
        await store.commit(makeBatch(await store.readRevision(), {
          writes: scheduled.writes ?? [], schedules: scheduled.schedules ?? [],
        }));

        let injected = false;
        if (mode.endsWith('-at-commit')) {
          const commit = store.commit.bind(store);
          store.commit = async batch => {
            if (!injected) {
              injected = true;
              if (mode === 'cancellation-added-at-commit') {
                await commit(makeBatch(await store.readRevision(), { writes: [{
                  kind: 'insert', model: asModel('maintain.Cancellation'), row: cancellation }] }));
              } else {
                const model = asModel(mode === 'inspection-cancelled-at-commit' ? 'maintain.Inspection'
                  : mode === 'plan-revised-at-commit' ? 'maintain.Plan' : 'employee.Employee');
                const id = mode === 'inspection-cancelled-at-commit' ? inspectionId
                  : mode === 'plan-revised-at-commit' ? planId : employeeId;
                const current = await store.load(model, id);
                assert.ok(current);
                const changed = mode === 'inspection-cancelled-at-commit' ? { cancelled: true }
                  : mode === 'plan-revised-at-commit' ? { revision: '2' } : { active: false };
                await commit(makeBatch(await store.readRevision(), { writes: [{
                  kind: 'update', model, id, expectedVersion: current.version,
                  row: { ...current, version: asVersion(current.version + 1), updated: now,
                    data: { ...current.data, ...changed } } }] }));
              }
            }
            return commit(batch);
          };
        }
        const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
          handler: 'maintain.remind', due, store, identities, now: () => now });
        const expected = mode === 'current-hidden' || mode === 'supersession-unrelated' ? 1 : 0;
        if (mode.endsWith('-at-commit')) {
          assert.ok(result.status === 'completed' || result.status === 'failed',
            `${mode}: ${JSON.stringify(result)}`);
        } else {
          assert.equal(result.status, 'completed', `${mode}: ${JSON.stringify(result)}`);
        }
        if (mode.endsWith('-at-commit')) assert.equal(injected, true, mode);
        const intents = probe.outboxAll();
        assert.equal(intents.length, expected, `${mode}: Mail intents`);
        const inspection = await store.load(asModel('maintain.Inspection'), inspectionId);
        assert.ok(inspection);
        assert.equal(inspection.data.reminded_at, expected ? new Date(now).toISOString() : null,
          `${mode}: reminded_at`);
        if (expected) {
          const request = intents[0]?.arguments['arguments'] as Record<string, unknown> | undefined;
          assert.equal(request?.['to'], 'technician@example.test');
          assert.equal(request?.['subject'], 'Inspection due');
          assert.equal(request?.['body'], 'Cooling inspection');
          const intent = intents[0];
          assert.ok(intent);
          const frozen = structuredClone(intent.arguments);
          if (mode === 'current-hidden' || mode === 'supersession-unrelated') {
            if (mode === 'current-hidden') {
              await store.commit(makeBatch(await store.readRevision(), { writes: [{
                kind: 'insert', model: asModel('maintain.Cancellation'), row: cancellation }] }));
            } else {
              const current = await store.load(asModel('employee.Employee'), employeeId);
              assert.ok(current);
              await store.commit(makeBatch(await store.readRevision(), { writes: [{
                kind: 'update', model: asModel('employee.Employee'), id: current.id,
                expectedVersion: current.version,
                row: { ...current, version: asVersion(current.version + 1), updated: now,
                  data: { ...current.data, active: false } } }] }));
            }
            const fenceFor = await bindNativeEmailDispatchGuards({ asm, artifact, store,
              identities, scope, revalidateAuthority: async () => true });
            let providerCalls = 0;
            const adapter: Parameters<typeof createBoundMailDispatcher>[0]['adapter'] = {
              available: () => true, userRecipient: () => null,
              recipientActive: async () => true, resolveRecipient: async () => null,
              callProvider: async () => { providerCalls++; throw new Error('stale reminder reached provider'); },
              reconcile: async () => null,
            };
            const dispatcher = await createBoundMailDispatcher({ store, adapter,
              workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS,
              createClaimCommand: createWorkDispatchClaimCommand });
            const dispatched = await dispatcher.drive({ intentId: intent.intentId,
              actor: `dispatch:${due.event}`, operation: 'test.maintain.dispatch',
              nowMs: () => now + 1, nextClaimId: () => `claim-${mode}`,
              maxClaimAgeMs: 60000, claimOperationId: uuidv7(now + 1, 1),
              recordOperationId: uuidv7(now + 1, 2), classifyFailure,
              evaluateGuard: () => { throw new Error('native guard was bypassed'); },
              readStateSnapshot: () => null, fence: fenceFor(intent) });
            assert.equal(dispatched.status, 'not-claimed', `${mode}: ${JSON.stringify(dispatched)}`);
            if (dispatched.status === 'not-claimed') assert.equal(dispatched.reason, 'guard-false', mode);
            assert.equal(providerCalls, 0, `${mode}: no stale provider call`);
            const retained = await store.outboxGet(intent.intentId);
            assert.deepEqual(retained?.intent.arguments, frozen,
              `${mode}: original recipient and body remain frozen`);
          }
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('records inspections and conditional repairs over the original hidden helper domains', { timeout: 900000 }, async () => {
  const path = join(root, 'packages/cloudflare/test/fixtures/maintain-inspect-owner-probe.can');
  const directory = await mkdtemp(join(tmpdir(), 'can-maintain-inspect-'));
  try {
    const original = await readFile(join(root, 'draft/apps/CanMaintain/CanMaintain.can'), 'utf8');
    const start = original.indexOf('  export scenario inspect('), end = original.indexOf('   examples ', start);
    assert.ok(start >= 0 && end > start);
    assert.ok((await readFile(path, 'utf8')).includes(original.slice(start, end).trimEnd()),
      'retain the exact authored inspection header and executable body');
    const fieldOriginal = await readFile(join(root, 'draft/apps/CanField/CanField.can'), 'utf8');
    const fieldStart = fieldOriginal.indexOf('  scenario complete('), fieldEnd = fieldOriginal.indexOf('  # Cancel only', fieldStart);
    const visitStart = original.indexOf('  scenario visit_report on='), visitEnd = original.indexOf('  scenario generate on=', visitStart);
    const fixture = await readFile(path, 'utf8');
    assert.ok(fieldStart >= 0 && fieldEnd > fieldStart && fixture.includes(fieldOriginal.slice(fieldStart, fieldEnd).trimEnd()),
      'retain the complete authored Field header and ordered executable tail');
    assert.ok(visitStart >= 0 && visitEnd > visitStart && fixture.includes(original.slice(visitStart, visitEnd).trimEnd()),
      'retain the actual owning ReportSubmitted consumer');
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.ok(artifact.operations?.find(item => item.name === 'maintain.inspect')?.result?.disclosure,
      'actual inspection requires its complete native receipt');
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: directory,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['passed', 'failed', 'blocked', 'superseded-hidden', 'employee-inactive', 'wrong-count', 'blank-evidence', 'role-revoked-during-source', 'revision-race', 'false-before-parent', 'true-needs-parent', 'parent-passed', 'parent-failed', 'parent-null', 'parent-superseded', 'parent-hidden', 'parent-wrong-user', 'parent-stale-link', 'parent-photo', 'parent-foreign-photo', 'parent-lost-photo'] as const) {
      const parent = mode.startsWith('parent-');
      const noInspection = mode === 'parent-null';
      const wantedResult = mode === 'passed' || mode === 'parent-passed' || mode === 'parent-photo' ? 'passed' : mode === 'blocked' ? 'blocked' : 'failed';
      const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: `${mode}@maintain.test`, password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false,
        roles: ['maintain.technician', 'field.technician'].map(role => ({ role, granted_at: new Date(now).toISOString(), granted_by: user.user_id })) });
      const token = `inspection-${mode}`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const scope = { app: 'CanMaintain', owner: team.team_id, ownerPackage: 'maintain' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
        stateStoreId: 'inspect-state', fileStoreId: 'inspect-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const location = asId('location-1'), asset = asId('asset-1'), plan = asId('plan-1'), inspection = asId('inspection-1');
      const row = (id: ReturnType<typeof asId>, data: Record<string, unknown>, parent: { model: ReturnType<typeof asModel>; id: ReturnType<typeof asId> } | null = null) =>
        ({ ...makeRow({ id, data }), parent, ...(id === plan && ['false-before-parent', 'true-needs-parent'].includes(mode) ? { archivedAt: now } : {}) });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('rent_catalog.Location'), row: row(location, { name: 'Main site', timezone: 'UTC', active: true }) },
        { kind: 'insert', model: asModel('employee.Employee'), row: row(asId('employee-1'), { user: { id: mode === 'parent-wrong-user' ? 'other-user' : user.user_id }, home: { id: location },
          locations: [], operator_wide: false, active: mode !== 'employee-inactive', hidden: true }) },
        { kind: 'insert', model: asModel('maintain.Asset'), row: row(asset, { name: 'Cooling unit', location: { id: location }, inspection_epoch: '0', retired: false }) },
        { kind: 'insert', model: asModel('maintain.Plan'), row: row(plan, { name: 'Cooling checklist', assignee: { id: user.user_id }, revision: '1', asset_epoch: '0', active: true, hidden: false }, { model: asModel('maintain.Asset'), id: asset }) },
        { kind: 'insert', model: asModel('maintain.Inspection'), row: row(inspection, { cancelled: false, reminder_email: 'inspector@example.test', reminded_at: null,
          due: '2026-10-22', asset_epoch: '0', template_version: '1', inspector: { id: user.user_id }, result: 'pending', checklist: ['Cooling works'],
          answers: [], evidence: null, inspected_at: null, repair: null, hidden: mode === 'parent-hidden' }, { model: asModel('maintain.Plan'), id: plan }) },
        ...(!['superseded-hidden', 'parent-superseded'].includes(mode) ? [] : [{ kind: 'insert' as const, model: asModel('maintain.Cancellation'), row: row(asId('cancellation-1'),
          { plan: { id: plan }, through: '1', cutoff: '2026-10-21', reason: 'plan_revised', hidden: true }, { model: asModel('maintain.Asset'), id: asset }) }]),
        { kind: 'insert', model: asModel('field.Job'), row: row(asId('job-1'), { source: 'job-source', schedule_source: null, schedule_revision: '1', release_delivery: null, released: false, contact: 'customer@example.test', repair: null, employee: { id: 'employee-1' },
          location: { id: location }, inspection: noInspection ? null : { id: inspection }, state: 'in_progress' }) },
      ] }));
      // Seed a real owning Work occurrence so CANCEL must join the same
      // transaction as the inspection update and optional Repair linkage.
      const due = { key: inspection, scope, occurrenceId: 'inspection-reminder-1',
        event: 'maintain.Reminder', at: now + 60000 };
      const payload = { inspection: { id: inspection, version: '1' }, revision: '1' };
      const stageContext = { actor: 'inspection-test', now, operation: 'maintain.inspect',
        load: (model: Parameters<typeof store.load>[0], id: Parameters<typeof store.load>[1]) => store.load(model, id),
        query: (spec: Parameters<typeof store.query>[0]) => store.query(spec) };
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      assert.ok(loaded.valueTypes);
      const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: 'maintain',
        artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
        operations: new Map(), scope, verify: async () => {} });
      assert.ok(opaque);
      const declaration = opaque.event(due.event);
      const scheduleWrites: NonNullable<Awaited<ReturnType<typeof workSchedulePutCommand.stage>>['writes']>[number][] = [];
      const scheduleOps: NonNullable<Awaited<ReturnType<typeof workSchedulePutCommand.stage>>['schedules']>[number][] = [];
      // Two concurrently created lineage heads must both be cancelled.
      for (const occurrenceId of mode === 'failed' ? [due.occurrenceId, 'inspection-reminder-twin'] : [due.occurrenceId]) {
        const staged = await workSchedulePutCommand.stage({ ...due, occurrenceId, payload }, stageContext);
        const scheduledRow = staged.writes?.find(write => write.kind === 'insert' && write.model === 'work.schedule');
        assert.ok(scheduledRow?.kind === 'insert');
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
          model: asModel('work.schedule'), row: scheduledRow.row, field: 'payload', scope,
          origin: { kind: 'event-input', occurrenceId, sourceOccurrence: occurrenceId, declaration,
            lineage: { kind: 'schedule', key: due.key, replaces: scheduledRow.row.data['replaces'] as null }, target: { kind: 'schedule' } },
          projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId }, value: payload, identity });
        const scheduled = await workSchedulePutCommand.stage({ ...due, occurrenceId, payload, filePayloadOrigin }, stageContext);
        scheduleWrites.push(...(scheduled.writes ?? []).map(write => mode === 'blocked' && write.kind === 'insert' && write.model === 'work.schedule'
          ? { ...write, row: { ...write.row, data: { ...write.row.data, state: 'admitted' } } } : write));
        scheduleOps.push(...scheduled.schedules ?? []);
      }
      if (mode === 'blocked') scheduleWrites.push({ kind: 'insert', model: asModel('work.dispatch'), row: newDispatchRow({
        intentId: 'inspection-mail-1', operationId: 'inspection-mail-operation', source: 'std.EmailV1.send', occurrenceIndex: 0,
        originOccurrence: due.occurrenceId }, { nowMs: now, actor: 'inspection-test' }) });
      await store.commit(makeBatch(await store.readRevision(), { writes: scheduleWrites, schedules: scheduleOps }));
      const scheduleKey = [scope.app, scope.ownerPackage, scope.owner, inspection].map(encodeURIComponent).join('/');
      assert.ok(await store.scheduleGet(scheduleKey));
      let revoked = false;
      if (mode === 'role-revoked-during-source') {
        const find = identities.findMembership.bind(identities);
        identities.findMembership = async (teamId, userId) => {
          const observed = await find(teamId, userId);
          if (!revoked && observed !== null && teamId === team.team_id && userId === user.user_id) {
            revoked = true;
            await identities.setMembershipRoles(membership.membership_id, []);
          }
          return observed;
        };
      }
      let raced = false;
      if (mode === 'revision-race' || mode === 'parent-stale-link') {
        const commit = store.commit.bind(store);
        store.commit = async batch => {
          if (!raced && batch.writes.some(write => write.model === 'maintain.Inspection')) {
            if (mode === 'parent-stale-link') {
              raced = true;
              const job = await store.load(asModel('field.Job'), asId('job-1')); assert.ok(job);
              await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: asModel('field.Job'),
                id: job.id, expectedVersion: job.version, row: { ...job, version: asVersion(job.version + 1),
                  updated: now, data: { ...job.data, inspection: null } } }] }));
              return commit(batch);
            }
            raced = true;
            const employee = await store.load(asModel('employee.Employee'), asId('employee-1'));
            assert.ok(employee);
            await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: asModel('employee.Employee'),
              id: employee.id, expectedVersion: employee.version, row: { ...employee, version: asVersion(employee.version + 1),
                updated: now, data: { ...employee.data, active: false } } }] }));
          }
          return commit(batch);
        };
      }
      const clockPort = new TestOnlyManualClock(now), blobs = new TestOnlyMemoryBlobStore(),
        finalizedFiles = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
      const physical = { clock: clockPort, blobs, files: finalizedFiles,
        upload: { clock: clockPort, intents, blobs, policy: DEFAULT_FILE_POLICY,
          intentIds: new TestOnlyCounterIntentIds(), intentTtlMs: 3600000, urlBase: 'https://field.test' },
        finalize: { clock: clockPort, intents, blobs, files: finalizedFiles, fileIds: new TestOnlyCounterFileIds() } };
      const PNG_BYTES = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,1]);
      const retention = { unattachedHorizonMs: 3600000, retentionMs: 86400000 };
      const observation = { policy: physical.upload.policy, retention };
      const kernel = createFileJourneyKernel({ maxBytes: physical.upload.policy.maxBytes,
        createIntent: input => createUploadIntent(physical.upload, input),
        append: (id, caller, bytes, offset) => appendUploadContentAtOffset(physical.upload, id, caller, bytes, offset),
        complete: (id, caller) => completeUploadContent(physical.upload, id, caller),
        finalize: input => finalizeUpload(physical.finalize, input),
        authorizeAttach: (ref, caller) => authorizeAttach(physical.finalize, ref, caller),
        readProvenance: (ref, caller) => readFinalizedFile(physical.finalize, ref, caller),
        recordAttachment: (ref, record, caller) => recordAttachment(physical.finalize, ref, record, caller),
        readBytes: (ref, caller) => readFinalizedBytes(physical.finalize, ref, caller),
        readCurrentBytes: (ref, caller, policy) => readCurrentFinalizedBytes(physical.finalize, ref, caller, { ...observation, retention: policy }),
        readCurrentSnapshot: (ref, caller, policy) => readCurrentFinalizedSnapshot(physical.finalize, ref, caller, { ...observation, retention: policy }),
        observeFile: (ref, caller, policy) => observeFinalizedFile(physical.finalize, ref, caller, { ...observation, retention: policy }),
        revalidateFile: (saved, caller, policy) => revalidateRetainedFinalizedFile(physical.finalize, saved, caller, { ...observation, retention: policy }),
      } satisfies FileJourneyBindings);
      let photo: { id: string } | null = null;
      if (mode.includes('photo')) {
        const receiver = { app: scope.app, owner: team.team_id, team: team.team_id,
          principal: mode === 'parent-foreign-photo' ? 'foreign-principal' : user.user_id };
        const created = createUploadIntent(physical.upload, { receiver,
          binding: { adapter: 'deployment.web', deliveryId: `inspection-${mode}`, resultPath: 'photo' },
          request: { upload_id: `photo-${mode}`, arguments: {}, operation: 'field.complete', field: '/photo', name: 'inspection.png',
            type: 'image/png', size: String(PNG_BYTES.length) } });
        assert.equal(created.status, 'granted'); assert.ok(created.status === 'granted');
        assert.equal(appendUploadContentAtOffset(physical.upload, created.intentId, receiver, PNG_BYTES, 0).status, 'appended');
        assert.equal(completeUploadContent(physical.upload, created.intentId, receiver).status, 'completed');
        const finalized = finalizeUpload(physical.finalize, { intentId: created.intentId, retryId: `photo-${mode}`,
          bytesDigest: sha256Hex(PNG_BYTES), caller: receiver });
        assert.equal(finalized.status, 'finalized'); assert.ok(finalized.status === 'finalized');
        photo = { id: finalized.result.file };
      }
      if (mode === 'parent-lost-photo') {
        const load = store.load.bind(store); let removed = false;
        store.load = async (model, id) => {
          const record = await load(model, id);
          if (!removed && model === asModel('employee.Employee') && photo !== null) {
            removed = true; physical.blobs.remove(blobKeyForFile(photo.id));
          }
          return record;
        };
      }
      const files = createCanonicalFileBinding(kernel, retention);
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files });
      let observedInspectionLoads = 0;
      if (noInspection) {
        const load = store.load.bind(store);
        store.load = async (model, id) => {
          if (model === asModel('maintain.Inspection')) observedInspectionLoads += 1;
          return load(model, id);
        };
      }
      const outcome = await invoker.invokeMutation({ operation: parent ? 'field.complete' : mode === 'false-before-parent' || mode === 'true-needs-parent' ? 'maintain.inspect_prefix' : 'maintain.inspect', operation_id: uuidv7(now, 1), inputs: {
        ...(['false-before-parent', 'true-needs-parent'].includes(mode) ? { enabled: mode === 'true-needs-parent' } : {}),
        ...(parent ? { job: { id: 'job-1', version: '1' }, notes: 'Measured warm air', photo } : { inspection: { id: inspection, version: '1' }, evidence: mode === 'blank-evidence' ? ' ' : 'Measured warm air' }),
        answers: mode === 'wrong-count' || noInspection ? [] : ['Measured cooling'], result: noInspection ? null : wantedResult } }, identity);
      if (noInspection) assert.equal(observedInspectionLoads, 0, 'null branch never loads the child Inspection');
      if (mode === 'false-before-parent') assert.ok('error' in outcome && outcome.error.code === 'rule_failed', JSON.stringify(outcome));
      if (mode === 'true-needs-parent') assert.ok('error' in outcome, JSON.stringify(outcome));
      if (mode === 'role-revoked-during-source') assert.equal(revoked, true);
      if (mode === 'revision-race' || mode === 'parent-stale-link') assert.equal(raced, true);
      const success = ['passed', 'failed', 'blocked', 'parent-passed', 'parent-failed', 'parent-null', 'parent-photo'].includes(mode);
      const inspected = success && !noInspection;
      assert.equal('result' in outcome && outcome.result.status === 'committed', success, `${mode}: ${JSON.stringify(outcome)}`);
      assert.equal((await store.scheduleGet(scheduleKey)) === null, inspected, `${mode}: atomic schedule cancellation`);
      const schedules = await store.query({ model: asModel('work.schedule'), authority: 'owner' });
      assert.equal(schedules.length, mode === 'failed' ? 2 : 1);
      assert.ok(schedules.every(row => row.data['state'] === (inspected ? 'cancelled' : 'pending')), mode);
      const supersessions = await store.query({ model: asModel('work.supersession'), authority: 'owner' });
      assert.equal(supersessions.length, mode === 'blocked' ? 1 : 0, mode);
      if (supersessions[0]) assert.equal(supersessions[0].data['outboxId'], 'inspection-mail-1');
      const reports = await store.query({ model: asModel('field.Report'), authority: 'owner' });
      assert.equal(reports.length, parent && success ? 1 : 0, `${mode}: atomic report creation`);
      const job = await store.load(asModel('field.Job'), asId('job-1')); assert.ok(job);
      assert.equal(job.data['state'], parent && success ? 'done' : 'in_progress', mode);
      if (parent && success) assert.equal(typeof job.data['release_delivery'], 'string');
      if (parent && success) {
        assert.deepEqual(reports[0]!.data['photo'], photo);
        if (photo !== null) assert.equal(physical.files.get(photo.id)?.state, 'attached');
      } else if (photo !== null) assert.equal(physical.files.get(photo.id)?.state, 'finalized',
        `${mode}: a rejected report never attaches its photo`);
      const current = await store.load(asModel('maintain.Inspection'), inspection); assert.ok(current);
      assert.equal(current.data['result'], inspected ? wantedResult : 'pending', mode);
      assert.deepEqual(current.data['answers'], inspected ? ['Measured cooling'] : [], mode);
      assert.equal(current.data['evidence'], inspected ? 'Measured warm air' : null, mode);
      assert.equal(current.data['inspected_at'], inspected ? new Date(now).toISOString() : null, mode);
      const repairs = await store.query({ model: asModel('maintain.Repair'), authority: 'owner' });
      assert.equal(repairs.length, inspected && wantedResult !== 'passed' ? 1 : 0, mode);
      if (repairs[0] !== undefined) {
        assert.equal(repairs[0].parent?.id, asset, mode);
        assert.equal(repairs[0].data['title'], 'Cooling checklist', mode);
        assert.equal(repairs[0].data['description'], 'Measured warm air', mode);
        assert.equal((repairs[0].data['reporter'] as { id: string }).id, user.user_id, mode);
        assert.equal((current.data['repair'] as { id: string }).id, repairs[0].id, mode);
      }
      if (parent) {
        const outbox = probe.outboxAll();
        assert.equal(outbox.length, success ? 2 : 0, `${mode}: release and guarded mail share the transaction`);
        if (success) {
          const release = outbox.find(intent => intent.target.endsWith('.release'));
          const mail = outbox.find(intent => intent.target.endsWith('.send'));
          assert.ok(release); assert.ok(mail);
          assert.deepEqual(release.arguments, { binding: 'field.StaffSchedule', from: 'deployment.staff_schedule',
            arguments: { source: 'job-source', revision: '1' } });
          const message = mail.arguments['arguments'] as Record<string, unknown>;
          assert.equal(message['to'], 'customer@example.test');
          assert.equal(message['body'], 'Measured warm air');
          assert.equal(job.data['release_delivery'], release.intentId);
          assert.equal(job.data['released'], false);
        }
      }
      const routes = await store.query({ model: asModel('work.handler_occurrence'), authority: 'owner' });
      const route = routes.find(row => row.data['handler'] === 'maintain.visit_report');
      assert.equal(route !== undefined, parent && success, `${mode}: original declared event route is atomic`);
      if (route !== undefined) {
        const sourceOccurrence = route.data['sourceOccurrence']; assert.equal(typeof sourceOccurrence, 'string');
        const selector = { sourceOccurrence: sourceOccurrence as string, event: 'field.ReportSubmitted',
          handler: 'maintain.visit_report', scope: { ...scope, ownerPackage: 'field' } };
        const receiptIdentity = { app: scope.app, owner: team.team_id, principal: user.user_id,
          operation: 'field.complete', operationId: uuidv7(now, 1) } as Parameters<typeof store.readReceipt>[0];
        const originalReceipt = await store.readReceipt(receiptIdentity); assert.ok(originalReceipt);
        const sourceRows = await store.query({ model: asModel('work.occurrence'), authority: 'owner' });
        const source = sourceRows.find(row => row.id === sourceOccurrence); assert.ok(source);
        const result = source.data['result'] as { context: { kind: string; operation: string; actor: { userId: string } } };
        assert.equal(result.context.kind, 'user'); assert.equal(result.context.operation, 'field.complete');
        assert.equal(result.context.actor.userId, user.user_id);
        const deliver = () => invokeRetainedHandlerOccurrenceCanonical({ asm, artifact, app: scope.app,
          selector, store, identities, files, now: () => now + 1 });
        const handled = await deliver();
        assert.equal((handled as { status: string }).status, 'completed', `${mode}: ${JSON.stringify(handled)}`);
        assert.equal((await deliver() as { status: string }).status, 'replayed');
        assert.deepEqual(await store.readReceipt(receiptIdentity), originalReceipt, 'delivery preserves original parent receipt');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('revises proposals through original filtered owner loops, interval guards and exact snapshots', { timeout: 900000 }, async () => {
  const path = join(root, 'packages/cloudflare/test/fixtures/propose-revise-owner-probe.can');
  const directory = await mkdtemp(join(tmpdir(), 'can-propose-revise-'));
  try {
    const original = await readFile(join(root, 'draft/apps/CanPropose/CanPropose.can'), 'utf8');
    const start = original.indexOf('  export scenario revise('), end = original.indexOf('   examples ', start);
    assert.ok(start >= 0 && end > start && (await readFile(path, 'utf8')).includes(original.slice(start,end).trimEnd()),
      'exercise the complete authored revision child');
    const {stdout} = await promisify(execFile)(compiler,
      ['compile','--format=json','--native-scenario-receipts','--catalog',catalog,path],
      {cwd:root,timeout:120000,maxBuffer:32*1024*1024});
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.ok(artifact.operations?.find(operation => operation.name === 'propose.revise')?.result?.disclosure);
    const document = artifact.models?.find(model => model.name === 'propose.Revision')?.fields.find(field => field.name === 'document');
    assert.equal(document?.field.kind,'delivery');
    if (document?.field.kind === 'delivery') {
      assert.equal(document.field.capability,'propose.DocumentsV1');
      assert.equal(document.field.operation,'quote');
      assert.equal(document.field.version,1);
      assert.equal(document.field.result.name,'propose.QuotePdf');
    }
    const asm = await assembleModules({artifact,sourcePath:path},{workDir:directory,
      stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
    for (const mode of ['overlap','inactive','valid','hidden','defaults','empty','many-unmatched','predicate-race','membership-race'] as const) {
      const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({clock});
      const team = await identities.createTeam({timezone:'UTC'});
      const user = await identities.createUser({email:`${mode}@propose.test`,password_hash:'unused',email_verified:true});
      await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,
        roles:[{role:'propose.salesperson',granted_at:new Date(now).toISOString(),granted_by:user.user_id}]});
      const token = `revise-${mode}`;
      await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,
        expires_at:new Date(now+3600000).toISOString()});
      const identity = await resolveIdentity(identities,{session_token:token},{clock});
      const scope = {app:'CanPropose',owner:team.team_id,ownerPackage:'propose'};
      const authority: FileRetirementAuthority = {app:scope.app,stateOwner:scope.app,stateStoreId:'propose-state',fileStoreId:'propose-files',
        receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
      const {store,probe} = createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
      const customer = asId('customer-1'), contact = asId('contact-1'), location = asId('location-1'), proposal = asId('proposal-1');
      const row = (id:ReturnType<typeof asId>,data:Record<string,unknown>,parent:{model:ReturnType<typeof asModel>;id:ReturnType<typeof asId>}|null=null) => ({...makeRow({id,data}),parent});
      const from = '2027-01-01T09:00:00.000Z', midpoint = '2027-01-01T10:00:00.000Z', until = '2027-01-01T11:00:00.000Z';
      const oldData = (number:string,state:string,hold_state:string) => ({product:null,attribution:null,exclusive_program:null,attributed_at:null,attribution_window:null,
        number,issuer_snapshot:'Issuer',title_snapshot:'Offer',location_snapshot:'Main',customer_snapshot:'Buyer',alternative_to:null,recipient_email:'buyer@example.test',account:null,
        expires:'2027-02-01T00:00:00.000Z',terms:'Old terms',refund_before:from,resource:'desk',from,until,intervals:[],seats:'1',quantity:'1',held_until:null,
        total:{minor:'0',currency:'EUR'},state,decided_by:null,decided_at:null,handoff:'none',delivery:null,booking:null,invoice:null,hold_state,
        booking_version:'0',hold_version:'0',hold_delivery:null,hold_release:null,notice:null,document_state:'none',document:null,pdf:null});
      await store.commit(makeBatch(await store.readRevision(),{writes:[
        {kind:'insert',model:asModel('customer.Customer'),row:row(customer,{name:'Buyer'})},
        {kind:'insert',model:asModel('customer.Contact'),row:row(contact,{email:'buyer@example.test'},{model:asModel('customer.Customer'),id:customer})},
        {kind:'insert',model:asModel('rent_catalog.Location'),row:row(location,{name:'Main',timezone:'UTC',active:true})},
        {kind:'insert',model:asModel('employee.Employee'),row:row(asId('employee-1'),{user:{id:user.user_id},home:{id:location},locations:[],operator_wide:false,active:mode!=='inactive',hidden:mode==='hidden'})},
        {kind:'insert',model:asModel('propose.Proposal'),row:row(proposal,{location:{id:location},recipient:{id:contact},issuer:'Issuer',title:'Offer',currency:'EUR',valid_days:'14',current:'3'},{model:asModel('customer.Customer'),id:customer})},
        ...(mode==='empty'?[]:(['draft','sent','accepted'] as const)).map((state,index)=>({kind:'insert' as const,model:asModel('propose.Revision'),row:row(asId(`old-${index}`),oldData(String(index+1),state,index===0?'none':'held'),{model:asModel('propose.Proposal'),id:proposal})})),
        ...(mode==='many-unmatched'?Array.from({length:101},(_,index)=>({kind:'insert' as const,model:asModel('propose.Revision'),
          row:row(asId(`unmatched-${index}`),oldData(String(index+10),'accepted','held'),{model:asModel('propose.Proposal'),id:proposal})})):[]),
      ]}));
      const businessRows = async () => Promise.all(['propose.Proposal','propose.Revision'].map(model => store.query({model:asModel(model),authority:'owner'})));
      const baseline = JSON.stringify(await businessRows());
      let raced = false;
      if (mode === 'predicate-race'||mode==='membership-race') {
        const commit = store.commit.bind(store);
        store.commit = async batch => {
          if (!raced && batch.writes.some(write => write.model === 'propose.Revision')) {
            raced = true;
            if(mode==='predicate-race') {
              const observed=await store.load(asModel('propose.Revision'),asId('old-2'));assert.ok(observed);
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('propose.Revision'),
                id:observed.id,expectedVersion:observed.version,row:{...observed,version:asVersion(observed.version+1),
                  updated:now,data:{...observed.data,state:'draft'}}}]}));
            } else {
              await commit(makeBatch(await store.readRevision(),{writes:Array.from({length:99},(_,index)=>({kind:'insert' as const,
                model:asModel('propose.Revision'),row:row(asId(`concurrent-${index}`),oldData(String(index+10),'draft','none'),
                  {model:asModel('propose.Proposal'),id:proposal})}))}));
            }
          }
          return commit(batch);
        };
      }
      const module = await import(asm.moduleUrls[artifact.modules[0]!.path]!);
      const helper = module[`$can$s$${Buffer.from('propose.quote_intervals_valid').toString('hex')}`];
      const nativeTime = (wire:string) => decodeValue('datetime',wire);
      assert.equal(await helper({},nativeTime(from),nativeTime(until),
        [{from:nativeTime(midpoint),until:nativeTime(until)},{from:nativeTime(from),until:nativeTime(mode==='overlap'?until:midpoint)}]),mode!=='overlap',`${mode}: actual interval helper`);
      const invoker = buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
      const intervals = [{from:midpoint,until},{from,until:mode==='overlap'?until:midpoint}];
      const outcome = await invoker.invokeMutation({operation:'propose.revise',operation_id:uuidv7(now,1),inputs:{
        proposal:{id:proposal,version:'1'},terms:'New terms',resource:null,from,until,seats:'2',
        ...(mode==='defaults'?{}:{quantity:'3',refund_before:from,intervals,product:'NEW'})}},identity);
      const success = ['valid','hidden','defaults','empty','many-unmatched','predicate-race'].includes(mode);
      assert.equal('result' in outcome && outcome.result.status==='committed',success,`${mode}: ${JSON.stringify(outcome)}`);
      if (mode==='predicate-race'||mode==='membership-race') assert.equal(raced,true);
      const revisions = await store.query({model:asModel('propose.Revision'),authority:'owner'});
      assert.equal(revisions.length,(mode==='empty'?0:mode==='many-unmatched'?104:mode==='membership-race'?102:3)+(success?1:0),mode);
      const changed = await store.load(asModel('propose.Proposal'),proposal); assert.ok(changed);
      assert.equal(changed.data['current'],success?'4':'3',mode);
      for (let index=0;index<(mode==='empty'?0:3);index++) {
        const prior = revisions.find(row=>row.id===`old-${index}`)!;
        assert.equal(prior.data['state'],success&&(index<2||mode==='predicate-race')?'withdrawn':['draft','sent','accepted'][index],mode);
        assert.equal(prior.data['hold_state'],success&&(index===1||mode==='predicate-race'&&index===2)?'releasing':index===0?'none':'held',mode);
      }
      if(mode==='many-unmatched')assert.ok(revisions.filter(row=>row.id.startsWith('unmatched-')).every(row=>row.version===1&&row.data['state']==='accepted'));
      if(mode==='membership-race')assert.ok(revisions.filter(row=>row.id.startsWith('concurrent-')).every(row=>row.version===1&&row.data['state']==='draft'));
      if (success) {
        const created = revisions.find(row=>row.id.includes('#create:')); assert.ok(created);
        assert.equal(created.data['number'],'4'); assert.equal(created.data['location_snapshot'],'Main');
        assert.equal(created.data['customer_snapshot'],'Buyer'); assert.equal(created.data['recipient_email'],'buyer@example.test');
        assert.equal(created.data['document'],null); assert.equal(created.data['pdf'],null);
        assert.equal(created.data['quantity'],mode==='defaults'?'1':'3'); assert.equal(created.data['refund_before'],from);
        assert.deepEqual(created.data['intervals'],mode==='defaults'?[]:[{from,until:midpoint},{from:midpoint,until}]);
        assert.equal(created.data['expires'],new Date(now+14*86400000).toISOString());
      } else if (mode!=='membership-race') {
        assert.equal(JSON.stringify(await businessRows()),baseline,'guard failure is atomic');
      }
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

it('executes original interval Values guards with nominal arrays, structural group results and declared defaults', {timeout:300000}, async()=>{
  const path=join(root,'packages/cloudflare/test/fixtures/native-values-interval-require.can');
  const directory=await mkdtemp(join(tmpdir(),'can-interval-values-'));
  try {
    const authored=await readFile(join(root,'draft/apps/CanPropose/CanPropose.can'),'utf8');
    const fixture=await readFile(path,'utf8');
    for(const line of fixture.split('\n').filter(line=>line.startsWith('  export contract QuoteInterval ')||line.startsWith('  export derive quote_intervals_valid(')))assert.ok(authored.includes(line));
    const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,path],
      {cwd:root,timeout:120000,maxBuffer:32*1024*1024});
    const artifact=JSON.parse(stdout) as CompileArtifact;
    const asm=await assembleModules({artifact,sourcePath:path},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
    for(const mode of ['valid','defaults','duplicate','overlap','bad-refund','blank-note'] as const){
      const now=Date.now(),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
      const team=await identities.createTeam({timezone:'UTC'});
      const user=await identities.createUser({email:`${mode}@interval.test`,password_hash:'unused',email_verified:true});
      await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
      const token=`interval-${mode}`;await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,expires_at:new Date(now+3600000).toISOString()});
      const identity=await resolveIdentity(identities,{session_token:token},{clock});
      const {store}=createTestMemoryStorage();
      await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('propose.Seed'),row:makeRow({id:asId('seed-1'),data:{number:'0'}})}]}));
      const from='2027-01-01T09:00:00.000Z',midpoint='2027-01-01T10:00:00.000Z',until='2027-01-01T11:00:00.000Z';
      const intervals=mode==='duplicate'?[{from,until},{from,until}]:[{from:midpoint,until},{from,until:mode==='overlap'?until:midpoint}];
      const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
      const result=await invoker.invokeMutation({operation:'propose.validate',operation_id:uuidv7(now,1),inputs:{seed:{id:'seed-1',version:'1'},from,until,
        ...(mode==='defaults'?{}:{quantity:'3',refund_before:mode==='bad-refund'?until:from,intervals,note:mode==='blank-note'?' ':null})}},identity);
      const success=mode==='valid'||mode==='defaults';
      assert.equal('result' in result&&result.result.status==='committed',success,`${mode}: ${JSON.stringify(result)}`);
      const row=await store.load(asModel('propose.Seed'),asId('seed-1'));assert.ok(row);
      assert.equal(row.data['number'],success?mode==='defaults'?'1':'3':'0',`${mode}: original guard controls the real atomic write`);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
