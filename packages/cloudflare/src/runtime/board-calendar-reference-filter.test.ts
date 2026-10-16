/** Board + calendar-agenda reference filters (CAN18-v1 reference-filter batch, C1).
 *
 * The reference-filter batch settles the C1 board/calendar shapes that bottom
 * out on stored-model-reference selectors (DESIGN 434 permissions-before-
 * filters, 440 predicate-operand forbidden, 975 defaults-only-declared-
 * controls, 977 typed filters): a `Location` model reference and a `user`
 * reference compare by typed opaque identity (`{id}`), never an enum
 * spelling, and conjoin with the source `where` business restriction through
 * the accepted E5 checked-conjunction mechanism (compiler `ref:`/`user`
 * lowering + Cloudflare invoke.ts filter-where conjunction + UI opaque-entry
 * controls). No new grants, no weakened permissions, no candidate directory:
 * unknown references simply match nothing (DESIGN 1027).
 *
 * This test is the board/calendar C1-shape consumer through the real
 * assembled worker path (actual `can` binary -> `assembleModules` ->
 * `assembleWorker` -> HTTP `worker.fetch`), following the E5
 * board-calendar-filter-where harness pattern. The interfaces page-source
 * shim cannot serve here: it forwards `where` straight into the
 * data-only State reader, which cannot evaluate compiled source lambdas.
 *
 * Finite acceptance, all through a real compiled `.can` source:
 * - Board own-tickets + site/owner/state/priority filters + full defaults
 *   (actor-referencing lambda where, mirroring the CanCRM board shape minus
 *   its C2/C3/C4 followers).
 * - Calendar-agenda own-visits + site/state/priority filters + partial
 *   defaults (field-to-field lambda where, proving the conjunction is
 *   general over lambda shapes).
 * - Reference selections flow request/default/clear precedence per control;
 *   an unknown reference matches nothing (200 empty, never a directory).
 * - Reference controls render as opaque text entry, never enum selects.
 * - Malformed selectors (bogus enum spelling, control characters in a
 *   reference id) refuse before query or row work, on both collections.
 * - DISCRIMINATOR: a source where that reads a denied field on a
 *   control-excluded row surfaces `forbidden` — never reordered away by
 *   the control exclusion (a data-first conjunction would return 200
 *   with just the control-matching rows).
 * - REVOCATION: revoking a session refuses further page reads for that
 *   caller while other callers keep serving.
 *
 * The remaining frozen original24 board/calendar occurrences (CanExpense
 * category/business_date, CanLeave from/until/columns, CanField skill)
 * stay loudly refused: text/date/datetime selectors and agenda `columns=`
 * are outside the C1 reference batch (C2/C3/C4).
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

const SOURCE = `app BoardCalRef
Given
 Location { name:text }
 Ticket { subject:text, category:text, email:email, site:Location, owner:user, from:datetime, until:datetime, state:enum(open,closed)=open, priority:enum(low,high)=low, staff_note:text? }
 policy Location read=public
 policy Ticket read=authenticated where=row.email==actor.email fields=subject,category,email,site,owner,from,until,state,priority
When
 crud Location by=authenticated fields=name
 crud Ticket by=authenticated fields=subject,category,email,site,owner,from,until,state,priority,staff_note
Then
 preferences { site:Location?, state:Ticket.state?, priority:Ticket.priority? }
 page /work title="Work"
  require authenticated and actor.email_verified
  board Ticket as ticket where actor!=null and ticket.email==actor.email by=state columns=subject,site,owner,state,priority filter=site,owner,state,priority defaults={site=preferences.site,state=preferences.state,priority=preferences.priority} empty="No own tickets match"
  calendar Ticket as visit where visit.subject!=visit.category start=from end=until filter=site,state,priority defaults={site=preferences.site,priority=preferences.priority} empty="No visits match"
   pagination
   badge row.state
   text row.subject
 page /leak title="Leak"
  require authenticated and actor.email_verified
  board Ticket as leak where leak.state==closed or leak.staff_note!=null by=state columns=subject filter=state empty="None"
`;

test('assembled board/calendar reference filters serve opaque identities with source-first failure order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-boardcal-ref-filter-'));
  try {
    const path = join(dir, 'BoardCalRef.can');
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
      throw new Error(`board/calendar reference fixture compile failed (the C1 admission must cover it): ${String(out.message)} ` +
        `stdout=${String(out.stdout ?? '').slice(0, 3000)} stderr=${String(out.stderr ?? '').slice(0, 3000)}`);
    }
    assert.ok(!('diagnostics' in artifact), 'real board/calendar reference fixture emits clean');
    // No uiUrl: production assembly serves UI factories through the native
    // query facade, which binds each original source callable before the
    // factory delegates (passing uiUrl would skip the facade, leaving
    // scoped source predicates unbound).
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const owners = await Promise.all(['agneta', 'boris'].map(async name => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const email = `${name}@boardcalref.test`;
      const user = await identities.createUser({ email, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
        is_owner: true, roles: [] });
      const token = `${name}-boardcalref-session`;
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
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(73));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'BoardCalRef', forIdentity: async identity => {
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a background work test'); } },
      pageReads: (identity, store: StoragePort) => {
        assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'BoardCalRef', ownerPackage: 'BoardCalRef', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request),
        preferences },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const [agneta, boris] = owners as [typeof owners[number], typeof owners[number]];
    const page = async (owner: typeof owners[number], href: string, status = 200): Promise<string> => {
      const url = new URL(href, 'https://boardcalref.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return body;
    };
    const pageJson = async (owner: typeof owners[number], href: string, status: number): Promise<{ code?: unknown }> => {
      const url = new URL(href, 'https://boardcalref.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return JSON.parse(body) as { code?: unknown };
    };
    let sequence = 0;
    const from = new Date(FIXED_NOW).toISOString();
    const until = new Date(FIXED_NOW + 3_600_000).toISOString();
    const create = async (owner: typeof owners[number], operation: string, inputs: Record<string, unknown>): Promise<{ id: string; version: string }[]> => {
      const invoker = buildInvoker(artifact, asm, owner.store, { memberships: identities, now: () => FIXED_NOW });
      const outcome = await invoker.invokeMutation({ operation: `BoardCalRef.${operation}`,
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, owner.identity);
      assert.ok('result' in outcome, JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.result.status, 'committed');
      const records = (outcome.result as unknown as { records?: readonly { id?: unknown; version?: unknown }[] }).records ?? [];
      return records.map(record => {
        assert.equal(typeof record.id, 'string', 'created row carries an opaque id');
        return { id: record.id as string, version: String(record.version) };
      });
    };
    // Two office locations: reference selections below address them by
    // opaque id, never by name spelling. Versioned model references travel
    // as `{id, version}` mutations and compare by identity downstream.
    const [headquarters] = await create(agneta, 'Location.create', { name: 'Headquarters' });
    const [branch] = await create(agneta, 'Location.create', { name: 'Branch' });
    assert.ok(headquarters && branch && headquarters.id !== branch!.id);
    const siteRef = (site: { id: string; version: string }): { id: string; version: string } =>
      ({ id: site.id, version: site.version });
    // Seed through the real canonical mutation: five own rows spanning
    // both locations, both enum filters, and both owners of interest (one
    // with subject==category, excluded only by the agenda's field-to-field
    // source where) plus one foreign row that must stay invisible to
    // agneta through both policy and source where. Closed rows come first:
    // the /leak discriminator short-circuits on closed rows, so its
    // control name is harvested from a 200 render before any denied-read
    // row exists.
    const own = { email: agneta.email, from, until, staff_note: 'staff only', owner: { id: agneta.user_id } };
    await create(agneta, 'Ticket.create', { ...own, subject: 'Gamma', category: 'C3', site: siteRef(headquarters!), state: 'closed', priority: 'low' });
    await create(agneta, 'Ticket.create', { ...own, subject: 'Delta', category: 'C4', site: siteRef(branch!), state: 'closed', priority: 'high' });

    // Harvest the emitted filter control names (never transcribed): the
    // board owns a site+owner+state+priority group, then the agenda owns
    // its own site+state+priority group. Reference controls render as
    // opaque text entry; enum controls render as selects.
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
    await create(agneta, 'Ticket.create', { ...own, subject: 'Alpha', category: 'C1', site: siteRef(headquarters!), state: 'open', priority: 'low' });
    await create(agneta, 'Ticket.create', { ...own, subject: 'Beta', category: 'C2', site: siteRef(branch!), state: 'open', priority: 'high' });
    await create(agneta, 'Ticket.create', { ...own, subject: 'Same', category: 'Same', site: siteRef(headquarters!), state: 'open', priority: 'low' });
    // Stores are per-team: the foreign row references a location in its
    // own store, staying invisible to agneta through policy and the actor
    // source where regardless of its site.
    const [foreignSite] = await create(boris, 'Location.create', { name: 'Foreign branch' });
    await create(boris, 'Ticket.create', { email: boris.email, from, until, staff_note: 'foreign staff',
      subject: 'Foreign', category: 'F1', site: siteRef(foreignSite!), owner: { id: boris.user_id }, state: 'open', priority: 'low' });

    // The board groups cards under one section per enum case; the agenda
    // groups items under one section per day. Scoping each collection to
    // its own section keeps board/agenda selection apart.
    const boardSectionOf = (pageHtml: string, group: string): string => {
      const match = new RegExp(`<section data-group="${group}">[\\s\\S]*?</ul></section>`).exec(pageHtml)?.[0] ?? '';
      assert.ok(match.length > 0, `board ${group} section renders`);
      return match;
    };
    const boardCardsOf = (pageHtml: string): number =>
      (pageHtml.match(/<li data-row="/g) ?? []).length;
    const agendaItemsOf = (pageHtml: string): number =>
      (pageHtml.match(/<li><span>/g) ?? []).length;

    // Defaults: nothing saved, no request selectors. The board serves
    // every own row (actor where only); the agenda serves every own row
    // whose subject differs from its category (field-to-field source
    // where). The foreign row stays invisible.
    let html = await page(agneta, '/work');
    const groups = filterNamesOf(html);
    assert.equal(groups.length, 2, 'board then agenda control groups');
    assert.deepEqual(groups[0]!.map(fieldOf).sort(), ['owner', 'priority', 'site', 'state']);
    assert.deepEqual(groups[1]!.map(fieldOf).sort(), ['priority', 'site', 'state']);
    const boardSite = controlFor(groups[0]!, 'site');
    const boardOwner = controlFor(groups[0]!, 'owner');
    const boardState = controlFor(groups[0]!, 'state');
    const agendaSite = controlFor(groups[1]!, 'site');
    // Reference controls are opaque text entry, never enum selects; enum
    // controls stay selects.
    assert.equal(controlKindOf(html, boardSite), 'input', 'site renders opaque entry');
    assert.equal(controlKindOf(html, boardOwner), 'input', 'owner renders opaque entry');
    assert.equal(controlKindOf(html, boardState), 'select', 'state stays a select');
    assert.equal(controlKindOf(html, agendaSite), 'input', 'agenda site renders opaque entry');
    assert.equal(boardCardsOf(html), 5, 'board serves every own row through the actor where');
    for (const subject of ['Alpha', 'Beta', 'Same', 'Gamma', 'Delta']) assert.ok(html.includes(subject), subject);
    assert.equal(agendaItemsOf(html), 4, 'agenda serves own rows minus subject==category');
    assert.ok(!html.includes('Foreign'), 'foreign row excluded from page');

    // Explicit owner selection beats no default: the owner control has no
    // saved default (975 subset), so the board serves every own row until
    // addressed. The caller's own identity selects all five; a foreign
    // identity selects nothing the caller may see.
    html = await page(agneta, `/work?${new URLSearchParams([[boardOwner, agneta.user_id]])}`);
    assert.equal(boardCardsOf(html), 5, 'own identity selects every own row');
    assert.equal(agendaItemsOf(html), 4, 'agenda unaffected by the board selection');
    html = await page(agneta, `/work?${new URLSearchParams([[boardOwner, boris.user_id]])}`);
    assert.equal(boardCardsOf(html), 0, 'foreign identity matches no visible row');
    assert.ok(html.includes('No own tickets match'), 'empty board renders its empty message');
    // An unknown reference is not a directory lookup: it matches nothing
    // (200 empty), never a refusal and never another row.
    html = await page(agneta, `/work?${new URLSearchParams([[boardOwner, '00000000-0000-0000-0000-000000000000']])}`);
    assert.equal(boardCardsOf(html), 0, 'unknown identity matches nothing');
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded');

    // Explicit site selection narrows by opaque identity: headquarters
    // serves its three rows, branch its two.
    html = await page(agneta, `/work?${new URLSearchParams([[boardSite, headquarters!.id]])}`);
    assert.equal(boardCardsOf(html), 3, 'headquarters selection serves three board cards');
    for (const subject of ['Alpha', 'Same', 'Gamma']) assert.ok(boardSectionOf(html, subject === 'Gamma' ? 'closed' : 'open').includes(subject), subject);
    assert.equal(agendaItemsOf(html), 4, 'agenda unaffected by the board site selection');
    html = await page(agneta, `/work?${new URLSearchParams([[agendaSite, branch!.id]])}`);
    assert.equal(agendaItemsOf(html), 2, 'agenda branch selection serves two items');
    for (const subject of ['Beta', 'Delta']) assert.ok(html.includes(subject), `agenda serves ${subject}`);
    assert.equal(boardCardsOf(html), 5, 'board unaffected by the agenda site selection');

    // Saved defaults filter rows. The preference store is shared, but each
    // collection follows only its declared defaults: site=headquarters
    // narrows both collections through their own site defaults while the
    // board keeps every state (no state default saved yet).
    const prefKey = seenPrefKeys[0]!;
    const savePref = (field: string, value: string): void => {
      savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
        agneta.identity.team!.team_id, prefKey.owner, field]), { value, version: '1' });
    };
    savePref('site', headquarters!.id);
    html = await page(agneta, '/work');
    assert.equal(boardCardsOf(html), 3, 'board follows the saved site default');
    assert.ok(!boardSectionOf(html, 'open').includes('Beta'), 'board excludes the branch row');
    // The agenda declares its own site default, so the saved headquarters
    // selection applies to it too: Beta and Delta (branch) drop out.
    assert.equal(agendaItemsOf(html), 2, 'agenda follows the saved site default');

    // Saving state=open narrows the board through its own default while
    // the agenda keeps every priority (partial defaults): open headquarters
    // rows are Alpha and Same; the agenda keeps Alpha and Gamma (it declares
    // no state default).
    savePref('state', 'open');
    html = await page(agneta, '/work');
    assert.equal(boardCardsOf(html), 2, 'board serves open headquarters rows only');
    assert.ok(html.includes('Alpha'), 'board keeps Alpha');
    assert.equal(agendaItemsOf(html), 2, 'agenda ignores the undeclared state default');

    // Explicit request beats saved defaults on the addressed collection
    // only: branch on the board serves Beta (open+branch) while the agenda
    // keeps following its saved headquarters default.
    html = await page(agneta, `/work?${new URLSearchParams([[boardSite, branch!.id]])}`);
    assert.equal(boardCardsOf(html), 1, 'explicit branch selection serves one board card');
    assert.ok(boardSectionOf(html, 'open').includes('Beta'), 'board serves Beta');
    assert.equal(agendaItemsOf(html), 2, 'agenda unaffected by the board selection');

    // Explicit clear beats saved defaults per control: clearing site
    // leaves the saved state default active (open rows only, every site).
    html = await page(agneta, `/work?${new URLSearchParams([[boardSite, '']])}`);
    assert.equal(boardCardsOf(html), 3, 'clearing site leaves saved state active');
    // Clearing state as well as site leaves no restriction on either
    // control: an explicit clear stays cleared rather than reapplying its
    // default, so every own row serves.
    html = await page(agneta, `/work?${new URLSearchParams([[boardSite, ''], [boardState, '']])}`);
    assert.equal(boardCardsOf(html), 5, 'clearing all saved controls serves every own row');
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded after clear');

    // Malformed selectors refuse before query or row work, on both
    // collections: a bogus enum spelling, a control character inside a
    // reference identity, and a legacy `filter[` envelope.
    const agendaState = controlFor(groups[1]!, 'state');
    for (const params of [new URLSearchParams([[boardState!, 'bogus']]),
      new URLSearchParams([[agendaState!, 'bogus']]),
      new URLSearchParams([[boardSite!, '\u0001bad']]),
      new URLSearchParams([['filter[state]', 'open']])]) {
      assert.equal((await pageJson(agneta, `/work?${params}`, 400)).code, 'validation');
    }

    // Denied caller (no session) refuses before any query.
    {
      const url = new URL('/work', 'https://boardcalref.test');
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

    // REVOCATION: boris reads his own row, then his session is revoked.
    // Further page reads refuse for boris while agneta keeps serving.
    const borisHtml = await page(boris, '/work');
    assert.ok(borisHtml.includes('Foreign'), 'boris serves his own row before revocation');
    assert.ok(!borisHtml.includes('Alpha'), 'boris never sees agneta rows');
    await identities.revokeSession(boris.session_id);
    assert.equal((await pageJson(boris, '/work', 403)).code, 'forbidden', 'revoked session refuses');
    html = await page(agneta, '/work');
    assert.equal(boardCardsOf(html), 2, 'other callers keep serving after the revocation');
    assert.ok(html.includes('Alpha'), 'agneta still serves her saved-default rows');
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
