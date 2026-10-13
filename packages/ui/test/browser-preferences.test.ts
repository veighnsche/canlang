import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window, type HTMLSelectElement, type HTMLFormElement, type HTMLInputElement, type HTMLButtonElement } from 'happy-dom';
import { startBrowserClient, startNativeBrowserClient, type BrowserClientOptions } from '../src/browser/bootstrap.js';
import type { SubmitFetch, SubmitFetchInit, SubmitFetchResponse } from '../src/client.js';

const action = '/jobs?team=team-1&search=ready';
function field(name: string, value: string, version: string): string {
  const authority = `<input type="hidden" name="_csrf" value="csrf-${version}"><input type="hidden" name="_version" value="${version}">`;
  return `<fieldset data-can-preference-field="${name}"><form action="/jobs?team=team-1&amp;search=ready" method="post" data-can-preference-form="save">${authority}<select name="${name}"><option value="list"${value === 'list' ? ' selected' : ''}>List</option><option value="board"${value === 'board' ? ' selected' : ''}>Board</option></select><button type="submit">Save</button></form><form action="/jobs?team=team-1&amp;search=ready" method="post" data-can-preference-form="reset">${authority}<input type="hidden" name="${name}" value="list"><button type="submit">Reset</button></form><p role="alert" data-can-preference-error></p></fieldset>`;
}
function html(value = 'list', version = '0', state = 'list'): string {
  return `<!doctype html><html><body data-can-context="actor-team"><main id="can-main" data-can-context="jobs"><h1>${state}</h1><form id="business" action="/api/jobs"><input name="title" value="Server title"></form></main><input id="can-settings" type="checkbox"><section class="can-settings-sidebar">Jobs</section><section class="can-settings-panel">${field('view', value, version)}${field('other', 'list', '0')}<button type="button" data-can-preference-cancel>Cancel</button></section></body></html>`;
}
const response = (status: number, body: string): SubmitFetchResponse => ({ status, headers: { get: () => status === 200 ? 'text/html' : 'application/json' }, text: async () => body });
async function settle(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function setup(fetchImpl: SubmitFetch) {
  const window = new Window({ url: `https://can.test${action}` });
  window.document.write(html());
  const client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl });
  const view = () => window.document.querySelector<HTMLSelectElement>('[data-can-preference-field="view"] select')!;
  const form = (kind = 'save') => window.document.querySelector<HTMLFormElement>(`[data-can-preference-field="view"] form[data-can-preference-form="${kind}"]`)!;
  const submit = (kind = 'save') => {
    const target = form(kind);
    const event = new window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: target.querySelector('button')! });
    target.dispatchEvent(event);
    return event;
  };
  return { window, client, view, form, submit, close: async () => { client.stop(); await window.happyDOM.close(); } };
}

test('preferences: save and reset post canonical authority, refresh accepted values and preserve neighboring drafts', async () => {
  const calls: Array<{ url: string; init: SubmitFetchInit }> = [];
  const page = setup(async (url, init) => {
    calls.push({ url, init });
    return response(200, calls.length === 1 ? html('board', '1', 'board') : html('list', '2', 'list'));
  });
  try {
    const business = page.window.document.querySelector<HTMLInputElement>('#business input')!;
    const other = page.window.document.querySelector<HTMLSelectElement>('[data-can-preference-field="other"] select')!;
    const toggle = page.window.document.getElementById('can-settings') as unknown as HTMLInputElement;
    business.value = 'Unsaved business draft'; other.value = 'board'; toggle.checked = true;
    page.view().value = 'board'; page.view().focus();
    assert.equal(page.submit().defaultPrevented, true);
    await settle();
    assert.equal(calls.length, 1); assert.equal(calls[0]!.url, action);
    assert.equal(calls[0]!.init.method, 'POST'); assert.equal(calls[0]!.init.mode, 'same-origin');
    assert.equal(calls[0]!.init.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual([...new URLSearchParams(calls[0]!.init.body as string)], [['_csrf', 'csrf-0'], ['_version', '0'], ['view', 'board']]);
    assert.equal(page.window.document.querySelector('h1')!.textContent, 'board');
    assert.equal(page.view().value, 'board');
    assert.equal(page.form().querySelector<HTMLInputElement>('[name="_version"]')!.value, '1');
    assert.equal(page.form('reset').querySelector<HTMLInputElement>('[name="_version"]')!.value, '1');
    assert.equal(business.value, 'Unsaved business draft'); assert.equal(other.value, 'board'); assert.equal(toggle.checked, true);
    page.view().value = 'list';
    (page.window.document.querySelector('[data-can-preference-cancel]') as unknown as HTMLButtonElement).click();
    assert.equal(page.view().value, 'board'); assert.equal(other.value, 'list'); assert.equal(toggle.checked, false); assert.equal(calls.length, 1);
    toggle.checked = true;
    page.submit('reset'); await settle();
    assert.deepEqual([...new URLSearchParams(calls[1]!.init.body as string)], [['_csrf', 'csrf-1'], ['_version', '1'], ['view', 'list']]);
    assert.equal(page.view().value, 'list'); assert.equal(page.form().querySelector<HTMLInputElement>('[name="_version"]')!.value, '2');
    assert.equal(page.window.document.querySelector('h1')!.textContent, 'list'); assert.equal(business.value, 'Unsaved business draft');
  } finally { await page.close(); }
});

test('preferences: pending save guards sibling reset; conflicts retain draft and render safe scoped feedback', async () => {
  let finish!: (value: SubmitFetchResponse) => void;
  let calls = 0;
  const page = setup(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  try {
    page.view().value = 'board'; page.submit(); page.submit(); page.submit('reset');
    assert.equal(calls, 1); assert.equal(page.form().getAttribute('aria-busy'), 'true');
    assert.equal(page.form('reset').querySelector('button')!.hasAttribute('disabled'), true);
    finish(response(409, JSON.stringify({ code: 'conflict', message: '<img src=x onerror=bad()> Preference changed; reload the page.' })));
    await settle();
    assert.equal(page.view().value, 'board'); assert.equal(page.form().querySelector<HTMLInputElement>('[name="_version"]')!.value, '0');
    assert.equal(page.form().getAttribute('data-can-submit-state'), 'denied'); assert.equal(page.form().hasAttribute('aria-busy'), false);
    const error = page.window.document.querySelector('[data-can-preference-field="view"] [data-can-preference-error]')!;
    assert.equal(error.getAttribute('data-can-preference-error-code'), 'conflict'); assert.match(error.textContent!, /<img/); assert.equal(error.querySelector('img'), null);
    assert.equal(page.window.document.querySelector('[data-can-preference-field="other"] [data-can-preference-error]')!.textContent, '');
    page.submit('reset'); assert.equal(calls, 2);
    finish(response(200, html('list', '1'))); await settle();
    assert.equal(page.view().value, 'list'); assert.equal(error.textContent, '');
  } finally { await page.close(); }
});

test('preferences: transport failure keeps drafts; disposed requests cannot replace a page', async () => {
  let finish!: (value: SubmitFetchResponse) => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const page = setup(async (_url, init) => {
    calls++; if (calls === 1) throw new Error('private transport detail');
    signal = init.signal; return new Promise(resolve => { finish = resolve; });
  });
  try {
    page.view().value = 'board'; page.submit(); await settle();
    assert.equal(page.view().value, 'board'); assert.equal(page.form().getAttribute('data-can-submit-state'), 'error');
    assert.doesNotMatch(page.window.document.querySelector('[data-can-preference-error]')!.textContent!, /private transport/);
    page.submit(); page.client.stop(); assert.equal(signal!.aborted, true);
    finish(response(200, html('board', '1', 'board'))); await settle();
    assert.equal(page.window.document.querySelector('h1')!.textContent, 'list'); assert.equal(page.view().value, 'board');
    assert.equal(page.form().hasAttribute('aria-busy'), false);
  } finally { await page.close(); }
});

test('preferences: native fallback remains available and rejected page responses cannot paint content', async () => {
  const window = new Window({ url: `https://can.test${action}` });
  window.document.write(html());
  Object.defineProperty(window, 'FormData', { value: undefined });
  let fetches = 0;
  const client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], fetchImpl: async () => { fetches++; return response(200, html()); } });
  try {
    const form = window.document.querySelector('[data-can-preference-form="save"]')!;
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false); assert.equal(form.getAttribute('method'), 'post'); assert.equal(form.getAttribute('action'), action); assert.equal(fetches, 0);
  } finally { client.stop(); await window.happyDOM.close(); }
  const page = setup(async () => response(200, html('board', '1', 'foreign').replace('data-can-context="jobs"', 'data-can-context="foreign"')));
  try {
    page.view().value = 'board'; page.submit(); await settle();
    assert.equal(page.window.document.querySelector('h1')!.textContent, 'list');
    assert.equal(page.view().value, 'board'); assert.equal(page.form().querySelector<HTMLInputElement>('[name="_version"]')!.value, '0');
    assert.equal(page.form().getAttribute('data-can-submit-state'), 'error');
  } finally { await page.close(); }
});

test('preferences: installed native adapter accepts the existing followed POST redirect', async () => {
  const window = new Window({ url: `https://can.test${action}` });
  window.document.write(html());
  const calls: Array<SubmitFetchInit & { credentials: string; cache: string }> = [];
  Object.defineProperty(window, 'fetch', { value: async (_url: string, init: typeof calls[number]) => {
    calls.push(init); return { ...response(200, html('board', '1', 'board')), redirected: true };
  } });
  const client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
  try {
    const form = window.document.querySelector<HTMLFormElement>('[data-can-preference-form="save"]')!;
    form.querySelector<HTMLSelectElement>('select')!.value = 'board';
    form.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button')! }));
    await settle();
    assert.equal(calls.length, 1); assert.equal(calls[0]!.credentials, 'same-origin'); assert.equal(calls[0]!.cache, 'no-store');
    assert.equal(form.getAttribute('data-can-submit-state'), 'committed');
    assert.equal(form.querySelector<HTMLInputElement>('[name="_version"]')!.value, '1');
    assert.equal(window.document.querySelector('h1')!.textContent, 'board');
  } finally { client.stop(); await window.happyDOM.close(); }
});
