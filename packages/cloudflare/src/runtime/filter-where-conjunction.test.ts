/** E5 filter+lambda-where conjunction (CAN18-v1 worker B19, lane B).
 *
 * The ONLY enum-selector batch with its rule settled by verified normative
 * text (DESIGN 434 permissions-before-filters, 440 predicate-operand
 * forbidden, 975 defaults-only-declared-controls, 977 typed filters):
 * a source `where` business restriction conjoins with typed filter
 * controls instead of refusing.
 *
 * This test is the actual E5-shape consumer through the real assembled
 * worker path (actual `can` binary -> `assembleModules` -> `assembleWorker`
 * -> HTTP `worker.fetch`), following the owner-page-binding assembly
 * pattern. The interfaces page-source shim cannot serve here: it forwards
 * `where` straight into the data-only State reader, which cannot evaluate
 * compiled source lambdas. The defining owner under test is the page query
 * adapter (`queryPageRowsInScope`): it splits the UI-composed
 * `{op:and,[where,...filters]}`, evaluates the source predicate FIRST on
 * every granted row (phase A, no data predicate, no limit), then applies
 * the data controls over the source-matched domain (phase B).
 *
 * Finite acceptance, all through real compiled `.can` sources:
 * - CanDesk:279 shape: list own-tickets + state/priority filters + full
 *   defaults + pagination (actor-referencing lambda where).
 * - CanMaintain:514 shape: table own-reports + severity/state-style
 *   filters + partial defaults + pagination (field-to-field lambda where,
 *   proving the conjunction is general, not an actor-equality exception).
 * - Selected rows, request/clear/default precedence, malformed/denied
 *   refusals intact.
 * - REVIEW24 cursor continuation: the observed source domain travels as
 *   data, so the emitted next link is genuinely followable (26 own rows
 *   page to a tail row); reusing a link under another control selection,
 *   another identity, or a moved revision restarts loudly (409) instead
 *   of serving foreign rows. No unusable links are emitted.
 * - DISCRIMINATOR: a source where that reads a denied field on a
 *   control-excluded row surfaces `forbidden` — never reordered away by
 *   the control exclusion (a data-first conjunction would return 200 with
 *   just the control-matching rows).
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

const SOURCE = `app FilterWhere
Given
 Ticket { subject:text, category:text, email:email, state:enum(open,closed)=open, priority:enum(low,high)=low, staff_note:text? }
 policy Ticket read=authenticated where=row.email==actor.email fields=subject,category,email,state,priority
When
 crud Ticket by=authenticated fields=subject,category,email,state,priority,staff_note
Then
 preferences { state:Ticket.state?, priority:Ticket.priority? }
 page /mine title="Mine"
  require authenticated and actor.email_verified
  list Ticket as ticket where actor!=null and ticket.email==actor.email filter=state,priority defaults={state=preferences.state,priority=preferences.priority} display=split
   pagination
   badge row.state
   text row.subject
  table Ticket as report where report.subject!=report.category columns=subject,category,state,priority filter=state,priority defaults={priority=preferences.priority} empty="No own reports match"
   pagination
   badge row.state
   text row.subject
 page /leak title="Leak"
  require authenticated and actor.email_verified
  list Ticket as leak where leak.state==closed or leak.staff_note!=null filter=state empty="None"
   text row.subject
`;

test('assembled filter+lambda-where conjunction serves E5 collections with source-first failure order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-filter-where-'));
  try {
    const path = join(dir, 'FilterWhere.can');
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
      throw new Error(`E5 fixture compile failed (the lifted veto must admit it): ${String(out.message)} ` +
        `stdout=${String(out.stdout ?? '').slice(0, 3000)} stderr=${String(out.stderr ?? '').slice(0, 3000)}`);
    }
    assert.ok(!('diagnostics' in artifact), 'real E5 fixture emits clean');
    // No uiUrl: production assembly serves UI factories through the native
    // query facade, which binds each original source callable before the
    // factory delegates (passing uiUrl would skip the facade, leaving
    // scoped source predicates unbound).
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const owners = await Promise.all(['agneta', 'boris', 'cursor'].map(async name => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const email = `${name}@filter.test`;
      const user = await identities.createUser({ email, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
        is_owner: true, roles: [] });
      const token = `${name}-filter-session`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { name, email, team, identity: makeIdentity({ membership, team, email }),
        cookie: buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!, store: createTestMemoryStorage().store };
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
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(71));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'FilterWhere', forIdentity: async identity => {
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a background work test'); } },
      pageReads: (identity, store: StoragePort) => {
        assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'FilterWhere', ownerPackage: 'FilterWhere', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request),
        preferences },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const [agneta, boris, cursor] = owners as
      [typeof owners[number], typeof owners[number], typeof owners[number]];
    const page = async (owner: typeof owners[number], href: string, status = 200): Promise<string> => {
      const url = new URL(href, 'https://filter.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return body;
    };
    const pageJson = async (owner: typeof owners[number], href: string, status: number): Promise<{ code?: unknown }> => {
      const url = new URL(href, 'https://filter.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return JSON.parse(body) as { code?: unknown };
    };
    // Seed through the real canonical mutation: five own rows spanning
    // both enum filters (one with subject==category, excluded only by the
    // table's field-to-field source where) plus one foreign row that must
    // stay invisible to agneta through both policy and source where.
    // Closed rows come first: the /leak discriminator short-circuits on
    // closed rows, so its control name is harvested from a 200 render
    // before any denied-read row exists.
    let sequence = 0;
    const create = async (owner: typeof owners[number], inputs: Record<string, unknown>): Promise<void> => {
      const invoker = buildInvoker(artifact, asm, owner.store, { memberships: identities, now: () => FIXED_NOW });
      const outcome = await invoker.invokeMutation({ operation: 'FilterWhere.Ticket.create',
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, owner.identity);
      assert.ok('result' in outcome, JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.result.status, 'committed');
    };
    const own = { email: agneta.email, staff_note: 'staff only' };
    await create(agneta, { ...own, subject: 'Gamma', category: 'C3', state: 'closed', priority: 'low' });
    await create(agneta, { ...own, subject: 'Delta', category: 'C4', state: 'closed', priority: 'high' });

    // Harvest the emitted filter control names (never transcribed): each
    // collection occurrence owns one state control and, on /mine, one
    // priority control.
    const filterNamesOf = (html: string): string[][] => {
      const names = [...html.matchAll(/<select[^>]*\bname="(can-filter:[^"]+)"[^>]*>/g)].map(match => match[1]!);
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

    // The /leak discriminator short-circuits (`or`) on closed rows, so
    // with only closed rows seeded its source where never reaches the
    // denied field: a clean 200 render to harvest its control name.
    const leakHtml = await page(agneta, '/leak');
    const leakGroups = filterNamesOf(leakHtml);
    assert.equal(leakGroups.length, 1, 'one discriminator control group');
    const leakState = controlFor(leakGroups[0]!, 'state');
    for (const subject of ['Gamma', 'Delta']) assert.ok(leakHtml.includes(subject), subject);

    // Now seed the rows whose denied reads must surface: open own rows
    // (control-excluded under a closed selection) plus the foreign row.
    await create(agneta, { ...own, subject: 'Alpha', category: 'C1', state: 'open', priority: 'low' });
    await create(agneta, { ...own, subject: 'Beta', category: 'C2', state: 'open', priority: 'high' });
    await create(agneta, { ...own, subject: 'Same', category: 'Same', state: 'open', priority: 'low' });
    await create(boris, { email: boris.email, staff_note: 'foreign staff',
      subject: 'Foreign', category: 'F1', state: 'open', priority: 'low' });

    // Defaults: nothing saved, no request selectors. The list serves every
    // own row (actor where only); the table serves every own row whose
    // subject differs from its category (field-to-field source where). The
    // foreign row stays invisible; with five rows there is no next cursor.
    let html = await page(agneta, '/mine');
    const groups = filterNamesOf(html);
    assert.equal(groups.length, 2, 'list then table control groups');
    assert.deepEqual(groups[0]!.map(fieldOf).sort(), ['priority', 'state']);
    assert.deepEqual(groups[1]!.map(fieldOf).sort(), ['priority', 'state']);
    const listState = controlFor(groups[0]!, 'state');
    // The split list renders one selection row per served record (no
    // subjects in links); the table renders subject cells. Scoping each
    // collection to its own section keeps list/table selection apart.
    const listSectionOf = (pageHtml: string): string => {
      const match = /<ul class="list">[\s\S]*?<\/ul>/.exec(pageHtml)?.[0] ?? '';
      assert.ok(match.length > 0, 'list section renders');
      return match;
    };
    const listRowsOf = (pageHtml: string): number =>
      (listSectionOf(pageHtml).match(/<li class="list-row">/g) ?? []).length;
    const tableSectionOf = (pageHtml: string): string => {
      const match = /<table[\s\S]*?<\/table>/.exec(pageHtml)?.[0] ?? '';
      assert.ok(match.length > 0, 'table section renders');
      return match;
    };
    assert.equal(listRowsOf(html), 5, 'list serves every own row through the actor where');
    let tableSection = tableSectionOf(html);
    for (const subject of ['Alpha', 'Beta', 'Gamma', 'Delta']) assert.ok(tableSection.includes(subject), subject);
    assert.ok(!tableSection.includes('Same'), 'table source where excludes subject==category');
    assert.ok(!tableSection.includes('Foreign'), 'foreign row excluded from table');
    assert.ok(!html.includes('Foreign'), 'foreign row excluded from page');
    assert.ok(!html.includes('rel="next"'), 'no continuation under the page bound');

    // Saved defaults filter rows. The preference store is shared, but each
    // collection follows only its declared defaults: state=open narrows
    // the list (full defaults) while the table keeps serving every
    // priority (partial defaults, CanMaintain shape).
    const prefKey = seenPrefKeys[0]!;
    const savePref = (field: string, value: string): void => {
      savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
        agneta.identity.team!.team_id, prefKey.owner, field]), { value, version: '1' });
    };
    savePref('state', 'open');
    html = await page(agneta, '/mine');
    assert.equal(listRowsOf(html), 3, 'list follows the saved state default');
    tableSection = tableSectionOf(html);
    for (const subject of ['Alpha', 'Beta', 'Gamma', 'Delta']) assert.ok(tableSection.includes(subject), subject);
    assert.ok(!tableSection.includes('Same'), 'table still excludes subject==category');

    // Saving priority=high narrows both collections through their own
    // defaults: the list serves open+high, the table high only.
    savePref('priority', 'high');
    html = await page(agneta, '/mine');
    assert.equal(listRowsOf(html), 1, 'list serves open+high only');
    tableSection = tableSectionOf(html);
    for (const subject of ['Beta', 'Delta']) assert.ok(tableSection.includes(subject), subject);
    for (const subject of ['Alpha', 'Gamma', 'Same']) assert.ok(!tableSection.includes(subject), `table excludes: ${subject}`);

    // Explicit request beats saved defaults on the addressed collection
    // only: closed on the list serves Delta (closed+high) while the table
    // keeps following its saved priority default.
    html = await page(agneta, `/mine?${new URLSearchParams([[listState, 'closed']])}`);
    assert.equal(listRowsOf(html), 1, 'explicit closed selection serves one list row');
    tableSection = tableSectionOf(html);
    assert.ok(tableSection.includes('Delta'), 'table unaffected by the list selection');

    // Explicit clear beats saved defaults per control: clearing state
    // leaves the saved priority default active (high rows only).
    html = await page(agneta, `/mine?${new URLSearchParams([[listState, '']])}`);
    assert.equal(listRowsOf(html), 2, 'clearing state leaves saved priority active');
    // Clearing priority as well returns every own row through the list.
    const listPriority = controlFor(groups[0]!, 'priority');
    html = await page(agneta, `/mine?${new URLSearchParams([[listState, ''], [listPriority, '']])}`);
    assert.equal(listRowsOf(html), 5, 'clearing all list controls serves every own row');
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded after clear');

    // Malformed selectors refuse before query or row work.
    for (const params of [new URLSearchParams([[listState!, 'bogus']]),
      new URLSearchParams([['filter[state]', 'open']])]) {
      assert.equal((await pageJson(agneta, `/mine?${params}`, 400)).code, 'validation');
    }

    // Denied caller (no session) refuses before any query.
    {
      const url = new URL('/mine', 'https://filter.test');
      url.searchParams.set('team', agneta.team.team_id);
      const response = await worker.fetch(new Request(url));
      assert.equal(response.status, 403);
      assert.equal((JSON.parse(await response.text()) as { code?: unknown }).code, 'forbidden');
    }

    // DISCRIMINATOR: the /leak source where reads the denied staff_note
    // field on every non-closed granted row. Selecting state=closed
    // excludes every open row at the controls — yet the denied reads on
    // those control-excluded rows must still surface `forbidden`, never
    // be reordered away. (A data-first conjunction would return 200 with
    // just the closed rows.) The bare render now forbids too: the open
    // rows' denied reads evaluate on the first page.
    assert.equal((await pageJson(agneta, `/leak?${new URLSearchParams([[leakState, 'closed']])}`, 403)).code,
      'forbidden', 'denied source read on a control-excluded row surfaces');
    assert.equal((await pageJson(agneta, `/leak?${new URLSearchParams([[leakState, 'open']])}`, 403)).code,
      'forbidden', 'denied source read on a control-included row surfaces');
    assert.equal((await pageJson(agneta, '/leak', 403)).code,
      'forbidden', 'denied source read surfaces without controls');

    // Cursor pages (REVIEW24): the source domain travels as data, so the
    // emitted next link is genuinely followable — no function identity in
    // cursor state. 26 own rows slice to the page bound with a next link;
    // following it serves the remaining row through the same verified
    // original. Reusing the link under another control selection, or
    // after the store moved, restarts loudly instead of serving foreign
    // rows: occurrence/filter/revision/actor-team binding holds.
    for (let index = 1; index <= 26; index++) {
      await create(cursor, { email: cursor.email, staff_note: 'staff only',
        subject: `Ck${String(index).padStart(2, '0')}`, category: 'CC',
        state: 'open', priority: 'low' });
    }
    // The split list renders one selection link per served record (row
    // headings, not subjects); the table renders subject cells. List row
    // identity proves follow progress without transcribing record ids.
    const listIdsOf = (pageHtml: string): string[] =>
      [...listSectionOf(pageHtml).matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map(match => match[1]!);
    const firstHtml = await page(cursor, '/mine');
    const firstIds = listIdsOf(firstHtml);
    assert.equal(firstIds.length, 25, 'first page serves 25 list rows');
    assert.equal(new Set(firstIds).size, 25, 'first-page list rows are distinct');
    assert.ok(firstHtml.includes('Ck01'), 'table first page serves rows');
    assert.ok(!firstHtml.includes('Ck26'), 'first page slices at the bound');
    const next = /<a rel="next" href="([^"]+)"/.exec(firstHtml)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(next, 'first page issues a next-page link');
    // Both collections slice: the first page carries one next link each.
    assert.equal(firstHtml.match(/rel="next"/g)?.length ?? 0, 2, 'first page links both collections');
    const secondHtml = await page(cursor, next);
    const secondIds = listIdsOf(secondHtml);
    assert.equal(secondIds.length, 1, 'follow serves the one remaining list row');
    assert.ok(!firstIds.includes(secondIds[0]!), 'follow advances past the first page');
    // The followed list is exhausted (no list link); the table keeps its
    // own first-page link.
    assert.equal(secondHtml.match(/rel="next"/g)?.length ?? 0, 1, 'last list page issues no list link');
    // Another control selection cannot reuse the binding: the same cursor
    // under a state selection restarts instead of serving.
    const cursorListState = controlFor(filterNamesOf(firstHtml)[0]!, 'state');
    const rebound = new URLSearchParams(next.split('?')[1] ?? '').toString();
    assert.equal((await pageJson(cursor,
      `/mine?${rebound}&${new URLSearchParams([[cursorListState, 'closed']])}`, 409)).code,
      'conflict', 'cursor binding rejects a changed control selection');
    // Another actor-team cannot reuse the binding either.
    assert.equal((await pageJson(boris, next, 409)).code,
      'conflict', 'cursor binding rejects another identity');
    // A store write between pages restarts: the cursor revision no longer
    // fences the read.
    await create(cursor, { email: cursor.email, staff_note: 'staff only',
      subject: 'Ck27', category: 'CC', state: 'open', priority: 'low' });
    assert.equal((await pageJson(cursor, next, 409)).code,
      'conflict', 'cursor binding rejects a moved revision');
    // Recovery: a fresh first page at the new revision issues a new link
    // whose follow serves both remaining rows.
    const refreshed = await page(cursor, '/mine');
    const refreshedIds = listIdsOf(refreshed);
    assert.equal(refreshedIds.length, 25, 'refreshed first page serves 25 list rows');
    const renewed = /<a rel="next" href="([^"]+)"/.exec(refreshed)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(renewed, 'refreshed first page reissues a next-page link');
    const recovered = await page(cursor, renewed);
    const recoveredIds = listIdsOf(recovered);
    assert.equal(recoveredIds.length, 2, 'recovery follow serves the two tail rows');
    for (const id of recoveredIds) assert.ok(!refreshedIds.includes(id), 'recovery follow advances');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
