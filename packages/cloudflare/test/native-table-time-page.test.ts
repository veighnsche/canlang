/** Genuine unchanged TableTime page over current State/Identity/D1 producers.
 * This qualifies unpaged admitted-time rendering and original protected partial forms, not cursor semantics. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { StoredRow, CanValue, CompileArtifact, ListQueryArgs, ListQueryResult, OperationName, PageSourceContext } from '@canlang/contracts';
import { collectionCursorName, collectionFilterName } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { decodeValue, encodeValue } from '@canlang/values';
import { buildSessionCookie, deriveCsrfToken, createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { ensureSchema, createD1Storage } from '@canlang/state/storage/d1';
import { FIXED_NOW, asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { handlePageRequest, handleOperationRequest, INPUT_CHOICES_VERSION, buildPageSourceContext, buildPresentationContext, createSourceFormBindings } from '@canlang/interfaces';
import type { PageHttpDeps } from '@canlang/interfaces';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { invokeMutationCanonical, loadCanonicalDescriptors, queryPageRowsCanonical } from '@canlang/cloudflare/runtime/invoke';
import { assembleWorker, type HttpDeps as AssemblyHttpDeps } from '@canlang/cloudflare/worker/assembly';
import { buildDerivedInputsModule } from '../dist/deploy/bundle.js';
import { createD1PagePreferenceStore, ensurePagePreferencesSchema } from '../dist/runtime/page-preferences.js';
import { createPageCursorCodec } from '../dist/runtime/page-cursor.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ORIGINAL_SOURCE_SHA = 'ca5d0432bda064324b0e8af133a2a4ab04ea8d9d6b39bbe3adebb96ff2d3fee4';
const app = 'TableTime', calendarModel = asModel(`${app}.Calendar`), windowModel = asModel(`${app}.Window`);
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(tables.success, true);
  const result: Record<string, readonly Record<string, unknown>[]> = {};
  for (const { name } of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return result;
}

test('unchanged native TableTime page uses admitted time and protected partial boolean forms',
  { timeout: 120000 }, async () => {
    const fixture = join(root, 'compiler/tests/fixtures/table-time.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [fixture, compiler, catalog];
    const hashes = () => Promise.all(paths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
    const captured = await hashes(); assert.equal(captured[0], ORIGINAL_SOURCE_SHA);
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'can-native-table-time-')));
    let worker: Miniflare | undefined;
    try {
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--catalog', catalog, fixture],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(artifact.artifact_version, 1);
      assert.ok(artifact.sources.some(source => resolve(source.path) === fixture && source.sha256 === captured[0]));
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(dir, 'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      assert.deepEqual(loaded.models.map(model => model.name).sort(), [`${app}.Calendar`, `${app}.Window`]);
      const entry = Object.entries(asm.moduleUrls).find(([, url]) => url === asm.entryUrl)?.[0]; assert.ok(entry);
      const namespace = object(await importVerifiedAssemblyModule(asm, entry, artifact));
      const definition = object(namespace.appDefinition); assert.equal(definition.id, app);
      const pages = definition.pages; assert.ok(Array.isArray(pages)); assert.equal(pages.length, 1);
      assert.equal(object(pages[0]).path, '/table-time');
      assert.deepEqual(object(pages[0]).preferenceFields,
        [{ name: 'window_state', options: ['open', 'closed'], defaultValue: null, nullable: true }]);
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { IDENTITY: 'table-page-identity', STATE: 'table-page-state' }, d1Persist: join(dir, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const db = await worker.getD1Database('STATE') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(db); await ensurePagePreferencesSchema(identityDb);
      const clock = { nowMs: () => FIXED_NOW };
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'table-page@example.test', password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
      const token = 'native-table-page-session';
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(FIXED_NOW + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      assert.equal(identity.actor?.user_id, user.user_id); assert.equal(identity.team?.team_id, team.team_id);
      const physical = createD1Storage(db), preferences = createD1PagePreferenceStore(identityDb);
      let sequence = 210;
      const nextId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
      const options = { artifact, asm, app, identity, source: 'worker', store: physical,
        memberships: identities, now: clock.nowMs };
      const calendarId = nextId();
      const created = await invokeMutationCanonical({ ...options, operation: `${app}.Calendar.create`,
        operationId: calendarId, inputs: { title: 'Actual time calendar' } });
      assert.equal(created.status, 'committed');
      const calendars = await physical.query({ model: calendarModel, authority: 'owner' });
      assert.equal(calendars.length, 1); const calendar = calendars[0]!;
      const instant = Date.parse(identity.admitted_at), windows: string[] = [];
      for (const [delta, state] of [[-60000, 'closed'], [0, 'open'], [60000, 'open']] as const) {
        const result = await invokeMutationCanonical({ ...options, operation: `${app}.Window.create`, operationId: nextId(),
          inputs: { parent: { id: calendar.id, version: String(calendar.version) },
            from: new Date(instant + delta).toISOString(), until: new Date(instant + delta + 3600000).toISOString(),
            state, available: true, rank: '7' } });
        assert.equal(result.status, 'committed');
        const rows = await physical.query({ model: windowModel, authority: 'owner' });
        const added = rows.filter(row => !windows.includes(row.id)); assert.equal(added.length, 1); windows.push(added[0]!.id);
      }
      const derivedModule = object(await import(`data:text/javascript,${encodeURIComponent(buildDerivedInputsModule(artifact))}`));
      const derivedInputs = derivedModule.derivedInputs as NonNullable<Parameters<typeof assembleWorker>[2]['http']>['derivedInputs'];
      assert.ok(derivedInputs);
      const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(53), 'native-table-page');
      type Query = { sequence: number; model: string; args: ListQueryArgs; result: ListQueryResult };
      let queries: Query[] = [], querySequence = 0, pageDeps: PageHttpDeps | undefined;
      const served = await assembleWorker(artifact, asm, { store: physical, identityStore: identities, now: clock.nowMs,
        pageReads: { scope: { app, owner: team.team_id, ownerPackage: app }, sourceIdentity: captured[0]! },
        http: { formBindings, preferences, derivedInputs, createOperationHandler: Object.assign(
          (deps: AssemblyHttpDeps) => (request: Request, operation: string) =>
            handleOperationRequest(deps as unknown as Parameters<typeof handleOperationRequest>[0], request, operation),
          { inputChoicesVersion: INPUT_CHOICES_VERSION }), createPageHandler: deps => {
          pageDeps = deps as unknown as PageHttpDeps;
          const original = pageDeps.createReadScope; assert.ok(original);
          const observed: PageHttpDeps = { ...pageDeps, createReadScope: async admitted => {
            assert.equal(admitted.admitted_at, identity.admitted_at);
            const scope = await original(admitted);
            return { ...scope, query: async (invocation, model, args) => {
              const sequence = querySequence++;
              const result = await scope.query(invocation, model, args);
              queries.push({ sequence, model, args, result }); return result;
            } };
          } };
          return request => handlePageRequest(observed, request);
        } } }, { active: true });
      const cookie = buildSessionCookie(token, { secure: false, maxAgeSeconds: 3600 }).split(';')[0]!;
      const resources = async () => ({ state: await snapshot(db), identity: await snapshot(identityDb) });
      const render = async (params = new URLSearchParams(), authenticated = true) => {
        queries = []; querySequence = 0;
        const response = await served.fetch(new Request(`https://table-page.example.test/table-time?${params}`, {
          headers: { 'hx-request': 'true', ...(authenticated ? { cookie } : {}) } }));
        return { response, html: await response.text(), queries: [...queries].sort((left, right) => left.sequence - right.sequence) };
      };
      const timeQuery = (value: Awaited<ReturnType<typeof render>>, operator: 'gte' | 'lt') => {
        const selected = value.queries.filter(query => query.model === windowModel);
        assert.equal(selected.length, 2);
        const query = selected.find(query => {
          const where = object(query.args.where); return (where.op === 'and' ? object((where.args as unknown[])[0]) : where).op === operator;
        }); assert.ok(query);
        const where = object(query.args.where), time = where.op === 'and' ? object((where.args as unknown[])[0]) : where;
        assert.deepEqual(time, { op: operator, field: 'from', value: identity.admitted_at });
        assert.equal(query.args.parent, undefined); assert.equal(query.args.page, undefined);
        assert.deepEqual(query.args.order, operator === 'gte' ? ['from'] : ['-from']);
        return query;
      };
      const expectRows = (value: Awaited<ReturnType<typeof render>>, upcoming: readonly string[], past: readonly string[]) => {
        assert.deepEqual(timeQuery(value, 'gte').result.rows.map(row => row.id), upcoming);
        assert.deepEqual(timeQuery(value, 'lt').result.rows.map(row => row.id), past);
      };
      const baseline = await resources(), initial = await render(new URLSearchParams([['now', '2099-01-01T00:00:00.000Z']])); assert.equal(initial.response.status, 200, initial.html);
      expectRows(initial, windows.slice(1), [windows[0]!]);
      assert.equal(timeQuery(initial, 'gte').result.rows[0]!.fields.from, identity.admitted_at);
      const occurrences = ['gte', 'lt'].map(op => timeQuery(initial, op as 'gte' | 'lt').args.occurrence!);
      assert.notEqual(occurrences[0], occurrences[1]);
      const filterNames = occurrences.map(value => collectionFilterName(value, 'state'));
      assert.ok(filterNames.every(name => initial.html.includes(name)));
      assert.equal(await preferences.read({ appId: app, actorUserId: user.user_id, teamId: team.team_id, owner: app, field: 'window_state' }), null);
      assert.deepEqual(await resources(), baseline);
      assert.equal(await preferences.save({ appId: app, actorUserId: user.user_id, teamId: team.team_id,
        owner: app, field: 'window_state', value: 'open', expectedVersion: '0' }), true);
      const savedBaseline = await resources(), saved = await render(); assert.equal(saved.response.status, 200, saved.html);
      expectRows(saved, windows.slice(1), []);
      const overridden = await render(new URLSearchParams([[filterNames[0]!, 'closed'], [filterNames[1]!, '']]));
      assert.equal(overridden.response.status, 200, overridden.html); expectRows(overridden, [], [windows[0]!]);
      for (const params of [new URLSearchParams([[filterNames[0]!, 'foreign']]),
        new URLSearchParams([[filterNames[0]!, 'open'], [filterNames[0]!, 'closed']])]) {
        const refused = await render(params); assert.equal(refused.response.status, 400, refused.html);
      }
      assert.deepEqual(await resources(), savedBaseline);
      assert.ok(pageDeps);
      const source = buildPageSourceContext(identity);
      const context = buildPresentationContext({ request: new Request('https://table-page.example.test/table-time?now=2099-01-01'),
        pathname: '/table-time', isPartial: true, appDefaultLocale: 'en', csrfToken: '', principal: identity,
        source: { ...source, now: decodeValue('datetime', '2099-01-01T00:00:00.000Z') } as PageSourceContext,
        query: (await pageDeps.createReadScope!(identity)).query, clock: { nowMs: () => FIXED_NOW + 999999 } });
      assert.equal(encodeValue('datetime', context.now!), identity.admitted_at);
      assert.equal(encodeValue('datetime', source.now), identity.admitted_at);
      const unauthenticated = await render(new URLSearchParams(), false); assert.equal(unauthenticated.response.status, 403);
      assert.deepEqual(await resources(), savedBaseline);
      // Submit only actual rendered inputs/seals; unchecked checkbox retains its emitted presence marker.
      const decode = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, decode(match[2]!)]));
      const select = new URLSearchParams([[`can-row:${occurrences[0]}`, windows[1]!]]);
      const forms = async () => {
        const selected = await render(select); assert.equal(selected.response.status, 200, selected.html);
        const found = [...selected.html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0])
          .filter(form => attrs(form.split('>')[0]!).method === 'post'); assert.equal(found.length, 2);
        return found.map(form => {
          const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map(match => attrs(match[0]));
          const params = new URLSearchParams(inputs.filter(input => input.name && input.type !== 'checkbox' && input.type !== 'submit')
            .map(input => [input.name!, input.value ?? ''] as [string, string]));
          const seal = params.get('form_binding'); assert.ok(seal);
          const claims = object(JSON.parse(Buffer.from(seal.split('.')[0]!, 'base64url').toString('utf8')));
          return { action: attrs(form.split('>')[0]!).action!, params, inputs, claims };
        });
      };
      const submit = async (form: Awaited<ReturnType<typeof forms>>[number]) => served.fetch(new Request(
        new URL(form.action, 'https://table-page.example.test'), { method: 'POST', headers: { cookie,
          'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-csrf-token': await deriveCsrfToken(token) }, body: form.params }));
      const receiptFor = (form: Awaited<ReturnType<typeof forms>>[number]) => physical.readReceipt({ app,
        owner: team.team_id, principal: user.user_id, operation: `${app}.Window.update` as OperationName, operationId: asOperationId(form.params.get('operation_id')!) });
      const currentRow = () => physical.load(windowModel, asId(windows[1]!));
      const originalRow = await currentRow(); assert.ok(originalRow);
      const originalHistory = await physical.historyFor(windowModel, originalRow.id);
      let rendered = await forms();
      const unchecked = rendered.find(form => form.inputs.some(input => input.type === 'checkbox')); assert.ok(unchecked);
      assert.deepEqual(unchecked.claims.bound, { record: { id: originalRow.id, version: String(originalRow.version) } });
      const marker = unchecked.inputs.find(input => input.name?.startsWith('can_boolean_present:')); assert.ok(marker);
      const checkbox = unchecked.inputs.find(input => input.type === 'checkbox')!;
      assert.equal(unchecked.params.get(marker.name!), 'true'); assert.equal(unchecked.params.has(checkbox.name!), false);
      const beforeFalse = await resources(), falseRevision = await physical.readRevision();
      const falseResponse = await submit(unchecked); assert.equal(falseResponse.status, 200, await falseResponse.clone().text());
      const falseBody = object(await falseResponse.json());
      const falseRow = await currentRow(); assert.ok(falseRow); assert.equal(falseRow.data.available, false);
      assert.equal(falseRow.version, originalRow.version + 1); assert.equal((await receiptFor(unchecked))?.outcome.status, 'committed');
      const afterFalse = await resources();
      assert.equal(await physical.readRevision(), falseRevision + 1);
      const assertMutationResources = (before: Awaited<ReturnType<typeof resources>>, after: Awaited<ReturnType<typeof resources>>, form: Awaited<ReturnType<typeof forms>>[number], prior: StoredRow, current: StoredRow, field: 'available' | 'rank', value: boolean | string) => {
        assert.deepEqual(after.identity, before.identity);
        for (const name of Object.keys(before.state)) if (!['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name))
          assert.deepEqual(after.state[name], before.state[name], `no unrelated ${name} effects`);
        assert.equal(after.state.receipts!.length, before.state.receipts!.length + 1);
        assert.equal(after.state.history!.length, before.state.history!.length + 1);
        assert.equal(after.state.records!.length, before.state.records!.length);
        assert.deepEqual(after.state.records!.filter(row => row.id !== originalRow.id || row.model !== windowModel),
          before.state.records!.filter(row => row.id !== originalRow.id || row.model !== windowModel));
        assert.ok(before.state.history!.every(row => after.state.history!.some(saved => JSON.stringify(saved) === JSON.stringify(row))));
        assert.ok(before.state.receipts!.every(row => after.state.receipts!.some(saved => JSON.stringify(saved) === JSON.stringify(row))));
        assert.deepEqual(current.data, { ...prior.data, [field]: value });
        assert.deepEqual(current.parent, prior.parent); assert.equal(current.created, prior.created); assert.equal(current.createdBy, prior.createdBy);
        const addedHistory = after.state.history!.filter(row => !before.state.history!.some(saved => JSON.stringify(saved) === JSON.stringify(row)));
        assert.equal(addedHistory.length, 1); const history = addedHistory[0]!;
        assert.equal(history.model, windowModel); assert.equal(history.record_id, current.id); assert.equal(history.version, current.version);
        assert.equal(history.operation, `${app}.Window.update`); assert.equal(history.operation_id, form.params.get('operation_id'));
        assert.equal(history.actor, user.user_id); assert.equal(history.at, FIXED_NOW); assert.equal(history.change, 'update');
        assert.deepEqual(JSON.parse(String(history.before)), prior.data); assert.deepEqual(JSON.parse(String(history.after)), current.data);
        assert.deepEqual(JSON.parse(String(history.audit_projection)), { created: originalRow.created, createdBy: originalRow.createdBy, secretFields: loaded.secretFields.get(windowModel) });
        const priorFence = before.state.fence![0]!, nextFence = after.state.fence![0]!;
        assert.deepEqual(nextFence, { ...priorFence, revision: Number(priorFence.revision) + 1 });
        assert.ok(before.state.fence_log!.every(row => after.state.fence_log!.some(saved => JSON.stringify(saved) === JSON.stringify(row))));
        const addedFence = after.state.fence_log!.filter(row => !before.state.fence_log!.some(saved => JSON.stringify(saved) === JSON.stringify(row)));
        assert.deepEqual(addedFence, [{ revision: nextFence.revision, at: FIXED_NOW, operation: `${app}.Window.update` }]);
        assert.deepEqual(after.state.sqlite_sequence, before.state.sqlite_sequence!.map(row =>
          row.name === 'history' ? { ...row, seq: Number(row.seq) + 1 } : row));
      };
      assertMutationResources(beforeFalse, afterFalse, unchecked, originalRow, falseRow, 'available', false);
      const stale = rendered.find(form => !form.inputs.some(input => input.type === 'checkbox')); assert.ok(stale);
      const staleRevision = await physical.readRevision();
      const staleResponse = await submit(stale); assert.ok(staleResponse.status >= 400 && staleResponse.status < 500);
      const staleReceipt = await receiptFor(stale), afterStale = await resources();
      assert.deepEqual(afterStale.identity, afterFalse.identity);
      if (staleReceipt === null) {
        assert.deepEqual(afterStale, afterFalse); assert.equal(await physical.readRevision(), staleRevision);
      } else {
        assert.equal(staleReceipt.outcome.status, 'rejected');
        assert.ok(staleReceipt.outcome.status === 'rejected'); assert.equal(staleReceipt.outcome.code, 'conflict');
        assert.equal(await physical.readRevision(), staleRevision + 1);
        for (const name of Object.keys(afterFalse.state)) if (!['receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name))
          assert.deepEqual(afterStale.state[name], afterFalse.state[name], `stale refusal preserves ${name}`);
        assert.equal(afterStale.state.receipts!.length, afterFalse.state.receipts!.length + 1);
        assert.ok(afterFalse.state.receipts!.every(row => afterStale.state.receipts!.some(saved => JSON.stringify(saved) === JSON.stringify(row))));
        assert.ok(afterFalse.state.fence_log!.every(row => afterStale.state.fence_log!.some(saved => JSON.stringify(saved) === JSON.stringify(row))));
        assert.deepEqual(afterStale.state.fence![0], { ...afterFalse.state.fence![0], revision: staleRevision + 1 });
        assert.deepEqual(afterStale.state.fence_log!.filter(row => !afterFalse.state.fence_log!.some(saved => JSON.stringify(saved) === JSON.stringify(row))),
          [{ revision: staleRevision + 1, at: FIXED_NOW, operation: `${app}.Window.update` }]);
        assert.deepEqual(afterStale.state.sqlite_sequence, afterFalse.state.sqlite_sequence);
      }
      assert.deepEqual(await currentRow(), falseRow); assert.equal((await physical.historyFor(windowModel, originalRow.id)).length, originalHistory.length + 1);
      rendered = await forms();
      const checked = rendered.find(form => form.inputs.some(input => input.type === 'checkbox')); assert.ok(checked);
      checked.params.set(checked.inputs.find(input => input.type === 'checkbox')!.name!, 'true');
      const beforeTrue = await resources(), trueRevision = await physical.readRevision();
      const trueResponse = await submit(checked); assert.equal(trueResponse.status, 200, await trueResponse.clone().text());
      const trueBody = object(await trueResponse.json());
      const trueRow = await currentRow(); assert.ok(trueRow); assert.equal(trueRow.data.available, true);
      assert.equal(trueRow.version, falseRow.version + 1); assert.equal((await receiptFor(checked))?.outcome.status, 'committed');
      assertMutationResources(beforeTrue, await resources(), checked, falseRow, trueRow, 'available', true); assert.equal(await physical.readRevision(), trueRevision + 1);
      rendered = await forms();
      const rank = rendered.find(form => !form.inputs.some(input => input.type === 'checkbox')); assert.ok(rank);
      assert.ok(![...rank.params.keys()].some(name => name.includes('available')));
      const rankInput = rank.inputs.find(input => input.name?.includes('rank')); assert.ok(rankInput); rank.params.set(rankInput.name!, '11');
      const beforeRank = await resources(), rankRevision = await physical.readRevision();
      const rankResponse = await submit(rank); assert.equal(rankResponse.status, 200, await rankResponse.clone().text());
      const rankBody = object(await rankResponse.json());
      const ranked = await currentRow(); assert.ok(ranked); assert.equal(ranked.data.rank, '11'); assert.equal(ranked.data.available, true);
      assert.equal(ranked.version, trueRow.version + 1); assert.equal((await receiptFor(rank))?.outcome.status, 'committed');
      assert.equal((await physical.historyFor(windowModel, originalRow.id)).length, originalHistory.length + 3);
      assertMutationResources(beforeRank, await resources(), rank, trueRow, ranked, 'rank', '11'); assert.equal(await physical.readRevision(), rankRevision + 1);
      const replayBaseline = await resources(), replayRevision = await physical.readRevision();
      for (const [form, original] of [[unchecked, falseBody], [checked, trueBody], [rank, rankBody]] as const) {
        const originalReceipt = await receiptFor(form); assert.ok(originalReceipt);
        const response = await submit(form); assert.equal(response.status, 200, await response.clone().text());
        const replay = object(await response.json()); assert.equal(replay.status, 'replayed');
        assert.deepEqual(replay.records, original.records);
        assert.deepEqual(await receiptFor(form), originalReceipt); assert.deepEqual(await currentRow(), ranked);
        assert.deepEqual(await resources(), replayBaseline); assert.equal(await physical.readRevision(), replayRevision);
      }
      for (const params of [new URLSearchParams(),
        new URLSearchParams([[`can-row:${occurrences[0]}`, uuidv7(FIXED_NOW, 998)]]),
        new URLSearchParams([[`can-row:${occurrences[0]}`, windows[0]!]]),
        new URLSearchParams([[`can-row:foreign-occurrence`, windows[1]!]])]) {
        const unselected = await render(params); assert.equal(unselected.response.status, 200, unselected.html);
        const postForms = [...unselected.html.matchAll(/<form\b[^>]*>/g)].filter(match => attrs(match[0]).method === 'post');
        assert.equal(postForms.length, 0, 'missing/off-query/foreign selection discloses no edit forms');
        assert.deepEqual(await resources(), replayBaseline); assert.equal(await physical.readRevision(), replayRevision);
      }
      const revokedForm = (await forms())[0]!;
      await identities.removeMembership(membership.membership_id);
      const revoked = await resources();
      const refusedSubmit = await submit(revokedForm); assert.ok(refusedSubmit.status >= 400 && refusedSubmit.status < 500);
      assert.deepEqual(await resources(), revoked);
      const denied = await render(); assert.equal(denied.response.status, 403, denied.html);
      assert.deepEqual(await resources(), revoked, 'current preference admission refuses revoked membership without effects');
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.deepEqual(await hashes(), captured);
      await importVerifiedAssemblyModule(asm, entry, artifact);
    } finally { await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

test('genuine paginated TableTime first pages and native continuations retain original query time',
  { timeout: 180000 }, async () => {
    // Both production GET links and direct continuations consume genuine
    // source-produced collection occurrences, args and authenticated cursors.
    const fixture = join(root, 'compiler/tests/fixtures/table-time.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [fixture, compiler, catalog];
    const hashes = () => Promise.all(paths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
    const captured = await hashes(); assert.equal(captured[0], ORIGINAL_SOURCE_SHA);
    const originalSource = await readFile(fixture, 'utf8');
    const paginatedSource = originalSource.replaceAll('display=split\n', 'display=split\n   pagination\n');
    assert.equal(paginatedSource.split('   pagination\n').length - 1, 2);
    const guardBoundary = FIXED_NOW + 17 * 60000;
    const guardedSource = paginatedSource.replace('Given\n',
      'Given\n message request_now(at:datetime)="Admitted now: {at}"@{}\n').replace('  ## Like original Upcoming/Past',
      `  require now<datetime("${new Date(guardBoundary).toISOString()}")\n  text request_now(at=now)\n  ## Like original Upcoming/Past`);
    assert.notEqual(guardedSource, paginatedSource);
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'can-native-paged-table-time-')));
    let worker: Miniflare | undefined;
    try {
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const compile = async (source: string, name: string) => {
        const path = join(dir, `${name}.can`); await writeFile(path, source);
        const sha = createHash('sha256').update(source).digest('hex');
        const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--catalog', catalog, path],
          { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        const artifact = JSON.parse(stdout) as CompileArtifact;
        assert.equal(artifact.artifact_version, 1);
        assert.ok(artifact.sources.some(entry => resolve(entry.path) === path && entry.sha256 === sha));
        const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, name),
          stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
        const entry = Object.entries(asm.moduleUrls).find(([, url]) => url === asm.entryUrl)?.[0]; assert.ok(entry);
        const definition = object(object(await importVerifiedAssemblyModule(asm, entry, artifact)).appDefinition);
        assert.equal(definition.id, app);
        assert.ok(Array.isArray(definition.pages)); assert.equal(definition.pages.length, 1);
        assert.equal(object(definition.pages[0]).path, '/table-time');
        return { path, sha, source, artifact, originalArtifact: JSON.stringify(artifact), asm, entry };
      };
      const compiled = await compile(paginatedSource, 'paged-table-time');
      const guarded = await compile(guardedSource, 'guarded-table-time');
      const { artifact, asm } = compiled;
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      assert.deepEqual(loaded.models.map(model => model.name).sort(), [`${app}.Calendar`, `${app}.Window`]);
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { IDENTITY: 'paged-table-time-identity', STATE: 'paged-table-time-state' }, d1Persist: join(dir, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const db = await worker.getD1Database('STATE') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(db); await ensurePagePreferencesSchema(identityDb);
      let now = FIXED_NOW;
      const clock = { nowMs: () => now };
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'paged-table-time@example.test', password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
      const token = 'native-paged-table-time-session';
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
        expires_at: new Date(FIXED_NOW + 2 * 3600000).toISOString() });
      const admit = () => resolveIdentity(identities, { session_token: token }, { clock });
      const identity = await admit();
      assert.equal(identity.actor?.user_id, user.user_id); assert.equal(identity.team?.team_id, team.team_id);
      const physical = createD1Storage(db), preferences = createD1PagePreferenceStore(identityDb);
      let sequence = 1400;
      const nextId = () => asOperationId(uuidv7(now, ++sequence));
      const mutationOptions = { artifact, asm, app, identity, source: 'worker', store: physical,
        memberships: identities, now: clock.nowMs };
      const calendarCreated = await invokeMutationCanonical({ ...mutationOptions, operation: `${app}.Calendar.create`,
        operationId: nextId(), inputs: { title: 'Actual paginated time calendar' } });
      assert.equal(calendarCreated.status, 'committed');
      const calendars = await physical.query({ model: calendarModel, authority: 'owner' });
      assert.equal(calendars.length, 1); const calendar = calendars[0]!;
      const upcoming: string[] = [], past: string[] = [];
      for (const [count, direction, state, ids] of [[52, 1, 'open', upcoming], [26, -1, 'closed', past]] as const) {
        for (let index = 0; index < count; index++) {
          const from = FIXED_NOW + direction * (direction === 1 ? index : index + 1) * 60000;
          const created = await invokeMutationCanonical({ ...mutationOptions, operation: `${app}.Window.create`, operationId: nextId(),
            inputs: { parent: { id: calendar.id, version: String(calendar.version) }, from: new Date(from).toISOString(),
              until: new Date(from + 3600000).toISOString(), state, available: true, rank: '7' } });
          assert.equal(created.status, 'committed');
          const rows = await physical.query({ model: windowModel, authority: 'owner' });
          const added = rows.filter(row => row.data.from === new Date(from).toISOString());
          assert.equal(added.length, 1); ids.push(added[0]!.id);
        }
      }
      const resources = async () => ({ state: await snapshot(db), identity: await snapshot(identityDb) });
      const cursors = await createPageCursorCodec(new Uint8Array(32).fill(64));
      const pageReads = { scope: { app, owner: team.team_id, ownerPackage: app }, sourceIdentity: compiled.sha, cursors };
      const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(65), 'native-paged-table-time');
      type Query = { sequence: number; model: string; args: ListQueryArgs; result: ListQueryResult; admittedAt: string };
      let queries: Query[] = [], querySequence = 0;
      const serve = async (input: typeof compiled) => {
        const derived = object(await import(`data:text/javascript,${encodeURIComponent(buildDerivedInputsModule(input.artifact))}`));
        const derivedInputs = derived.derivedInputs as NonNullable<Parameters<typeof assembleWorker>[2]['http']>['derivedInputs'];
        assert.ok(derivedInputs);
        return assembleWorker(input.artifact, input.asm, { store: physical, identityStore: identities, now: clock.nowMs,
          pageReads: { ...pageReads, sourceIdentity: input.sha }, http: { formBindings, preferences, derivedInputs,
            createOperationHandler: Object.assign((deps: AssemblyHttpDeps) => (request: Request, operation: string) =>
              handleOperationRequest(deps as unknown as Parameters<typeof handleOperationRequest>[0], request, operation),
            { inputChoicesVersion: INPUT_CHOICES_VERSION }), createPageHandler: deps => {
              const pageDeps = deps as unknown as PageHttpDeps, original = pageDeps.createReadScope; assert.ok(original);
              return request => handlePageRequest({ ...pageDeps, createReadScope: async admitted => {
                assert.equal(admitted.admitted_at, new Date(now).toISOString());
                const scope = await original(admitted);
                return { ...scope, query: async (invocation, model, args) => {
                  const sequence = querySequence++, result = await scope.query(invocation, model, args);
                  queries.push({ sequence, model, args, result, admittedAt: admitted.admitted_at }); return result;
                } };
              } }, request);
            } } }, { active: true });
      };
      const served = await serve(compiled), guardServed = await serve(guarded);
      const cookie = buildSessionCookie(token, { secure: false, maxAgeSeconds: 7200 }).split(';')[0]!;
      const follow = async (url: URL, server = served, partial = true) => {
        assert.equal(url.origin, 'https://paged-table-time.example.test'); assert.equal(url.pathname, '/table-time');
        queries = []; querySequence = 0;
        const response = await server.fetch(new Request(url,
          { headers: { ...(partial ? { 'hx-request': 'true' } : {}), cookie } }));
        return { url, response, html: await response.text(), queries: [...queries].sort((left, right) => left.sequence - right.sequence) };
      };
      const render = (params = new URLSearchParams(), server = served, partial = true) =>
        follow(new URL(`https://paged-table-time.example.test/table-time?${params}`), server, partial);
      const timeQuery = (value: Awaited<ReturnType<typeof render>>, operator: 'gte' | 'lt') => {
        const selected = value.queries.filter(query => query.model === windowModel);
        assert.equal(selected.length, 2);
        const query = selected.find(query => {
          const where = object(query.args.where); return (where.op === 'and' ? object((where.args as unknown[])[0]) : where).op === operator;
        }); assert.ok(query);
        const where = object(query.args.where), time = where.op === 'and' ? object((where.args as unknown[])[0]) : where;
        assert.deepEqual(time, { op: operator, field: 'from', value: { kind: 'page-query-now' } });
        assert.equal(query.args.page, true); assert.equal(query.args.parent, undefined);
        assert.deepEqual(query.args.order, operator === 'gte' ? ['from'] : ['-from']);
        assert.ok(query.args.occurrence); return query;
      };
      const nextHref = (value: Awaited<ReturnType<typeof render>>, query: Query) => {
        assert.ok(query.result.nextCursor);
        const name = collectionCursorName(query.args.occurrence!);
        const links = [...value.html.matchAll(/<a\b[^>]*\brel="next"[^>]*\bhref="([^"]*)"[^>]*>/g)]
          .map(match => new URL(match[1]!.replaceAll('&amp;', '&'), value.url));
        const matching = links.filter(url => url.searchParams.get(name) === query.result.nextCursor);
        assert.equal(matching.length, 1, 'one actual next link belongs to this source occurrence');
        const next = matching[0]!;
        assert.equal(next.origin, value.url.origin); assert.equal(next.pathname, value.url.pathname);
        const expected = new URLSearchParams(value.url.searchParams); expected.set(name, query.result.nextCursor);
        assert.deepEqual([...next.searchParams], [...expected], 'next replaces only its own cursor and retains complete current GET state');
        return next;
      };
      const continuation = async (query: Query, cursor: string, overrides: Partial<ListQueryArgs> = {}) =>
        queryPageRowsCanonical({ artifact, asm, store: physical, memberships: identities,
          identity: await admit(), now: clock.nowMs, pageReads, model: query.model,
          args: { ...query.args, ...overrides, cursor } });
      const proof = async (cursor: string, queryTimeMs: number) => {
        const decoded = await cursors.decode(cursor, now); assert.equal(decoded.status, 'valid');
        if (decoded.status !== 'valid') assert.fail('expected current authenticated cursor');
        assert.equal(decoded.position.queryTimeMs, queryTimeMs); return decoded;
      };
      const refusal = async (read: () => Promise<unknown>, code: 'validation' | 'conflict' | 'forbidden', message?: string) => {
        const before = await resources();
        await assert.rejects(read(), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === code &&
          (message === undefined || ('message' in error && error.message === message)));
        assert.deepEqual(await resources(), before, `${code} cursor refusal has no State or Identity effects`);
      };
      const baseline = await resources();
      const first = await render(new URLSearchParams([['now', '2099-01-01T00:00:00.000Z']]));
      assert.equal(first.response.status, 200, first.html);
      const up = timeQuery(first, 'gte'), old = timeQuery(first, 'lt');
      assert.notEqual(up.args.occurrence, old.args.occurrence);
      assert.deepEqual(up.result.rows.map(row => row.id), upcoming.slice(0, 25));
      assert.deepEqual(old.result.rows.map(row => row.id), past.slice(0, 25));
      assert.equal(up.result.rows[0]!.fields.from, new Date(FIXED_NOW).toISOString(), 'equal boundary is upcoming');
      assert.ok(up.result.nextCursor); assert.ok(old.result.nextCursor);
      await proof(up.result.nextCursor, FIXED_NOW); await proof(old.result.nextCursor, FIXED_NOW);
      assert.deepEqual(await resources(), baseline);
      const httpParams = new URLSearchParams([['team', team.team_id], ['unrelated', 'retained'],
        [`can-row:${up.args.occurrence}`, upcoming[0]!], [collectionFilterName(up.args.occurrence!, 'state'), ''],
        [collectionFilterName(old.args.occurrence!, 'state'), '']]);
      const httpFirst = await render(httpParams, served, false); assert.equal(httpFirst.response.status, 200, httpFirst.html);
      const httpUp = timeQuery(httpFirst, 'gte'), httpPast = timeQuery(httpFirst, 'lt');
      assert.deepEqual(httpUp.result.rows.map(row => row.id), upcoming.slice(0, 25));
      assert.deepEqual(httpPast.result.rows.map(row => row.id), past.slice(0, 25));
      assert.equal(httpUp.args.cursor, undefined); assert.equal(httpPast.args.cursor, undefined);
      const httpUpNext = nextHref(httpFirst, httpUp); nextHref(httpFirst, httpPast);
      assert.deepEqual(await resources(), baseline);
      now = FIXED_NOW + 14 * 60000;
      assert.equal((await admit()).admitted_at, new Date(now).toISOString());
      const second = await continuation(up, up.result.nextCursor), lastPast = await continuation(old, old.result.nextCursor);
      assert.deepEqual(second.rows.map(row => row.id), upcoming.slice(25, 50)); assert.ok(second.nextCursor);
      assert.deepEqual(lastPast.rows.map(row => row.id), past.slice(25)); assert.equal(lastPast.nextCursor, undefined);
      await proof(second.nextCursor, FIXED_NOW);
      const issued = JSON.parse(Buffer.from(second.nextCursor.split('.')[0]!, 'base64url').toString('utf8')) as unknown[];
      assert.deepEqual(issued.slice(5), [FIXED_NOW, now, now + 15 * 60000]);
      assert.deepEqual(await resources(), baseline);
      const httpSecond = await follow(httpUpNext); assert.equal(httpSecond.response.status, 200, httpSecond.html);
      const httpSecondUp = timeQuery(httpSecond, 'gte'), httpFreshPast = timeQuery(httpSecond, 'lt');
      assert.equal(httpSecondUp.args.cursor, httpUp.result.nextCursor);
      assert.deepEqual(httpSecondUp.result.rows.map(row => row.id), upcoming.slice(25, 50));
      assert.equal(httpFreshPast.args.cursor, undefined);
      assert.deepEqual(httpFreshPast.result.rows.map(row => row.id), [...upcoming.slice(0, 14).reverse(), ...past].slice(0, 25));
      assert.ok(httpSecondUp.result.nextCursor); assert.ok(httpFreshPast.result.nextCursor);
      await proof(httpSecondUp.result.nextCursor, FIXED_NOW); await proof(httpFreshPast.result.nextCursor, now);
      const httpBoth = await follow(nextHref(httpSecond, httpFreshPast)); assert.equal(httpBoth.response.status, 200, httpBoth.html);
      const httpBothUp = timeQuery(httpBoth, 'gte'), httpBothPast = timeQuery(httpBoth, 'lt');
      assert.equal(httpBothUp.args.cursor, httpUp.result.nextCursor);
      assert.equal(httpBothPast.args.cursor, httpFreshPast.result.nextCursor);
      assert.deepEqual(httpBothUp.result.rows.map(row => row.id), upcoming.slice(25, 50));
      assert.deepEqual(httpBothPast.result.rows.map(row => row.id), [...upcoming.slice(0, 14).reverse(), ...past].slice(25));
      const httpThirdHref = nextHref(httpBoth, httpBothUp);
      assert.equal(httpThirdHref.searchParams.get(collectionCursorName(httpPast.args.occurrence!)), httpFreshPast.result.nextCursor);
      assert.deepEqual(await resources(), baseline);
      now = FIXED_NOW + 16 * 60000;
      const third = await continuation(up, second.nextCursor);
      assert.deepEqual(third.rows.map(row => row.id), upcoming.slice(50)); assert.equal(third.nextCursor, undefined);
      const httpThird = await follow(httpThirdHref, served, false); assert.equal(httpThird.response.status, 200, httpThird.html);
      const httpThirdUp = timeQuery(httpThird, 'gte'), httpThirdPast = timeQuery(httpThird, 'lt');
      assert.equal(httpThirdUp.args.cursor, httpBothUp.result.nextCursor);
      assert.equal(httpThirdPast.args.cursor, httpFreshPast.result.nextCursor);
      assert.deepEqual(httpThirdUp.result.rows.map(row => row.id), upcoming.slice(50));
      assert.deepEqual(httpThirdPast.result.rows.map(row => row.id), [...upcoming.slice(0, 14).reverse(), ...past].slice(25));
      assert.equal(httpThirdUp.result.nextCursor, undefined); assert.equal(httpThirdPast.result.nextCursor, undefined);
      await proof(httpThirdUp.args.cursor!, FIXED_NOW); await proof(httpThirdPast.args.cursor!, FIXED_NOW + 14 * 60000);
      assert.deepEqual(await resources(), baseline);
      for (const duplicate of [false, true]) {
        const malformed = new URLSearchParams(httpParams);
        for (const [query, cursor] of [[httpUp, httpBothUp.result.nextCursor!], [httpPast, httpFreshPast.result.nextCursor!]] as const) {
          const name = collectionCursorName(query.args.occurrence!);
          malformed.append(name, duplicate ? cursor : '');
          if (duplicate) malformed.append(name, cursor);
        }
        const rejected = await render(malformed); assert.equal(rejected.response.status, 422, rejected.html);
        assert.equal(object(JSON.parse(rejected.html)).code, 'rule_failed');
        assert.deepEqual(rejected.queries, [], 'each malformed occurrence refuses before its query');
        assert.deepEqual(await resources(), baseline);
      }
      await refusal(() => continuation(up, up.result.nextCursor!), 'conflict');
      const fresh = await render(); assert.equal(fresh.response.status, 200, fresh.html);
      const freshUp = timeQuery(fresh, 'gte'), freshPast = timeQuery(fresh, 'lt');
      assert.deepEqual(freshUp.result.rows.map(row => row.id), upcoming.slice(16, 41)); assert.ok(freshUp.result.nextCursor);
      assert.deepEqual(freshPast.result.rows.map(row => row.id), [...upcoming.slice(0, 16).reverse(), ...past].slice(0, 25));
      assert.ok(freshPast.result.nextCursor); await proof(freshUp.result.nextCursor, now); await proof(freshPast.result.nextCursor, now);
      await proof(second.nextCursor, FIXED_NOW);
      const independentPast = await continuation(freshPast, freshPast.result.nextCursor);
      assert.deepEqual(independentPast.rows.map(row => row.id), [...upcoming.slice(0, 16).reverse(), ...past].slice(25),
        'the fresh past occurrence has a T16 boundary while the live upcoming continuation retains T0');
      assert.deepEqual(await resources(), baseline);
      await refusal(() => continuation(up, second.nextCursor!, { occurrence: old.args.occurrence! }), 'conflict');
      await refusal(() => continuation(up, freshPast.result.nextCursor!), 'conflict');
      const tampered = freshUp.result.nextCursor.slice(0, -1) + (freshUp.result.nextCursor.endsWith('A') ? 'B' : 'A');
      await refusal(() => continuation(freshUp, tampered), 'validation');
      const filterName = collectionFilterName(up.args.occurrence!, 'state');
      const changedFilter = await render(new URLSearchParams([[filterName, 'closed']]));
      assert.equal(changedFilter.response.status, 200, changedFilter.html);
      const closedUp = timeQuery(changedFilter, 'gte'); assert.deepEqual(closedUp.result.rows, []);
      await refusal(() => continuation(closedUp, second.nextCursor!), 'conflict');
      assert.equal(await preferences.save({ appId: app, actorUserId: user.user_id, teamId: team.team_id,
        owner: app, field: 'window_state', value: 'open', expectedVersion: '0' }), true);
      const preferredBaseline = await resources(), preferred = await render(); assert.equal(preferred.response.status, 200, preferred.html);
      const preferredUp = timeQuery(preferred, 'gte'); assert.ok(preferredUp.result.nextCursor);
      await refusal(() => continuation(preferredUp, second.nextCursor!), 'conflict');
      const cleared = await render(new URLSearchParams([[filterName, '']])); assert.equal(cleared.response.status, 200, cleared.html);
      await refusal(() => continuation(timeQuery(cleared, 'gte'), preferredUp.result.nextCursor!), 'conflict');
      const guardPage = await render(new URLSearchParams(), guardServed); assert.equal(guardPage.response.status, 200, guardPage.html);
      assert.deepEqual(await resources(), preferredBaseline);
      const currentText = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(now));
      assert.ok(guardPage.html.includes(`<p><span lang="en" dir="auto">\u2068Admitted now: ${currentText}\u2069</span></p>`),
        'ordinary typed message now uses current admission time');
      const guardUp = timeQuery(guardPage, 'gte'); assert.ok(guardUp.result.nextCursor);
      const guardNextHref = nextHref(guardPage, guardUp);
      await refusal(async () => queryPageRowsCanonical({ artifact: guarded.artifact, asm: guarded.asm, store: physical,
        memberships: identities, identity: await admit(), now: clock.nowMs, pageReads: { ...pageReads, sourceIdentity: guarded.sha },
        model: up.model, args: { ...up.args, cursor: second.nextCursor! } }), 'conflict');
      now = FIXED_NOW + 18 * 60000;
      await proof(guardUp.result.nextCursor, FIXED_NOW + 16 * 60000);
      const guardBaseline = await resources(), denied = await follow(guardNextHref, guardServed);
      assert.equal(denied.response.status, 403, denied.html); assert.deepEqual(denied.queries, []);
      assert.deepEqual(await resources(), guardBaseline, 'current-time page guard refuses without collection reads or effects');
      now = FIXED_NOW + 31 * 60000;
      await refusal(() => continuation(freshUp, freshUp.result.nextCursor!), 'conflict');
      now = FIXED_NOW + 18 * 60000;
      const beforeUpdate = await physical.load(windowModel, asId(upcoming[51]!)); assert.ok(beforeUpdate);
      const changed = await invokeMutationCanonical({ ...mutationOptions, identity: await admit(), operation: `${app}.Window.update`,
        operationId: nextId(), inputs: { record: { id: beforeUpdate.id, version: String(beforeUpdate.version) }, rank: '8' } });
      assert.equal(changed.status, 'committed');
      await refusal(() => continuation(freshUp, freshUp.result.nextCursor!), 'conflict');
      const updatedBaseline = await resources(), current = await render(); assert.equal(current.response.status, 200, current.html);
      const currentUp = timeQuery(current, 'gte'); assert.ok(currentUp.result.nextCursor);
      assert.deepEqual(await resources(), updatedBaseline);
      await identities.removeMembership(membership.membership_id);
      await refusal(() => continuation(currentUp, currentUp.result.nextCursor!), 'validation', 'Query path "from" is not granted to this caller.');
      const revokedBaseline = await resources(), revoked = await render(); assert.equal(revoked.response.status, 403, revoked.html);
      assert.deepEqual(await resources(), revokedBaseline);
      for (const value of [compiled, guarded]) {
        assert.equal(await readFile(value.path, 'utf8'), value.source);
        assert.equal(JSON.stringify(value.artifact), value.originalArtifact);
        await importVerifiedAssemblyModule(value.asm, value.entry, value.artifact);
      }
      assert.deepEqual(await hashes(), captured);
    } finally { await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
