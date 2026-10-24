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
        stdlibUrl: new URL('./stdlib.js',import.meta.url).href,
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

it('executes original due FIRST against retained D1 rows with confined owner decisions',
  { timeout: 120000 }, async () => {
    const { Miniflare } = await import('miniflare');
    const { createD1Storage, ensureSchema } = await import('@canlang/state/storage/d1');
    const { sha256HexText } = await import('@canlang/identity');
    const { uuidv7 } = await import('@canlang/state/testing/invocation/fixtures');
    const { invokeMutationCanonical } = await import('./invoke.js');
    const { readScheduleRow, readOccurrenceRow } = await import('@canlang/work/kernel/tables');
    const directory = await mkdtemp(join(tmpdir(), 'can-due-first-d1-'));
    try {
      for (const privateRead of [false, true]) {
        const app = privateRead ? 'HookFirstPrivateGuard' : 'HookFirstDelivery';
        const fixture = join(root, `packages/cloudflare/test/fixtures/hook-first-delivery${privateRead ? '-private' : ''}.can`);
        const { stdout } = await promisify(execFile)(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, fixture],
          { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        let artifact = JSON.parse(stdout) as CompileArtifact;
        const assemble = (suffix: string) => assembleModules({ artifact, sourcePath: fixture }, {
          workDir: join(directory, suffix), stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
          uiUrl: import.meta.resolve('@canlang/ui') });
        let asm = await assemble(`${app}-initial`);
        const module = await import(asm.entryUrl);
        const plan = module.canScenarioQuerySources()[`${app}.probe`];
        assert.ok(plan, 'the original private handler publishes its native FIRST plan');
        assert.equal(plan.queries.length, 1);
        assert.equal(plan.queries[0].model, `${app}.Budget`);
        assert.deepEqual(plan.queries[0].order, []);
        assert.equal(plan.queries[0].archived, 'exclude');
        assert.equal(plan.queries[0].dependencies[0].role, 'control');
        assert.equal(plan.queries[0].dependencies[0].field, 'source');
        assert.equal(artifact.callables.find(callable => callable.id === `${app}.probe`)?.kind, 'handler');
        assert.ok(artifact.modules.some(item => item.js.includes('await firstQuery(c,await executeScenarioReceiptQuery(c,')));

        for (const mode of privateRead ? ['private'] as const : ['approved', 'rejected', 'missing', 'race'] as const) {
          const now = Date.now(), clock = createFrozenClock(now);
          const identities = createMemoryIdentityStore({ clock });
          const team = await identities.createTeam({ timezone: 'UTC' });
          const owner = await identities.createUser({ email: `${mode}@first.test`, password_hash: 'unused', email_verified: true });
          await identities.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
          const token = `first-${mode}`;
          await identities.createSession({ user_id: owner.user_id, token_sha256: await sha256HexText(token),
            expires_at: new Date(now + 3600000).toISOString(), last_team_id: team.team_id });
          const identity = await resolveIdentity(identities, { session_token: token }, { clock });
          const scope = { app, owner: team.team_id, ownerPackage: app };
          const authority: FileRetirementAuthority = { app, stateOwner: app,
            stateStoreId: `first-${mode}-state`, fileStoreId: `first-${mode}-files`,
            receiver: { app, owner: team.team_id, team: team.team_id } };
          const options = { modules: true, compatibilityDate: '2026-07-15',
            script: 'export default { fetch() { return new Response("ok"); } }',
            d1Databases: { DB: `first-${mode}` }, d1Persist: join(directory, `db-${mode}`) };
          let worker = new Miniflare(options);
          let budgetQueries = 0, raceArmed = false, raced = false;
          const open = async () => {
            const db = await worker.getD1Database('DB') as unknown as import('@cloudflare/workers-types').D1Database;
            await ensureSchema(db);
            const backing = createD1Storage(db, authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
            const store = backing;
            const originalQuery = store.query.bind(store), originalCommit = store.commit.bind(store);
            store.query = async spec => { if (spec.model === `${app}.Budget`) budgetQueries++; return originalQuery(spec); };
            store.commit = async batch => {
                if (raceArmed && batch.writes.some(write => write.model === 'work.occurrence')) {
                  raceArmed = false; raced = true;
                  const row = await backing.load(asModel(`${app}.Budget`), asId('budget'));
                  assert.ok(row);
                  await originalCommit(makeBatch(await backing.readRevision(), { writes: [{ kind: 'update',
                    model: asModel(`${app}.Budget`), id: row.id, expectedVersion: row.version,
                    row: { ...row, version: asVersion(row.version + 1), updated: now, data: { ...row.data, approved: false } } }] }));
                }
                return originalCommit(batch);
              };
            await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
              verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
            return store;
          };
          try {
            let store = await open();
            const slotModel = asModel(`${app}.Slot`), budgetModel = asModel(`${app}.Budget`);
            await store.commit(makeBatch(await store.readRevision(), { writes: [
              { kind: 'insert', model: slotModel, row: { ...makeRow({ id: asId('slot'), data: { label: 'due' } }), parent: null } },
              { kind: 'insert', model: budgetModel, row: { ...makeRow({ id: asId('distractor'), data: { source: 'other', approved: false } }), parent: null } },
              ...(mode === 'missing' ? [] : [{ kind: 'insert' as const, model: budgetModel,
                row: { ...makeRow({ id: asId('budget'), data: { source: 'original', approved: mode !== 'rejected' } }), parent: null } }]),
            ] }));
            const arm = await invokeMutationCanonical({ artifact, asm, store, app, operation: `${app}.arm`,
              operationId: uuidv7(now), inputs: { slot: { id: 'slot', version: '1' }, at: new Date(now - 1).toISOString(), source: 'original' },
              identity, memberships: identities, source: 'worker', now: () => now });
            assert.equal(arm.status, 'committed', JSON.stringify(arm));
            const schedules = await store.query({ model: asModel('work.schedule'), authority: 'owner' });
            assert.equal(schedules.length, 1, 'arm stages its genuine original Work occurrence');
            const scheduled = readScheduleRow(schedules[0]!);
            assert.deepEqual(scheduled.payload, { source: 'original' });
            assert.ok(scheduled.filePayloadOrigin, 'the original typed event source is retained');
            const due = { key: scheduled.key, occurrenceId: scheduled.occurrenceId, event: scheduled.event, at: scheduled.at,
              scope: { app: scheduled.scopeApp, owner: scheduled.scopeOwner, ownerPackage: scheduled.scopeOwnerPackage } };
            const invoke = () => invokeDueScheduleCanonical({ artifact, asm, app, handler: `${app}.probe`, due, store, identities, now: () => now });
            budgetQueries = 0; raceArmed = mode === 'race';
            const result = await invoke();
            const succeeds = mode === 'approved' || mode === 'private';
            assert.equal(result.status, succeeds ? 'completed' : 'failed', `${mode}: ${JSON.stringify(result)}`);
            assert.ok(budgetQueries > 0, 'FIRST reads actual retained Budget rows');
            assert.equal(raced, mode === 'race');
            const terminal = await store.load(asModel('work.occurrence'), asId(due.occurrenceId));
            assert.ok(terminal);
            const receipt = readOccurrenceRow(terminal);
            assert.equal(receipt.status, succeeds ? 'completed' : 'failed');
            assert.equal(receipt.code, succeeds ? null : 'require-false');
            if (mode === 'private') {
              // The checked FIRST/Require grants only this owner decision,
              // including its exact issued rows; it confers no general DATA read.
              assert.equal(receipt.message, null);
              assert.equal(receipt.result, null, 'the private decision discloses no result');
              assert.equal((await store.load(budgetModel, asId('budget')))?.data['approved'], true,
                'the confined decision consumes the actual unchanged owner-only row');
            }
            if (mode === 'approved') {
              await worker.dispose(); worker = new Miniflare(options);
              artifact = JSON.parse(stdout) as CompileArtifact;
              asm = await assemble(`${app}-reopened`);
              store = await open();
            }
            budgetQueries = 0;
            const retainedRevision = await store.readRevision();
            const replay = await invoke();
            assert.equal(replay.status, 'replayed', JSON.stringify(replay));
            assert.equal(budgetQueries, 0, 'terminal Work replay does not rerun FIRST');
            assert.equal(await store.readRevision(), retainedRevision);
            assert.deepEqual(await store.load(asModel('work.occurrence'), asId(due.occurrenceId)), terminal);
            const forged = await invokeDueScheduleCanonical({ artifact, asm, app, handler: `${app}.probe`,
              due: { ...due, occurrenceId: 'not-the-original' }, store, identities, now: () => now });
            assert.equal(forged.status, 'refused');
            assert.equal(await store.readRevision(), retainedRevision);
          } finally { await worker.dispose(); }
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('runs a retained scoped cohort through actual D1 ticks, interrupted completion, races and cold navigation',
  { timeout: 180000 }, async () => {
    const { Miniflare } = await import('miniflare');
    const { createD1OwnerRouter } = await import('@canlang/state/storage/owner-router');
    const { createTeamOwnerStorageBoundary } = await import('../worker/assembly.js');
    const { createBoundCohortTick } = await import('./cohort-tick.js');
    const { checkedNativeValueTypes } = await import('./native-value-schema.js');
    const { importVerifiedAssemblyModule } = await import('./assembly-verification.js');
    const { invokeDueSourceRoutingCanonical, readFanoutSchedulerProgress } = await import('./invoke.js');
    const { FANOUT_INTENT_MODEL, FANOUT_CHILD_MODEL, FANOUT_CHECKPOINT_MODEL,
      readFanoutIntentRow, readFanoutChildRow, readFanoutCheckpointRow } = await import('@canlang/state/fanout/tables');
    const { FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL, fanoutNavigationRowId,
      fanoutOwnerScanRowId, readFanoutNavigationRow } = await import('@canlang/state/fanout/navigation');
    const directory = await mkdtemp(join(tmpdir(), 'can-retained-cohort-d1-'));
    const cohortSource = join(root, 'packages/cloudflare/test/fixtures/typed-private-cohort.can');
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, cohortSource],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const scope = { app: 'CohortJourney', owner: team.team_id, ownerPackage: 'CohortJourney' };
    const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
      stateStoreId: 'retained-cohort-state', fileStoreId: 'retained-cohort-files',
      receiver: { app: scope.app, owner: scope.owner, team: scope.owner } };
    const options = { modules: true as const, compatibilityDate: '2026-07-15',
      script: 'export default {fetch(){return new Response("retained cohort")}}',
      d1Databases: { DB: 'retained-cohort' }, d1Persist: join(directory, 'd1') };
    let runtime: InstanceType<typeof Miniflare> | undefined;
    let routeAvailable = true;
    const open = async (generation: number) => {
      runtime = new Miniflare(options);
      const db = await runtime.getD1Database('DB') as unknown as import('@cloudflare/workers-types').D1Database;
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: cohortSource }, { workDir: join(directory, `assembly-${generation}`),
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
      const router = createD1OwnerRouter({ resolveBinding: selected => routeAvailable && selected.app === scope.app && selected.owner === scope.owner
        ? { app: scope.app, owner: scope.owner, db, initializeFresh: true as const,
          fileRetirementAuthority: authority, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER] }
        : null });
      const ownerStorage = await createTeamOwnerStorageBoundary({ artifact, asm, app: scope.app, identities, router });
      const { store } = await ownerStorage.forTrustedScope(scope, now);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(scope.owner)); } });
      const tick = await createBoundCohortTick({ artifact, asm, identities, ownerStorage, scope, now: () => now });
      return { artifact, asm, ownerStorage, store, tick };
    };
    try {
      let host = await open(0);
      const parent = { ...makeRow({ id: asId('cohort-target'), data: { name: 'Selected container' } }), parent: null };
      const foreign = { ...makeRow({ id: asId('cohort-foreign'), data: { name: 'Other container' } }), parent: null };
      const entry = (id: string, container = parent.id) => ({ ...makeRow({ id: asId(id),
        data: { label: 'Before', applicable: true, consent: true, count: '0' } }),
        parent: { model: asModel('CohortJourney.Container'), id: container } });
      const members = ['member-a', 'member-b', 'member-c', 'member-d'].map(id => entry(id));
      const outsider = entry('foreign-entry', foreign.id);
      await host.store.commit(makeBatch(await host.store.readRevision(), { writes: [
        ...[parent, foreign].map(row => ({ kind: 'insert' as const, model: asModel('CohortJourney.Container'), row })),
        ...[...members, outsider].map(row => ({ kind: 'insert' as const, model: asModel('CohortJourney.Entry'), row })),
      ] }));
      const payload = { container: { id: parent.id }, marker: 'Retained scoped effect' };
      const stageScoped = async (occurrenceId: string) => {
        const due = { key: occurrenceId, occurrenceId, event: 'CohortJourney.Scoped', scope, at: now - 1 };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'CohortJourney.scoped',
          load: host.store.load.bind(host.store), query: host.store.query.bind(host.store) };
        const loaded = await loadCanonicalDescriptors(host.asm, host.artifact);
        const originalModule = await importVerifiedAssemblyModule(host.asm, host.artifact.modules[0]!.path, host.artifact);
        const originalDefinition = Object.getOwnPropertyDescriptor(originalModule, 'appDefinition')?.value;
        const valueTypes = checkedNativeValueTypes(host.artifact, originalDefinition, loaded.valueTypes);
        const opaque = await loadOpaqueFileStaging({ artifact: host.artifact, store: host.store,
          inventoryOwner: scope.ownerPackage, canonicalModels: loaded.models, valueTypes,
          operations: new Map(), scope, verify: async () => { await host.ownerStorage.forTrustedScope(scope, now); } });
        assert.ok(opaque);
        const declaration = opaque.event(due.event);
        const initial = await workSchedulePutCommand.stage({ ...due, payload }, stageContext);
        const schedule = initial.writes?.find(write => write.kind === 'insert' && write.model === 'work.schedule');
        assert.ok(schedule && schedule.kind === 'insert');
        const identity = await resolveIdentity(identities, { team_id: team.team_id }, { clock });
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: await host.store.readRevision(),
          model: asModel('work.schedule'), row: schedule.row, field: 'payload', scope,
          origin: { kind: 'event-input', occurrenceId: due.occurrenceId, sourceOccurrence: due.occurrenceId,
            declaration, lineage: { kind: 'schedule', key: due.key, replaces: null }, target: { kind: 'schedule' } },
          projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId }, value: payload, identity });
        const staged = await workSchedulePutCommand.stage({ ...due, payload, filePayloadOrigin }, stageContext);
        await host.store.commit(makeBatch(await host.store.readRevision(), { writes: staged.writes ?? [], schedules: staged.schedules ?? [] }));
        const routed = await invokeDueSourceRoutingCanonical({ artifact: host.artifact, asm: host.asm, app: scope.app,
          handler: 'CohortJourney.scoped', due: { ...due, filePayloadOrigin }, store: host.store, identities, now: () => now,
          cohortBounds: { pageLimit: 2, chunkSize: 2 } });
        assert.equal(routed.status, 'completed');
      };
      await stageScoped('scoped-cohort-source');
      const intents = await host.store.query({ model: asModel(FANOUT_INTENT_MODEL), authority: 'owner' });
      assert.equal(intents.length, 1);
      const intentRow = intents[0]!, intent = readFanoutIntentRow(intentRow);
      assert.deepEqual(intent.members, members.map(row => row.id).sort());
      assert.equal(intent.handler, 'CohortJourney.scoped');
      const checkpointBefore = await host.store.load(asModel(FANOUT_CHECKPOINT_MODEL), intentRow.id);
      assert.ok(checkpointBefore);
      assert.notEqual(readFanoutCheckpointRow(checkpointBefore).cursor, null, 'the original source admits only its first real chunk');
      const late = entry('late-member');
      await host.store.commit(makeBatch(await host.store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('CohortJourney.Entry'), row: late },
      ] }));
      const physicalCommit = host.store.commit;
      let acknowledgementLost = false;
      host.store.commit = async batch => {
        const terminal = batch.writes.some(write => write.kind !== 'remove' && write.model === FANOUT_CHILD_MODEL && write.row.data['state'] === 'completed');
        const authored = batch.writes.some(write => write.kind !== 'remove' && write.model === 'CohortJourney.Entry');
        const committed = await physicalCommit.call(host.store, batch);
        if (!acknowledgementLost && terminal && authored) {
          acknowledgementLost = true;
          assert.ok(batch.writes.some(write => write.model === FANOUT_NAVIGATION_MODEL), 'navigation joins the actual terminal business batch');
          assert.ok(batch.writes.some(write => write.model === FANOUT_CHECKPOINT_MODEL), 'coverage joins the actual terminal business batch');
          throw new Error('fixture lost retained child acknowledgement');
        }
        return committed;
      };
      let interrupted: unknown;
      try { await host.tick.tick(); } catch (error) { interrupted = error; }
      assert.equal(acknowledgementLost, true, `the real child must cross its native commit before interruption: ${String(interrupted)}`);
      const committedChildren = (await host.store.query({ model: asModel(FANOUT_CHILD_MODEL), authority: 'owner' }))
        .map(row => readFanoutChildRow(row)).filter(child => child.state === 'completed');
      assert.equal(committedChildren.length, 1);
      const deletedId = intent.members.find(id => id !== committedChildren[0]!.recordId)!;
      const deleted = await host.store.load(asModel('CohortJourney.Entry'), asId(deletedId));
      assert.ok(deleted);
      await host.store.commit(makeBatch(await host.store.readRevision(), { writes: [{ kind: 'update',
        model: asModel('CohortJourney.Entry'), id: deleted.id, expectedVersion: deleted.version,
        row: { ...deleted, version: asVersion(deleted.version + 1), updated: now, archivedAt: now } }] }));
      await runtime!.dispose(); runtime = undefined;
      host = await open(1);
      assert.deepEqual(readFanoutIntentRow((await host.store.load(asModel(FANOUT_INTENT_MODEL), intentRow.id))!), intent);
      const competing = await Promise.allSettled([host.tick.tick(), host.tick.tick()]);
      assert.ok(competing.some(result => result.status === 'fulfilled'));
      for (const result of competing) if (result.status === 'rejected') {
        assert.match(String(result.reason), /conflict|fence|revision|claim/i, 'a rival tick may lose only its actual fence/claim');
      }
      let progress = await readFanoutSchedulerProgress({ store: host.store, fanoutId: intent.fanoutId, pageLimit: 2 });
      for (let turn = 0; turn < 12 && !progress.terminal; turn++) {
        await host.tick.tick();
        progress = await readFanoutSchedulerProgress({ store: host.store, fanoutId: intent.fanoutId, pageLimit: 2 });
      }
      assert.deepEqual(progress, { fanoutId: intent.fanoutId, pending: 0, running: 0, completed: 3, skipped: 1, failed: 0, terminal: true, attention: false });
      const children = (await host.store.query({ model: asModel(FANOUT_CHILD_MODEL), authority: 'owner' })).map(row => readFanoutChildRow(row));
      assert.equal(children.length, 4);
      assert.equal(new Set(children.map(child => child.childId)).size, 4);
      assert.deepEqual(children.map(child => child.recordId).sort(), intent.members);
      assert.equal(children.find(child => child.recordId === deletedId)?.causeReason, 'deleted');
      for (const member of members) {
        const row = await host.store.load(asModel('CohortJourney.Entry'), member.id);
        assert.ok(row);
        assert.equal(row.data['count'], member.id === deletedId ? '0' : '1');
        assert.equal(row.data['label'], member.id === deletedId ? 'Before' : payload.marker);
      }
      for (const id of [outsider.id, late.id]) assert.equal((await host.store.load(asModel('CohortJourney.Entry'), id))?.data['count'], '0');
      const checkpoint = await host.store.load(asModel(FANOUT_CHECKPOINT_MODEL), intentRow.id);
      assert.ok(checkpoint);
      assert.deepEqual(readFanoutCheckpointRow(checkpoint).completed, intent.members);
      assert.equal(readFanoutCheckpointRow(checkpoint).cursor, null);
      let wrapped = false;
      for (let turn = 0; turn < 8 && !wrapped; turn++) {
        const outputs = await host.tick.tick();
        assert.ok(Array.isArray(outputs));
        wrapped = outputs.some(output => typeof output === 'object' && output !== null &&
          'status' in output && output.status === 'turn' && 'wrapped' in output && output.wrapped === true);
      }
      assert.equal(wrapped, true, 'an actual empty retained page wraps navigation');
      const navigation = await host.store.load(asModel(FANOUT_NAVIGATION_MODEL), asId(fanoutNavigationRowId(scope.owner, intent.fanoutId)));
      assert.ok(navigation);
      assert.equal(readFanoutNavigationRow(navigation, { owner: scope.owner, intentRow }).lastVisitedChildId, null);
      assert.ok(await host.store.load(asModel(FANOUT_OWNER_SCAN_MODEL), asId(fanoutOwnerScanRowId(scope.owner))));
      const beforeTerminalReplay = await host.store.query({ model: asModel('CohortJourney.Entry'), authority: 'owner', archived: 'include' });
      await host.tick.tick();
      assert.deepEqual(await host.store.query({ model: asModel('CohortJourney.Entry'), authority: 'owner', archived: 'include' }), beforeTerminalReplay);
      assert.deepEqual(await readFanoutSchedulerProgress({ store: host.store, fanoutId: intent.fanoutId, pageLimit: 2 }), progress);
      await stageScoped('revoked-scoped-source');
      const newIntentRows = await host.store.query({ model: asModel(FANOUT_INTENT_MODEL), authority: 'owner' });
      const revokedIntentRow = newIntentRows.find(row => readFanoutIntentRow(row).sourceOccurrence === 'revoked-scoped-source');
      assert.ok(revokedIntentRow);
      const beforeRevocation = {
        entries: await host.store.query({ model: asModel('CohortJourney.Entry'), authority: 'owner', archived: 'include' }),
        checkpoint: await host.store.load(asModel(FANOUT_CHECKPOINT_MODEL), revokedIntentRow.id),
        navigation: await host.store.load(asModel(FANOUT_NAVIGATION_MODEL),
          asId(fanoutNavigationRowId(scope.owner, readFanoutIntentRow(revokedIntentRow).fanoutId))),
      };
      const routedCommit = host.store.commit;
      let revokedAfterClaim = false;
      host.store.commit = async batch => {
        const claim = batch.writes.some(write => write.kind !== 'remove' && write.model === FANOUT_CHILD_MODEL &&
          write.row.data['parentOccurrence'] === 'revoked-scoped-source' && write.row.data['state'] === 'running');
        const committed = await routedCommit.call(host.store, batch);
        if (claim) { revokedAfterClaim = true; routeAvailable = false; }
        return committed;
      };
      let revokedOutcome: unknown;
      for (let turn = 0; turn < 4 && !revokedAfterClaim; turn++) {
        try { revokedOutcome = await host.tick.tick(); } catch (error) { revokedOutcome = error; }
      }
      assert.equal(revokedAfterClaim, true, `the real D1 child claim must precede route revocation: ${String(revokedOutcome)}`);
      assert.deepEqual(await host.store.query({ model: asModel('CohortJourney.Entry'), authority: 'owner', archived: 'include' }),
        beforeRevocation.entries, 'revoking the physical route after claim prevents domain effects');
      const afterRevokedCheckpoint = await host.store.load(asModel(FANOUT_CHECKPOINT_MODEL), revokedIntentRow.id);
      assert.ok(beforeRevocation.checkpoint && afterRevokedCheckpoint);
      assert.deepEqual(readFanoutCheckpointRow(afterRevokedCheckpoint).completed,
        readFanoutCheckpointRow(beforeRevocation.checkpoint).completed, 'revoked authority cannot complete checkpoint coverage');
      assert.deepEqual(await host.store.load(asModel(FANOUT_NAVIGATION_MODEL),
        asId(fanoutNavigationRowId(scope.owner, readFanoutIntentRow(revokedIntentRow).fanoutId))),
      beforeRevocation.navigation, 'revoked authority cannot advance terminal navigation');
      const retainedClaims = (await host.store.query({ model: asModel(FANOUT_CHILD_MODEL), authority: 'owner' })).map(row => readFanoutChildRow(row))
        .filter(child => child.parentOccurrence === 'revoked-scoped-source');
      assert.equal(retainedClaims.filter(child => child.state === 'running').length, 1,
        'the actual claim committed before revocation remains durable for recovery');
      assert.equal(retainedClaims.some(child => ['completed', 'skipped', 'failed'].includes(child.state)), false);
    } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
