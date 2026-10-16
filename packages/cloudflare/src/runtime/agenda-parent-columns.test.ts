/** Parent-bound agenda with consumed columns (CAN18-v1 agenda binding batch, C4).
 *
 * Two shapes had no factory profile: a nested (parent-bound) agenda
 * (`calendar row.Commitment` under a roster card, the recorded CanShift
 * shape) and agenda `columns=` (the recorded CanLeave shape). This batch
 * connects both at their defining owners, mirroring the accepted
 * timeline bound-sequence contract and the board missing-columns
 * contract: the compiler admits `parent`/`columns` on the agenda
 * profile, and the calendarAgenda factory scopes its authorized query
 * to the enclosing row and renders one owned column line beside each
 * endpoint line. Enum/bool/reference filters and saved defaults reuse
 * the accepted C1/E5 mechanism unchanged (request/default/clear
 * precedence, source-where conjunction with denied reads surfacing
 * `forbidden` before control exclusion).
 *
 * This test is the agenda binding consumer through the real assembled
 * worker path (actual `can` binary -> `assembleModules` ->
 * `assembleWorker` -> HTTP `worker.fetch`), following the
 * board-row-children harness pattern. The interfaces page-source shim
 * cannot serve here: it forwards `where` straight into the data-only
 * State reader, which cannot evaluate compiled source lambdas.
 *
 * Finite acceptance, all through a real compiled `.can` source:
 * - Parent-bound agenda rows render endpoint lines, consumed column
 *   lines, and authored row bodies once per authorized row, in source
 *   order, scoped to the enclosing roster (foreign-roster rows never
 *   leak across callers), each enclosing row serving its own filter
 *   occurrence. Parent-bound agendas here carry filters/columns,
 *   matching the recorded original shapes (which carry no source
 *   lambda `where`); a parent-bound agenda with a source lambda
 *   `where`, or with saved-preference `defaults`, returned 422 in this
 *   harness and stays outside this batch (observed boundary for the
 *   downstream State/Cloudflare query owner, not the Compiler/UI
 *   binding: the same shapes render 200 through the UI factory with
 *   stubbed queries and compile clean). Top-level agendas prove saved
 *   defaults, the E5 conjunction, and the discriminator below and in
 *   the green board-calendar suites.
 * - The same agenda without columns keeps its prior emission (no
 *   column lines).
 * - Enum/reference filter behavior is unchanged: request selection
 *   narrows, saved defaults apply, explicit clear wins, malformed
 *   spellings refuse before query or row work.
 * - DISCRIMINATOR: a source where that reads a denied field on a
 *   control-excluded row surfaces `forbidden` — never reordered away
 *   by the control exclusion.
 * - REVOCATION: revoking a session refuses further page reads for that
 *   caller while other callers keep serving.
 *
 * Loud refusals stay put: C2 text selectors (`skill`), C3
 * date/datetime selectors (`from`/`until`), and unadmitted agenda
 * options (`search=`) keep their exact E6008 refusals (covered by the
 * green calendar_date_selector/board_text_selector/agenda-unknown-option
 * suites).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { CompileArtifact, StoragePort } from '@canlang/contracts';
import {
  handlePageRequest,
  type PageHttpDeps,
  type PagePreferenceKey,
  type PagePreferenceStore,
} from '@canlang/interfaces';
import { buildSessionCookie, sha256HexText } from '@canlang/identity';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, asOperationId, makeIdentity, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleWorker, buildInvoker, type AssemblyDeps } from '../worker/assembly.js';
import { assembleModules } from './modules.js';
import { createPageCursorCodec } from './page-cursor.js';

const SOURCE = `app AgendaBind
Given
 Location { name:text }
 Roster { name:text }
 Commitment in Roster { email:email, location:Location, from:datetime, until:datetime, kind:enum(duty,visit)=duty, conflict:bool=false, note:text? }
 LeakCase { email:email, from:datetime, until:datetime, kind:enum(duty,visit)=duty, note:text? }
 policy Location read=public
 policy Roster read=public
 policy Commitment read=authenticated where=row.email==actor.email fields=email,location,from,until,kind,conflict
 policy LeakCase read=authenticated where=row.email==actor.email fields=email,from,until,kind
When
 crud Location by=authenticated fields=name
 crud Roster by=authenticated fields=name
 crud Commitment by=authenticated fields=email,location,from,until,kind,conflict,note
 crud LeakCase by=authenticated fields=email,from,until,kind,note
Then
 preferences { location:Location?, kind:LeakCase.kind? }
 page /work title="Work"
  require authenticated and actor.email_verified
  list Roster
   card "Roster commitments"
    calendar row.Commitment start=from end=until columns=kind,conflict filter=location,kind,conflict empty="No commitments match"
     pagination
     badge row.kind
     text row.conflict
 page /plain title="Plain"
  require authenticated and actor.email_verified
  list Roster
   card "Unfiltered agenda"
    calendar row.Commitment start=from end=until empty="None"
     badge row.kind
 page /leak title="Leak"
  require authenticated and actor.email_verified
  card "Visit check"
   calendar LeakCase as leak where leak.kind==visit or leak.note!=null start=from end=until filter=kind empty="None"
    badge row.kind
 page /saved title="Saved"
  require authenticated and actor.email_verified
  card "Kind default"
   calendar LeakCase start=from end=until filter=kind defaults={kind=preferences.kind} empty="None"
    badge row.kind
`;

test('assembled parent-bound agendas scope rows to the enclosing roster and render consumed columns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-agenda-bind-'));
  try {
    const path = join(dir, 'AgendaBind.can');
    await writeFile(path, SOURCE);
    let artifact: CompileArtifact;
    try {
      // --native-scenario-receipts is the production emission: it wraps
      // source lambdas ($can$read$issue) with their whereSource markers so
      // the assembled UI facade can bind each original callable through
      // its verified query scope before the adapter splits the conjunction.
      artifact = JSON.parse(execFileSync(process.env['CAN_COMPILER_BIN'] ?? resolve('compiler/target/debug/can'),
        ['compile', '--format=json', '--catalog=packages/values/dist/catalog.json',
          '--native-scenario-receipts', path],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
    } catch (error) {
      const out = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      throw new Error(`agenda binding fixture compile failed (the parent/columns admission must cover it): ${String(out.message)} ` +
        `stdout=${String(out.stdout ?? '').slice(0, 3000)} stderr=${String(out.stderr ?? '').slice(0, 3000)}`);
    }
    assert.ok(!('diagnostics' in artifact), 'real agenda binding fixture emits clean');
    // No uiUrl: production assembly serves UI factories through the native
    // query facade, which binds each original source callable before the
    // factory delegates (passing uiUrl would skip the facade, leaving
    // scoped source predicates unbound).
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const owners = await Promise.all(['agneta', 'boris'].map(async name => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const email = `${name}@agendabind.test`;
      const user = await identities.createUser({ email, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
        is_owner: true, roles: [] });
      const token = `${name}-agendabind-session`;
      const session = await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { name, email, user_id: user.user_id, team, identity: makeIdentity({ membership, team, email }),
        cookie: buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!, session_id: session.session_id,
        store: createTestMemoryStorage().store };
    }));
    const stores = new Map(owners.map(owner => [owner.team.team_id, owner.store]));
    const savedPrefs = new Map<string, { value: string; version: string }>();
    const seenPrefKeys: PagePreferenceKey[] = [];
    const prefKeyOf = (key: PagePreferenceKey): string =>
      JSON.stringify([key.appId, key.actorUserId, key.teamId, key.owner, key.field]);
    const preferences: PagePreferenceStore = {
      read: async key => { seenPrefKeys.push(key); return savedPrefs.get(prefKeyOf(key)) ?? null; },
      save: async key => {
        savedPrefs.set(prefKeyOf(key), { value: key.value, version: String(Number(key.expectedVersion) + 1) });
        return true;
      },
    };
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(42));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'AgendaBind', forIdentity: async identity => {
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a background work test'); } },
      pageReads: (identity, store: StoragePort) => {
        assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'AgendaBind', ownerPackage: 'AgendaBind', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request),
        preferences },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const [agneta, boris] = owners as [typeof owners[number], typeof owners[number]];
    const page = async (owner: typeof owners[number], href: string, status = 200): Promise<string> => {
      const url = new URL(href, 'https://agendabind.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return body;
    };
    const pageJson = async (owner: typeof owners[number], href: string, status: number): Promise<{ code?: unknown }> => {
      const url = new URL(href, 'https://agendabind.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return JSON.parse(body) as { code?: unknown };
    };
    let sequence = 0;
    const create = async (owner: typeof owners[number], operation: string, inputs: Record<string, unknown>): Promise<{ id: string; version: string }[]> => {
      const invoker = buildInvoker(artifact, asm, owner.store, { memberships: identities, now: () => FIXED_NOW });
      const outcome = await invoker.invokeMutation({ operation: `AgendaBind.${operation}`,
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, owner.identity);
      assert.ok('result' in outcome, JSON.stringify(outcome).slice(0, 2000));
      assert.equal(outcome.result.status, 'committed');
      const records = (outcome.result as unknown as { records?: readonly { id?: unknown; version?: unknown }[] }).records ?? [];
      return records.map(record => {
        assert.equal(typeof record.id, 'string', 'created row carries an opaque id');
        return { id: record.id as string, version: String(record.version) };
      });
    };
    const refOf = (record: { id: string; version: string }): { id: string; version: string } =>
      ({ id: record.id, version: record.version });
    const siteOf = async (owner: typeof owners[number], name: string): Promise<{ id: string; version: string }> =>
      (await create(owner, 'Location.create', { name }))[0]!;
    const rosterOf = async (owner: typeof owners[number], name: string): Promise<{ id: string; version: string }> =>
      (await create(owner, 'Roster.create', { name }))[0]!;
    const shiftOf = async (owner: typeof owners[number], inputs: Record<string, unknown>): Promise<string> =>
      (await create(owner, 'Commitment.create', inputs))[0]!.id;
    const itemsOf = (pageHtml: string): number =>
      (pageHtml.match(/<li><span>/g) ?? []).length;
    const columnLinesOf = (pageHtml: string): number =>
      (pageHtml.match(/<p><span>/g) ?? []).length;
    const filterNamesOf = (html: string): string[][] => {
      const names = [...html.matchAll(/<(?:select|input)[^>]*\bname="(can-filter:[^"]+)"[^>]*>/g)].map(match => match[1]!);
      const groups: string[][] = [];
      let current: string | undefined;
      for (const name of names) {
        const occurrence = name.slice('can-filter:'.length, name.lastIndexOf(':'));
        if (occurrence !== current) { current = occurrence; groups.push([]); }
        groups[groups.length - 1]!.push(name);
      }
      return groups;
    };
    const fieldOf = (name: string): string => name.slice(name.lastIndexOf(':') + 1);
    const controlFor = (group: string[], field: string): string => {
      const found = group.find(name => fieldOf(name) === field);
      assert.ok(found !== undefined, `control for ${field}`);
      return found;
    };
    // Seed the visit row first: the /leak discriminator short-circuits
    // (`or`) on visit rows, so with only a visit row seeded its source
    // where never reaches the denied field: a clean 200 render to
    // harvest its control name.
    const hq = await siteOf(agneta, 'HQ');
    const branch = await siteOf(agneta, 'Branch');
    const alpha = await rosterOf(agneta, 'Alpha roster');
    const beta = await rosterOf(agneta, 'Beta roster');
    const day = (n: number): string => `2099-06-0${n}T09:00:00.000Z`;
    const evening = (n: number): string => `2099-06-0${n}T17:00:00.000Z`;
    const leakOf = async (owner: typeof owners[number], inputs: Record<string, unknown>): Promise<string> =>
      (await create(owner, 'LeakCase.create', inputs))[0]!.id;
    await leakOf(agneta, { email: agneta.email, from: day(2), until: evening(2), kind: 'visit' });
    const leakHtml = await page(agneta, '/leak');
    const leakGroups = filterNamesOf(leakHtml);
    assert.equal(leakGroups.length, 1, 'one discriminator control group');
    assert.deepEqual(leakGroups[0]!.map(fieldOf), ['kind']);
    const leakKind = leakGroups[0]![0]!;
    assert.equal(itemsOf(leakHtml), 1, 'visit row renders before duty rows exist');
    // Now seed the duty rows whose denied note reads must surface, plus
    // the parent-bound commitments proving the roster scope binds per
    // enclosing row.
    await leakOf(agneta, { email: agneta.email, from: day(1), until: evening(1), kind: 'duty', note: 'staff only' });
    await shiftOf(agneta, { parent: refOf(alpha), email: agneta.email, location: refOf(hq),
      from: day(2), until: evening(2), kind: 'visit', conflict: true });
    await shiftOf(agneta, { parent: refOf(alpha), email: agneta.email, location: refOf(hq),
      from: day(1), until: evening(1), kind: 'duty', conflict: false, note: 'staff only' });
    await shiftOf(agneta, { parent: refOf(beta), email: agneta.email, location: refOf(branch),
      from: day(3), until: evening(3), kind: 'duty', conflict: false, note: 'staff only' });
    // The column-less parent-bound agenda renders first: endpoint rows
    // and bodies with no column lines (isolates the parent query path
    // from the filter/columns/pagination path below).
    const plain = await page(agneta, '/plain');
    assert.equal(itemsOf(plain), 3, 'column-less agenda serves every own row');
    assert.equal(columnLinesOf(plain), 0, 'column-less agenda renders no column lines');
    // The parent-bound work agenda serves every own row once, grouped by
    // endpoint day in source order, with one consumed column line per
    // declared column beside each endpoint line.
    let html = await page(agneta, '/work');
    const groups = filterNamesOf(html);
    assert.equal(groups.length, 2, 'one control group per enclosing roster occurrence');
    for (const group of groups) assert.deepEqual(group.map(fieldOf).sort(), ['conflict', 'kind', 'location']);
    const alphaKind = controlFor(groups[0]!, 'kind');
    const alphaLocation = controlFor(groups[0]!, 'location');
    assert.equal(itemsOf(html), 3, 'parent-bound agenda serves every own row exactly once');
    assert.equal((html.match(/<section><h2>/g) ?? []).length, 3, 'one endpoint-day section per day');
    assert.equal(columnLinesOf(html), 6, 'two consumed column lines per endpoint row');
    assert.ok(html.includes('<p><span>kind</span>'), 'kind column line renders');
    assert.ok(html.includes('<p><span>conflict</span>'), 'conflict column line renders');
    // Enum/reference filter behavior is unchanged per occurrence:
    // request selection narrows only the addressed roster agenda,
    // explicit clear restores, and malformed spellings refuse before
    // query or row work.
    html = await page(agneta, `/work?${new URLSearchParams([[alphaLocation, branch.id]])}`);
    assert.equal(itemsOf(html), 1, 'branch selection on the alpha occurrence serves only the beta item');
    html = await page(agneta, `/work?${new URLSearchParams([[alphaKind, 'duty']])}`);
    assert.equal(itemsOf(html), 2, 'duty selection on the alpha occurrence keeps both duty items');
    assert.equal(columnLinesOf(html), 4, 'narrowed rows keep their column lines');
    html = await page(agneta, `/work?${new URLSearchParams([[alphaLocation, '']])}`);
    assert.equal(itemsOf(html), 3, 'explicit clear serves every own row');
    assert.equal((await pageJson(agneta, `/work?${new URLSearchParams([[alphaKind, 'bogus']])}`, 400)).code,
      'validation', 'bogus enum spelling refuses');
    assert.equal((await pageJson(agneta, `/work?${new URLSearchParams([[alphaLocation, '\u0001bad']])}`, 400)).code,
      'validation', 'control characters in a reference id refuse');
    assert.equal((await pageJson(agneta, '/work?filter[kind]=duty', 400)).code,
      'validation', 'legacy filter envelope refuses');
    // Denied caller (no session) refuses before any query.
    {
      const url = new URL('/work', 'https://agendabind.test');
      url.searchParams.set('team', agneta.team.team_id);
      const response = await worker.fetch(new Request(url));
      assert.equal(response.status, 403);
      assert.equal((JSON.parse(await response.text()) as { code?: unknown }).code, 'forbidden');
    }
    // DISCRIMINATOR: the /leak source where reads the denied note field
    // on every non-visit granted row. Selecting kind=visit excludes every
    // duty row at the controls — yet the denied reads on those
    // control-excluded rows must still surface `forbidden`, never be
    // reordered away. The bare render forbids too.
    assert.equal((await pageJson(agneta, `/leak?${new URLSearchParams([[leakKind, 'visit']])}`, 403)).code,
      'forbidden', 'denied source read on a control-excluded row surfaces');
    assert.equal((await pageJson(agneta, `/leak?${new URLSearchParams([[leakKind, 'duty']])}`, 403)).code,
      'forbidden', 'denied source read on a control-included row surfaces');
    assert.equal((await pageJson(agneta, '/leak', 403)).code,
      'forbidden', 'denied source read surfaces without controls');
    // Saved defaults flow through request/default/clear precedence on a
    // top-level agenda: nothing saved serves every row, a saved kind
    // default narrows, an explicit request selection wins over the
    // saved default, and explicit clear restores.
    const savedHtml = await page(agneta, '/saved');
    const savedGroups = filterNamesOf(savedHtml);
    assert.equal(savedGroups.length, 1, 'one saved-page control group');
    const savedKind = controlFor(savedGroups[0]!, 'kind');
    assert.equal(itemsOf(savedHtml), 2, 'no saved default serves every row');
    const prefKey = seenPrefKeys[0]!;
    savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
      agneta.identity.team!.team_id, prefKey.owner, 'kind']), { value: 'duty', version: '1' });
    html = await page(agneta, '/saved');
    assert.equal(itemsOf(html), 1, 'agenda follows the saved kind default');
    html = await page(agneta, `/saved?${new URLSearchParams([[savedKind, 'visit']])}`);
    assert.equal(itemsOf(html), 1, 'explicit kind beats the saved kind default');
    html = await page(agneta, `/saved?${new URLSearchParams([[savedKind, '']])}`);
    assert.equal(itemsOf(html), 2, 'explicit clear serves every row');
    // REVOCATION: boris reads his own row, then his session is revoked.
    // Further page reads refuse for boris while agneta keeps serving.
    const depot = await siteOf(boris, 'Depot');
    const borisRoster = await rosterOf(boris, 'Boris roster');
    await shiftOf(boris, { parent: refOf(borisRoster), email: boris.email, location: refOf(depot),
      from: day(4), until: evening(4), kind: 'visit', conflict: false });
    const borisHtml = await page(boris, '/work');
    assert.equal(itemsOf(borisHtml), 1, 'boris serves his own row before revocation');
    await identities.revokeSession(boris.session_id);
    assert.equal((await pageJson(boris, '/work', 403)).code, 'forbidden', 'revoked session refuses');
    html = await page(agneta, '/work');
    assert.equal(itemsOf(html), 3, 'other callers keep serving after the revocation');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
