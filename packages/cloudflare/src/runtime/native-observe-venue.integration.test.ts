/** The original CanEvent observe_venue scan owns one confirming Change and its guarded Rooms confirmation. */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS,
  createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { classifyFailure } from '@canlang/work/receipt';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, createWorkerDispatchJoinPort, driveDispatchIntentWithPreclaim,
  invokeDueScheduleCanonical, loadCanonicalDescriptors, loadDispatchSystemProducers,
  withDispatchJoinPort } from './invoke.js';
import { assembleDispatchCommands } from '../worker/assembly.js';
import { assembleModules } from './modules.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/event-observe-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const now = Date.parse('2099-01-01T12:00:00.000Z');

it('refuses altered venue scan, pending gate, and guarded Rooms SEND', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-observe-venue-mutants-'));
  try {
    const original = await readFile(source, 'utf8');
    const variants = [
      ['scan', 'where row.source==event.value.source limit=1',
        'where row.source==event.value.source limit=2'],
      ['gate', 'if change.parent.pending_change==change and not change.parent.cancelled and change.base_revision==change.parent.revision',
        'if change.parent.pending_change==change and not change.parent.cancelled'],
      ['send-guard', 'when=change.parent.pending_change==change and not change.parent.cancelled and change.state==confirming',
        'when=change.parent.pending_change==change and not change.parent.cancelled'],
      ['send-target', 'send Rooms.confirm {source=change.source,resource=resource.id}',
        'send Rooms.confirm {source=change.source,resource=change.source}'],
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
        `${name}: changed original owner must lose native receipt`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stages one Rooms.confirm for the eligible Change and refuses stale, cancelled, swapped, missing, archived, raised, and rebased rows',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-observe-venue-'));
    try {
      const probe = await readFile(source, 'utf8');
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      assert.ok(probe.includes('scenario observe_venue on=VenueObserved'), 'original venue scan is retained');
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });

      // No actor-membership mode: the due schedule resolves the system team
      // owner identity (due.scope), never the fixture actor session, so
      // skipping an unrelated membership cannot deny a valid system event.
      for (const mode of ['eligible', 'stale-revision', 'cancelled', 'swapped-resource',
        'missing-resource', 'cancelled-at-dispatch', 'resource-archived-at-dispatch',
        'venue-raised-at-dispatch', 'base-rebased-at-dispatch'] as const) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `actor-${mode}@observe-venue.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: false, roles: [] });
        const token = `observe-venue-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const scope = { app: 'CanEvent', owner: team.team_id, ownerPackage: 'events' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'observe-venue-state', fileStoreId: 'observe-venue-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const program = { ...makeRow({ id: asId('program'), data: { name: 'Season' } }), parent: null };
        const resource = { ...makeRow({ id: asId('hall'), data: { name: 'Hall' } }), parent: null };
        const otherResource = { ...makeRow({ id: asId('annex'), data: { name: 'Annex' } }), parent: null };
        const event = { ...makeRow({ id: asId('event'), data: {
          revision: '5', pending_change: { id: asId('change') },
          cancelled: mode === 'cancelled' } }),
          parent: { model: model('events.Program'), id: program.id } };
        const change = { ...makeRow({ id: asId('change'), data: {
          source: 'chg-1', base_revision: '5', venue_revision: mode === 'stale-revision' ? '6' : '4',
          state: 'holding', resource: { id: resource.id },
          confirm_delivery: null, confirm_status: null } }),
          parent: { model: model('events.Event'), id: event.id } };
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: model('events.Program'), row: program },
          { kind: 'insert', model: model('events.Resource'), row: resource },
          { kind: 'insert', model: model('events.Resource'), row: otherResource },
          { kind: 'insert', model: model('events.Event'), row: event },
          { kind: 'insert', model: model('events.Change'), row: change },
        ] }));
        const due = { key: asId('change'), scope, occurrenceId: 'observe-venue-1',
          event: 'events.VenueObserved', at: now - 1 };
        const payload = { value: { source: 'chg-1', revision: '6', state: 'pending', reference: null, detail: null } };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'events.observe_venue',
          load: (modelName: Parameters<typeof store.load>[0], id: Parameters<typeof store.load>[1]) => store.load(modelName, id),
          query: (spec: Parameters<typeof store.query>[0]) => store.query(spec) };
        const loaded = await loadCanonicalDescriptors(asm, artifact);
        assert.ok(loaded.valueTypes);
        const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage,
          artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
          operations: new Map(), scope, verify: async () => {} });
        assert.ok(opaque);
        const declaration = opaque.event(due.event);
        const first = await workSchedulePutCommand.stage({ ...due, payload }, stageContext);
        const row = first.writes?.find(write => write.kind === 'insert' &&
          write.model === 'work.schedule' && write.row.id === due.occurrenceId);
        assert.ok(row && row.kind === 'insert');
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
          model: model('work.schedule'), row: row.row, field: 'payload', scope,
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
        const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
          handler: 'events.observe_venue', due, store, identities, now: () => now });
        const staged = mode === 'eligible' || mode === 'swapped-resource' ||
          mode === 'missing-resource' || mode === 'cancelled-at-dispatch' ||
          mode === 'resource-archived-at-dispatch' || mode === 'venue-raised-at-dispatch' ||
          mode === 'base-rebased-at-dispatch';
        assert.equal(result.status, 'completed', `${mode}: ${JSON.stringify(result)}`);
        const intents = storageProbe.outboxAll();
        assert.equal(intents.length, staged ? 1 : 0, `${mode}: Rooms.confirm intents`);
        const stored = await store.load(model('events.Change'), change.id);
        assert.ok(stored);
        assert.equal(stored.data['state'], staged ? 'confirming' : 'holding', `${mode}: change state`);
        if (!staged) continue;
        const intent = intents[0]!;
        assert.equal(intent.operation, 'events.observe_venue', mode);
        assert.ok(intent.target.endsWith('RoomsV1.confirm'), `${mode}: ${intent.target}`);
        const request = intent.arguments['arguments'] as Record<string, unknown>;
        assert.equal(request['source'], 'chg-1', mode);
        assert.equal(request['resource'], resource.id, mode);
        assert.equal(stored.data['confirm_delivery'], intent.intentId, mode);
        if (mode !== 'eligible') {
          const current = await store.load(model('events.Change'), change.id);
          assert.ok(current);
          if (mode === 'resource-archived-at-dispatch') {
            const currentResource = await store.load(model('events.Resource'), resource.id);
            assert.ok(currentResource);
            await store.commit(makeBatch(await store.readRevision(), { writes: [{
              kind: 'update', model: model('events.Resource'), id: currentResource.id,
              expectedVersion: currentResource.version,
              row: { ...currentResource, version: asVersion(currentResource.version + 1), updated: now,
                archivedAt: now, data: { ...currentResource.data } },
            }] }));
          } else if (mode === 'venue-raised-at-dispatch') {
            await store.commit(makeBatch(await store.readRevision(), { writes: [{
              kind: 'update', model: model('events.Change'), id: current.id,
              expectedVersion: current.version,
              row: { ...current, version: asVersion(current.version + 1), updated: now,
                data: { ...current.data, venue_revision: '7' } },
            }] }));
          } else if (mode === 'base-rebased-at-dispatch') {
            const currentEvent = await store.load(model('events.Event'), event.id);
            assert.ok(currentEvent);
            await store.commit(makeBatch(await store.readRevision(), { writes: [{
              kind: 'update', model: model('events.Event'), id: currentEvent.id,
              expectedVersion: currentEvent.version,
              row: { ...currentEvent, version: asVersion(currentEvent.version + 1), updated: now,
                data: { ...currentEvent.data, revision: '6' } },
            }, {
              kind: 'update', model: model('events.Change'), id: current.id,
              expectedVersion: current.version,
              row: { ...current, version: asVersion(current.version + 1), updated: now,
                data: { ...current.data, base_revision: '6' } },
            }] }));
          } else if (mode === 'swapped-resource') {
            await store.commit(makeBatch(await store.readRevision(), { writes: [{
              kind: 'update', model: model('events.Change'), id: current.id,
              expectedVersion: current.version,
              row: { ...current, version: asVersion(current.version + 1), updated: now,
                data: { ...current.data, resource: { id: otherResource.id } } },
            }] }));
          } else if (mode === 'missing-resource') {
            await store.commit(makeBatch(await store.readRevision(), { writes: [{
              kind: 'update', model: model('events.Change'), id: current.id,
              expectedVersion: current.version,
              row: { ...current, version: asVersion(current.version + 1), updated: now,
                data: { ...current.data, resource: null } },
            }] }));
          } else {
            const currentEvent = await store.load(model('events.Event'), event.id);
            assert.ok(currentEvent);
            await store.commit(makeBatch(await store.readRevision(), { writes: [{
              kind: 'update', model: model('events.Event'), id: currentEvent.id,
              expectedVersion: currentEvent.version,
              row: { ...currentEvent, version: asVersion(currentEvent.version + 1), updated: now,
                data: { ...currentEvent.data, cancelled: true } },
            }] }));
          }
        }
        const fenceFor = await bindNativeEmailDispatchGuards({ asm, artifact, store, identities,
          scope, revalidateAuthority: async () => true });
        const producers = await loadDispatchSystemProducers();
        const claim = createWorkDispatchClaimCommand((candidateId, target) =>
          candidateId === intent.intentId && target === intent.target);
        const commands = assembleDispatchCommands({ l3Commands: producers.l3Commands,
          workCommands: WORK_SYSTEM_COMMANDS.map(command => command.name === claim.name ? claim : command),
          stageCommands: WORK_DISPATCH_STAGE_COMMANDS });
        const joined = withDispatchJoinPort(store, await createWorkerDispatchJoinPort(store));
        let providerCalls = 0;
        const dispatch = await driveDispatchIntentWithPreclaim({
          store: joined, intent, actor: 'dispatch:events.observe_venue',
          operation: 'test.events.observe_venue.dispatch', nowMs: () => now + 1000,
          nextClaimId: () => `claim-${mode}`, maxClaimAgeMs: 60000,
          claimOperationId: uuidv7(now + 1000, 1), recordOperationId: uuidv7(now + 1000, 2),
          evaluateGuard: () => { throw new Error('native venue guard was bypassed'); },
          readStateSnapshot: () => null,
          callProvider: async () => { providerCalls++; return { kind: 'delivered', result: null }; },
          classifyFailure, fence: fenceFor(intent),
        }, (guard, allocator) => {
          const guarded = createWorkDispatchClaimCommand((candidateId, target) =>
            candidateId === intent.intentId && target === intent.target, guard, allocator);
          return producers.createSystemRegistry(commands.map(command =>
            command.name === claim.name ? guarded : command));
        });
        const expected = mode === 'eligible' ? 'recorded' : 'not-claimed';
        assert.equal(dispatch.status, expected, `${mode}: ${JSON.stringify(dispatch)}`);
        if (dispatch.status === 'not-claimed') assert.equal(dispatch.reason, 'guard-false', mode);
        assert.equal(providerCalls, mode === 'eligible' ? 1 : 0, `${mode}: provider calls`);
        assert.equal(storageProbe.outboxAll().length, 1, `${mode}: no duplicate confirmation`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
