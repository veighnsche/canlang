/** Board row/card binding (CAN18-v1 board row-binding batch).
 *
 * Boards with authored row children used to lower eagerly with no row_scope:
 * childless boards serve from columns while boards with row children crashed
 * at render with `ticket is not defined`. This batch threads row_scope for
 * board children at the defining compiler owner (mirroring the accepted
 * table/list row-child path: same row grants, source order, laziness, field
 * failures) and adds the minimal UI `board()` renderRow/details-drawer slot
 * reusing the existing owning row-render contract.
 *
 * This test is the board row-binding consumer through the real assembled
 * worker path (actual `can` binary -> `assembleModules` -> `assembleWorker`
 * -> HTTP `worker.fetch`), following the d0e56e402/d126924de
 * board-calendar harness pattern. The interfaces page-source shim cannot
 * serve here: it forwards `where` straight into the data-only State reader,
 * which cannot evaluate compiled source lambdas.
 *
 * Finite acceptance, all through a real compiled `.can` source:
 * - Board own-tickets with row children (badge, text, modal-opening
 *   action with row-bound dialog content, details drawer) renders one
 *   card per row with actions and drawer content (no `ticket is not
 *   defined`), in source order.
 * - Childless-board control on the same model renders unchanged column
 *   cards with no row-actions region.
 * - Row grants hold per row; revoking a session refuses further page reads
 *   for that caller while other callers keep serving.
 * - DISCRIMINATOR: a source where that reads a denied field on a
 *   control-excluded row surfaces `forbidden` — never reordered away by
 *   the control exclusion.
 * - Malformed selectors refuse before query or row work.
 *
 * Loud refusals stay put: calendar `columns=` remains withdrawn and
 * reference/enum filter behavior is unchanged (covered by the green
 * board-calendar-filter-where and board-calendar-reference-filter suites).
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

const SOURCE = `app BoardRow
Given
 Ticket { subject:text, category:text, email:email, state:enum(open,closed)=open, priority:enum(low,high)=low, staff_note:text? }
 policy Ticket read=authenticated where=row.email==actor.email fields=subject,category,email,state,priority
When
 crud Ticket by=authenticated fields=subject,category,email,state,priority,staff_note
Then
 preferences { state:Ticket.state?, priority:Ticket.priority? }
 page /work title="Work"
  require authenticated and actor.email_verified
  board Ticket as ticket where actor!=null and ticket.email==actor.email by=state columns=subject,state,priority filter=state,priority defaults={state=preferences.state,priority=preferences.priority} empty="No own tickets match"
   badge row.state
   text row.subject
   primary "Touch" opens=touch_panel
   modal "Touch panel" id=touch_panel
    slot content
     text row.subject
   details "Ticket notes" display=drawer
    text row.category
 page /plain title="Plain"
  require authenticated and actor.email_verified
  board Ticket as ticket where actor!=null and ticket.email==actor.email by=state columns=subject,state empty="No own tickets match"
 page /leak title="Leak"
  require authenticated and actor.email_verified
  board Ticket as leak where leak.state==closed or leak.staff_note!=null by=state columns=subject filter=state empty="None"
`;

test('assembled board row children render bound cards with actions while the childless board stays unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-board-row-children-'));
  try {
    const path = join(dir, 'BoardRow.can');
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
      throw new Error(`board row-children fixture compile failed (the row-scope admission must cover it): ${String(out.message)} ` +
        `stdout=${String(out.stdout ?? '').slice(0, 3000)} stderr=${String(out.stderr ?? '').slice(0, 3000)}`);
    }
    assert.ok(!('diagnostics' in artifact), 'real board row-children fixture emits clean');
    // No uiUrl: production assembly serves UI factories through the native
    // query facade, which binds each original source callable before the
    // factory delegates (passing uiUrl would skip the facade, leaving
    // scoped source predicates unbound).
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const owners = await Promise.all(['agneta', 'boris'].map(async name => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const email = `${name}@boardrow.test`;
      const user = await identities.createUser({ email, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
        is_owner: true, roles: [] });
      const token = `${name}-boardrow-session`;
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
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(41));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'BoardRow', forIdentity: async identity => {
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a background work test'); } },
      pageReads: (identity, store: StoragePort) => {
        assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'BoardRow', ownerPackage: 'BoardRow', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request),
        preferences },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const [agneta, boris] = owners as [typeof owners[number], typeof owners[number]];
    const page = async (owner: typeof owners[number], href: string, status = 200): Promise<string> => {
      const url = new URL(href, 'https://boardrow.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return body;
    };
    const pageJson = async (owner: typeof owners[number], href: string, status: number): Promise<{ code?: unknown }> => {
      const url = new URL(href, 'https://boardrow.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const body = await response.text();
      assert.equal(response.status, status, body.slice(0, 2000));
      return JSON.parse(body) as { code?: unknown };
    };
    let sequence = 0;
    const create = async (owner: typeof owners[number], operation: string, inputs: Record<string, unknown>): Promise<{ id: string; version: string }[]> => {
      const invoker = buildInvoker(artifact, asm, owner.store, { memberships: identities, now: () => FIXED_NOW });
      const outcome = await invoker.invokeMutation({ operation: `BoardRow.${operation}`,
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, owner.identity);
      assert.ok('result' in outcome, JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.result.status, 'committed');
      const records = (outcome.result as unknown as { records?: readonly { id?: unknown; version?: unknown }[] }).records ?? [];
      return records.map(record => {
        assert.equal(typeof record.id, 'string', 'created row carries an opaque id');
        return { id: record.id as string, version: String(record.version) };
      });
    };
    // Closed rows come first: the /leak discriminator short-circuits on
    // closed rows, so its control name is harvested from a 200 render
    // before any denied-read row exists.
    const own = { email: agneta.email, category: 'general', staff_note: 'staff only' };
    await create(agneta, 'Ticket.create', { ...own, subject: 'Gamma', state: 'closed', priority: 'low' });
    await create(agneta, 'Ticket.create', { ...own, subject: 'Delta', category: 'ops', state: 'closed', priority: 'high' });

    // Harvest the emitted filter control names (never transcribed): the
    // /work board owns a state+priority group, then /leak owns its own
    // state group.
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

    // The /leak discriminator short-circuits (`or`) on closed rows, so
    // with only closed rows seeded its source where never reaches the
    // denied field: a clean 200 render to harvest its control name.
    const leakHtml = await page(agneta, '/leak');
    const leakGroups = filterNamesOf(leakHtml);
    assert.equal(leakGroups.length, 1, 'one discriminator control group');
    assert.deepEqual(leakGroups[0]!.map(fieldOf).sort(), ['state']);
    const leakState = leakGroups[0]![0]!;
    for (const subject of ['Gamma', 'Delta']) assert.ok(leakHtml.includes(subject), subject);

    // Now seed the open rows whose denied reads must surface, plus the
    // foreign row that stays invisible to agneta through both policy and
    // the actor source where.
    await create(agneta, 'Ticket.create', { ...own, subject: 'Alpha', state: 'open', priority: 'low' });
    await create(agneta, 'Ticket.create', { ...own, subject: 'Beta', category: 'ops', state: 'open', priority: 'high' });
    await create(agneta, 'Ticket.create', { ...own, subject: 'Same', state: 'open', priority: 'low' });
    await create(boris, 'Ticket.create', { email: boris.email, category: 'general', staff_note: 'foreign staff',
      subject: 'Foreign', state: 'open', priority: 'low' });

    // One card per row: the row-child board binds every granted row.
    const boardSectionOf = (pageHtml: string, group: string): string => {
      const match = new RegExp(`<section data-group="${group}">[\\s\\S]*?</ul></section>`).exec(pageHtml)?.[0] ?? '';
      assert.ok(match.length > 0, `board ${group} section renders`);
      return match;
    };
    const boardCardsOf = (pageHtml: string): number =>
      (pageHtml.match(/<li data-row="/g) ?? []).length;
    const rowActionsOf = (pageHtml: string): number =>
      (pageHtml.match(/data-can-row-actions/g) ?? []).length;

    // The bound board renders every own row with its authored row body:
    // badge state, subject text, the Touch modal opener with its
    // row-bound dialog content, and the notes drawer — never `ticket is
    // not defined` (any eager lowering would 500 this page instead
    // of 200).
    let html = await page(agneta, '/work');
    const groups = filterNamesOf(html);
    assert.equal(groups.length, 1, 'one work control group');
    assert.deepEqual(groups[0]!.map(fieldOf).sort(), ['priority', 'state']);
    const workState = groups[0]!.find(name => fieldOf(name) === 'state')!;
    assert.equal(boardCardsOf(html), 5, 'bound board serves every own row');
    assert.equal(rowActionsOf(html), 5, 'every bound card carries its row-actions region');
    for (const subject of ['Alpha', 'Beta', 'Same', 'Gamma', 'Delta']) assert.ok(html.includes(subject), subject);
    assert.ok(!html.includes('Foreign'), 'foreign row excluded from page');
    assert.ok(html.includes('Touch'), 'row modal opener renders');
    assert.equal((html.match(/<dialog class="modal"/g) ?? []).length, 5, 'one row-bound dialog per card');
    assert.ok(html.includes('Touch panel'), 'row dialog caption renders');
    assert.ok(html.includes('Ticket notes'), 'row details drawer renders');
    // Category bodies render per card through the drawer (Beta/Delta carry
    // `ops`); the closed/open sections keep source order within each group.
    const openSection = boardSectionOf(html, 'open');
    assert.ok(openSection.indexOf('Alpha') < openSection.indexOf('Beta'), 'source order: Alpha before Beta');
    assert.ok(openSection.indexOf('Beta') < openSection.indexOf('Same'), 'source order: Beta before Same');
    assert.ok(boardSectionOf(html, 'closed').includes('Gamma'), 'closed group serves Gamma');

    // Childless-board control on the same model: identical column cards,
    // no row-actions region, no row body.
    const plain = await page(agneta, '/plain');
    assert.equal(boardCardsOf(plain), 5, 'childless board serves every own row');
    for (const subject of ['Alpha', 'Beta', 'Same', 'Gamma', 'Delta']) assert.ok(plain.includes(subject), subject);
    assert.equal(rowActionsOf(plain), 0, 'childless board renders no row-actions region');
    assert.ok(!plain.includes('Touch'), 'childless board renders no row action');
    assert.ok(!plain.includes('Ticket notes'), 'childless board renders no row drawer');

    // Enum filter behavior is unchanged: request selection narrows, saved
    // defaults apply, explicit clear wins, malformed spellings refuse.
    html = await page(agneta, `/work?${new URLSearchParams([[workState, 'open']])}`);
    assert.equal(boardCardsOf(html), 3, 'open selection serves three cards');
    assert.equal(rowActionsOf(html), 3, 'narrowed cards keep their actions');
    const prefKey = seenPrefKeys[0]!;
    savedPrefs.set(JSON.stringify([prefKey.appId, agneta.identity.actor!.user_id,
      agneta.identity.team!.team_id, prefKey.owner, 'state']), { value: 'closed', version: '1' });
    html = await page(agneta, '/work');
    assert.equal(boardCardsOf(html), 2, 'board follows the saved state default');
    html = await page(agneta, `/work?${new URLSearchParams([[workState, '']])}`);
    assert.equal(boardCardsOf(html), 5, 'explicit clear serves every own row');
    assert.equal((await pageJson(agneta, `/work?${new URLSearchParams([[workState, 'bogus']])}`, 400)).code,
      'validation', 'bogus enum spelling refuses');
    assert.equal((await pageJson(agneta, '/work?filter[state]=open', 400)).code,
      'validation', 'legacy filter envelope refuses');

    // Denied caller (no session) refuses before any query.
    {
      const url = new URL('/work', 'https://boardrow.test');
      url.searchParams.set('team', agneta.team.team_id);
      const response = await worker.fetch(new Request(url));
      assert.equal(response.status, 403);
      assert.equal((JSON.parse(await response.text()) as { code?: unknown }).code, 'forbidden');
    }

    // DISCRIMINATOR: the /leak source where reads the denied staff_note
    // field on every non-closed granted row. Selecting state=closed
    // excludes every open row at the controls — yet the denied reads on
    // those control-excluded rows must still surface `forbidden`, never
    // be reordered away. The bare render forbids too: the open rows'
    // denied reads evaluate on the first page.
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
    assert.ok(!html.includes('Foreign'), 'foreign row still excluded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

