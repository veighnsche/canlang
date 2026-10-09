import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import type { D1Database } from '@cloudflare/workers-types';
import { Miniflare } from 'miniflare';
import type { CompileArtifact, DerivedOperationInputs, PresentationContext, StoragePort } from '@canlang/contracts';
import { CSRF_FIELD } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asModel, asId, asVersion, makeRow, makeBatch, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { buildSessionCookie, createD1IdentityStore, deriveCsrfToken, ensureIdentitySchema, sha256HexText } from '@canlang/identity';
import { catalogFromArtifactOperations, handleOperationRequest, INPUT_CHOICES_VERSION } from '@canlang/interfaces/http/operations';
import type { HttpDeps } from '@canlang/interfaces';
import { generatedForm, message, renderPage } from '@canlang/ui';
import type { BrowserClientOptions } from '../../../ui/dist/src/browser/bootstrap.js';
import type { SubmitFetchInit } from '../../../ui/dist/src/client.js';
import type { HTMLInputElement, HTMLSelectElement } from '../../../ui/node_modules/happy-dom/lib/index.js';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { assembleWorker } from '@canlang/cloudflare/worker/assembly';
import { gatherBrowserAssets } from '@canlang/cloudflare/deploy/package-assets';

const fixturePath = resolve('packages/cloudflare/test/fixtures/input-choices.json');

// Browser-evaluated callbacks use the native document; this Node test has no DOM lib.
type ChromiumGlobals = { document: { activeElement: unknown;
  querySelector(selector: string): { textContent: string | null; getAttribute(name: string): string | null } | null } };

test('genuine dependent choices use current native D1 grants and the original generated form controls', async () => {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-input-choices-'));
  const clock = { nowMs: () => FIXED_NOW };
  let sequence = 100;
  const id = () => uuidv7(FIXED_NOW, ++sequence);
  let miniflare: Miniflare | undefined;
  const open = async () => {
    miniflare = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'input-choices' }, d1Persist: join(dir, 'd1') });
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); await ensureIdentitySchema(db);
    return { state: createD1Storage(db), identity: createD1IdentityStore(db, { clock }) };
  };
  try {
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui') });
    const { createAssetTable, handleAssetsRequest } = await import(new URL('./http/assets.js', import.meta.resolve('@canlang/interfaces')).href) as
      typeof import('../../../interfaces/dist/src/http/assets.js');
    const resources = gatherBrowserAssets().resources;
    const assetTable = createAssetTable(Object.entries(resources).map(([key, resource]) => ({
      key, bytes: resource.bytes, mime: resource.contentType, cache: { maxAgeSeconds: 0, immutable: false },
    })));
    const catalog = catalogFromArtifactOperations(artifact);
    const derivedInputs: Record<string, DerivedOperationInputs> = {};
    for (const operation of artifact.operations ?? []) {
      const derived = catalog.derivedFor(operation.name); assert.ok(derived); derivedInputs[operation.name] = derived;
    }
    const save = derivedInputs['InputChoices.save']!;
    const submit = derivedInputs['InputChoices.submit']!;
    let storage = await open();
    const team = await storage.identity.createTeam({ timezone: 'UTC' });
    const user = await storage.identity.createUser({ email: 'choices@example.test', password_hash: 'unused', email_verified: true });
    const reviewer = await storage.identity.createUser({ email: 'reviewer@example.test', password_hash: 'unused', email_verified: true });
    const membership = await storage.identity.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = 'input-choices-session';
    await storage.identity.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3600_000).toISOString(), last_team_id: team.team_id });
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const csrf = await deriveCsrfToken(token);
    const countries = [id(), id(), id()]; const regions = [id(), id()];
    const sites = [id(), id()]; const document = id(); const submission = id();
    const employee = id(); const otherEmployee = id();
    const rows = [
      { model: 'Country', id: countries[0]!, data: { name: 'First', active: true } },
      { model: 'Country', id: countries[1]!, data: { name: 'Second', active: true } },
      { model: 'Country', id: countries[2]!, data: { name: 'Empty', active: true } },
      ...regions.map((record, index) => ({ model: 'Region', id: record, data: { name: `Region ${index + 1}` },
        parent: { model: asModel('InputChoices.Country'), id: asId(countries[index]!) } })),
      ...sites.map((record, index) => ({ model: 'Site', id: record, data: { name: `Site ${index + 1}` } })),
      { model: 'Document', id: document, data: { site: { id: sites[0] } } },
      { model: 'Submission', id: submission, data: { note: 'Submitted' },
        parent: { model: asModel('InputChoices.Document'), id: asId(document) } },
      { model: 'Employee', id: employee, data: { user: { id: reviewer.user_id }, name: 'Reviewer', role: 'Approver', home: { id: sites[0] } } },
      { model: 'Employee', id: otherEmployee, data: { user: { id: user.user_id }, name: 'Elsewhere', role: 'Approver', home: { id: sites[1] } } },
    ];
    await storage.state.commit(makeBatch(await storage.state.readRevision(), { writes: rows.map(record => ({
      kind: 'insert', model: asModel(`InputChoices.${record.model}`), row: {
        ...makeRow({ id: record.id, createdBy: user.user_id, updatedBy: user.user_id, data: record.data }),
        parent: 'parent' in record ? record.parent ?? null : null,
      },
    })) }));
    let domainQueries = 0;
    let revokeOnEmployeeRead = false;
    const countedStore = (): StoragePort => ({ ...storage.state, query: async query => {
      domainQueries++;
      const result = await storage.state.query(query);
      if (revokeOnEmployeeRead && query.model === 'InputChoices.Employee') {
        revokeOnEmployeeRead = false;
        await storage.identity.removeMembership(membership.membership_id);
      }
      return result;
    } });
    const assemble = () => assembleWorker(artifact, asm, { store: countedStore(), identityStore: storage.identity,
      now: () => FIXED_NOW, http: { derivedInputs,
        loadBrowserAssets: async () => ({ paths: Object.keys(resources).map(key => `/assets/${key}`),
          fetch: request => handleAssetsRequest(assetTable, request) }),
        createOperationHandler: Object.assign(
        (deps: unknown) => (request: Request, operation: string) => handleOperationRequest(deps as HttpDeps, request, operation),
        { inputChoicesVersion: INPUT_CHOICES_VERSION }) } }, { active: true });
    let worker = await assemble();
    const post = (operation: string, inputs: Record<string, unknown>, options: { auth?: boolean; csrf?: boolean; operationId?: string } = {}) =>
      worker.fetch(new Request(`https://test.invalid/api/operations/InputChoices.${operation}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(options.auth === false ? {} : { cookie }), ...(options.csrf === false ? {} : { 'x-csrf-token': csrf }) },
        body: JSON.stringify({ operation_id: options.operationId ?? id(), inputs }) }));
    const choices = async (operation: string, inputs: Record<string, unknown>, options = {}) => {
      const response = await post(operation, inputs, options);
      return { status: response.status, body: await response.json() as { state?: string; choices?: Array<{ value: unknown; labels: string[] }>; code?: string } };
    };
    const lookupRevision = await storage.state.readRevision();
    const beforeAbsent = domainQueries;
    assert.deepEqual((await choices('save/choices/region', {})).body, { state: 'absent', choices: [] });
    assert.equal(domainQueries, beforeAbsent);
    const first = await choices('save/choices/region', { country: { id: countries[0], version: '1' } });
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.deepEqual(first.body.choices, [{ value: { id: regions[0], version: '1' }, labels: ['Region 1'] }]);
    assert.deepEqual((await choices('save/choices/region', { country: { id: countries[1], version: '1' } })).body.choices,
      [{ value: { id: regions[1], version: '1' }, labels: ['Region 2'] }]);
    assert.equal((await choices('save/choices/region', { country: { id: countries[0], version: '2' } })).body.code, 'conflict');
    for (const [operation, inputs] of [['submit', { document: { id: document, version: '1' } }],
      ['assign', { submission: { id: submission, version: '1' } }]] as const) {
      const result = await choices(`${operation}/choices/assignee`, inputs);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.deepEqual(result.body.choices, [{ value: { id: reviewer.user_id }, labels: ['Reviewer', 'Approver', sites[0]] }]);
    }
    for (const options of [{ auth: false }, { csrf: false }]) {
      const denied = await choices('save/choices/region', { country: { id: countries[0], version: '1' } }, options);
      assert.equal(denied.status, 403); assert.equal(denied.body.choices, undefined);
    }
    revokeOnEmployeeRead = true;
    const revoked = await choices('submit/choices/assignee', { document: { id: document, version: '1' } });
    assert.equal(revoked.body.code, 'forbidden', JSON.stringify(revoked));
    assert.equal(revoked.body.choices, undefined);
    await storage.identity.reactivateMembership(membership.membership_id, { is_owner: false, roles: [] });
    assert.equal(await storage.state.readRevision(), lookupRevision, 'lookups create no mutation fence or receipt');
    for (const row of rows) assert.equal((await storage.state.historyFor(asModel(`InputChoices.${row.model}`), asId(row.id))).length, 0);

    // Malformed claims are intake failures of the genuine full slice, never
    // alternate callable implementations or candidate schemas.
    for (const corrupt of [
      (field: object) => Reflect.set(field, 'choices', { ...save.inputs[1]!.choices, version: 2 }),
      (field: object) => Reflect.set(field, 'choices', { ...save.inputs[1]!.choices, readOperation: 'InputChoices.save' }),
      (field: object) => Reflect.set(field, 'choices', { ...save.inputs[1]!.choices, resultModel: 'InputChoices.Region' }),
      (field: object) => Reflect.set(field, 'choices', { ...save.inputs[1]!.choices, arguments: { country: { input: 'region', path: [] } } }),
    ]) {
      const malformed = structuredClone(artifact);
      const field = malformed.operations!.find(operation => operation.name === save.operation)!.inputs.fields[1]!;
      corrupt(field); assert.throws(() => catalogFromArtifactOperations(malformed));
    }

    const { Window } = createRequire(import.meta.resolve('@canlang/ui'))('happy-dom') as typeof import('../../../ui/node_modules/happy-dom/lib/index.js');
    const { startBrowserClient } = await import(new URL('./browser/bootstrap.js', import.meta.resolve('@canlang/ui')).href);
    const window = new Window({ url: 'https://test.invalid/form' });
    const context: PresentationContext = { preferredLocales: [], appDefaultLocale: 'en',
      theme: { mode: 'light', accent: 'blue', density: 'comfortable' }, path: '/form', pollContext: 'choices/member/team',
      isPartial: false, csrfToken: csrf, principal: null, invocation: null,
      query: async () => ({ rows: [], columns: [] }) };
    const saveNonce = id(); const userNonce = id();
    const render = (derived: DerivedOperationInputs, operationId: string, prefix: string, values: Record<string, unknown>) => generatedForm({
      context, derived, mode: 'scenario', action: `/api/operations/${derived.operation}`, operationId,
      timeZone: 'UTC', idPrefix: prefix, submit: 'Save', values });
    window.document.body.setAttribute('data-can-context', context.pollContext!);
    window.document.body.innerHTML = await render(save, saveNonce, 'save', {
      country: countries[0], country__version: '1', note: 'Unrelated draft' }) +
      await render(submit, userNonce, 'user', { document, document__version: '1' });
    let hold = false;
    const releases: Array<() => void> = [];
    const signals: Array<NonNullable<SubmitFetchInit['signal']>> = [];
    let choiceRequests = 0;
    const fetchImpl: BrowserClientOptions['fetchImpl'] = async (url, init) => {
      if (url.includes('/choices/')) {
        choiceRequests++; assert.ok(init.signal); signals.push(init.signal);
      }
      const response = await worker.fetch(new Request(new URL(url, 'https://test.invalid'), {
        ...init, body: init.body as string, headers: { ...init.headers, cookie } }));
      if (hold && url.includes('/choices/')) await new Promise<void>(resolve => releases.push(resolve));
      return response;
    };
    let client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl });
    const wait = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(condition(), 'native DOM/worker interaction completed');
    };
    const form = window.document.querySelector('form')!;
    const control = (name: string) => Array.from(form.elements).find(element => 'name' in element && element.name === `inputs[${name}]`) as import('../../../ui/node_modules/happy-dom/lib/index.js').HTMLInputElement;
    const regionSelect = form.querySelector('select[data-can-choices-select]') as HTMLSelectElement;
    const userForm = window.document.querySelectorAll('form')[1]!;
    const userSelect = userForm.querySelector('select[data-can-choices-select]') as HTMLSelectElement;
    const choiceStatus = () => form.querySelector('[data-can-choices-feedback]')!.textContent;
    try {
      await wait(() => regionSelect.children.length === 2 && userSelect.children.length === 2);
      assert.equal(window.document.querySelectorAll('select[data-can-choices-select]').length, 2);
      assert.equal(choiceStatus(), '1 choices available.');
      control('country').focus();
      hold = true; const beforeRapid = choiceRequests;
      for (const country of [countries[2]!, countries[0]!, countries[1]!]) {
        control('country').value = country;
        control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
      }
      await wait(() => releases.length === 1);
      assert.equal(choiceRequests, beforeRapid + 1, 'rapid edits share one bounded lookup');
      assert.equal(choiceStatus(), 'Loading choices…');
      assert.equal(regionSelect.getAttribute('aria-busy'), 'true');
      assert.equal(window.document.activeElement, control('country'));
      hold = false; releases[0]!(); await wait(() => regionSelect.children.length === 2);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(choiceRequests, beforeRapid + 1);
      assert.equal(regionSelect.children[1]!.textContent, 'Region 2');
      assert.equal(regionSelect.hasAttribute('aria-busy'), false);
      releases.length = 0;
      control('country').value = countries[2]!;
      control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
      await wait(() => choiceStatus() === 'No choices available.');
      assert.equal(regionSelect.children.length, 1);
      assert.equal(userSelect.children.length, 2, 'other native select remains intact');
      assert.equal(window.document.activeElement, control('country'));
      const beforeBlank = choiceRequests;
      control('country').value = '';
      control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
      await wait(() => choiceStatus() === 'Choose the required values first.');
      assert.equal(choiceRequests, beforeBlank);
      const csrfControl = form.querySelector(`input[name="${CSRF_FIELD}"]`) as HTMLInputElement;
      assert.ok(csrfControl);
      csrfControl.value = 'wrong-csrf';
      control('country').value = countries[0]!;
      control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
      await wait(() => choiceStatus() === 'Choices could not be loaded. Use the value controls or try again.');
      assert.equal(regionSelect.children.length, 1);
      assert.equal(window.document.activeElement, control('country'));
      csrfControl.value = csrf;
      control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
      await wait(() => regionSelect.children.length === 2);
      regionSelect.value = '0'; regionSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      assert.equal(control('region').value, regions[0]); assert.equal(control('region__version').value, '1');
      userSelect.value = '0'; userSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      const userControl = userForm.querySelector('input[name="inputs[assignee]"]') as HTMLInputElement;
      assert.equal(userControl.value, reviewer.user_id);
      hold = true;
      control('country').value = countries[1]!; control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
      assert.equal(control('region').value, ''); assert.equal(control('region__version').value, '');
      assert.equal(control('note').value, 'Unrelated draft');
      await wait(() => releases.length === 1);
      const supersededSignal = signals[signals.length - 1]!;
      assert.equal(supersededSignal.aborted, false);
      control('country').value = countries[0]!; control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
      assert.equal(supersededSignal.aborted, true);
      await wait(() => releases.length === 2);
      hold = false; releases[1]!(); await wait(() => regionSelect.children.length === 2);
      releases[0]!(); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(regionSelect.children[1]!.textContent, 'Region 1');
      regionSelect.value = '0'; regionSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await wait(() => form.getAttribute('data-can-submit-state') === 'committed');
      const receiptIdentity = (operation: string, operationId: string) => ({ app: 'InputChoices', owner: team.team_id, principal: user.user_id, operation: asOperation(operation), operationId: asOperationId(operationId) });
      assert.equal((await storage.state.readReceipt(receiptIdentity(save.operation, saveNonce)))?.outcome.status, 'committed');
      userForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await wait(() => userForm.getAttribute('data-can-submit-state') === 'committed');
      const userReceipt = await storage.state.readReceipt(receiptIdentity(submit.operation, userNonce));
      assert.equal(userReceipt?.outcome.status, 'committed');
      if (userReceipt?.outcome.status === 'committed') assert.deepEqual(userReceipt.outcome.result, { id: reviewer.user_id });
      assert.deepEqual((await (await post('submit', { document: { id: document, version: '1' }, assignee: { id: reviewer.user_id } }, { operationId: userNonce })).json() as { result: unknown }).result,
        { id: reviewer.user_id });

      for (const invalidate of ['stop', 'context', 'replace'] as const) {
        hold = true; const start = releases.length;
        control('country').value = countries[1]!; control('country').dispatchEvent(new window.Event('input', { bubbles: true }));
        await wait(() => releases.length === start + 1);
        const unboundSignal = signals[signals.length - 1]!;
        if (invalidate === 'context') { window.document.body.setAttribute('data-can-context', 'changed'); client.rescan(); }
        else if (invalidate === 'replace') { form.remove(); client.rescan(); }
        else client.stop();
        assert.equal(unboundSignal.aborted, true, `${invalidate} aborts the request even when held transport ignores cancellation`);
        releases[start]!(); hold = false; await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(regionSelect.children.length, 1, `${invalidate} discards the late response`);
        client.stop();
        for (const release of releases) release();
        if (invalidate !== 'replace') {
          window.document.body.setAttribute('data-can-context', context.pollContext!);
          client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl });
          await wait(() => regionSelect.children.length === 2);
        }
      }
    } finally { client.stop(); await window.happyDOM.close(); }

    // This separate client uses Chromium's native fetch/FormData and the
    // installed, served bootstrap. Only the transport response is delayed;
    // every candidate and final request executes the original assembled Worker.
    const browserSaveNonce = id(); const browserUserNonce = id();
    const html = await renderPage(context, {
      owner: 'InputChoices', path: '/form', title: message('Dependent choices'),
      admit: async () => ({}), render: async () => '',
    }, [await render(save, browserSaveNonce, 'browser-save', {
      country: countries[0], country__version: '1', note: 'Chromium draft',
    }), await render(submit, browserUserNonce, 'browser-reviewer', { document, document__version: '1' })], {
      brand: message('InputChoices'), navigation: { groups: [], incomplete: false },
      routes: { signIn: '/auth/sign-in', signOut: '/auth/sign-out', switchTeam: '/auth/switch-team' },
      account: { authenticated: false, teams: [] }, settings: { sections: [] },
    });
    type Traffic = { path: string; inputs: Record<string, unknown>; operationId: string;
      status: number; body: { code?: string; result?: unknown; choices?: Array<{ value: unknown; labels: string[] }> } };
    const traffic: Traffic[] = [];
    const serverErrors: unknown[] = [];
    const heldResponses: Array<() => void> = [];
    const closedHeldResponses: boolean[] = [];
    let heldCountry: string | undefined;
    const server = createServer(async (incoming, outgoing) => {
      try {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const url = new URL(incoming.url ?? '/', `http://127.0.0.1:${address.port}`);
        if (incoming.method === 'GET' && url.pathname === '/form') {
          outgoing.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); outgoing.end(html); return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const response = await worker.fetch(new Request(url, { method: incoming.method ?? 'GET', headers,
          ...(body === '' ? {} : { body }) }));
        const bytes = Buffer.from(await response.arrayBuffer());
        if (body !== '') {
          const requestBody = JSON.parse(body) as { operation_id: string; inputs: Record<string, unknown> };
          traffic.push({ path: url.pathname, inputs: requestBody.inputs, operationId: requestBody.operation_id,
            status: response.status, body: JSON.parse(bytes.toString('utf8')) as Traffic['body'] });
          const country = requestBody.inputs['country'] as { id?: string } | undefined;
          if (url.pathname.endsWith('/choices/region') && country?.id === heldCountry) {
            const index = heldResponses.length; closedHeldResponses[index] = false;
            outgoing.once('close', () => { closedHeldResponses[index] = true; });
            await new Promise<void>(release => heldResponses.push(release));
          }
        }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(bytes);
      } catch (error) {
        serverErrors.push(error); outgoing.writeHead(500); outgoing.end('HTTP bridge failed');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const browserContext = await browser.newContext();
      const cookieEquals = cookie.indexOf('=');
      await browserContext.addCookies([{ name: cookie.slice(0, cookieEquals), value: cookie.slice(cookieEquals + 1), url: origin }]);
      const page = await browserContext.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const bootstrapResponse = page.waitForResponse(response => response.url() === `${origin}/assets/browser/bootstrap.js`);
      await page.goto(`${origin}/form`);
      const bootstrap = await bootstrapResponse;
      assert.equal(bootstrap.status(), 200);
      assert.deepEqual(await bootstrap.body(), Buffer.from(resources['browser/bootstrap.js']!.bytes));
      const browserSave = page.locator('form[action="/api/operations/InputChoices.save"]');
      const browserReviewer = page.locator('form[action="/api/operations/InputChoices.submit"]');
      const field = (name: string) => browserSave.locator(`[name="inputs[${name}]"]`);
      const region = browserSave.locator('select[data-can-choices-select]');
      const assignee = browserReviewer.locator('select[data-can-choices-select]');
      const status = browserSave.locator('[data-can-choices-feedback]');
      const waitBrowser = async (selector: string, expected: string) => page.waitForFunction(({ selector, expected }) =>
        (globalThis as unknown as ChromiumGlobals).document.querySelector(selector)?.textContent === expected, { selector, expected });
      const saveFeedback = 'form[action="/api/operations/InputChoices.save"] [data-can-choices-feedback]';
      const reviewerFeedback = 'form[action="/api/operations/InputChoices.submit"] [data-can-choices-feedback]';
      await waitBrowser(saveFeedback, '1 choices available.');
      await waitBrowser(reviewerFeedback, '1 choices available.');
      assert.equal(await region.locator('option').nth(1).textContent(), 'Region 1');
      assert.deepEqual(traffic.find(row => row.path.endsWith('save/choices/region'))?.inputs,
        { country: { id: countries[0], version: '1' }, note: 'Chromium draft' });
      assert.equal(traffic.find(row => row.path.endsWith('submit/choices/assignee'))?.operationId, browserUserNonce);
      assert.equal(await page.locator('select[data-can-choices-select]').count(), 2);

      // A parent edit aborts a genuine outstanding request. Its completed
      // canonical response is released after the current response arrives.
      await field('note').fill('Retained Chromium draft');
      await region.selectOption('0');
      await assignee.selectOption('0');
      heldCountry = countries[1]!;
      await field('country').fill(countries[1]!);
      assert.equal(await field('region').inputValue(), '');
      assert.equal(await field('region__version').inputValue(), '');
      await wait(() => heldResponses.length === 1);
      assert.equal(await status.textContent(), 'Loading choices…');
      assert.equal(await region.getAttribute('aria-busy'), 'true');
      assert.equal(await field('country').evaluate(element => element === (globalThis as unknown as ChromiumGlobals).document.activeElement), true);
      await field('country').fill(countries[0]!);
      await waitBrowser(saveFeedback, '1 choices available.');
      await wait(() => closedHeldResponses[0] === true);
      heldCountry = undefined; heldResponses[0]!();
      assert.deepEqual(traffic.find(row => row.path.endsWith('save/choices/region') &&
        (row.inputs['country'] as { id: string }).id === countries[1])?.body.choices,
        [{ value: { id: regions[1], version: '1' }, labels: ['Region 2'] }]);
      assert.equal(await region.locator('option').nth(1).textContent(), 'Region 1');
      assert.equal(await field('note').inputValue(), 'Retained Chromium draft');
      assert.equal(await browserReviewer.locator('[name="inputs[assignee]"]').inputValue(), reviewer.user_id);

      // Direct submissions cannot turn assistance into authority.
      const direct = async (operation: string, inputs: Record<string, unknown>) => {
        const response = await browserContext.request.post(`${origin}/api/operations/InputChoices.${operation}`, {
          headers: { 'x-csrf-token': csrf }, data: { operation_id: id(), inputs },
        });
        return { status: response.status(), body: await response.json() as Traffic['body'] };
      };
      const mismatched = await direct('save', { country: { id: countries[0], version: '1' },
        region: { id: regions[1], version: '1' }, note: 'Forged region' });
      assert.equal(mismatched.body.code, 'rule_failed', JSON.stringify(mismatched));
      for (const [operation, input] of [['submit', { document: { id: document, version: '1' } }],
        ['assign', { submission: { id: submission, version: '1' } }]] as const) {
        const forged = await direct(operation, { ...input, assignee: { id: user.user_id } });
        assert.equal(forged.body.code, 'rule_failed', JSON.stringify(forged));
        for (const optional of [{}, { assignee: null }]) {
          const nullable = await direct(operation, { ...input, ...optional });
          assert.equal(nullable.status, 200, JSON.stringify(nullable)); assert.equal(nullable.body.result, null);
        }
      }

      const replaceData = async (model: string, recordId: string, data: Record<string, unknown>) => {
        const current = await storage.state.load(asModel(`InputChoices.${model}`), asId(recordId)); assert.ok(current);
        await storage.state.commit(makeBatch(await storage.state.readRevision(), { writes: [{ kind: 'update',
          model: asModel(`InputChoices.${model}`), id: current.id, expectedVersion: current.version,
          row: { ...current, version: asVersion(Number(current.version) + 1), data },
        }] }));
      };
      const submitBrowser = async (operation: string, form: typeof browserSave) => {
        const response = page.waitForResponse(response => response.url() === `${origin}/api/operations/InputChoices.${operation}`);
        await form.locator('button[type="submit"]').click();
        return (await response).json() as Promise<Traffic['body']>;
      };
      await region.selectOption('0');
      await replaceData('Region', regions[0]!, { name: 'Region 1 current' });
      const stale = await submitBrowser('save', browserSave);
      assert.equal(stale.code, 'conflict', JSON.stringify(stale));
      await page.waitForFunction(() => (globalThis as unknown as ChromiumGlobals).document.querySelector('form[action="/api/operations/InputChoices.save"]')?.getAttribute('data-can-submit-state') === 'denied');
      assert.equal(await field('region').inputValue(), regions[0]);
      assert.equal(await field('region__version').inputValue(), '1');
      assert.equal(await field('note').inputValue(), 'Retained Chromium draft');
      assert.equal(await field('country').inputValue(), countries[0]);
      const staleRequest = traffic.find(row => row.path.endsWith('InputChoices.save') && row.operationId === browserSaveNonce)!;
      assert.deepEqual(staleRequest.inputs, { country: { id: countries[0], version: '1' },
        region: { id: regions[0], version: '1' }, note: 'Retained Chromium draft' });
      assert.equal(await storage.state.readReceipt({ app: 'InputChoices', owner: team.team_id, principal: user.user_id,
        operation: asOperation(save.operation), operationId: asOperationId(browserSaveNonce) }), null);

      // Correct the stale candidate using the existing parent and selection
      // controls, preserving the form's original idempotency key and siblings.
      await field('country').fill(countries[2]!); await waitBrowser(saveFeedback, 'No choices available.');
      await field('country').fill(countries[0]!); await waitBrowser(saveFeedback, '1 choices available.');
      assert.equal(await region.locator('option').nth(1).textContent(), 'Region 1 current');
      await region.selectOption('0');
      assert.equal(await field('region__version').inputValue(), '2');
      const corrected = await submitBrowser('save', browserSave);
      assert.deepEqual(corrected.result, { id: regions[0], version: '2' });
      await page.waitForFunction(() => (globalThis as unknown as ChromiumGlobals).document.querySelector('form[action="/api/operations/InputChoices.save"]')?.getAttribute('data-can-submit-state') === 'committed');
      assert.equal(await field('note').inputValue(), 'Retained Chromium draft');
      assert.deepEqual(traffic.filter(row => row.path.endsWith('InputChoices.save') && row.operationId === browserSaveNonce).at(-1)?.inputs,
        { country: { id: countries[0], version: '1' }, region: { id: regions[0], version: '2' }, note: 'Retained Chromium draft' });

      // Eligibility can disappear without changing the bound document version.
      // The already selected user is refused by the source predicate, and a
      // fresh candidate lookup reflects the current Employee/site relationship.
      await replaceData('Employee', employee, { user: { id: reviewer.user_id }, name: 'Reviewer', role: 'Approver', home: { id: sites[1] } });
      const ineligible = await submitBrowser('submit', browserReviewer);
      assert.equal(ineligible.code, 'rule_failed', JSON.stringify(ineligible));
      assert.equal(await browserReviewer.locator('[name="inputs[assignee]"]').inputValue(), reviewer.user_id);
      const noReviewer = await direct('submit/choices/assignee', { document: { id: document, version: '1' } });
      assert.equal(noReviewer.status, 200); assert.deepEqual(noReviewer.body.choices, []);
      assert.equal((await direct('assign', { submission: { id: submission, version: '1' }, assignee: { id: reviewer.user_id } })).body.code, 'rule_failed');
      await replaceData('Employee', employee, { user: { id: reviewer.user_id }, name: 'Reviewer', role: 'Approver', home: { id: sites[0] } });
      const restored = await direct('submit', { document: { id: document, version: '1' }, assignee: { id: reviewer.user_id } });
      assert.equal(restored.status, 200, JSON.stringify(restored)); assert.deepEqual(restored.body.result, { id: reviewer.user_id });

      // Revoking the native D1 membership refuses both HTTP lookup and a final
      // mutation from the same authenticated Chromium cookie jar.
      await storage.identity.removeMembership(membership.membership_id);
      const revisionBeforeDenied = await storage.state.readRevision();
      const deniedLookup = await direct('submit/choices/assignee', { document: { id: document, version: '1' } });
      assert.equal(deniedLookup.status, 403); assert.equal(deniedLookup.body.code, 'forbidden');
      assert.equal(deniedLookup.body.choices, undefined);
      const deniedMutation = await direct('save', { country: { id: countries[0], version: '1' }, region: { id: regions[0], version: '2' } });
      assert.equal(deniedMutation.status, 403); assert.equal(deniedMutation.body.code, 'forbidden');
      assert.equal(await storage.state.readRevision(), revisionBeforeDenied);
      await storage.identity.reactivateMembership(membership.membership_id, { is_owner: false, roles: [] });
      assert.deepEqual(pageErrors, []); assert.deepEqual(serverErrors, []);
    } finally {
      for (const release of heldResponses) release();
      await browser.close();
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    const beforeReopen = await storage.state.readRevision();
    await miniflare!.dispose(); miniflare = undefined; storage = await open(); worker = await assemble();
    const reopened = await choices('assign/choices/assignee', { submission: { id: submission, version: '1' } });
    assert.equal(reopened.status, 200, JSON.stringify(reopened));
    assert.deepEqual(reopened.body.choices?.[0]?.value, { id: reviewer.user_id });
    assert.equal(await storage.state.readRevision(), beforeReopen);
  } finally { await miniflare?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
