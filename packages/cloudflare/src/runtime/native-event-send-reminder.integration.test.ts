/** A scheduled appointment reminder reads its current private Contact and Calendar sources. */
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
const source = join(root, 'packages/cloudflare/test/fixtures/appointments-reminder-transport-probe.can');
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
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
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
