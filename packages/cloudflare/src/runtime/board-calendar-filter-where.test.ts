/** Board + calendar-agenda filter+lambda-where conjunction (CAN18-v1 board/calendar filter batch).
 *
 * The ONLY enum-selector batch with its rule settled by verified normative
 * text (DESIGN 434 permissions-before-filters, 440 predicate-operand
 * forbidden, 975 defaults-only-declared-controls, 977 typed filters):
 * a source `where` business restriction conjoins with typed filter
 * controls instead of refusing. The compiler/UI/adapter mechanism is the
 * accepted E5 path reused exactly (no new grants, no weakened
 * permissions): compiler admits enum/bool columns with matching owned
 * declarations and Lambda `where`, UI `prepareSourceFilters` composes
 * `{op:and,[where,...filters]}`, and the page query adapter
 * (`queryPageRowsInScope`) splits the conjunction, evaluating the source
 * predicate FIRST on every granted row (phase A) before the data controls
 * (phase B).
 *
 * This test is the board/calendar E5-shape consumer through the real
 * assembled worker path (actual `can` binary -> `assembleModules` ->
 * `assembleWorker` -> HTTP `worker.fetch`), following the B19
 * filter-where-conjunction harness pattern. The interfaces page-source
 * shim cannot serve here: it forwards `where` straight into the
 * data-only State reader, which cannot evaluate compiled source lambdas.
 *
 * Finite acceptance, all through a real compiled `.can` source:
 * - Board own-tickets + state/priority filters + full defaults
 *   (actor-referencing lambda where, mirroring the CanField board shape
 *   minus its unsupported model-reference/text selectors).
 * - Calendar-agenda own-visits + state/priority filters + partial
 *   defaults (field-to-field lambda where, proving the conjunction is
 *   general over lambda shapes, not an actor-equality exception).
 * - Selected rows, request/default/clear precedence, malformed/denied
 *   refusals intact.
 * - DISCRIMINATOR: a source where that reads a denied field on a
 *   control-excluded row surfaces `forbidden` — never reordered away by
 *   the control exclusion (a data-first conjunction would return 200
 *   with just the control-matching rows).
 * - REVOCATION: revoking a session refuses further page reads for that
 *   caller while other callers keep serving.
 *
 * The frozen original24 board/calendar occurrences (CanCRM/CanExpense/
 * CanField boards, CanShift/CanLeave/CanField calendars) stay loudly
 * refused: every one bottoms out on a genuinely unsupported selector
 * (model-reference `location`, identity `owner`, text `category`/`skill`,
 * date `business_date`, datetime `from`/`until`), which is outside the
 * E5 enum-selector batch. None of those is absorbed here.
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

const SOURCE = `app BoardCal
Given
 Ticket { subject:text, category:text, email:email, from:datetime, until:datetime, state:enum(open,closed)=open, priority:enum(low,high)=low, staff_note:text? }
 policy Ticket read=authenticated where=row.email==actor.email fields=subject,category,email,from,until,state,priority
When
 crud Ticket by=authenticated fields=subject,category,email,from,until,state,priority,staff_note
Then
 preferences { state:Ticket.state?, priority:Ticket.priority? }
 page /work title="Work"
  require authenticated and actor.email_verified
  board Ticket as ticket where actor!=null and ticket.email==actor.email by=state columns=subject,state,priority filter=state,priority defaults={state=preferences.state,priority=preferences.priority} empty="No own tickets match"
  calendar Ticket as visit where visit.subject!=visit.category start=from end=until filter=state,priority defaults={priority=preferences.priority} empty="No visits match"
   pagination
   badge row.state
   text row.subject
 page /leak title="Leak"
  require authenticated and actor.email_verified
  board Ticket as leak where leak.state==closed or leak.staff_note!=null by=state columns=subject filter=state empty="None"
`;

test('assembled board/calendar filter+lambda-where conjunction serves E5 collections with source-first failure order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-boardcal-filter-where-'));
  try {
    const path = join(dir, 'BoardCal.can');
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
      throw new Error(`board/calendar fixture compile failed (the E5 admission must cover it): ${String(out.message)} ` +
        `stdout=${String(out.stdout ?? '').slice(0, 3000)} stderr=${String(out.stderr ?? '').slice(0, 3000)}`);
    }
    assert.ok(!('diagnostics' in artifact), 'real board/calendar fixture emits clean');
    // No uiUrl: production assembly serves UI factories through the native
    // query facade, which binds each original source callable before the
    // factory delegates (passing uiUrl would skip the facade, leaving
    // scoped source predicates unbound).
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const owners = await Promise.all(['agneta', 'boris'].map(async name => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const email = `${name}@boardcal.test`;
      const user = await identities.createUser({ email, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
        is_owner: true, roles: [] });
      const token = `${name}-boardcal-session`;
      const session = await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { name, email, team, identity: makeIdentity({ membership, team, email }),
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
      ownerStorage: { app: 'BoardCal', forIdentity: async identity => {
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a background work test'); } },
      pageReads: (identity, store: StoragePort) => {
        assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'BoardCal', ownerPackage: 'BoardCal', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request),
        preferences },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const [agneta, boris] = owners as [typeof owners[number], typeof owners[number]];
    const page = async (owner: typeof owners[number], href: string, status = 200): Promise<string> => {
      const url = new URL(href, 'https://boardcal.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return body;
    };
    const pageJson = async (owner: typeof owners[number], href: string, status: number): Promise<{ code?: unknown }> => {
      const url = new URL(href, 'https://boardcal.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return JSON.parse(body) as { code?: unknown };
    };
    // Seed through the real canonical mutation: five own rows spanning
    // both enum filters (one with subject==category, excluded only by the
    // agenda's field-to-field source where) plus one foreign row that must
    // stay invisible to agneta through both policy and source where.
    // Closed rows come first: the /leak discriminator short-circuits on
    // closed rows, so its control name is harvested from a 200 render
    // before any denied-read row exists.
    let sequence = 0;
    const from = new Date(FIXED_NOW).toISOString();
    const until = new Date(FIXED_NOW + 3_600_000).toISOString();
    const create = async (owner: typeof owners[number], inputs: Record<string, unknown>): Promise<void> => {
      const invoker = buildInvoker(artifact, asm, owner.store, { memberships: identities, now: () => FIXED_NOW });
      const outcome = await invoker.invokeMutation({ operation: 'BoardCal.Ticket.create',
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, owner.identity);
      assert.ok('result' in outcome, JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.result.status, 'committed');
    };
    const own = { email: agneta.email, from, until, staff_note: 'staff only' };
    await create(agneta, { ...own, subject: 'Gamma', category: 'C3', state: 'closed', priority: 'low' });
    await create(agneta, { ...own, subject: 'Delta', category: 'C4', state: 'closed', priority: 'high' });

    // Harvest the emitted filter control names (never transcribed): the
    // board owns a state+priority group, then the agenda owns its own
    // state+priority group.
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
    await create(boris, { email: boris.email, from, until, staff_note: 'foreign staff',
      subject: 'Foreign', category: 'F1', state: 'open', priority: 'low' });

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
    assert.deepEqual(groups[0]!.map(fieldOf).sort(), ['priority', 'state']);
    assert.deepEqual(groups[1]!.map(fieldOf).sort(), ['priority', 'state']);
    const boardState = controlFor(groups[0]!, 'state');
    assert.equal(boardCardsOf(html), 5, 'board serves every own row through the actor where');
    for (const subject of ['Alpha', 'Beta', 'Same', 'Gamma', 'Delta']) assert.ok(html.includes(subject), subject);
    assert.equal(agendaItemsOf(html), 4, 'agenda serves own rows minus subject==category');
    assert.ok(!html.includes('Foreign'), 'foreign row excluded from page');

    // Saved defaults filter rows. The preference store is shared, but each
    // collection follows only its declared defaults: state=open narrows
    // the board (full defaults) while the agenda keeps serving every
    // priority (partial defaults).
    const prefKey = seenPrefKeys[0]!;
    const savePref = (field: string, value: string): void => {
      savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
        agneta.identity.team!.team_id, prefKey.owner, field]), { value, version: '1' });
    };
    savePref('state', 'open');
    html = await page(agneta, '/work');
    assert.equal(boardCardsOf(html), 3, 'board follows the saved state default');
    assert.equal(boardSectionOf(html, 'open').match(/<li data-row="/g)?.length ?? 0, 3, 'open group holds the three rows');
    // An empty group renders no cards: either no closed section at all or
    // an empty one (the UI only pre-populates sections from enum labels
    // when the result carries them).
    const closedSection = /<section data-group="closed">[\s\S]*?<\/ul><\/section>/.exec(html)?.[0] ?? '';
    assert.equal(closedSection.match(/<li data-row="/g)?.length ?? 0, 0, 'closed group holds no cards');
    // The agenda declares no state default, so the saved state selection
    // does not apply to it: all four subject!=category rows still serve.
    assert.equal(agendaItemsOf(html), 4, 'agenda ignores the undeclared state default');

    // Saving priority=high narrows both collections through their own
    // defaults: the board serves open+high, the agenda high only.
    savePref('priority', 'high');
    html = await page(agneta, '/work');
    assert.equal(boardCardsOf(html), 1, 'board serves open+high only');
    assert.ok(html.includes('Beta'), 'board keeps Beta');
    assert.equal(agendaItemsOf(html), 2, 'agenda serves high only');
    assert.ok(!boardSectionOf(html, 'open').includes('Alpha'), 'board excludes Alpha');

    // Explicit request beats saved defaults on the addressed collection
    // only: closed on the board serves Delta (closed+high) while the
    // agenda keeps following its saved priority default.
    html = await page(agneta, `/work?${new URLSearchParams([[boardState, 'closed']])}`);
    assert.equal(boardCardsOf(html), 1, 'explicit closed selection serves one board card');
    assert.ok(boardSectionOf(html, 'closed').includes('Delta'), 'board serves Delta');
    assert.equal(agendaItemsOf(html), 2, 'agenda unaffected by the board selection');

    // Explicit clear beats saved defaults per control: clearing state
    // leaves the saved priority default active (high rows only).
    html = await page(agneta, `/work?${new URLSearchParams([[boardState, '']])}`);
    assert.equal(boardCardsOf(html), 2, 'clearing state leaves saved priority active');
    // Clearing priority as well returns every own row through the board.
    const boardPriority = controlFor(groups[0]!, 'priority');
    html = await page(agneta, `/work?${new URLSearchParams([[boardState, ''], [boardPriority, '']])}`);
    assert.equal(boardCardsOf(html), 5, 'clearing all board controls serves every own row');
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded after clear');

    // Malformed selectors refuse before query or row work, on both
    // collections.
    const agendaState = controlFor(groups[1]!, 'state');
    for (const params of [new URLSearchParams([[boardState!, 'bogus']]),
      new URLSearchParams([[agendaState!, 'bogus']]),
      new URLSearchParams([['filter[state]', 'open']])]) {
      assert.equal((await pageJson(agneta, `/work?${params}`, 400)).code, 'validation');
    }

    // Denied caller (no session) refuses before any query.
    {
      const url = new URL('/work', 'https://boardcal.test');
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
    assert.equal(boardCardsOf(html), 1, 'other callers keep serving after the revocation');
    assert.ok(html.includes('Beta'), 'agneta still serves her saved-default row');
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
