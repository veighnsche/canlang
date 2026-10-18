/** Genuine unchanged TableFilters page over current State/Identity/D1 producers.
 * This qualifies rendering/filtering, not checkbox mutation or cursor semantics. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CanValue, CompileArtifact, ListQueryArgs, ListQueryResult, PageSourceContext } from '@canlang/contracts';
import { collectionFilterName } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { decodeValue, encodeValue, makeUserRef, makeRecordRef } from '@canlang/values';
import { buildSessionCookie, createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { buildContext } from '@canlang/state/invocation';
import { runMutationWrites, type ModelTable, type MutationWrite } from '@canlang/state/mutation';
import { ensureSchema, createD1Storage } from '@canlang/state/storage/d1';
import { FIXED_NOW, asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { handlePageRequest, buildPageSourceContext, buildPresentationContext, createSourceFormBindings } from '@canlang/interfaces';
import type { PageHttpDeps } from '@canlang/interfaces';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';
import { assembleWorker } from '@canlang/cloudflare/worker/assembly';
import { createD1PagePreferenceStore, ensurePagePreferencesSchema } from '../dist/runtime/page-preferences.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = 'TableFilters', calendarModel = asModel(`${app}.Calendar`), windowModel = asModel(`${app}.Window`);
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

test('unchanged native TableFilters page preserves order, nullable defaults and occurrence-local authorized filters',
  { timeout: 120000 }, async () => {
    const fixture = join(root, 'compiler/tests/fixtures/table-filters.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [fixture, compiler, catalog];
    const hashes = () => Promise.all(paths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
    const captured = await hashes();
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'can-native-table-page-')));
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
      assert.deepEqual(loaded.models.map(model => model.name).sort(), [`${app}.Calendar`, `${app}.Other`, `${app}.Window`]);
      const entry = Object.entries(asm.moduleUrls).find(([, url]) => url === asm.entryUrl)?.[0]; assert.ok(entry);
      const namespace = object(await importVerifiedAssemblyModule(asm, entry, artifact));
      const definition = object(namespace.appDefinition); assert.equal(definition.id, app);
      const pages = definition.pages; assert.ok(Array.isArray(pages)); assert.equal(pages.length, 1);
      assert.equal(object(pages[0]).path, '/table-filters');
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
      const replacementOwner = await identities.createUser({ email: 'replacement-owner@table-page.example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: replacementOwner.user_id, is_owner: true, roles: [] });
      const token = 'native-table-page-session';
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(FIXED_NOW + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      assert.equal(identity.actor?.user_id, user.user_id); assert.equal(identity.team?.team_id, team.team_id);
      const physical = createD1Storage(db), preferences = createD1PagePreferenceStore(identityDb);
      const calendar = asId(uuidv7(FIXED_NOW, 201)), otherCalendar = asId(uuidv7(FIXED_NOW, 202));
      const windows = [203, 204, 205].map(index => asId(uuidv7(FIXED_NOW, index)));
      const otherWindow = asId(uuidv7(FIXED_NOW, 206));
      // The original source exposes no Calendar create. Setup uses the genuine
      // checked State writer; it does not supply a replacement page/business handler.
      const writes: MutationWrite[] = [
        { op: 'create', model: calendarModel, id: calendar, data: { title: 'Main calendar' } },
        { op: 'create', model: calendarModel, id: otherCalendar, data: { title: 'Other calendar' } },
        ...windows.map((id, index): MutationWrite => ({ op: 'create', model: windowModel, id,
          parent: { model: calendarModel, id: calendar }, data: {
            from: decodeValue('datetime', `2030-01-0${index + 2}T10:00:00.000Z`),
            until: decodeValue('datetime', `2030-01-0${index + 2}T11:00:00.000Z`),
            state: index === 1 ? 'closed' : 'open', available: index !== 1, rank: BigInt(index + 7),
          } })),
        { op: 'create', model: windowModel, id: otherWindow, parent: { model: calendarModel, id: otherCalendar },
          data: { from: decodeValue('datetime', '2030-01-01T10:00:00.000Z'), until: decodeValue('datetime', '2030-01-01T11:00:00.000Z'),
            state: 'closed', available: true, rank: 99n } },
      ];
      const effects = await runMutationWrites({ table: loaded.table as ModelTable, store: physical, writes,
        context: buildContext({ identity, app, operation: asOperation(`${app}.setup`), operationId: asOperationId(uuidv7(FIXED_NOW, 207)),
          source: 'worker', now: FIXED_NOW }),
        secretFields: new Map(loaded.models.map(model => [model.name, loaded.secretFields.get(model.name)!])),
        encodeField: (type, value) => encodeValue(type, value as CanValue) });
      await physical.commit({ ...effects, outbox: [], expectedRevision: await physical.readRevision(), receipt: null });
      const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(53), 'native-table-page');
      type Query = { sequence: number; model: string; args: ListQueryArgs; result: ListQueryResult };
      let queries: Query[] = [], querySequence = 0, pageDeps: PageHttpDeps | undefined;
      const served = await assembleWorker(artifact, asm, { store: physical, identityStore: identities, now: clock.nowMs,
        pageReads: { scope: { app, owner: team.team_id, ownerPackage: app }, sourceIdentity: captured[0]! },
        http: { formBindings, preferences, createPageHandler: deps => {
          pageDeps = deps as unknown as PageHttpDeps;
          const original = pageDeps.createReadScope; assert.ok(original);
          const observed: PageHttpDeps = { ...pageDeps, createReadScope: async (admitted, source, resolveCaller) => {
            assert.equal(admitted.admitted_at, identity.admitted_at);
            const scope = await original(admitted, source, resolveCaller);
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
        const response = await served.fetch(new Request(`https://table-page.example.test/table-filters?${params}`, {
          headers: { 'hx-request': 'true', ...(authenticated ? { cookie } : {}) } }));
        return { response, html: await response.text(), queries: [...queries].sort((left, right) => left.sequence - right.sequence) };
      };
      const rows = (value: Awaited<ReturnType<typeof render>>, parent: string) => value.queries.filter(query =>
        query.model === windowModel && query.args.parent?.id === parent);
      const expectRows = (value: Awaited<ReturnType<typeof render>>, parent: string, expected: readonly string[][]) => {
        const selected = rows(value, parent); assert.equal(selected.length, 2);
        assert.deepEqual(selected.map(query => query.args.order), [['from'], ['-from']]);
        assert.deepEqual(selected.map(query => query.result.rows.map(row => row.id)), expected);
        for (const query of selected) for (const row of query.result.rows) {
          const stored = writes.find(write => write.id === row.id)!;
          assert.equal(stored.parent?.id, parent);
          assert.equal(row.fields['state'], stored.data?.state);
          assert.equal(row.fields['rank'], stored.data?.rank?.toString());
          assert.equal(row.fields['from'], encodeValue('datetime', stored.data?.from as CanValue));
        }
      };
      const baseline = await resources(), initial = await render(); assert.equal(initial.response.status, 200, initial.html);
      expectRows(initial, calendar, [windows, [...windows].reverse()]);
      expectRows(initial, otherCalendar, [[otherWindow], [otherWindow]]);
      assert.match(initial.html, /Main calendar/); assert.match(initial.html, /Open &lt;window&gt;/);
      assert.match(initial.html, /Closed window/);
      const initialQueries = rows(initial, calendar), occurrences = initialQueries.map(query => query.args.occurrence);
      assert.ok(occurrences.every(value => typeof value === 'string')); assert.notEqual(occurrences[0], occurrences[1]);
      const filterNames = occurrences.map(value => collectionFilterName(value!, 'state'));
      assert.ok(filterNames.every(name => initial.html.includes(name)));
      assert.equal(await preferences.read({ appId: app, actorUserId: user.user_id, teamId: team.team_id, owner: app, field: 'window_state' }), null);
      assert.deepEqual(await resources(), baseline, 'nullable initial default and all rendering are read-only');
      assert.equal(await preferences.save({ appId: app, actorUserId: user.user_id, teamId: team.team_id,
        owner: app, field: 'window_state', value: 'open', expectedVersion: '0' }), true);
      const savedBaseline = await resources(), saved = await render(); assert.equal(saved.response.status, 200, saved.html);
      expectRows(saved, calendar, [[windows[0]!, windows[2]!], [windows[2]!, windows[0]!]]);
      expectRows(saved, otherCalendar, [[], []]);
      const overridden = await render(new URLSearchParams([[filterNames[0]!, 'closed'], [filterNames[1]!, '']]));
      assert.equal(overridden.response.status, 200, overridden.html);
      expectRows(overridden, calendar, [[windows[1]!], [...windows].reverse()]);
      expectRows(overridden, otherCalendar, [[], []]);
      for (const params of [new URLSearchParams([[filterNames[0]!, 'foreign']]),
        new URLSearchParams([[filterNames[0]!, 'open'], [filterNames[0]!, 'closed']]),
        new URLSearchParams([[collectionFilterName(occurrences[0]!, 'foreign_state'), 'open']])]) {
        const refused = await render(params); assert.equal(refused.response.status, 400, refused.html);
      }
      assert.deepEqual(await resources(), savedBaseline, 'filters/clear/refusals never persist or mutate resources');
      assert.ok(pageDeps);
      const source = buildPageSourceContext(identity);
      const context = buildPresentationContext({ request: new Request('https://table-page.example.test/table-filters?now=2099-01-01'),
        pathname: '/table-filters', isPartial: true, appDefaultLocale: 'en', csrfToken: '', principal: identity,
        source: { ...source, now: decodeValue('datetime', '2099-01-01T00:00:00.000Z') } as PageSourceContext,
        query: (await pageDeps.createReadScope!(identity, buildPageSourceContext(identity), () => resolveIdentity(identities, { session_token: token }, { clock }))).query, clock: { nowMs: () => FIXED_NOW + 999999 } });
      assert.equal(encodeValue('datetime', context.now!), identity.admitted_at);
      assert.equal(encodeValue('datetime', source.now), identity.admitted_at);
      const unauthenticated = await render(new URLSearchParams(), false); assert.equal(unauthenticated.response.status, 403);
      assert.deepEqual(await resources(), savedBaseline);
      await identities.removeMembership(membership.membership_id);
      const revoked = await resources(), denied = await render(); assert.equal(denied.response.status, 403, denied.html);
      assert.deepEqual(await resources(), revoked, 'current preference admission refuses revoked membership without effects');
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.deepEqual(await hashes(), captured);
      await importVerifiedAssemblyModule(asm, entry, artifact);
    } finally { await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

/** The six frozen original selector/default combinations, compiled together.
 * Model data is finite fixture data; no runtime filter descriptor is transcribed. */
test('compiled original scalar and contained-parent table filters reach current State projections',
  {timeout: 120000}, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'can-scalar-table-page-')));
    let worker: Miniflare | undefined;
    try {
      const fixture = join(root, 'compiler/tests/fixtures/scalar-table-filters.can');
      const {stdout} = await promisify(execFile)(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', process.env.CAN_NATIVE_CATALOG ?? fileURLToPath(distribution.catalog), fixture],
        {cwd: root, timeout: 120000, maxBuffer: 32 * 1024 * 1024});
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assert.ok(!('diagnostics' in artifact));
      // Keep the actual original filter lists/default reads in this consumer.
      const selectorSource = await readFile(fixture, 'utf8');
      for (const [path, clause] of [
        ['CanAffiliate', 'filter=reversed,qualified_at,amount.currency defaults={reversed=preferences.reversed}'],
        ['CanInvoice', 'filter=location,state,currency,due'],
        ['CanExpense', 'filter=parent,location,category,business_date'],
        ['CanLeave', 'filter=year,bucket defaults={year=preferences.year,bucket=preferences.bucket}'],
      ]) {
        assert.ok((await readFile(join(root, `draft/apps/${path}/${path}.can`), 'utf8')).includes(clause!));
        assert.ok(selectorSource.includes(clause!));
      }
      worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: {IDENTITY: 'scalar-filter-identity', STATE: 'scalar-filter-state'}});
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const db = await worker.getD1Database('STATE') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(db); await ensurePagePreferencesSchema(identityDb);
      const identities = createD1IdentityStore(identityDb, {clock: {nowMs: () => FIXED_NOW}});
      const team = await identities.createTeam({timezone: 'UTC'});
      const user = await identities.createUser({email: 'scalar-filter@example.test', password_hash: 'unused', email_verified: true});
      await identities.createMembership({team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: []});
      const token = 'scalar-filter-session';
      await identities.createSession({user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(FIXED_NOW + 3600000).toISOString()});
      const identity = await resolveIdentity(identities, {session_token: token}, {clock: {nowMs: () => FIXED_NOW}});
      const store = createD1Storage(db), preferences = createD1PagePreferenceStore(identityDb);
      const asm = await assembleModules({artifact, sourcePath: fixture}, {workDir: join(dir, 'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib')});
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      const name = (leaf: string) => asModel(`ScalarTableFilters.${leaf}`);
      const employee = asId(uuidv7(FIXED_NOW, 601)), location = asId(uuidv7(FIXED_NOW, 602)), partner = asId(uuidv7(FIXED_NOW, 603));
      const ids = [604, 605, 606].map(index => asId(uuidv7(FIXED_NOW, index)));
      const clock = {nowMs: () => FIXED_NOW};
      const writes: MutationWrite[] = [
        {op: 'create', model: name('Employee'), id: employee, data: {user: makeUserRef(user.user_id)}},
        {op: 'create', model: name('Location'), id: location, data: {name: 'Site'}},
        {op: 'create', model: name('Partner'), id: partner, data: {name: 'Partner'}},
        ...ids.map((id, index): MutationWrite => ({op: 'create', model: name('Sale'), id,
          parent: {model: name('Partner'), id: partner}, data: {source: `sale-${index}`, reversed: index === 2,
            qualified_at: decodeValue('datetime', '2026-10-18T09:30:00.000Z'),
            amount: decodeValue('money', {minor: '100', currency: index === 1 ? 'USD' : 'EUR'})}})),
        {op: 'create', model: name('Invoice'), id: asId(uuidv7(FIXED_NOW, 607)), data: {location: makeRecordRef(name('Location'), location), state: 'issued', currency: 'EUR', due: decodeValue('date', '2026-10-18')}},
        {op: 'create', model: name('Expense'), id: asId(uuidv7(FIXED_NOW, 608)), parent: {model: name('Employee'), id: employee},
          data: {location: makeRecordRef(name('Location'), location), category: 'travel', business_date: decodeValue('date', '2026-10-18'), status: 'approved', purpose: 'Travel', amount: decodeValue('money', {minor: '100', currency: 'EUR'}), receipt: 'evidence'}},
        {op: 'create', model: name('Allowance'), id: asId(uuidv7(FIXED_NOW, 609)), parent: {model: name('Employee'), id: employee}, data: {year: 2026n, bucket: 'vacation', days: 20n, remaining: 19n}},
      ];
      const effects = await runMutationWrites({store, table: loaded.table as ModelTable, writes,
        context: buildContext({identity, app: 'ScalarTableFilters', operation: asOperation('ScalarTableFilters.seed'),
          operationId: asOperationId(uuidv7(FIXED_NOW, 610)), source: 'worker', now: FIXED_NOW}),
        secretFields: new Map(loaded.models.map(model => [model.name, loaded.secretFields.get(model.name)!])),
        encodeField: (type, value) => encodeValue(type, value as CanValue)});
      await store.commit({...effects, outbox: [], expectedRevision: await store.readRevision(), receipt: null});
      const queries: Array<{model: string; args: ListQueryArgs; result: ListQueryResult}> = [];
      const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(54), 'scalar-table-page');
      const served = await assembleWorker(artifact, asm, {store, identityStore: identities, now: clock.nowMs,
        pageReads: {scope: {app: 'ScalarTableFilters', owner: team.team_id, ownerPackage: 'ScalarTableFilters'}, sourceIdentity: 'scalar-filter-fixture'},
        http: {formBindings, preferences, createPageHandler: deps => {
          const pageDeps = deps as unknown as PageHttpDeps, original = pageDeps.createReadScope!;
          return request => handlePageRequest({...pageDeps, createReadScope: async (...args) => {
            const scope = await original(...args);
            return {...scope, ...(scope.onQueryBound === undefined ? {} : {onQueryBound: scope.onQueryBound.bind(scope)}), query: async (caller, model, selection) => {
              const result = await scope.query(caller, model, selection); queries.push({model, args: selection, result}); return result;
            }};
          }}, request);
        }}}, {active: true});
      const cookie = buildSessionCookie(token, {secure: false, maxAgeSeconds: 3600}).split(';')[0]!;
      const render = async (path: string, params = new URLSearchParams()) => {
        queries.length = 0;
        const response = await served.fetch(new Request(`https://scalar-filter.example.test${path}?${params}`, {headers: {'hx-request': 'true', cookie}}));
        const html = await response.text(); assert.equal(response.status, 200, html); return html;
      };
      await render('/affiliate');
      const sales = queries.filter(query => query.model === name('Sale'));
      assert.equal(sales.length, 2); assert.ok(sales.every(query => query.result.rows.length === 2), 'denied reversed row never reaches filters');
      const occurrence = sales[0]!.args.occurrence!;
      const params = new URLSearchParams([[collectionFilterName(occurrence, 'amount.currency'), 'EUR'],
        [collectionFilterName(occurrence, 'qualified_at'), '2026-10-18T09:30:00.000Z']]);
      await render('/affiliate', params);
      const selectedSales = queries.filter(query => query.model === name('Sale'));
      assert.deepEqual(selectedSales.find(query => query.args.occurrence === occurrence)!.result.rows.map(row => row.id), [ids[0]]);
      assert.deepEqual(selectedSales.find(query => query.args.occurrence !== occurrence)!.result.rows.map(row => row.id), [ids[0], ids[1]]);
      await render('/invoice'); assert.equal(queries.find(query => query.model === name('Invoice'))!.result.rows.length, 1);
      await render('/expense'); const expense = queries.find(query => query.model === name('Expense'))!;
      await render('/expense', new URLSearchParams([[collectionFilterName(expense.args.occurrence!, 'parent'), employee]]));
      assert.equal(queries.find(query => query.model === name('Expense'))!.result.rows.length, 1);
      await preferences.save({appId: 'ScalarTableFilters', actorUserId: user.user_id, teamId: team.team_id,
        owner: 'ScalarTableFilters', field: 'year', value: '2026', expectedVersion: '0'});
      const allowanceHtml = await render('/allowance'); assert.match(allowanceHtml.replaceAll(',', ''), /2027/);
      const allowance = queries.find(query => query.model === name('Allowance'))!;
      assert.equal(allowance.result.rows.length, 1); assert.ok(JSON.stringify(allowance.args.where).includes('2026'));
      await render('/allowance', new URLSearchParams([[collectionFilterName(allowance.args.occurrence!, 'year'), '2027']]));
      assert.equal(queries.find(query => query.model === name('Allowance'))!.result.rows.length, 0);
      await render('/allowances'); assert.equal(queries.find(query => query.model === name('Allowance'))!.result.rows.length, 1);
    } finally {await worker?.dispose(); await rm(dir, {recursive: true, force: true});}
  });
