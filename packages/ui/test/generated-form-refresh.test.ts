import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type { DerivedOperationInputs, PresentationContext } from '@canlang/contracts';
import { form, deleteRecord, generatedFields } from '../src/forms.js';
import { startBrowserClient, startNativeBrowserClient, type BrowserClientOptions } from '../src/browser/bootstrap.js';
import type { SubmitFetch, SubmitFetchInit, SubmitFetchResponse } from '../src/client.js';

const context: PresentationContext = {
  preferredLocales: [], appDefaultLocale: 'en', theme: { mode: 'light', accent: 'blue', density: 'comfortable' },
  path: '/tasks', isPartial: false, csrfToken: 'csrf', principal: null, invocation: null,
  query: async () => ({ rows: [], columns: [] }),
};
const derived: DerivedOperationInputs = { operation: 'Tasks.create', kind: 'create', artifactVersion: 1,
  inputs: [{ name: 'title', kind: 'string', required: true }] };
async function markup(label = 'No records', nonce = 'one') {
  const create = await form({ context, derived, mode: 'create', operation: derived.operation,
    action: '/operations/Tasks.create', operationId: nonce, timeZone: 'UTC', fields: generatedFields(derived, 'create'),
    submit: 'Create', idPrefix: 'create' });
  const archive = await deleteRecord({ context, action: '/operations/Tasks.delete', operation: 'Tasks.delete',
    operationId: nonce, record: { id: 'task-1', version: '3' }, mode: 'archive', itemLabel: 'Task', confirm: 'Archive task?', idPrefix: 'archive' });
  return `<main id="can-main" data-can-context="Tasks"><p id="state">${label}</p>${create}${archive}</main>`;
}
const json = (body: unknown, status = 200): SubmitFetchResponse => ({ status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body) });
const success = (status = 'committed') => json({ status, operation_id: 'one', records: [], deliveries: [], result: null });
const html = (body: string): SubmitFetchResponse => ({ status: 200, headers: { get: () => 'text/html' }, text: async () => body });
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function setup(fetchImpl: SubmitFetch, native = false, observe?: BrowserClientOptions['onGeneratedFormResult']) {
  const window = new Window({ url: 'https://can.test/tasks?filter=open' });
  window.document.body.innerHTML = await markup();
  Object.defineProperty(window, 'fetch', { value: fetchImpl });
  const client = native ? startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0])
    : startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl,
      ...(observe === undefined ? {} : { onGeneratedFormResult: observe }) });
  const submit = (selector = 'form[data-can-generated-form]') => {
    const target = window.document.querySelector(selector)!;
    const event = new window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: target.querySelector('button')! });
    target.dispatchEvent(event); return event;
  };
  return { window, client, submit, close: async () => { client.stop(); await window.happyDOM.close(); } };
}
it('installed client refreshes confirmed commits and replays using one read while retaining another draft', async () => {
  const calls: Array<[string, SubmitFetchInit]> = [];
  const fresh = await markup('Created task', 'two');
  const page = await setup(async (url, init) => { calls.push([url, init]); return init.method === 'GET' ? html(fresh) : success('replayed'); }, true);
  try {
    const input = page.window.document.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[title]"]')!;
    input.value = 'My draft'; input.focus();
    assert.equal(page.submit().defaultPrevented, true); await settle();
    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [['/operations/Tasks.create', 'POST'], ['/tasks?filter=open', 'GET']]);
    assert.equal(calls[1]![1].headers['HX-Request'], 'true');
    assert.equal(page.window.document.getElementById('state')!.textContent, 'Created task');
    assert.equal(page.window.document.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[title]"]')!.value, 'My draft');
    assert.equal(page.window.document.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="operation_id"]')!.value, 'two', 'completed occurrence adopts the next server nonce');
  } finally { await page.close(); }
});
it('archive opt-in retains native fields, owns one pending submission and refreshes without navigation', async () => {
  let resolve!: (result: SubmitFetchResponse) => void;
  const calls: Array<[string, SubmitFetchInit]> = [];
  const page = await setup(async (url, init) => { calls.push([url, init]); return init.method === 'GET' ? html('<main id="can-main" data-can-context="Tasks"><p id="state">Archived</p></main>') : new Promise(done => { resolve = done; }); }, true);
  try {
    const target = page.window.document.querySelector('form[data-can-delete-form]')!;
    page.submit('form[data-can-delete-form]'); page.submit('form[data-can-delete-form]');
    assert.equal(calls.length, 1); assert.equal(target.querySelector('button')!.disabled, true);
    const encoded = new URLSearchParams(calls[0]![1].body as string);
    assert.deepEqual(Object.fromEntries(encoded), { operation: 'Tasks.delete', operation_id: 'one', _csrf: 'csrf', timezone: 'UTC', 'inputs[record][id]': 'task-1', 'inputs[record][version]': '3' });
    resolve(success()); await settle();
    assert.equal(calls.length, 2); assert.equal(page.window.document.getElementById('state')!.textContent, 'Archived');
    assert.equal(page.window.location.pathname, '/tasks');
  } finally { await page.close(); }
});
it('denials and unknown results preserve controls and feedback without issuing a page read', async () => {
  for (const reply of [json({ code: 'conflict', message: 'Changed by someone else' }, 409), json({ status: 'pending', operation_id: 'one' })]) {
    let calls = 0;
    const page = await setup(async () => { calls++; return reply; });
    try {
      const input = page.window.document.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[title]"]')!; input.value = 'Keep draft';
      page.submit(); await settle(); assert.equal(calls, 1); assert.equal(input.value, 'Keep draft');
      assert.equal(page.window.document.querySelector('[data-can-form-feedback]')!.hasAttribute('hidden'), false);
      assert.equal(page.window.document.querySelector<typeof page.window.HTMLButtonElement.prototype>('form button')!.disabled, false);
    } finally { await page.close(); }
  }
});
it('result observers still receive the commit alongside default refresh', async () => {
  let observed = 0, reads = 0;
  const page = await setup(async (_url, init) => { if (init.method === 'GET') { reads++; return html(await markup('Visible')); } return success(); }, false, () => { observed++; });
  try { page.submit(); await settle(); assert.equal(observed, 1); assert.equal(reads, 1); assert.equal(page.window.document.getElementById('state')!.textContent, 'Visible'); }
  finally { await page.close(); }
});
it('newer submission and disposal suppress stale ignored-abort refresh bodies', async () => {
  let finish!: (body: string) => void;
  let posts = 0;
  const page = await setup(async (_url, init) => {
    if (init.method === 'POST') { posts++; return posts === 1 ? success() : json({ code: 'validation', message: 'Keep latest draft' }, 422); }
    return { status: 200, headers: { get: () => 'text/html' }, text: () => new Promise(done => { finish = done; }) };
  });
  try {
    page.submit(); await settle(); page.submit(); await settle();
    finish(await markup('Stale')); await settle(); assert.equal(page.window.document.getElementById('state')!.textContent, 'No records');
    assert.equal(page.window.document.querySelector('[data-can-form-feedback]')!.textContent, 'Keep latest draft');
    page.client.stop();
  } finally { await page.close(); }
});
it('refuses foreign-context, full-document and failed refresh bodies without replacing the draft', async () => {
  for (const reply of [html('<main id="can-main" data-can-context="Other">Foreign</main>'), html('<!doctype html><html><body>Login</body></html>'), { ...html('Unavailable'), status: 500 }]) {
    const page = await setup(async (_url, init) => init.method === 'POST' ? success() : reply);
    try {
      const input = page.window.document.querySelector<typeof page.window.HTMLInputElement.prototype>('input[name="inputs[title]"]')!;
      input.value = 'Retain me'; page.submit(); await settle();
      assert.equal(page.window.document.getElementById('state')!.textContent, 'No records'); assert.equal(input.value, 'Retain me');
      assert.equal(page.window.document.querySelector('form')!.getAttribute('data-can-submit-state'), 'committed');
    } finally { await page.close(); }
  }
});
it('withdraws forms when the authorized page reread denies access and ignores unmarked forms', async () => {
  const page = await setup(async (_url, init) => init.method === 'POST' ? success() : json({ code: 'forbidden', message: 'Forbidden' }, 403));
  try {
    page.window.document.body.insertAdjacentHTML('beforeend', '<form id="sign-out" action="/sign-out" method="post"><button>Sign out</button></form>'); page.client.rescan();
    const event = new page.window.SubmitEvent('submit', { bubbles: true, cancelable: true });
    page.window.document.getElementById('sign-out')!.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
    page.submit(); await settle(); assert.equal(page.window.document.querySelector('#can-main form'), null);
    assert.ok(page.window.document.getElementById('sign-out'));
  } finally { await page.close(); }
});
