import type { OwnedChromium } from "@canlang/contracts/browser/chromium";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { deriveCsrfToken, SESSION_COOKIE_NAME } from '@canlang/identity';
import type { LocalPreviewWithActors } from './preview-builder.js';

type Browser = OwnedChromium['browser'];
type Context = Awaited<ReturnType<Browser['newContext']>>;
type Page = Awaited<ReturnType<Context['newPage']>>;
type Locator = ReturnType<Page['locator']>;
type Label = 'Ava' | 'Ben' | 'Cal' | 'Dee';
export interface FirstProfileBrowserRow {
  readonly name: string;
  readonly quantity: string | null;
  readonly available: boolean;
}
export interface FirstProfileBrowserInput {
  readonly browser: Browser;
  readonly preview: LocalPreviewWithActors;
  readonly signal?: AbortSignal;
  readonly expectedActors: Readonly<Record<Label, { readonly owner: string | null; readonly principal: string }>>;
  readonly initialVisible: readonly FirstProfileBrowserRow[];
  /** The caller verifies the opaque session's actual principal using owning Identity. */
  readonly onAuthenticated: (label: Label, facts: {
    readonly cookie: string; readonly csrf: string; readonly owner: string | null;
  }) => Promise<void>;
  readonly snapshot: () => Promise<unknown>;
  /** The caller verifies exact canonical receipt/history/domain/effect changes. */
  readonly mutation: (label: 'Ava' | 'Ben', operation: 'create' | 'update' | 'delete',
    expected: FirstProfileBrowserRow, action: () => Promise<void>) => Promise<void>;
  /** The caller verifies the exact owning Identity page-preference change. */
  readonly preference: (label: 'Ava', value: 'all' | 'available', action: () => Promise<void>) => Promise<void>;
}
export interface FirstProfileBrowserQualification { readonly id: string; readonly runtimeCheck: string }

/** Consumes the unchanged whole HelpOffice fixture through its actual protected browser origin. */
export async function qualifyFirstProfileBrowser(input: FirstProfileBrowserInput): Promise<readonly FirstProfileBrowserQualification[]> {
  const check = () => input.signal?.throwIfAborted();
  const contexts = new Set<Context>();
  const closes = new Map<Context, Promise<void>>();
  const close = (context: Context): Promise<void> => {
    let pending = closes.get(context);
    if (pending === undefined) {
      pending = context.close(); closes.set(context, pending);
      void pending.catch(() => undefined);
    }
    return pending;
  };
  const abort = () => { for (const context of contexts) void close(context); };
  input.signal?.addEventListener('abort', abort, { once: true });
  let phase = 'browser authentication';
  try {
    check();
    const seeds = input.preview.issueLocalActors();
    const sessions = new Map<Label, { context: Context; page: Page; origin: string }>();
    const authenticateSession = async (label: Label): Promise<void> => {
        check(); const context = await input.browser.newContext(); contexts.add(context);
        context.setDefaultTimeout(10_000); context.setDefaultNavigationTimeout(15_000);
        check(); const page = await context.newPage(); check();
        assert.ok(input.preview.issueOpenUrl, 'browser preview must issue genuine bootstrap URLs');
        const opened = input.preview.issueOpenUrl();
        const bootstrap = await page.goto(opened, { waitUntil: 'domcontentloaded' }); check();
        // HelpOffice's source preference schema requires an active member before page rendering.
        assert.ok(bootstrap && bootstrap.status() === 403, 'anonymous HelpOffice bootstrap must reach the owning page refusal');
        const bootstrapRefusal: unknown = await bootstrap.json();
        assert.ok(bootstrapRefusal && typeof bootstrapRefusal === 'object' && 'code' in bootstrapRefusal &&
          bootstrapRefusal.code === 'forbidden', 'anonymous HelpOffice bootstrap must preserve the owning forbidden refusal');
        const origin = new URL(opened).origin;
        const seed = seeds.find(actor => actor.label === label); assert.ok(seed, 'browser actor seed is required');
        const descriptor = await context.request.get(`${origin}/auth/login`, { timeout: 10_000 });
        assert.ok(descriptor.status() === 200, 'browser login descriptor must succeed');
        const loginDescriptor: unknown = await descriptor.json();
        assert.ok(loginDescriptor && typeof loginDescriptor === 'object' && 'preSessionToken' in loginDescriptor &&
          typeof loginDescriptor.preSessionToken === 'string', 'browser login descriptor must supply its token');
        check(); const logged = await context.request.post(`${origin}/auth/login`, { timeout: 10_000,
          headers: { origin }, data: { email: seed.email, password: seed.password, _presession: loginDescriptor.preSessionToken } });
        assert.ok(logged.status() === 200, 'browser actor login must succeed');
        const cookie = (await context.cookies()).find(item => item.name === SESSION_COOKIE_NAME); assert.ok(cookie, 'browser session is required');
        const csrf = await deriveCsrfToken(decodeURIComponent(cookie.value)); check();
        const listing = await context.request.get(`${origin}/auth/teams`, { timeout: 10_000 });
        assert.ok(listing.status() === 200, 'browser actor teams must be available');
        const body: unknown = await listing.json();
        assert.ok(body && typeof body === 'object' && 'teams' in body && Array.isArray(body.teams), 'browser team response must be structured');
        const expected = input.expectedActors[label];
        assert.ok(expected.principal.length > 0, 'browser expected principal must be supplied');
        assert.ok(body.teams.length === (expected.owner === null ? 0 : 1), 'browser team membership must match its seeded actor');
        if (expected.owner !== null) {
          const team: unknown = body.teams[0];
          assert.ok(team && typeof team === 'object' && 'team_id' in team && team.team_id === expected.owner,
            'browser actor must discover its actual expected owner');
          const selected = await context.request.post(`${origin}/auth/select-team`, { timeout: 10_000,
            headers: { origin, 'x-csrf-token': csrf }, data: { team: expected.owner, _csrf: csrf } });
          assert.ok(selected.status() === 200, 'browser actor team selection must succeed');
        }
        await input.onAuthenticated(label, { cookie: `${SESSION_COOKIE_NAME}=${cookie.value}`, csrf, owner: expected.owner }); check();
        sessions.set(label, { context, page, origin });
    };
    for (const label of ['Ava', 'Ben', 'Cal', 'Dee'] as const) await authenticateSession(label);
    assert.ok(input.expectedActors.Ava.owner !== null && input.expectedActors.Ava.owner === input.expectedActors.Ben.owner &&
      input.expectedActors.Cal.owner !== null && input.expectedActors.Cal.owner !== input.expectedActors.Ava.owner &&
      input.expectedActors.Dee.owner === null, 'browser identities must retain the owning security matrix');
    const ava = sessions.get('Ava')!, ben = sessions.get('Ben')!;
    const reload = async (session: typeof ava) => {
      check(); const response = await session.page.goto(session.origin, { waitUntil: 'domcontentloaded' }); check();
      assert.ok(response && response.status() === 200, `browser member page must serve successfully (status ${response?.status() ?? 'absent'})`);
      await session.page.locator('form[action*="Supply.create"]').first().waitFor({ state: 'visible' }); check();
    };
    const readonly = async (label: string, action: () => Promise<void>) => {
      phase = label; check(); const before = await input.snapshot(); check(); await action(); check();
      assert.ok(isDeepStrictEqual(await input.snapshot(), before), 'browser read-only phase changed owned resources'); check();
    };
    const rows = (page: Page) => page.locator('li.list-row');
    // Authored text is one combined paragraph; all supplied/generated names are unique.
    const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
    // Owning UI isolates interpolated values with FSI/PDI; compare their visible glyphs.
    const visibleText = (value: string) => value.replace(/[\u2068\u2069]/g, '');
    const overview = async (session: typeof ava, visible: readonly FirstProfileBrowserRow[], all: readonly FirstProfileBrowserRow[]) => {
      const { page } = session;
      assert.ok(await page.title() === 'Office supplies — HelpOffice', 'browser must render the authored page title and actual app brand');
      assert.ok(await page.locator('main#can-main > section.card > .card-body > h2.card-title').allTextContents()
        .then(titles => isDeepStrictEqual(titles, ['Add a supply', 'Team supplies'])), 'browser must render both authored card headings');
      assert.ok(await rows(page).count() === visible.length, 'browser list must have its expected visible rows');
      const nameInputs = rows(page).locator('form[action*="Supply.update"] input[name="inputs[changes][name]"]');
      const names: string[] = [];
      for (let index = 0; index < await nameInputs.count(); index++) names.push(await nameInputs.nth(index).inputValue());
      assert.ok(isDeepStrictEqual(names, visible.map(item => item.name).sort()), 'browser list must preserve authored name ordering');
      for (const item of visible) {
        const actual = row(page, item.name); assert.ok(await actual.count() === 1, 'browser authored row name must be present once');
        const text = visibleText(await actual.locator('p').first().innerText()).replace(/\s+/g, ' ').trim();
        assert.ok(text === `${item.name} ${item.quantity ?? ''} ${String(item.available)}`.replace(/\s+/g, ' ').trim(),
          'browser row paragraph must render the authored name, nullable quantity and availability');
        const form = actual.locator('form[action*="Supply.update"]').first();
        assert.ok(await form.locator('input[name="inputs[changes][name]"]').inputValue() === item.name, 'browser edit name must reflect the physical row');
        assert.ok(await form.locator('input[name="inputs[changes][quantity]"]').inputValue() === (item.quantity ?? ''), 'browser edit nullable quantity must reflect the physical row');
        assert.ok(await form.locator('input[name="inputs[changes][available]"]').isChecked() === item.available, 'browser edit availability must reflect the physical row');
      }
      assert.ok(visibleText(await page.locator('.stat-value').innerText()).trim() === String(all.length), 'browser authored stat must count all supplies independently of list preference');
      assert.ok((await page.locator('.stat-desc').innerText()).trim() === 'Visible supplies', 'browser stat must retain authored description');
      if (all.length === 0) {
        assert.ok(await page.getByText('No supplies', { exact: true }).count() > 0, 'browser must render authored list empty state');
        assert.ok(await page.getByText('No stock', { exact: true }).count() > 0, 'browser must render authored table empty state');
      } else {
        const table = page.locator('table.table'); assert.ok(await table.count() === 1, 'browser must render the authored table');
        assert.ok(isDeepStrictEqual(await table.locator('thead th').allTextContents(), ['name', 'stock', 'available']), 'browser table must retain authored columns');
        assert.ok(await table.locator('tbody tr').count() === all.length, 'browser table must remain unfiltered by list preferences');
        for (const item of all) {
          const tableRow = table.locator('tbody tr').filter({ hasText: item.name });
          assert.ok(await tableRow.count() === 1, 'browser table must contain the physical row once');
          const cells = (await tableRow.locator('td').allTextContents()).map(visibleText);
          assert.ok(isDeepStrictEqual(cells, [item.name, '0', String(item.available)]), 'browser table cells must reflect actual name, default stock and availability');
        }
      }
    };
    const submit = async (session: typeof ava, form: Locator, operation: string) => {
      check(); const [response] = await Promise.all([
        session.page.waitForResponse(value => value.request().method() === 'POST' &&
          decodeURIComponent(new URL(value.url()).pathname).includes(`HelpOffice.Supply.${operation}`), { timeout: 15_000 }),
        form.locator('button[type="submit"]').first().click(),
      ]); check(); assert.ok(response.status() === 200, 'browser generated operation must commit'); await reload(session);
    };
    const remove = async (item: FirstProfileBrowserRow) => {
      phase = 'browser generated archive';
      await input.mutation('Ava', 'delete', item, async () => {
        const form = row(ava.page, item.name).locator('form[action*="Supply.delete"]');
        assert.ok(await form.count() === 1, 'browser must use the authored generated delete form');
        await submit(ava, form, 'delete');
      }); check();
    };
    const noAvaNames = async (page: Page) => {
      const text = await page.locator('body').innerText();
      assert.ok(input.initialVisible.every(item => !text.includes(item.name)), 'unrelated browser page must not disclose initial Ava supplies');
    };
    const refusedPage = async (page: Page, url: string) => {
      check(); const response = await page.goto(url, { waitUntil: 'domcontentloaded' }); check();
      assert.ok(response && response.status() === 403, 'HelpOffice page without active membership must refuse');
      const body: unknown = await response.json();
      assert.ok(body && typeof body === 'object' && 'code' in body && body.code === 'forbidden',
        'HelpOffice page must expose only the owning forbidden envelope');
      assert.ok(await page.locator('form[action*="Supply.create"], form[action*="Supply.update"], form[action*="Supply.delete"]').count() === 0,
        'refused browser page must not disclose supply mutation forms');
      assert.ok(await rows(page).count() === 0 && await page.locator('table.table').count() === 0,
        'refused browser page must not disclose supply read projections');
      await noAvaNames(page);
    };
    const edit = async (before: FirstProfileBrowserRow, after: FirstProfileBrowserRow) => {
      phase = 'browser shared member edit';
      await input.mutation('Ben', 'update', after, async () => {
        const actual = row(ben.page, before.name), form = actual.locator('form[action*="Supply.update"]').first();
        assert.ok(await form.count() === 1, 'browser must use the authored row edit form');
        await actual.locator('label.drawer-button').click();
        await form.locator('input[name="inputs[changes][name]"]').fill(after.name);
        await form.locator('input[name="inputs[changes][quantity]"]').fill(after.quantity ?? '');
        await form.locator('input[name="inputs[changes][available]"]').setChecked(after.available);
        await submit(ben, form, 'update');
      }); check();
    };
    const tabs = ava.page.locator('form:has(input[type="radio"][name="view"])');
    const selectPreference = async (value: 'all' | 'available') => {
      phase = 'browser persisted preferences';
      await input.preference('Ava', value, async () => {
        check(); await tabs.locator(`input[value="${value}"]`).check();
        const [response] = await Promise.all([
          ava.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/', { timeout: 15_000 }),
          tabs.locator('button[type="submit"]').click(),
        ]); check(); assert.ok(response.status() === 303, 'browser preference must redirect after persisting');
        await reload(ava);
        assert.ok(await tabs.locator(`input[value="${value}"]`).isChecked(), 'browser preference must survive reload');
      }); check();
    };
    const runAuthorityMatrix = async (): Promise<void> => {
      const cal = sessions.get('Cal')!, dee = sessions.get('Dee')!;
      await readonly('browser page authority matrix', async () => {
        phase = 'browser foreign-owner page';
        await reload(cal); await overview(cal, [], []); await noAvaNames(cal.page);
        phase = 'browser nonmember page refusal';
        await refusedPage(dee.page, dee.origin);
        phase = 'browser anonymous page refusal';
        check(); const anonymous = await input.browser.newContext(); contexts.add(anonymous);
        anonymous.setDefaultTimeout(10_000); anonymous.setDefaultNavigationTimeout(15_000); check();
        const page = await anonymous.newPage(); check();
        assert.ok(input.preview.issueOpenUrl, 'anonymous browser requires its own fresh protected bootstrap');
        await refusedPage(page, input.preview.issueOpenUrl());
        assert.ok(!(await anonymous.cookies()).some(cookie => cookie.name === SESSION_COOKIE_NAME),
          'anonymous page refusal must not synthesize an Identity session');
      });
    };
    const runCreateFlow = async (paper: FirstProfileBrowserRow, pens: FirstProfileBrowserRow): Promise<void> => {
      for (const item of [paper, pens]) {
        phase = 'browser generated create';
        await input.mutation('Ava', 'create', item, async () => {
          const form = ava.page.locator('form[action*="Supply.create"]').first();
          assert.ok(await form.count() === 1, 'browser must use the authored inline create form');
          await form.locator('input[name="inputs[name]"]').fill(item.name);
          await form.locator('input[name="inputs[quantity]"]').fill(item.quantity ?? '');
          await submit(ava, form, 'create');
        }); check();
      }
      await readonly('browser shared created rows', async () => { await reload(ben); await overview(ava, [paper, pens], [paper, pens]); await overview(ben, [paper, pens], [paper, pens]); });
    };
    const runEditFlow = async (paper: FirstProfileBrowserRow, pens: FirstProfileBrowserRow,
      changed: FirstProfileBrowserRow): Promise<void> => {
      await edit(paper, changed);
      await readonly('browser shared updated readback', async () => { await reload(ava); await overview(ava, [changed, pens], [changed, pens]); await overview(ben, [changed, pens], [changed, pens]); });
    };
    const runPreferenceFlow = async (pens: FirstProfileBrowserRow, changed: FirstProfileBrowserRow): Promise<void> => {
      await selectPreference('available');
      await readonly('browser list-only filtering', async () => { await reload(ava);
        assert.ok(await tabs.locator('input[value="available"]').isChecked(), 'browser preference must survive reload');
        await overview(ava, [pens], [changed, pens]);
      });
      await selectPreference('all');
      await readonly('browser all preference readback', async () => { await reload(ava); await overview(ava, [changed, pens], [changed, pens]); });
    };
    const runCleanupFlow = async (changed: FirstProfileBrowserRow, pens: FirstProfileBrowserRow): Promise<void> => {
      const restored = { ...changed, available: true }; await edit(changed, restored);
      await readonly('browser restored shared row', async () => { await reload(ava); await overview(ava, [restored, pens], [restored, pens]); });
      await remove(restored); await remove(pens);
      await readonly('browser final shared archive absence', async () => { await reload(ben); await overview(ava, [], []); await overview(ben, [], []); });
    };
    await runAuthorityMatrix();
    await readonly('browser initial member read', async () => { await reload(ava); await reload(ben); await overview(ava, input.initialVisible, input.initialVisible); });
    for (const initial of input.initialVisible) await remove(initial);
    await readonly('browser initial archive absence', async () => { await reload(ben); await overview(ava, [], []); await overview(ben, [], []); });
    const suffix = randomUUID().slice(0, 8);
    const paper: FirstProfileBrowserRow = { name: `Browser paper ${suffix}`, quantity: null, available: true };
    const pens: FirstProfileBrowserRow = { name: `Browser pens ${suffix}`, quantity: '2', available: true };
    await runCreateFlow(paper, pens);
    const changed: FirstProfileBrowserRow = { name: `Browser changed paper ${suffix}`, quantity: '8', available: false };
    await runEditFlow(paper, pens, changed);
    await runPreferenceFlow(pens, changed);
    await runCleanupFlow(changed, pens);
    check();
    const descriptions: readonly [readonly string[], string][] = [
      [['can.v1.section.then', 'can.v1.then.page'], 'HelpOffice Chromium: protected authored page serves members; foreign-owner page is empty and nonmember/anonymous pages refuse without supply projections or resource writes'],
      [['can.v1.ui.card', 'can.v1.derive.function'], 'HelpOffice Chromium: actual Add a supply and derived Team supplies card headings render'],
      [['can.v1.then.form', 'can.v1.ui.input'], 'HelpOffice Chromium: generated inline create form submits text and nullable integer inputs; actual shared rows persist'],
      [['can.v1.then.edit', 'can.v1.then.text', 'can.v1.ui.list'], 'HelpOffice Chromium: Ben edits Ava supply name, quantity and availability through generated row drawer; both members read actual values'],
      [['can.v1.then.preferences-schema', 'can.v1.ui.tabs-selector', 'can.v1.type.enum'], 'HelpOffice Chromium: actual all/available enum preference persists across reload and filters only the list'],
      [['can.v1.ui.stat', 'can.v1.ui.table'], 'HelpOffice Chromium: unfiltered actual count and authored name/stock/available table retain both rows while list filters'],
      [['can.v1.then.delete'], 'HelpOffice Chromium: generated archives remove initial and created supplies from both members; stat zero and authored list/table empty states render'],
    ];
    return Object.freeze(descriptions.flatMap(([ids, runtimeCheck]) => ids.map(id => Object.freeze({ id, runtimeCheck }))));
  } catch (error) {
    check();
    // Only an explicit assertion's first message line is safe to retain.
    // Generated diffs and browser logs can include Identity or page values.
    const detail = error instanceof assert.AssertionError && !error.generatedMessage
      ? error.message.split('\n', 1)[0] : undefined;
    throw new Error(`HelpOffice browser qualification failed during ${phase}${detail ? `: ${detail}` : ''}`);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    const settled = await Promise.allSettled([...contexts].map(close));
    assert.ok(settled.every(result => result.status === 'fulfilled'), 'HelpOffice browser contexts must close');
    check();
  }
}
