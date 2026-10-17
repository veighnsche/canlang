/** Civil-date installed consumer (CAN18-v1 C3 installed closure, 2321 acceptance).
 *
 * The compiler admits plain owned `date` filter selectors (DESIGN
 * 1015-1025 operator table: exact typed equality over civil dates, no
 * spelling inventory), and `packages/interfaces/test/date-page-source.test.ts`
 * proves the component path (real `can` binary, real `queryRecords`)
 * with a handwritten query bridge, hand-built PolicyTable/columns, and
 * public-only grants. That is useful component evidence, NOT the
 * original real State/Cloudflare/UI workflow: no installed Cloudflare
 * source-where/field-grant/parent projection is exercised there.
 *
 * This test is the required INSTALLED consumer through the real
 * assembled worker path (actual `can` binary -> `assembleModules` ->
 * `assembleWorker` -> HTTP `worker.fetch`), following the E5
 * filter-where-conjunction / board-calendar-reference-filter harness
 * pattern. The interfaces page-source shim cannot serve here: it
 * forwards `where` straight into the data-only State reader, which
 * cannot evaluate compiled source lambdas. The defining owner under
 * test is the page query adapter (`queryPageRowsInScope`): it splits
 * the UI-composed `{op:and,[where,...filters]}`, evaluates the source
 * predicate FIRST on every granted row (phase A), then applies the
 * data controls over the source-matched domain (phase B).
 *
 * Finite acceptance, all through a real compiled `.can` source:
 * - Two collections over the same date control: a DIRECT saved default
 *   (`defaults={due=preferences.due}`, actor-referencing
 *   lambda where) and a DATE LITERAL default
 *   (`defaults={due=date("2026-10-01")}`, field-to-field lambda where,
 *   proving the conjunction is general, not an actor-equality
 *   exception). Filter parameter names are harvested from the rendered
 *   controls, never transcribed; date controls render as date inputs,
 *   never enum selects.
 * - Saved/request/clear/unknown precedence per list: saved civil dates
 *   narrow through the exact typed equality (boundary dates match
 *   exactly, adjacent dates do not), explicit request beats saved and
 *   literal defaults on the addressed collection only, explicit clear
 *   restores, and well-formed unknown dates (saved or requested) simply
 *   match nothing (200 empty, never a refusal and never a directory).
 * - Malformed selectors (impossible calendar dates, non-date strings,
 *   legacy `filter[field]` envelope) refuse with `validation` before
 *   query or row work.
 * - Source-where conjunction: the actor where and the field-to-field
 *   where each scope their collection; foreign rows stay invisible
 *   through both policy and source where.
 * - DISCRIMINATOR: a source where that reads a denied field
 *   (`staff_note`, outside the granted `name,nick,due,email` fields)
 *   on a control-excluded row surfaces `forbidden` — never reordered
 *   away by the control exclusion (a data-first conjunction would
 *   return 200 with just the control-matching rows).
 * - REVOCATION: revoking a session refuses further page reads for that
 *   caller while other callers keep serving; removing a previously
 *   granted membership (`removeMembership`) refuses further page reads
 *   for that caller under current grants with the teammate unaffected.
 *   No production change: the consumer exposes no failure.
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

const SOURCE = `app DateInstalled
Given
 Customer { name:text, nick:text, due:date, email:email, staff_note:text? }
 policy Customer read=authenticated where=row.email==actor.email fields=name,nick,due,email
When
 crud Customer by=authenticated fields=name,nick,due,email,staff_note
Then
 preferences { due:date? }
 page /customers title="Customers"
  require authenticated and actor.email_verified
  list Customer as saved where actor!=null and saved.email==actor.email filter=due defaults={due=preferences.due} display=split
   text row.name
  table Customer as rep where rep.name!=rep.nick columns=name,due filter=due defaults={due=date("2026-10-01")} empty="No reports match"
   text row.name
 page /leak title="Leak"
  require authenticated and actor.email_verified
  list Customer as leak where leak.name!=leak.nick or leak.staff_note!=null filter=due empty="None"
   text row.name
`;

test('assembled date filters serve owned saved/literal defaults with source-first failure order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-date-installed-'));
  try {
    const path = join(dir, 'DateInstalled.can');
    await writeFile(path, SOURCE);
    let artifact: CompileArtifact;
    try {
      // --native-scenario-receipts is the production emission: it wraps
      // source lambdas ($can$read$issue) with their whereSource markers so
      // the assembled UI facade can bind each original callable through
      // its verified query scope before the adapter splits the conjunction.
      const catalog = process.env['CAN_NATIVE_CATALOG'] ??
        resolve('packages/cloudflare/dist/native-catalog.json');
      artifact = JSON.parse(execFileSync(process.env['CAN_COMPILER_BIN'] ?? resolve('compiler/target/debug/can'),
        ['compile', '--format=json', '--catalog', catalog,
          '--native-scenario-receipts', path],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
    } catch (error) {
      const out = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      throw new Error(`date installed fixture compile failed (the C3 admission must cover it): ${String(out.message)} ` +
        `stdout=${String(out.stdout ?? '').slice(0, 3000)} stderr=${String(out.stderr ?? '').slice(0, 3000)}`);
    }
    assert.ok(!('diagnostics' in artifact), 'real date fixture emits clean');
    assert.equal(artifact.pages.length, 2, 'customers and leak pages emit');
    // The emitted date column type is harvested from the emission (never
    // transcribed): the filter descriptor carries `type:"date"` with an
    // empty value-label map (no spelling inventory), the saved default
    // reads `preferences.due`, the literal default carries the authored
    // civil date, and the preference leaf is marked `date:true`.
    const entryModule = artifact.modules.find(module => module.path === artifact.pages[0]!.module);
    assert.ok(entryModule, 'page module present in real artifact');
    assert.ok(entryModule.js.includes('type:"date"'), 'emitted date column type present');
    assert.ok(entryModule.js.includes('valueLabels:{}'), 'date descriptor carries no spellings');
    assert.ok(entryModule.js.includes('preferences.due'), 'saved default reads the owned preference');
    assert.ok(entryModule.js.includes('"2026-10-01"'), 'literal default carries the authored civil date');
    assert.ok(entryModule.js.includes('date:true'), 'date preference leaf marked');
    // No uiUrl: production assembly serves UI factories through the native
    // query facade, which binds each original source callable before the
    // factory delegates (passing uiUrl would skip the facade, leaving
    // scoped source predicates unbound).
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const teamA = await identities.createTeam({ timezone: 'UTC' });
    const teamB = await identities.createTeam({ timezone: 'UTC' });
    const makeOwner = async (name: string, team: typeof teamA, isOwner: boolean):
      Promise<{ name: string; email: string; team: typeof teamA; identity: ReturnType<typeof makeIdentity>;
        cookie: string; session_id: string; membership_id: string; store: StoragePort }> => {
      const email = `${name}@dateinstalled.test`;
      const user = await identities.createUser({ email, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
        is_owner: isOwner, roles: [] });
      const token = `${name}-dateinstalled-session`;
      const session = await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { name, email, team, identity: makeIdentity({ membership, team, email }),
        cookie: buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!,
        session_id: session.session_id, membership_id: membership.membership_id,
        store: createTestMemoryStorage().store };
    };
    // carol shares agneta's team (and store): removing her previously
    // granted membership later must refuse her while agneta keeps serving.
    const agneta = await makeOwner('agneta', teamA, true);
    const carol = await makeOwner('carol', teamA, false);
    const boris = await makeOwner('boris', teamB, true);
    // Stores are per-team: the teammate shares team A's store (her
    // canonical mutations land where the worker reads them).
    carol.store = agneta.store;
    const stores = new Map([[teamA.team_id, agneta.store], [teamB.team_id, boris.store]]);
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
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(77));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'DateInstalled', forIdentity: async identity => {
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a background work test'); } },
      pageReads: (identity, store: StoragePort) => {
        assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'DateInstalled', ownerPackage: 'DateInstalled', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request),
        preferences },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    type Caller = typeof agneta;
    const page = async (owner: Caller, href: string, status = 200): Promise<string> => {
      const url = new URL(href, 'https://dateinstalled.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return body;
    };
    const pageJson = async (owner: Caller, href: string, status: number): Promise<{ code?: unknown }> => {
      const url = new URL(href, 'https://dateinstalled.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return JSON.parse(body) as { code?: unknown };
    };
    let sequence = 0;
    const create = async (owner: Caller, inputs: Record<string, unknown>): Promise<void> => {
      const invoker = buildInvoker(artifact, asm, owner.store, { memberships: identities, now: () => FIXED_NOW });
      const outcome = await invoker.invokeMutation({ operation: 'DateInstalled.Customer.create',
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, owner.identity);
      assert.ok('result' in outcome, JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.result.status, 'committed');
    };
    // Seed through the real canonical mutation: three own rows on
    // adjacent boundary dates whose names differ from their nicks (the
    // /leak discriminator short-circuits on those, so its control name
    // is harvested from a 200 render before any denied-read row
    // exists).
    const own = { email: agneta.email, staff_note: 'staff only' };
    await create(agneta, { ...own, name: 'Ada', nick: 'A', due: '2026-09-30' });
    await create(agneta, { ...own, name: 'Bo', nick: 'B', due: '2026-10-01' });
    await create(agneta, { ...own, name: 'Cy', nick: 'C', due: '2026-10-02' });

    // Harvest the emitted filter control names (never transcribed): the
    // main page owns a saved-list group then a literal-table group; date
    // controls render as date inputs, never enum selects.
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
      const found = group.filter(name => fieldOf(name) === field);
      assert.equal(found.length, 1, `one ${field} control`);
      return found[0]!;
    };
    const controlKindOf = (html: string, control: string): 'select' | 'input' => {
      const select = new RegExp(`<select[^>]*\\bname="${control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html);
      if (select) return 'select';
      assert.ok(new RegExp(`<input[^>]*\\bname="${control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html), `input ${control} renders`);
      return 'input';
    };
    const controlTypeOf = (html: string, control: string): string => {
      const match = new RegExp(`<input[^>]*\\btype="([^"]+)"[^>]*\\bname="${control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"|<input[^>]*\\bname="${control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*\\btype="([^"]+)"`).exec(html);
      assert.ok(match, `typed input ${control} renders`);
      return (match[1] ?? match[2])!;
    };
    // Each page owns a single list (the main table renders `<table>`
    // rows, never `list-row` items), so the saved/leak list count is the
    // page-global `list-row` count. An empty list renders its empty state
    // instead of an empty `<ul>`, which still counts zero here.
    const listRowsOf = (pageHtml: string): number =>
      (pageHtml.match(/<li class="list-row">/g) ?? []).length;
    const tableSectionOf = (pageHtml: string): string => {
      const match = /<table[\s\S]*?<\/table>/.exec(pageHtml)?.[0] ?? '';
      assert.ok(match.length > 0, 'table section renders');
      return match;
    };

    // The /leak discriminator short-circuits (`or`) on rows whose names
    // differ from their nicks, so with only such rows seeded its source
    // where never reaches the denied field: a clean 200 render to
    // harvest its control name.
    const leakHtml = await page(agneta, '/leak');
    const leakGroups = filterNamesOf(leakHtml);
    assert.equal(leakGroups.length, 1, 'one discriminator control group');
    const leakDue = controlFor(leakGroups[0]!, 'due');
    assert.equal(controlKindOf(leakHtml, leakDue), 'input', 'leak due renders date entry');
    assert.equal(controlTypeOf(leakHtml, leakDue), 'date', 'leak due renders a date input');
    for (const subject of ['Ada', 'Bo', 'Cy']) assert.ok(leakHtml.includes(subject), subject);

    // Now seed the rows whose denied reads must surface: an own row
    // whose name equals its nick (field-to-field where excludes it from
    // the literal table while the denied `or` branch forbids the leak
    // page), a foreign row that must stay invisible through both policy
    // and the actor source where, and the teammate's own row.
    await create(agneta, { ...own, name: 'Same', nick: 'Same', due: '2026-10-01' });
    await create(boris, { email: boris.email, staff_note: 'foreign staff',
      name: 'Foreign', nick: 'F', due: '2026-10-01' });
    await create(carol, { email: carol.email, staff_note: 'carol staff',
      name: 'Caro', nick: 'Ca', due: '2026-10-02' });

    // Defaults: nothing saved, no request selectors. The saved list
    // serves every own row (actor where only); the literal table serves
    // the boundary-date row whose name differs from its nick
    // (field-to-field source where conjoins the literal default). The
    // foreign row stays invisible; the teammate row stays in its own
    // actor domain.
    let html = await page(agneta, '/customers');
    const groups = filterNamesOf(html);
    assert.equal(groups.length, 2, 'saved list then literal table control groups');
    assert.deepEqual(groups[0]!.map(fieldOf), ['due']);
    assert.deepEqual(groups[1]!.map(fieldOf), ['due']);
    const savedDue = controlFor(groups[0]!, 'due');
    const literalDue = controlFor(groups[1]!, 'due');
    assert.equal(controlKindOf(html, savedDue), 'input', 'saved due renders date entry');
    assert.equal(controlTypeOf(html, savedDue), 'date', 'saved due renders a date input');
    assert.equal(controlKindOf(html, literalDue), 'input', 'literal due renders date entry');
    assert.equal(controlTypeOf(html, literalDue), 'date', 'literal due renders a date input');
    assert.equal(listRowsOf(html), 4, 'saved list serves every own row through the actor where');
    let tableSection = tableSectionOf(html);
    assert.ok(tableSection.includes('Bo'), 'table serves Bo');
    for (const subject of ['Ada', 'Cy', 'Same']) assert.ok(!tableSection.includes(subject), `table excludes ${subject}`);
    assert.ok(!html.includes('Foreign'), 'foreign row excluded from page');
    assert.ok(!html.includes('Caro'), 'teammate row excluded from the actor domain');

    // Saved civil dates (wire strings, as the store holds them) narrow
    // the saved list through the exact typed equality while the literal
    // table keeps its authored date: only the boundary-date row matches.
    const prefKey = seenPrefKeys[0]!;
    savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
      agneta.identity.team!.team_id, prefKey.owner, 'due']), { value: '2026-10-02', version: '1' });
    html = await page(agneta, '/customers');
    assert.equal(listRowsOf(html), 1, 'saved list follows the saved date default');
    assert.ok(html.includes('value="2026-10-02"'), 'current date selection renders in the control');
    tableSection = tableSectionOf(html);
    assert.ok(tableSection.includes('Bo'), 'table keeps Bo');

    // Explicit request beats the saved date on the saved list only.
    html = await page(agneta, `/customers?${new URLSearchParams([[savedDue, '2026-09-30']])}`);
    assert.equal(listRowsOf(html), 1, 'explicit date selection serves one saved row');
    tableSection = tableSectionOf(html);
    assert.ok(tableSection.includes('Bo'), 'table unaffected by the list selection');

    // Explicit request beats the literal date on the literal table.
    html = await page(agneta, `/customers?${new URLSearchParams([[literalDue, '2026-10-02']])}`);
    tableSection = tableSectionOf(html);
    assert.ok(tableSection.includes('Cy'), 'table serves Cy under the explicit date selection');
    for (const subject of ['Bo', 'Same']) assert.ok(!tableSection.includes(subject), `table excludes ${subject}`);
    assert.equal(listRowsOf(html), 1, 'saved list unaffected by the table selection');

    // Explicit clear beats the saved date on the saved list.
    html = await page(agneta, `/customers?${new URLSearchParams([[savedDue, '']])}`);
    assert.equal(listRowsOf(html), 4, 'clearing the saved control serves every own row');

    // Explicit clear beats the literal date on the literal table: the
    // field-to-field source where still excludes name==nick.
    html = await page(agneta, `/customers?${new URLSearchParams([[literalDue, '']])}`);
    tableSection = tableSectionOf(html);
    for (const subject of ['Ada', 'Bo', 'Cy']) assert.ok(tableSection.includes(subject), `cleared table serves ${subject}`);
    assert.ok(!tableSection.includes('Same'), 'cleared table still excludes name==nick');

    // A well-formed unknown SAVED date never fails materialization:
    // dates carry no case inventory, so the value narrows the saved
    // list to no rows through the exact typed equality while the
    // literal table is unaffected.
    savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
      agneta.identity.team!.team_id, prefKey.owner, 'due']), { value: '2026-12-25', version: '2' });
    html = await page(agneta, '/customers');
    assert.equal(listRowsOf(html), 0, 'unknown saved date matches nothing');
    tableSection = tableSectionOf(html);
    assert.ok(tableSection.includes('Bo'), 'table unaffected by the unknown default');
    // A well-formed unknown REQUEST date matches nothing (200 empty),
    // never a refusal and never another row.
    savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
      agneta.identity.team!.team_id, prefKey.owner, 'due']), { value: '2026-10-02', version: '3' });
    html = await page(agneta, `/customers?${new URLSearchParams([[savedDue, '2026-11-11']])}`);
    assert.equal(listRowsOf(html), 0, 'unknown request date matches nothing');
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded');

    // Malformed selectors refuse with the exact error: impossible
    // calendar dates and non-date strings are malformed (validation),
    // as is the legacy `filter[field]` envelope.
    for (const params of [new URLSearchParams([[savedDue!, '2026-13-01']]),
      new URLSearchParams([[savedDue!, '2026-02-30']]),
      new URLSearchParams([[savedDue!, 'not-a-date']]),
      new URLSearchParams([['filter[due]', '2026-10-01']])]) {
      assert.equal((await pageJson(agneta, `/customers?${params}`, 400)).code, 'validation');
    }

    // Denied caller (no session) refuses before any query.
    {
      const url = new URL('/customers', 'https://dateinstalled.test');
      url.searchParams.set('team', agneta.team.team_id);
      const response = await worker.fetch(new Request(url));
      assert.equal(response.status, 403);
      assert.equal((JSON.parse(await response.text()) as { code?: unknown }).code, 'forbidden');
    }

    // DISCRIMINATOR: the /leak source where reads the denied staff_note
    // field on every name==nick granted row. Selecting due=2026-09-30
    // excludes the Same row at the controls — yet the denied read on
    // that control-excluded row must still surface `forbidden`, never
    // be reordered away. (A data-first conjunction would return 200
    // with just the boundary rows.) The bare render now forbids too:
    // the Same row's denied read evaluates on the first page.
    assert.equal((await pageJson(agneta, `/leak?${new URLSearchParams([[leakDue, '2026-09-30']])}`, 403)).code,
      'forbidden', 'denied source read on a control-excluded row surfaces');
    assert.equal((await pageJson(agneta, `/leak?${new URLSearchParams([[leakDue, '2026-10-01']])}`, 403)).code,
      'forbidden', 'denied source read on a control-included row surfaces');
    assert.equal((await pageJson(agneta, '/leak', 403)).code,
      'forbidden', 'denied source read surfaces without controls');

    // REVOCATION: boris reads his own row, then his session is revoked.
    // Further page reads refuse for boris while agneta keeps serving.
    const borisHtml = await page(boris, '/customers');
    assert.ok(borisHtml.includes('Foreign'), 'boris serves his own row before revocation');
    assert.ok(!borisHtml.includes('Ada'), 'boris never sees agneta rows');
    await identities.revokeSession(boris.session_id);
    assert.equal((await pageJson(boris, '/customers', 403)).code, 'forbidden', 'revoked session refuses');
    html = await page(agneta, '/customers');
    assert.equal(listRowsOf(html), 1, 'other callers keep serving after the revocation');

    // MEMBERSHIP: carol reads her own row under her previously granted
    // membership, then the membership is removed. Further page reads
    // refuse for carol under current grants while her teammate agneta
    // keeps serving.
    const carolHtml = await page(carol, '/customers');
    assert.equal(listRowsOf(carolHtml), 1, 'carol serves her own row before removal');
    assert.ok(carolHtml.includes('Caro'), 'carol sees her granted row');
    assert.ok(!carolHtml.includes('Ada'), 'carol never sees the teammate rows');
    await identities.removeMembership(carol.membership_id);
    assert.equal((await pageJson(carol, '/customers', 403)).code,
      'forbidden', 'removed membership refuses under current grants');
    html = await page(agneta, '/customers');
    assert.equal(listRowsOf(html), 1, 'teammate keeps serving after the membership removal');
    assert.ok(!html.includes('Caro'), 'removed caller rows stay out of the teammate domain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
