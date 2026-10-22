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
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS,
  createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { classifyFailure } from '@canlang/work/receipt';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { buildInvoker } from '../worker/assembly.js';
import { createBoundMailDispatcher } from './bound-dispatch.js';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, invokeDueScheduleCanonical,
  loadCanonicalDescriptors } from './invoke.js';
import { assembleModules } from './modules.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

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
