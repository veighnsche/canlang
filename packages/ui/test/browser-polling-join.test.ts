import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type { DerivedOperationInputs, PageDescriptor, PresentationContext, ShellData } from '@canlang/contracts';
import { list } from '../src/collections.js';
import { renderPage } from '../src/shell.js';
import { startBrowserClient, startNativeBrowserClient, type BrowserClientOptions } from '../src/browser/bootstrap.js';
import { GeneratedSubmitError, type GeneratedSubmitResult, type SubmitFetch, type SubmitFetchInit, type SubmitFetchResponse } from '../src/client.js';
import { form, generatedFields } from '../src/forms.js';

const context: PresentationContext = {
  preferredLocales: [], appDefaultLocale: 'en', theme: { mode: 'light', accent: 'blue', density: 'comfortable' },
  path: '/jobs', pollContext: 'principal/team/jobs', isPartial: false,
  csrfToken: 'csrf', principal: null, invocation: null,
  query: async () => ({ rows: [{ id: 'job-one', fields: {} }], columns: [] }),
};
const descriptor: PageDescriptor = { owner: 'Jobs', path: '/jobs', title: 'Jobs', poll: 1000n, admit: async () => ({}), render: async () => '' };
const shell: ShellData = {
  brand: 'Jobs', navigation: { groups: [], incomplete: false },
  routes: { signIn: '/sign-in', signOut: '/sign-out', switchTeam: '/team' },
  account: { authenticated: false, teams: [] }, settings: { sections: [] },
};
async function pageHtml(state: string, isPartial = false) {
  const collection = await list({ context, model: 'Jobs', empty: 'No jobs',
    controls: { context, regionId: 'jobs-list', baseHref: '/jobs' },
    renderRow: () => [`<p id="job-state">${state}</p>`],
  });
  return renderPage({ ...context, isPartial }, descriptor, [collection], shell);
}
class Clock {
  next = 0;
  tasks = new Map<number, () => void>();
  setTimeout = (callback: () => void, _ms: number) => { const id = ++this.next; this.tasks.set(id, callback); return id; };
  clearTimeout = (id: unknown) => { this.tasks.delete(id as number); };
  async tick() {
    const task = this.tasks.entries().next().value;
    assert.ok(task, 'a poll timer should be armed');
    this.tasks.delete(task[0]); task[1](); await settle();
  }
}
async function settle() { for (let index = 0; index < 15; index += 1) await Promise.resolve(); }
function response(text: () => Promise<string>): SubmitFetchResponse {
  return { status: 200, headers: { get: () => 'text/html' }, text };
}
async function setup(fetchImpl: SubmitFetch, initialVisibility = 'visible') {
  const window = new Window({ url: 'https://can.test/jobs' });
  window.document.write(await pageHtml('running'));
  let visibility = initialVisibility;
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
  const clock = new Clock();
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: clock.setTimeout });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: clock.clearTimeout });
  assert.equal('visibilityState' in window, false, 'visibility is owned by Document');
  const client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl });
  return { window, clock, client, setVisibility: (value: string) => { visibility = value; },
    close: async () => { client.stop(); await window.happyDOM.close(); } };
}

describe('browser polling document and emitted-markup join', () => {
  it('arms the emitted page marker around actual collection markup only after document visibility permits it', async () => {
    let calls = 0;
    const partial = await pageHtml('completed', true);
    const page = await setup(async (url) => { calls++; assert.equal(url, '/jobs'); return response(async () => partial); }, 'hidden');
    try {
      assert.equal(page.window.document.querySelectorAll('[data-can-poll]').length, 1);
      assert.equal(page.window.document.querySelector('[data-can-poll]')?.id, 'can-main');
      assert.ok(page.window.document.querySelector('#can-main [data-region="jobs-list"]'));
      assert.equal(page.clock.tasks.size, 0);
      assert.equal(calls, 0);
      page.setVisibility('visible'); page.client.rescan(true);
      await page.clock.tick();
      assert.equal(calls, 1);
      assert.equal(page.window.document.getElementById('job-state')?.textContent, 'completed');
      page.setVisibility('hidden'); await page.clock.tick();
      assert.equal(calls, 1);
      assert.equal(page.clock.tasks.size, 0);
    } finally { await page.close(); }
  });
  it('refuses a body completed while the document is hidden and re-arms fresh on visible rescan', async () => {
    let finish!: (body: string) => void;
    const delayedBody = new Promise<string>((resolve) => { finish = resolve; });
    const partial = await pageHtml('completed', true);
    let calls = 0;
    const page = await setup(async () => { calls++; return response(() => calls === 1 ? delayedBody : Promise.resolve(partial)); });
    try {
      await page.clock.tick();
      assert.equal(calls, 1);
      page.setVisibility('hidden'); finish(partial); await settle();
      assert.equal(page.window.document.getElementById('job-state')?.textContent, 'running');
      assert.equal(page.clock.tasks.size, 0);
      page.setVisibility('visible'); page.client.rescan(true); await page.clock.tick();
      assert.equal(calls, 2);
      assert.equal(page.window.document.getElementById('job-state')?.textContent, 'completed');
    } finally { await page.close(); }
  });
});

const formDerived: DerivedOperationInputs = {
  operation: 'Store.Job.schedule', kind: 'scenario', artifactVersion: 1,
  inputs: [
    { name: 'title', kind: 'string', required: true },
    { name: 'active', kind: 'boolean', required: false },
    { name: 'owner', kind: 'ref', model: 'Store.Owner', versioned: true, required: true },
    { name: 'tags', kind: 'string', array: { required: false }, required: false },
  ],
};
async function sourceForm() {
  return form({ context, derived: formDerived, operation: formDerived.operation, mode: 'scenario',
    action: '/operations/schedule', operationId: 'rendered-operation-id', timeZone: 'UTC',
    fields: generatedFields(formDerived, 'scenario'), submit: 'Schedule', idPrefix: 'schedule',
    children: [
      '<input name="inputs[title]" value="first"><input name="inputs[title]" value="last">' +
      '<input disabled name="inputs[title]" value="disabled"><input value="unnamed">' +
      '<input type="hidden" name="inputs[active]" value="false">' +
      '<input type="checkbox" checked name="inputs[active]" value="true">' +
      '<input type="checkbox" name="inputs[title]" value="unchecked">' +
      '<input name="inputs[owner]" value="owner-1"><input name="inputs[owner__version]" value="7">' +
      '<textarea name="inputs[tags]">["last"]</textarea>' +
      '<button type="button" name="inputs[title]" value="button">Other</button>' +
      '<button id="activated" type="submit" name="inputs[title]" value="activated">Activated</button>' +
      '<button type="submit" name="inputs[title]" value="inactive-submit">Inactive</button>',
    ],
  });
}
function committed(): SubmitFetchResponse {
  return { status: 200, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ status: 'committed', operation_id: 'rendered-operation-id', records: [], deliveries: [], result: null }) };
}
async function formPage(fetchImpl: SubmitFetch, html?: string) {
  const window = new Window({ url: 'https://can.test/jobs' });
  window.document.body.innerHTML = html ?? await sourceForm();
  const results: GeneratedSubmitResult[] = [], errors: unknown[] = [];
  const client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl,
    onGeneratedFormResult: (_form, result) => results.push(result), onGeneratedFormError: (_form, error) => errors.push(error) });
  const submit = (submitter = false) => {
    const target = window.document.querySelector('form')!;
    const event = new window.SubmitEvent('submit', { bubbles: true, cancelable: true,
      ...(submitter ? { submitter: window.document.querySelector<typeof window.HTMLButtonElement.prototype>('#activated')! } : {}) });
    target.dispatchEvent(event);
    return event;
  };
  return { window, client, results, errors, submit,
    close: async () => { client.stop(); await window.happyDOM.close(); } };
}

describe('prepared source form browser submission', () => {
  it('projects only rendered partial-update fields and keeps an unchecked selected boolean false', async () => {
    const derived: DerivedOperationInputs = { ...formDerived, operation: 'Store.Job.update', kind: 'update',
      inputs: [{ name: 'record', kind: 'ref', model: 'Store.Job', versioned: true, required: true },
        ...formDerived.inputs] };
    for (const selected of ['title', 'active']) {
      const html = await form({ context, derived, operation: derived.operation, mode: 'update',
        record: { id: 'job-one', version: '9' }, action: '/operations/update',
        operationId: 'rendered-operation-id', timeZone: 'UTC',
        fields: generatedFields(derived, 'update').filter(field => field.path === selected),
        submit: 'Save', idPrefix: `selected-${selected}`,
        ...(selected === 'title' ? { children: ['<input name="inputs[changes][title]" value="edited"><input name="inputs[changes][owner]" value="tampered"><input name="inputs[changes][unknown]" value="extra">'] } : {}),
      });
      const calls: SubmitFetchInit[] = [];
      const page = await formPage(async (_url, init) => { calls.push(init); return committed(); }, html);
      try {
        const metadata = JSON.parse(page.window.document.querySelector('form')!.getAttribute('data-can-generated-form')!);
        assert.deepEqual(metadata.derived, derived, 'complete operation metadata stays intact');
        assert.deepEqual(metadata.renderedInputs, [selected]);
        page.submit(); await settle();
        assert.deepEqual(page.errors, []); assert.equal(calls.length, 1);
        assert.deepEqual(JSON.parse(calls[0]!.body as string).inputs,
          { record: { id: 'job-one', version: '9' }, ...(selected === 'title' ? { title: 'edited' } : { active: false }) });
      } finally { await page.close(); }
    }
  });

  it('projects native successful controls with rendered identity, CSRF and reference version; retries reuse identity', async () => {
    const calls: Array<{ url: string; init: SubmitFetchInit }> = [];
    const page = await formPage(async (url, init) => { calls.push({ url, init }); return committed(); });
    try {
      const target = page.window.document.querySelector('form')!;
      target.querySelector('input[name="operation"]')!.setAttribute('value', 'Tampered.operation');
      const event = page.submit();
      assert.equal(event.defaultPrevented, true);
      assert.equal(target.getAttribute('aria-busy'), 'true');
      assert.equal(page.submit().defaultPrevented, true, 'duplicate submit is intercepted while pending');
      await settle();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, '/operations/schedule');
      assert.equal(calls[0]!.init.headers['x-csrf-token'], 'csrf');
      assert.equal(calls[0]!.init.headers['content-type'], 'application/json');
      assert.equal(calls[0]!.init.headers['accept'], 'application/json');
      assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
        operation: formDerived.operation, operation_id: 'rendered-operation-id',
        inputs: { title: 'last', active: true, owner: { id: 'owner-1', version: '7' }, tags: ['last'] },
      });
      assert.equal(target.getAttribute('data-can-submit-state'), 'committed');
      assert.equal(target.hasAttribute('aria-busy'), false);
      page.submit(true); await settle();
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(calls[1]!.init.body as string).inputs.title, 'activated');
      assert.equal(JSON.parse(calls[1]!.init.body as string).operation_id, 'rendered-operation-id');
      assert.equal(page.results.length, 2); assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  });

  it('prevents native bracket submission on malformed metadata, projection failure and unsupported picked bytes', async () => {
    let calls = 0;
    const page = await formPage(async () => { calls++; return committed(); });
    try {
      const target = page.window.document.querySelector('form')!, metadata = target.getAttribute('data-can-generated-form')!;
      target.setAttribute('data-can-generated-form', '{');
      assert.equal(page.submit().defaultPrevented, true); await settle();
      target.setAttribute('data-can-generated-form', metadata);
      target.querySelector('input[name="inputs[active]"][type="checkbox"]')!.setAttribute('value', 'invalid-bool');
      assert.equal(page.submit().defaultPrevented, true); await settle();
      assert.ok(page.errors[1] instanceof GeneratedSubmitError && page.errors[1].code === 'projection');
      const picker = page.window.document.createElement('input'); picker.type = 'file';
      Object.defineProperty(picker, 'files', { value: [new page.window.File(['bytes'], 'picked.txt')] });
      target.appendChild(picker);
      assert.equal(page.submit().defaultPrevented, true); await settle();
      assert.ok(page.errors[2] instanceof GeneratedSubmitError && page.errors[2].code === 'usage');
      assert.equal(calls, 0); assert.equal(target.getAttribute('data-can-submit-state'), 'error');
      assert.equal(target.hasAttribute('aria-busy'), false);
    } finally { await page.close(); }
  });

  it('shows safe projection and backend feedback only in the submitted occurrence, keeping drafts and clearing on retry', async () => {
    const backend = {
      code: 'validation', message: 'Please correct this form.',
      fields: [
        { path: '/title', code: 'required', message: '<img src=x onerror=alert(1)> needs a title.' },
        { path: '/omitted', code: 'required', message: 'The omitted input still needs attention.' },
      ],
    };
    let calls = 0;
    const page = await formPage(async (_url, init) => {
      calls++;
      assert.equal(init.headers['accept'], 'application/json');
      return calls === 1 ? { status: 422, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(backend) } : committed();
    });
    try {
      page.window.document.body.insertAdjacentHTML('beforeend', await sourceForm());
      const [submitted, neighboring] = page.window.document.querySelectorAll('form');
      assert.ok(submitted && neighboring);
      const feedback = submitted.querySelector('[data-can-form-feedback]')!;
      const otherFeedback = neighboring.querySelector('[data-can-form-feedback]')!;
      otherFeedback.textContent = 'Neighbor feedback'; otherFeedback.removeAttribute('hidden');
      const neighborMarkup = neighboring.outerHTML;
      const title = submitted.querySelectorAll<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[title]"]')[1]!;
      title.value = 'Edited draft <strong>text</strong>';
      const identity = submitted.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="operation_id"]')!;
      const csrf = submitted.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="_csrf"]')!;
      const version = submitted.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[owner__version]"]')!;
      const checkbox = submitted.querySelector<typeof page.window.HTMLInputElement.prototype>('input[type="checkbox"][name="inputs[active]"]')!;
      checkbox.value = 'invalid-bool';
      page.client.rescan();
      page.submit(); await settle();
      assert.equal(calls, 0);
      assert.equal(feedback.hasAttribute('hidden'), false);
      assert.equal(feedback.getAttribute('data-can-form-feedback-code'), 'projection');
      assert.match(feedback.textContent!, /bool input "active"/);
      assert.equal(title.value, 'Edited draft <strong>text</strong>');
      assert.equal(neighboring.outerHTML, neighborMarkup);
      checkbox.value = 'true';
      page.submit();
      assert.equal(feedback.textContent, ''); assert.equal(feedback.hasAttribute('hidden'), true);
      await settle();
      assert.equal(feedback.textContent, backend.message + '\n' + backend.fields.map(field => field.message).join('\n'));
      assert.equal(feedback.querySelector('img'), null);
      assert.equal(feedback.hasAttribute('hidden'), false);
      assert.equal(feedback.getAttribute('data-can-form-feedback-code'), 'validation');
      const result = page.results[0]; assert.ok(result?.kind === 'denied');
      assert.deepEqual(result.error, backend, 'checked public codes and paths stay intact in the result');
      assert.equal(submitted.querySelector('input[name="operation_id"]'), identity);
      assert.equal(identity.value, 'rendered-operation-id'); assert.equal(csrf.value, 'csrf'); assert.equal(version.value, '7');
      assert.equal(submitted.querySelector('input[name="inputs[title]"]')?.nextElementSibling, title);
      assert.equal(title.value, 'Edited draft <strong>text</strong>');
      assert.equal(neighboring.outerHTML, neighborMarkup);
      page.submit(); await settle();
      assert.equal(calls, 2); assert.equal(submitted.getAttribute('data-can-submit-state'), 'committed');
      assert.equal(feedback.textContent, ''); assert.equal(feedback.hasAttribute('hidden'), true);
      assert.equal(feedback.hasAttribute('data-can-form-feedback-code'), false);
      assert.equal(title.value, 'Edited draft <strong>text</strong>'); assert.equal(neighboring.outerHTML, neighborMarkup);
    } finally { await page.close(); }
  });

  it('uses fixed public text for transport, contract and usage failures without applying legacy HTML', async () => {
    let html = false;
    const page = await formPage(async () => {
      if (!html) throw new Error('INTERNAL_TRANSPORT_DIAGNOSTIC');
      return { status: 422, headers: { get: () => 'text/html' },
        text: async () => '<form>UNRELATED_LEGACY_OCCURRENCE</form>' };
    });
    try {
      const target = page.window.document.querySelector('form')!;
      const feedback = target.querySelector('[data-can-form-feedback]')!;
      page.submit(); await settle();
      assert.equal(feedback.textContent, 'The submission could not be confirmed. Please try again.');
      assert.equal(feedback.getAttribute('data-can-form-feedback-code'), 'submit_failed');
      html = true; page.submit(); await settle();
      assert.equal(feedback.textContent, 'The submission could not be confirmed. Please try again.');
      assert.ok(page.errors[1] instanceof GeneratedSubmitError && page.errors[1].code === 'contract');
      assert.equal(page.window.document.querySelector('form'), target);
      assert.equal(target.textContent?.includes('UNRELATED_LEGACY_OCCURRENCE'), false);
      target.removeAttribute('action'); page.submit(); await settle();
      assert.equal(feedback.textContent, 'The submission could not be confirmed. Please try again.');
      assert.ok(page.errors[2] instanceof GeneratedSubmitError && page.errors[2].code === 'usage');
    } finally { await page.close(); }
  });

  it('rebinds swaps once and suppresses detached or stopped outcome delivery without claiming cancellation', async () => {
    let finish!: (response: SubmitFetchResponse) => void, calls = 0;
    const page = await formPage(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    try {
      const old = page.window.document.querySelector('form')!;
      page.submit(); assert.equal(calls, 1);
      page.window.document.body.innerHTML = await sourceForm();
      page.client.rescan(); page.client.rescan();
      finish(committed()); await settle();
      assert.equal(old.hasAttribute('aria-busy'), false); assert.deepEqual(page.results, []);
      page.submit(); assert.equal(calls, 2);
      page.client.stop(); finish(committed()); await settle();
      assert.deepEqual(page.results, []); assert.deepEqual(page.errors, []);
      assert.equal(page.window.document.querySelector('form')!.hasAttribute('aria-busy'), false);
      assert.equal(page.submit().defaultPrevented, false, 'stop removes its owned listener');
      assert.equal(calls, 2);
    } finally { await page.close(); }
  });

  it('forwards the projected JSON body through the installed native adapter', async () => {
    const window = new Window({ url: 'https://can.test/jobs' });
    window.document.body.innerHTML = await sourceForm();
    const calls: SubmitFetchInit[] = [];
    Object.defineProperty(window, 'fetch', { value: async (_url: string, init: SubmitFetchInit) => { calls.push(init); return committed(); } });
    const client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
    try {
      const target = window.document.querySelector('form')!;
      const event = new window.SubmitEvent('submit', { bubbles: true, cancelable: true });
      target.dispatchEvent(event); await settle();
      assert.equal(event.defaultPrevented, true); assert.equal(calls.length, 1);
      assert.equal(JSON.parse(calls[0]!.body as string).operation, formDerived.operation);
      assert.equal(target.getAttribute('data-can-submit-state'), 'committed');
    } finally { client.stop(); await window.happyDOM.close(); }
  });
});

async function pollingFormHtml(state: string, partial = false, bindingIdentity = 'same-binding') {
  const window = new Window();
  try {
    window.document.body.innerHTML = await sourceForm();
    const target = window.document.querySelector('form')!;
    const metadata = JSON.parse(target.getAttribute('data-can-generated-form')!);
    target.setAttribute('data-can-generated-form', JSON.stringify({ ...metadata, bindingIdentity }));
    target.querySelector('input[name="inputs[owner__version]"]')!.setAttribute('type', 'hidden');
    target.insertAdjacentHTML('beforeend', '<input type="hidden" name="form_binding" value="original-sealed-token">');
    return renderPage({ ...context, isPartial: partial }, descriptor,
      [`<p id="job-state">${state}</p>`, target.outerHTML], shell);
  } finally { await window.happyDOM.close(); }
}

async function pollingFormPage(fetchImpl: SubmitFetch) {
  const window = new Window({ url: 'https://can.test/jobs' });
  window.document.write(await pollingFormHtml('running'));
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'visible' });
  const clock = new Clock();
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: clock.setTimeout });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: clock.clearTimeout });
  const results: GeneratedSubmitResult[] = [];
  const client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl,
    onGeneratedFormResult: (_form, result) => results.push(result) });
  const submit = () => window.document.querySelector('form')!.dispatchEvent(
    new window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  return { window, clock, client, results, submit,
    close: async () => { client.stop(); await window.happyDOM.close(); } };
}

describe('source form polling occurrence lifecycle', () => {
  it('retains the occurrence nonce, sealed binding, CSRF/version and feedback with edited input and focus', async () => {
    const fresh = (await pollingFormHtml('completed', true))
      .replace('rendered-operation-id', 'fresh-operation-id').replace('original-sealed-token', 'fresh-sealed-token')
      .replace('value="csrf"', 'value="fresh-csrf"').replace('value="7"', 'value="8"');
    const calls: SubmitFetchInit[] = [];
    const page = await pollingFormPage(async (_url, init) => {
      if (init.method === 'GET') return response(async () => fresh);
      calls.push(init);
      return { status: 422, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ code: 'validation', message: 'Keep this feedback.' }) };
    });
    try {
      const target = page.window.document.querySelector('form')!;
      const title = target.querySelectorAll<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[title]"]')[1]!;
      title.value = 'Draft for this occurrence'; title.focus();
      page.submit(); await settle();
      const feedback = target.querySelector('[data-can-form-feedback]')!;
      const original = ['operation_id', 'form_binding', '_csrf', 'inputs[owner__version]']
        .map(name => target.querySelector<typeof page.window.HTMLInputElement.prototype>(`input[name="${name}"]`)!);
      await page.clock.tick();
      assert.equal(page.window.document.getElementById('job-state')?.textContent, 'completed');
      assert.equal(page.window.document.querySelector('form'), target);
      assert.deepEqual(original.map(control => control.value), ['rendered-operation-id', 'original-sealed-token', 'csrf', '7']);
      assert.equal(target.querySelector('[data-can-form-feedback]'), feedback);
      assert.equal(feedback.textContent, 'Keep this feedback.');
      assert.equal(feedback.getAttribute('data-can-form-feedback-code'), 'validation');
      assert.equal(target.getAttribute('data-can-submit-state'), 'denied');
      assert.equal(title.value, 'Draft for this occurrence'); assert.equal(page.window.document.activeElement, title);
      page.submit(); await settle();
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(calls[1]!.body as string).operation_id, 'rendered-operation-id');
      assert.equal(calls[1]!.headers['x-csrf-token'], 'csrf');
    } finally { await page.close(); }
  });

  it('keeps an in-flight occurrence bound once through a poll and delivers its eventual result', async () => {
    const fresh = (await pollingFormHtml('completed', true)).replace('rendered-operation-id', 'fresh-operation-id')
      .replace('original-sealed-token', 'fresh-sealed-token');
    let finish!: (value: SubmitFetchResponse) => void;
    let submissions = 0;
    const page = await pollingFormPage(async (_url, init) => init.method === 'GET'
      ? response(async () => fresh) : (submissions++, new Promise(resolve => { finish = resolve; })));
    try {
      const target = page.window.document.querySelector('form')!;
      page.submit(); await page.clock.tick();
      assert.equal(target.getAttribute('aria-busy'), 'true');
      assert.equal(target.getAttribute('data-can-submit-state'), 'pending');
      page.submit(); assert.equal(submissions, 1);
      finish(committed()); await settle();
      assert.equal(page.results.length, 1); assert.equal(target.getAttribute('data-can-submit-state'), 'committed');
      assert.equal(target.hasAttribute('aria-busy'), false);
    } finally { await page.close(); }
  });

  it('replaces changed binding or schema with fresh authority and suppresses the detached pending outcome', async () => {
    for (const changed of ['binding', 'schema']) {
      let fresh = (await pollingFormHtml('completed', true, changed === 'binding' ? 'different-binding' : 'same-binding'))
        .replace('rendered-operation-id', 'fresh-operation-id').replace('original-sealed-token', 'fresh-sealed-token');
      if (changed === 'schema') fresh = fresh.replace('artifactVersion&quot;:1', 'artifactVersion&quot;:2');
      let finish!: (value: SubmitFetchResponse) => void;
      const page = await pollingFormPage(async (_url, init) => init.method === 'GET'
        ? response(async () => fresh) : new Promise(resolve => { finish = resolve; }));
      try {
        const old = page.window.document.querySelector('form')!;
        const title = old.querySelectorAll<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[title]"]')[1]!;
        title.value = 'Old draft'; title.focus(); page.submit();
        old.querySelector('[data-can-form-feedback]')!.textContent = 'Old feedback';
        await page.clock.tick();
        const current = page.window.document.querySelector('form')!;
        assert.notEqual(current, old);
        assert.equal(current.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="operation_id"]')!.value, 'fresh-operation-id');
        assert.equal(current.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="form_binding"]')!.value, 'fresh-sealed-token');
        assert.equal(current.hasAttribute('aria-busy'), false); assert.equal(current.hasAttribute('data-can-submit-state'), false);
        assert.equal(current.querySelector('[data-can-form-feedback]')!.textContent, '');
        finish(committed()); await settle(); assert.deepEqual(page.results, []);
      } finally { await page.close(); }
    }
  });

  it('withdraws writable controls on the actual current-context forbidden poll without reading or painting its body', async () => {
    let finish!: (value: SubmitFetchResponse) => void;
    const page = await pollingFormPage(async (_url, init) => init.method === 'GET'
      ? { status: 403, headers: { get: () => 'text/html' }, text: async () => { throw new Error('Forbidden body must not be read'); } }
      : new Promise(resolve => { finish = resolve; }));
    try {
      const old = page.window.document.querySelector('form')!;
      page.submit(); await page.clock.tick();
      const region = page.window.document.getElementById('can-main')!;
      assert.equal(region.querySelectorAll('form, input, button, select, textarea').length, 0);
      assert.equal(page.window.document.getElementById('job-state')?.textContent, 'running');
      assert.equal(page.clock.tasks.size, 0); assert.equal(page.window.document.querySelector('[data-can-poll]'), null);
      assert.equal(old.isConnected, false);
      finish(committed()); await settle(); assert.deepEqual(page.results, []);
      page.client.rescan(true); assert.equal(page.clock.tasks.size, 0);
    } finally { await page.close(); }
  });

  it('does not withdraw the new context from a delayed forbidden response for an obsolete context', async () => {
    let finish!: (value: SubmitFetchResponse) => void;
    const page = await pollingFormPage(async () => new Promise(resolve => { finish = resolve; }));
    try {
      await page.clock.tick();
      const target = page.window.document.querySelector('form')!;
      page.window.document.body.setAttribute('data-can-context', 'different-actor/team');
      finish({ status: 403, headers: { get: () => 'text/html' }, text: async () => '<form>untrusted</form>' }); await settle();
      assert.equal(page.window.document.querySelector('form'), target); assert.equal(page.clock.tasks.size, 0);
    } finally { await page.close(); }
  });
});
