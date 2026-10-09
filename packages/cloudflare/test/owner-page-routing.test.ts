import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, PageRecordsQuery } from '@canlang/contracts';
import { buildSessionCookie, createD1IdentityStore, ensureIdentitySchema,
  resolveIdentity, sha256HexText } from '@canlang/identity';
import { handlePageRequest } from '@canlang/interfaces';
import type { PageHttpDeps } from '@canlang/interfaces';
import { createD1Storage } from '@canlang/state/storage/d1';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { FIXED_NOW, asModel, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '../src/runtime/modules.js';
import { resolveProducerFile } from '../src/deploy/producer-files.js';

const APP = 'TypedOperationForms';
const MODEL = `${APP}.Entry`;
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-operation-forms.json');

test('page scopes route verified teams to distinct physical stores and retain canonical read admission', async () => {
  // Use the installed portable producer's native ESM loader, as the example
  // host does. Vitest's accessor wrappers are not canonical artifact metadata.
  const { assembleWorker, buildInvoker, createTeamOwnerStorageBoundary } = await compileFunction(
    'return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  )(pathToFileURL(resolveProducerFile('@canlang/cloudflare/worker/assembly',
    'bun run --filter @canlang/cloudflare build')).href) as typeof import('../src/worker/assembly.js');
  // Existing compiled fixture; this checks the consumer, not Office acceptance.
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-owner-pages-'));
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { IDENTITY: 'page-identity', A: 'page-team-a', B: 'page-team-b' },
    d1Persist: join(dir, 'd1') });
  try {
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const dbA = await worker.getD1Database('A') as unknown as D1Database;
    const dbB = await worker.getD1Database('B') as unknown as D1Database;
    await ensureIdentitySchema(identityDb);
    const clock = { nowMs: () => FIXED_NOW };
    const identities = createD1IdentityStore(identityDb, { clock });
    const teamA = await identities.createTeam({ timezone: 'UTC' });
    const teamB = await identities.createTeam({ timezone: 'UTC' });
    const unknownTeam = await identities.createTeam({ timezone: 'UTC' });
    const users = await Promise.all(['a', 'b', 'none', 'unknown'].map(name =>
      identities.createUser({ email: `${name}@owner-pages.example.test`, password_hash: 'unused', email_verified: true })));
    const memberA = await identities.createMembership({ team_id: teamA.team_id, user_id: users[0]!.user_id,
      is_owner: false, roles: [] });
    const memberB = await identities.createMembership({ team_id: teamB.team_id, user_id: users[1]!.user_id, is_owner: false, roles: [] });
    await identities.createMembership({ team_id: unknownTeam.team_id, user_id: users[3]!.user_id, is_owner: false, roles: [] });
    const tokens = ['page-session-a', 'page-session-b', 'page-session-none', 'page-session-unknown'];
    for (const [index, team] of [teamA, teamB, null, unknownTeam].entries()) {
      await identities.createSession({ user_id: users[index]!.user_id,
        token_sha256: await sha256HexText(tokens[index]!),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team?.team_id ?? null });
    }
    const expired = 'page-session-expired';
    await identities.createSession({ user_id: users[0]!.user_id, token_sha256: await sha256HexText(expired),
      expires_at: new Date(FIXED_NOW - 1).toISOString(), last_team_id: teamA.team_id });
    const identityFor = (token: string) => resolveIdentity(identities, { session_token: token }, { clock });
    const identityA = await identityFor(tokens[0]!);
    const identityB = await identityFor(tokens[1]!);
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'),
      stdlibUrl: pathToFileURL(resolveProducerFile('@canlang/cloudflare/runtime/stdlib',
        'bun run --filter @canlang/cloudflare build')).href,
    });
    let routeCalls = 0;
    let fallbackCalls = 0;
    const fallback = new Proxy(createD1Storage(identityDb), { get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return () => { fallbackCalls += 1; throw new Error('Routed page used default storage.'); };
    } });
    const boundary = await createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities,
      router: createD1OwnerRouter({ resolveBinding: scope => {
        routeCalls += 1;
        const db = scope.owner === teamA.team_id ? dbA : scope.owner === teamB.team_id ? dbB : null;
        return db === null ? null : { ...scope, db, initializeFresh: true };
      } }) });
    const invoker = buildInvoker(artifact, asm, fallback, { memberships: identities, now: clock.nowMs, ownerStorage: boundary });
    let pageDeps: PageHttpDeps | undefined;
    const page = await assembleWorker(artifact, asm, {
      store: fallback, identityStore: identities, now: clock.nowMs, ownerStorage: boundary,
      http: { createPageHandler: deps => {
        pageDeps = deps as unknown as PageHttpDeps;
        return request => handlePageRequest(pageDeps!, request);
      } },
    }, { active: true });
    const requestFor = (token?: string) => new Request('https://owner-pages.example.test/', {
      headers: { 'hx-request': 'true', ...(token === undefined ? {} : {
        cookie: buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false }).split(';')[0]!,
      }) },
    });
    const stateSnapshot = async () => Promise.all([dbA, dbB].map(async db => ({
      fence: (await db.prepare('SELECT * FROM fence').all()).results,
      records: (await db.prepare('SELECT * FROM records ORDER BY id').all()).results,
      receipts: (await db.prepare('SELECT * FROM receipts ORDER BY rowid').all()).results,
      history: (await db.prepare('SELECT * FROM history ORDER BY rowid').all()).results,
    })));

    assert.ok(pageDeps?.createReadScope);
    const declarations = [{ field: 'label', type: 'text' }, { field: 'count', type: 'int' },
      { field: 'owner', type: 'user' }];
    const emptyScope = await pageDeps.createReadScope(identityA);
    const empty = await emptyScope.query(identityA, MODEL, { includeCount: true });
    assert.deepEqual(empty.rows, []); assert.deepEqual(empty.columns, []);
    assert.deepEqual(empty.emptyDeclarations, declarations);
    assert.equal(empty.totalCount, 0);
    for (const [index, identity] of [identityA, identityB].entries()) {
      const created = await invoker.invokeMutation({ operation: `${MODEL}.create`, operation_id: uuidv7(FIXED_NOW, index + 1),
        inputs: { label: index === 0 ? 'Only team A' : 'Only team B' } }, identity);
      assert.ok('result' in created, JSON.stringify(created));
      assert.equal(created.result.status, 'committed');
    }
    const filteredScope = await pageDeps.createReadScope(identityA);
    const filteredEmpty = await filteredScope.query(identityA, MODEL, { includeCount: true,
      where: { op: 'eq', field: 'label', value: 'No matching entry' } });
    assert.deepEqual(filteredEmpty.rows, []); assert.deepEqual(filteredEmpty.columns, []);
    assert.deepEqual(filteredEmpty.emptyDeclarations, declarations);
    assert.equal(filteredEmpty.totalCount, 0);

    // Selected pages disclose only their own store; one read scope pins one route.
    {
      for (const [token, own, foreign] of [[tokens[0]!, 'Only team A', 'Only team B'],
        [tokens[1]!, 'Only team B', 'Only team A']]) {
        const before = routeCalls;
        const response = await page.fetch(requestFor(token));
        assert.equal(response.status, 200, await response.clone().text());
        const html = await response.text();
        assert.ok(html.includes(own!));
        assert.equal(html.includes(foreign!), false);
        assert.equal(routeCalls, before + 1);
      }
      assert.ok(pageDeps?.createReadScope);
      const before = routeCalls;
      const scope = await pageDeps.createReadScope(identityA);
      const first = await scope.query(identityA, MODEL, { includeCount: true });
      // Renderer arguments cannot switch a scope's verified identity or store.
      const second = await scope.query(identityB, MODEL, { includeCount: true });
      assert.deepEqual(second, first);
      assert.equal(first.totalCount, 1);
      assert.equal(first.rows[0]?.fields['label'], 'Only team A');
      assert.equal(Object.hasOwn(first, 'emptyDeclarations'), false);
      const readRecords = scope.readRecords;
      assert.equal(typeof readRecords, 'function');
      assert.ok(readRecords);
      const beforeNative = await stateSnapshot();
      const native = await readRecords(MODEL, {});
      assert.equal(native.length, 1);
      assert.equal(native[0]?.['label'], 'Only team A');
      assert.equal(native[0]?.['count'], 1n);
      assert.equal(native[0]?.['version'], 1n);
      assert.equal(native[0]?.['archived_at'], null);
      assert.deepEqual(native[0]?.['owner'], { kind: 'user', id: users[0]!.user_id });
      assert.deepEqual(Object.keys(native[0]!).sort(), ['archived_at', 'count', 'created', 'created_by',
        'id', 'label', 'owner', 'updated', 'updated_by', 'version']);
      // Extra renderer arguments cannot replace this scope's admitted identity.
      const nativeAgain = await Reflect.apply(readRecords, undefined, [MODEL, {}, identityB]);
      assert.deepEqual(nativeAgain, native);
      assert.equal(JSON.stringify(native, (_key, value) => typeof value === 'bigint' ? String(value) : value)
        .includes('Only team B'), false);
      assert.deepEqual(await stateSnapshot(), beforeNative);
      assert.equal(routeCalls, before + 1);
      assert.ok(pageDeps.query);
      const fallbackRead = await pageDeps.query(identityB, MODEL, { includeCount: true });
      assert.equal(fallbackRead.rows[0]?.fields['label'], 'Only team B');
      assert.equal(routeCalls, before + 2);
      assert.equal(fallbackCalls, 0);
      assert.deepEqual(await dbA.prepare('SELECT app, owner FROM state_owner_pin').first(), { app: APP, owner: teamA.team_id });
      assert.deepEqual(await dbB.prepare('SELECT app, owner FROM state_owner_pin').first(), { app: APP, owner: teamB.team_id });
    }

    // No selected team, expired credential and absent trusted route refuse without State writes.
    {
      const beforeState = await stateSnapshot();
      for (const token of [undefined, tokens[2]!, expired, tokens[3]!]) {
        const response = await page.fetch(requestFor(token));
        assert.equal(response.status, 403, await response.clone().text());
        const error = await response.json() as { code: string; retryable: boolean };
        assert.equal(error.code, 'forbidden');
        assert.equal(error.retryable, false);
      }
      const noTeam = await identityFor(tokens[2]!);
      const beforeRoutes = routeCalls;
      await assert.rejects(() => boundary.forIdentity(noTeam), (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'forbidden');
      assert.equal(routeCalls, beforeRoutes);
      assert.deepEqual(await stateSnapshot(), beforeState);
      assert.equal(fallbackCalls, 0);
      // Preserve the trusted, actor-free scheduler route independently of
      // request membership; its concrete app/package/team are still checked.
      const trusted = await boundary.forTrustedScope({ app: APP, owner: teamB.team_id, ownerPackage: APP }, FIXED_NOW);
      assert.equal(trusted.identity.actor, null);
      assert.equal(trusted.identity.team?.team_id, teamB.team_id);
      assert.equal(await trusted.store.readRevision(), await (await boundary.forIdentity(identityB)).readRevision());
      const publicIdentity = await resolveIdentity(identities, { team_id: teamB.team_id }, { clock });
      // The route itself adds no member gate to declared public operations.
      assert.equal(await (await boundary.forIdentity(publicIdentity)).readRevision(), await trusted.store.readRevision());
    }

    // A checked host page binding cannot silently switch to another owner.
    {
      const beforeState = await stateSnapshot();
      const checkedPage = await assembleWorker(artifact, asm, {
        store: fallback, identityStore: identities, now: clock.nowMs, ownerStorage: boundary,
        pageReads: { scope: { app: APP, owner: teamA.team_id, ownerPackage: APP }, sourceIdentity: 'compiled-consumer-fixture' },
        http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
      }, { active: true });
      assert.equal((await checkedPage.fetch(requestFor(tokens[0]!))).status, 200);
      const response = await checkedPage.fetch(requestFor(tokens[1]!));
      assert.equal(response.status, 403, await response.clone().text());
      assert.equal((await response.json() as { code: string }).code, 'forbidden');
      assert.deepEqual(await stateSnapshot(), beforeState);
      assert.equal(fallbackCalls, 0);
    }

    // Source reads have no collection limit. These are declared-model setup
    // rows committed to the real owner store, not a compiled create workflow.
    {
      assert.ok(pageDeps?.createReadScope);
      const store = await boundary.forIdentity(identityA);
      const privateModel = `${APP}.PrivateEntry`;
      const seeds = Array.from({ length: 130 }, (_, index) => ({ model: asModel(MODEL), row: makeRow({
        id: `native-page-${String(index).padStart(3, '0')}`, createdBy: users[0]!.user_id,
        updatedBy: users[0]!.user_id, data: { label: `Native team A ${index}`, count: String(index + 2),
          owner: { id: users[0]!.user_id } },
      }) }));
      seeds.push({ model: asModel(privateModel), row: makeRow({ id: 'native-private',
        createdBy: users[0]!.user_id, updatedBy: users[0]!.user_id,
        data: { label: 'PRIVATE_NATIVE_PAGE_ROW', count: '999' },
      }) });
      await store.commit(makeBatch(await store.readRevision(), { writes: seeds.map(seed => ({
        kind: 'insert', model: seed.model, row: seed.row,
      })) }));
      try {
        const scope = await pageDeps.createReadScope(identityA);
        const readRecords = scope.readRecords;
        assert.ok(readRecords);
        const beforeReads = await stateSnapshot();
        const rows = await readRecords(MODEL, {});
        assert.equal(rows.length, 131);
        assert.equal(rows.filter(row => String(row['id']).startsWith('native-page-')).length, 130);
        assert.equal(rows.find(row => row['id'] === 'native-page-129')?.['count'], 131n);
        assert.ok(rows.every(row => typeof row['count'] === 'bigint' && row['archived_at'] === null));
        let predicateCalls = 0;
        const selected = await readRecords(MODEL, { where: (row: Record<string, unknown>) => {
          predicateCalls++;
          return typeof row['count'] === 'bigint' && row['count'] > 127n;
        }, order: ['-count'], limit: 4 });
        assert.deepEqual(selected.map(row => row['count']), [131n, 130n, 129n, 128n]);
        assert.equal(predicateCalls, 131, 'authority revalidation does not evaluate source predicates twice');
        assert.deepEqual(await readRecords(privateModel, {}), []);
        assert.equal(rows.some(row => Object.values(row).includes('PRIVATE_NATIVE_PAGE_ROW')), false);
        const unsupported: readonly PageRecordsQuery[] = [
          { authority: 'owner' }, { archived: 'include' }, { parent: { id: 'foreign-parent' } },
          { where: 'unsupported-selector' }, { order: 23 }, { limit: -1 },
        ];
        for (const query of unsupported) {
          await assert.rejects(() => readRecords(MODEL, query), (error: unknown) =>
            typeof error === 'object' && error !== null && 'code' in error && error.code === 'validation');
        }
        assert.deepEqual(await stateSnapshot(), beforeReads);
        assert.equal(fallbackCalls, 0);
      } finally {
        await store.commit(makeBatch(await store.readRevision(), { writes: seeds.map(seed => ({
          kind: 'remove', model: seed.model, id: seed.row.id, expectedVersion: seed.row.version,
        })) }));
      }
    }

    // Identity changes during an awaited source predicate cannot disclose the
    // earlier native projection; this revokes the actual other owner's member.
    {
      assert.ok(pageDeps?.createReadScope);
      const scope = await pageDeps.createReadScope(identityB);
      const readRecords = scope.readRecords;
      assert.ok(readRecords);
      const beforeState = await stateSnapshot();
      let evaluated = false;
      await assert.rejects(() => readRecords(MODEL, { where: async () => {
        evaluated = true;
        await identities.removeMembership(memberB.membership_id);
        return true;
      } }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'forbidden');
      assert.equal(evaluated, true);
      assert.deepEqual(await stateSnapshot(), beforeState);
      const response = await page.fetch(requestFor(tokens[1]!));
      assert.equal(response.status, 403, await response.clone().text());
      assert.equal(fallbackCalls, 0);
    }

    // Membership removal during a real row predicate prevents disclosure and later page admission.
    {
      assert.ok(pageDeps?.createReadScope);
      const beforeState = await stateSnapshot();
      const scope = await pageDeps.createReadScope(identityA);
      let evaluated = false;
      await assert.rejects(() => scope.query(identityA, MODEL, {
        where: async () => { evaluated = true; await identities.removeMembership(memberA.membership_id); return true; },
      }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'forbidden');
      assert.equal(evaluated, true);
      await assert.rejects(() => scope.query(identityA, MODEL, {
        where: { op: 'eq', field: 'label', value: 'No matching entry' },
      }), { code: 'validation', message: 'Query path "label" is not granted to this caller.' });
      const response = await page.fetch(requestFor(tokens[0]!));
      assert.equal(response.status, 403, await response.clone().text());
      assert.equal((await response.json() as { code: string }).code, 'forbidden');
      const read = await invoker.invokeRead({ operation: `${MODEL}.read`, inputs: {} }, identityA);
      // Ordinary generated reads preserve State's empty unauthorized
      // projection; the member-only page itself refuses above.
      assert.ok('result' in read);
      assert.ok(typeof read.result === 'object' && read.result !== null && 'records' in read.result);
      assert.deepEqual(read.result.records, []);
      assert.deepEqual(await stateSnapshot(), beforeState);
      assert.equal(fallbackCalls, 0);
    }
  } finally {
    await worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
