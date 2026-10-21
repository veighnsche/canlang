/** Original booking correspondence and reminder execute from retained Work sources. */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority, ModelName, StoredRow } from '@canlang/contracts';
import { resolveIdentity } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { installNativeFileInventory } from './file-inventory.js';
import { invokeDueScheduleCanonical, invokeDueSourceRoutingCanonical,
  invokeRetainedHandlerOccurrenceCanonical, loadCanonicalDescriptors } from './invoke.js';
import { assembleModules } from './modules.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/rent-notice-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const now = Date.parse('2099-01-01T12:00:00.000Z');

it('refuses changed correspondence and reminder guards, Mail request, and Notice effects',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-rent-notice-mutants-'));
    try {
      const original = await readFile(source, 'utf8');
      const variants = [
        ['correspondence-revision', 'require event.booking.version==event.revision',
          'require event.booking.version>=event.revision'],
        ['correspondence-cancel', 'cancel event.booking.source',
          'cancel "wrong-source"'],
        ['confirmation-subject', '"Workspace confirmed"@{nl="Werkplek bevestigd"}',
          '"Workspace ready"@{nl="Werkplek bevestigd"}'],
        ['confirmation-guard', 'when=event.booking.status==confirmed and event.booking.version==event.revision as delivery\n     create Notice {parent=event.booking,kind=confirmation',
          'when=event.booking.version==event.revision as delivery\n     create Notice {parent=event.booking,kind=confirmation'],
        ['cancellation-kind', 'kind=cancellation,revision=event.revision,subject,body,delivery',
          'kind=reminder,revision=event.revision,subject,body,delivery'],
        ['reminder-schedule', 'if event.booking.from>now+1h',
          'if event.booking.from>=now+1h'],
        ['reminder-subject', '"Workspace arrival reminder"@{nl="Herinnering werkplekaankomst"}',
          '"Workspace arrival"@{nl="Herinnering werkplekaankomst"}'],
        ['reminder-body', 'let body=event.booking.parent.location.arrival',
          'let body=event.booking.parent.name'],
      ] as const;
      for (const [name, before, after] of variants) {
        assert.equal(original.split(before).length, 2, `${name}: unique original source`);
        const path = join(directory, `${name}.can`);
        await writeFile(path, original.replace(before, after));
        const result = spawnSync(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(result.status, 10, `${name}: ${result.stderr || result.stdout}`);
        const report = JSON.parse(result.stdout) as { diagnostics: { code: string }[] };
        assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008'),
          `${name}: changed original owner must lose its native receipt`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('sends and records original confirmation, cancellation, and reminder from genuine Work',
  { timeout: 300000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-rent-notice-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanRent/CanRent.can'), 'utf8');
      for (const [start, end] of [
        ['  scenario correspondence on=ReservationChanged', '  scenario remind on=Reminder'],
        ['  scenario remind on=Reminder', '  export scenario resend_notice'],
      ] as const) {
        const begin = original.indexOf(start), finish = original.indexOf(end, begin + start.length);
        assert.ok(begin >= 0 && finish > begin);
        assert.ok(probe.includes(original.slice(begin, finish).trimEnd()),
          `${start.trim()} retains its original handler`);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });

      for (const mode of ['cancellation', 'expired', 'no-show', 'held', 'hidden-parents',
        'stale-event', 'retired-event', 'confirmed-soon', 'confirmation'] as const) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const scope = { app: 'CanRent', owner: team.team_id, ownerPackage: 'rent_reservations' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'rent-notice-state', fileStoreId: 'rent-notice-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const status = mode === 'cancellation' ? 'cancelled' : mode === 'expired' ? 'expired' :
          mode === 'no-show' ? 'no_show' : mode === 'held' ? 'held' : 'confirmed';
        const location = { ...makeRow({ id: asId('location'), data: {
          name: 'Harbor', arrival: 'Use the east entrance', hidden: false } }), parent: null };
        const resource = { ...makeRow({ id: asId('resource'), data: {
          location: { id: location.id }, name: 'Studio', hidden: false } }), parent: null };
        const from = mode === 'confirmed-soon' ? now + 30 * 60000 : now + 3 * 3600000;
        const booking = { ...makeRow({ id: asId('booking'), data: {
          source: 'booking-source', email: 'guest@example.test',
          from: new Date(from).toISOString(), until: new Date(from + 3600000).toISOString(),
          terms: 'House terms', status, hidden: false } }),
          parent: { model: model('rent_reservations.Resource'), id: resource.id } };
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: model('rent_catalog.Location'), row: location },
          { kind: 'insert', model: model('rent_reservations.Resource'), row: resource },
          { kind: 'insert', model: model('rent_reservations.Booking'), row: booking },
        ] }));
        const kickoff = { key: `notice-kickoff-${mode}`, scope,
          occurrenceId: `notice-kickoff-${mode}`, event: 'rent_reservations.Kickoff', at: now - 1 };
        const payload = { booking: { id: booking.id, version: String(booking.version) } };
        const stageContext = { actor: `schedule:${kickoff.event}`, now,
          operation: 'rent_reservations.source_bridge',
          load: (name: Parameters<typeof store.load>[0], id: StoredRow['id']) => store.load(name, id),
          query: (spec: Parameters<typeof store.query>[0]) => store.query(spec) };
        const loaded = await loadCanonicalDescriptors(asm, artifact);
        assert.ok(loaded.valueTypes);
        const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage,
          artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
          operations: new Map(), scope, verify: async () => {} });
        assert.ok(opaque);
        const declaration = opaque.event(kickoff.event);
        const scheduleIdentity = await resolveIdentity(identities, { team_id: team.team_id },
          { clock: createFrozenClock(now) });
        const initial = await workSchedulePutCommand.stage({ ...kickoff, payload }, stageContext);
        const scheduleWrite = initial.writes?.find(write => write.kind === 'insert' &&
          write.model === 'work.schedule' && write.row.id === kickoff.occurrenceId);
        assert.ok(scheduleWrite && scheduleWrite.kind === 'insert');
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
          model: model('work.schedule'), row: scheduleWrite.row, field: 'payload', scope,
          origin: { kind: 'event-input', occurrenceId: kickoff.occurrenceId,
            sourceOccurrence: kickoff.occurrenceId, declaration,
            lineage: { kind: 'schedule', key: kickoff.key,
              replaces: scheduleWrite.row.data['replaces'] as null }, target: { kind: 'schedule' } },
          projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId },
          value: payload, identity: scheduleIdentity });
        const scheduled = await workSchedulePutCommand.stage({ ...kickoff, payload, filePayloadOrigin }, stageContext);
        await store.commit(makeBatch(await store.readRevision(), {
          writes: scheduled.writes ?? [], schedules: scheduled.schedules ?? [],
        }));
        const sourceRoute = await invokeDueSourceRoutingCanonical({ asm, artifact, app: scope.app,
          handler: 'rent_reservations.source_bridge', due: kickoff, store, identities, now: () => now });
        assert.equal(sourceRoute.status, 'completed', `${mode}: ${JSON.stringify(sourceRoute)}`);
        const kickoffRoutes = await store.query({ model: model('work.handler_occurrence'), authority: 'owner' });
        const bridgeRoute = kickoffRoutes.find(row => row.data['handler'] === 'rent_reservations.source_bridge');
        assert.ok(bridgeRoute, `${mode}: Kickoff retains its bridge handler`);
        const bridge = await invokeRetainedHandlerOccurrenceCanonical({ asm, artifact, app: scope.app,
          selector: { sourceOccurrence: kickoff.occurrenceId,
            handler: 'rent_reservations.source_bridge', event: kickoff.event, scope },
          store, identities, now: () => now });
        assert.ok(typeof bridge === 'object' && bridge !== null && 'status' in bridge);
        assert.equal(bridge.status, 'completed', `${mode}: ${JSON.stringify(bridge)}`);
        const routes = await store.query({ model: model('work.handler_occurrence'), authority: 'owner' });
        const route = routes.find(row => row.data['handler'] === 'rent_reservations.correspondence');
        assert.ok(route, `${mode}: emitted ReservationChanged retains its ordinary handler`);
        const sourceOccurrence = route.data['sourceOccurrence'];
        assert.equal(typeof sourceOccurrence, 'string', mode);
        const selector = { sourceOccurrence: sourceOccurrence as string,
          handler: 'rent_reservations.correspondence', event: 'rent_reservations.ReservationChanged', scope };
        if (mode === 'hidden-parents') {
          const writes: Array<{ kind: 'update'; model: ModelName; id: StoredRow['id'];
            expectedVersion: StoredRow['version']; row: StoredRow }> = [];
          for (const [name, id] of [
            ['rent_catalog.Location', location.id], ['rent_reservations.Resource', resource.id],
          ] as const) {
            const current = await store.load(model(name), id); assert.ok(current);
            writes.push({ kind: 'update', model: model(name), id: current.id,
              expectedVersion: current.version,
              row: { ...current, version: asVersion(current.version + 1), updated: now,
                data: { ...current.data, hidden: true } } });
          }
          await store.commit(makeBatch(await store.readRevision(), { writes }));
        }
        if (mode === 'stale-event' || mode === 'retired-event') {
          const current = await store.load(model('rent_reservations.Booking'), booking.id); assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: model('rent_reservations.Booking'), id: current.id,
            expectedVersion: current.version,
            row: { ...current, version: asVersion(current.version + 1), updated: now,
              ...(mode === 'retired-event' ? { archivedAt: now } : {}),
              data: { ...current.data, ...(mode === 'stale-event' ? { status: 'held' } : {}) } },
          }] }));
        }
        let handled: { readonly status: string } | null = null;
        let handlerError: unknown;
        try {
          const outcome = await invokeRetainedHandlerOccurrenceCanonical({ asm, artifact, app: scope.app,
            selector, store, identities, now: () => now });
          if (typeof outcome !== 'object' || outcome === null || !('status' in outcome) ||
              typeof outcome.status !== 'string') throw new Error('Retained notice handler lacks its Work status.');
          handled = outcome as { readonly status: string };
        }
        catch (error) { handlerError = error; }
        const shouldSend = !['held', 'stale-event', 'retired-event'].includes(mode);
        if (['stale-event', 'retired-event'].includes(mode)) {
          assert.notEqual(handled?.status, 'completed', `${mode}: changed Booking cannot send`);
        } else {
          assert.equal(handlerError, undefined, `${mode}: ${String(handlerError)}`);
          assert.equal(handled?.status, 'completed', `${mode}: ${JSON.stringify(handled)}`);
        }
        const notices = await store.query({ model: model('rent_reservations.Notice'),
          parent: { model: model('rent_reservations.Booking'), id: booking.id }, authority: 'owner' });
        const intents = storageProbe.outboxAll();
        assert.equal(notices.length, shouldSend ? 1 : 0, `${mode}: one original Notice`);
        assert.equal(intents.length, shouldSend ? 1 : 0, `${mode}: one original Mail intent`);
        if (shouldSend) {
          const notice = notices[0]!, intent = intents[0]!;
          assert.equal(intent.target, 'std.EmailV1.send', mode);
          assert.equal(intent.arguments['binding'], 'rent_reservations.Mail', mode);
          const args = intent.arguments['arguments'] as Record<string, unknown>;
          assert.equal(args['to'], 'guest@example.test', mode);
          assert.equal(notice.data['revision'], '1', mode);
          assert.equal(notice.data['subject'], args['subject'], mode);
          assert.equal(notice.data['body'], args['body'], mode);
          assert.ok(JSON.stringify(notice.data['delivery']).includes(intent.intentId),
            `${mode}: Notice retains the exact Mail delivery`);
          if (['cancellation', 'expired', 'no-show'].includes(mode)) {
            assert.equal(notice.data['kind'], 'cancellation', mode);
            assert.equal(args['subject'], 'Workspace booking changed', mode);
            assert.equal(args['body'], 'House terms', mode);
          } else {
            assert.equal(notice.data['kind'], 'confirmation', mode);
            assert.equal(args['subject'], 'Workspace confirmed', mode);
            assert.ok(String(args['body']).includes('Harbor; Studio;'), mode);
            assert.ok(String(args['body']).includes('Use the east entrance; House terms; /workspace/my-bookings'), mode);
          }
        }
        const allSchedules = await store.query({ model: model('work.schedule'), authority: 'owner' });
        const schedules = allSchedules
          .filter(row => row.data['event'] === 'rent_reservations.Reminder');
        const expectedSchedule = status === 'confirmed' && from > now + 3600000 && shouldSend;
        assert.equal(schedules.length, expectedSchedule ? 1 : 0,
          `${mode}: original Reminder schedule ${JSON.stringify(allSchedules.map(row => ({ id: row.id, data: row.data })))}`);
        if (mode === 'confirmation') {
          const schedule = schedules[0]!;
          assert.equal(schedule.data['key'], booking.data.source, mode);
          assert.equal(schedule.data['event'], 'rent_reservations.Reminder', mode);
          assert.equal(schedule.data['at'], from - 3600000, mode);
          const due = { key: booking.data.source as string, scope, occurrenceId: schedule.id,
            event: 'rent_reservations.Reminder', at: from - 3600000 };
          const reminder = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
            handler: 'rent_reservations.remind', due, store, identities, now: () => from - 3600000 + 1000 });
          assert.equal(reminder.status, 'completed', JSON.stringify(reminder));
          const after = await store.query({ model: model('rent_reservations.Notice'),
            parent: { model: model('rent_reservations.Booking'), id: booking.id }, authority: 'owner' });
          assert.equal(after.length, 2, 'original Reminder creates exactly one further Notice');
          const reminderNotice = after.find(row => row.data['kind'] === 'reminder');
          assert.ok(reminderNotice);
          const allMail = storageProbe.outboxAll();
          assert.equal(allMail.length, 2, 'reminder queues exactly one further Mail intent');
          const mail = allMail.find(intent => intent.intentId !== intents[0]?.intentId);
          assert.ok(mail);
          assert.equal(mail.target, 'std.EmailV1.send');
          assert.equal(reminderNotice.data['subject'], 'Workspace arrival reminder');
          assert.equal(reminderNotice.data['body'], 'Use the east entrance');
          assert.ok(JSON.stringify(reminderNotice.data['delivery']).includes(mail.intentId));
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
