import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type { PageDescriptor, PresentationContext, ShellData } from '@canlang/contracts';
import { renderPage } from '../src/shell.js';
import { applyPollResponse, startNativeBrowserClient, type DocumentLike, type ElementLike } from '../src/browser/bootstrap.js';
import type { SubmitFetchResponse } from '../src/client.js';

const descriptor: PageDescriptor = { owner: 'Images', path: '/jobs', title: 'Images', poll: 2000n, admit: async () => ({}), render: async () => '' };
const context: PresentationContext = {
  preferredLocales: [], appDefaultLocale: 'en', theme: { mode: 'light', accent: 'blue', density: 'comfortable' },
  path: '/jobs', pollContext: 'principal-one/team-one/jobs', isPartial: false,
  csrfToken: 'csrf', principal: null, invocation: null, query: async () => ({ rows: [], columns: [] }),
};
const shell: ShellData = {
  brand: 'Images', navigation: { groups: [], incomplete: false },
  routes: { signIn: '/sign-in', signOut: '/sign-out', switchTeam: '/team' },
  account: { authenticated: false, teams: [] }, settings: { sections: [] },
};
const prompt = '<form id="prompt-form" action="/operations" method="post"><input type="hidden" name="operation" value="Images.generate"><input type="hidden" name="operation_id" value="operation-old"><label>Prompt<input id="prompt" name="inputs[prompt]" value=""></label><button>Generate</button></form>';
function content(state: 'running' | 'completed') {
  return prompt + (state === 'running' ? '<section id="job"><p role="status">Generating…</p></section>' : '<section id="job"><img alt="Generated image" src="/files/image-one"></section>');
}
async function partial(state: 'running' | 'completed', key = context.pollContext!) {
  return renderPage({ ...context, isPartial: true, pollContext: key }, descriptor, [content(state)]);
}
class Clock {
  next = 0;
  tasks = new Map<number, () => void>();
  setTimeout(callback: () => void, _ms: number) { const id = ++this.next; this.tasks.set(id, callback); return id; }
  clearTimeout(id: unknown) { this.tasks.delete(id as number); }
  async tick() {
    const task = this.tasks.entries().next().value;
    assert.ok(task, 'a poll timer should be armed');
    this.tasks.delete(task[0]); task[1]();
    await settle();
  }
}
async function settle() { for (let index = 0; index < 15; index += 1) await Promise.resolve(); }
function response(body: string, status = 200): SubmitFetchResponse { return { status, headers: { get: () => 'text/html' }, text: async () => body }; }
async function setup(fetcher: (url: string, init: { headers: Record<string, string> }) => Promise<SubmitFetchResponse>, pageContext: PresentationContext = context) {
  const window = new Window({ url: `https://can.test${pageContext.pollUrl ?? pageContext.path}` });
  window.document.write(await renderPage(pageContext, descriptor, [content('running')], shell));
  const clock = new Clock();
  let visibility = 'visible';
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
  const native = {
    document: window.document, location: window.location,
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock), fetch: fetcher,
  } as unknown as Parameters<typeof startNativeBrowserClient>[0];
  const client = startNativeBrowserClient(native);
  return { window, clock, client, setVisibility: (value: string) => { visibility = value; window.document.dispatchEvent(new window.Event('visibilitychange')); }, close: async () => { client.stop(); await window.happyDOM.close(); } };
}

describe('configured page polling', () => {
  it('renders stable typed polling metadata and an external browser entry', async () => {
    const html = await renderPage(context, descriptor, [content('running')], shell);
    assert.match(html, /<main id="can-main"[^>]*data-can-poll/);
    assert.match(html, /data-can-poll-url="\/jobs"/);
    assert.match(html, /data-can-poll-interval="2"/);
    assert.match(html, /<script type="module" src="\/assets\/browser\/bootstrap.js"><\/script>/);
    const noPoll = { ...descriptor }; delete (noPoll as { poll?: bigint }).poll;
    const staticHtml = await renderPage(context, noPoll, ['Static'], shell);
    assert.doesNotMatch(staticHtml, /data-can-poll(?: |-|>)/);
    assert.doesNotMatch(await partial('running'), /<script|<!doctype|<html/i);
    for (const poll of [0n, 999n, 1500n, 3600001n]) await assert.rejects(renderPage(context, { ...descriptor, poll }, [''], shell), /poll must/);
  });
  it('preserves the current query in poll requests and rejects external poll URLs', async () => {
    const html = await renderPage({ ...context, pollUrl: '/jobs?team=T2&search=moon%2Fcity' }, descriptor, [''], shell);
    assert.match(html, /data-can-poll-url="\/jobs\?team=T2&amp;search=moon%2Fcity"/);
    const queryContext = { ...context, pollUrl: '/jobs?team=T2&search=moon%2Fcity' };
    const page = await setup(async (url) => { assert.equal(url, queryContext.pollUrl); return response(
      await renderPage({ ...queryContext, isPartial: true }, descriptor, [content('completed')], shell)); }, queryContext);
    try { await page.clock.tick(); assert.ok(page.window.document.querySelector('#job img')); } finally { await page.close(); }
    for (const pollUrl of ['https://evil.test/jobs', '//evil.test/jobs', '/\\evil.test/jobs', '/jobs#fragment', '/%2fevil']) {
      await assert.rejects(renderPage({ ...context, pollUrl }, descriptor, [''], shell), /same-app/);
    }
  });
  it('native client rereads an authorized partial and updates state without losing typed input or focus', async () => {
    const completed = (await partial('completed')).replace('operation-old', 'operation-new');
    let calls = 0;
    const page = await setup(async (url, init) => { calls += 1; assert.equal(url, '/jobs'); assert.equal(init.headers['HX-Request'], 'true'); return response(completed); });
    try {
      const input = page.window.document.getElementById('prompt') as unknown as { value: string; focus(): void };
      input.value = 'A city on the moon'; input.focus();
      const beforeForm = page.window.document.getElementById('prompt-form');
      await page.clock.tick();
      assert.equal(calls, 1);
      assert.equal(page.window.document.querySelector('#job img')?.getAttribute('src'), '/files/image-one');
      assert.equal(page.window.document.querySelector('#job [role=status]'), null);
      assert.equal(page.window.document.getElementById('prompt-form'), beforeForm);
      assert.equal(input.value, 'A city on the moon');
      assert.equal((page.window.document.querySelector('[name=operation_id]') as unknown as { value: string }).value, 'operation-new');
      assert.equal(page.window.document.activeElement, input);
      assert.equal(page.clock.tasks.size, 1);
    } finally { await page.close(); }
  });
  it('refreshes focused form availability and hidden metadata while preserving editable values', async () => {
    const freshPrompt = prompt.replace('<button>', '<input type="hidden" name="_csrf" value="new-csrf"><input type="hidden" name="version" value="2"><button disabled>');
    const fresh = await renderPage({ ...context, isPartial: true }, descriptor, [freshPrompt], shell);
    const page = await setup(async () => response(fresh));
    try {
      const input = page.window.document.getElementById('prompt') as unknown as { value: string; focus(): void };
      input.value = 'keep my prompt'; input.focus();
      const form = page.window.document.getElementById('prompt-form');
      await page.clock.tick();
      assert.equal(page.window.document.getElementById('prompt-form'), form);
      assert.equal(input.value, 'keep my prompt');
      assert.equal(page.window.document.activeElement, input);
      assert.equal(form?.querySelector('button')?.hasAttribute('disabled'), true);
      assert.equal(form?.querySelector('input[name="version"]')?.getAttribute('value'), '2');
      assert.equal(form?.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'new-csrf');
      assert.equal(applyPollResponse(page.window.document as unknown as DocumentLike,
        page.window.document.getElementById('can-main') as unknown as ElementLike,
        await renderPage({ ...context, isPartial: true }, descriptor, ['<p>Operation withdrawn</p>'], shell), 200), true);
      assert.equal(page.window.document.getElementById('prompt-form'), null);
    } finally { await page.close(); }
  });
  it('stops errors, redirected/full login pages and foreign-context partials without painting', async () => {
    for (const result of [response('{"code":"forbidden"}', 403), response('<!doctype html><html><body>Sign in</body></html>'), response(await partial('completed', 'principal-two/team-two/jobs'))]) {
      const page = await setup(async () => result);
      try {
        await page.clock.tick();
        assert.ok(page.window.document.querySelector('#job [role=status]'));
        assert.equal(page.window.document.querySelector('#job img'), null);
        assert.equal(page.clock.tasks.size, 0);
      } finally { await page.close(); }
    }
  });
  it('suppresses a delayed body after principal/team context changes', async () => {
    let finish!: (body: string) => void;
    const body = new Promise<string>((resolve) => { finish = resolve; });
    const page = await setup(async () => ({ status: 200, headers: { get: () => 'text/html' }, text: () => body }));
    try {
      await page.clock.tick();
      page.window.document.getElementById('can-main')!.setAttribute('data-can-context', 'principal-two/team-two/jobs');
      finish(await partial('completed'));
      await settle();
      assert.equal(page.window.document.querySelector('#job img'), null);
      assert.equal(page.clock.tasks.size, 0);
    } finally { await page.close(); }
  });
  it('stops when hidden, re-arms on visibility, and refuses late navigation or logout responses', async () => {
    const completed = await partial('completed');
    const page = await setup(async () => response(completed));
    try {
      page.setVisibility('hidden');
      assert.equal(page.clock.tasks.size, 0);
      page.setVisibility('visible');
      await page.clock.tick();
      assert.ok(page.window.document.querySelector('#job img'));
      page.window.document.body.setAttribute('data-can-logged-out', 'true');
      await page.clock.tick();
      assert.equal(page.clock.tasks.size, 0);
    } finally { await page.close(); }
    let finish!: (value: SubmitFetchResponse) => void;
    const pending = new Promise<SubmitFetchResponse>((resolve) => { finish = resolve; });
    const navigating = await setup(async () => pending);
    try {
      await navigating.clock.tick();
      navigating.window.location.href = 'https://can.test/other';
      finish(response(completed)); await settle();
      assert.equal(navigating.window.document.querySelector('#job img'), null);
      assert.equal(navigating.clock.tasks.size, 0);
    } finally { await navigating.close(); }
  });
  it('resumes polling when a persisted page returns from the browser cache', async () => {
    const page = await setup(async () => response(await partial('completed')));
    try {
      const hide = new page.window.Event('pagehide'); Object.defineProperty(hide, 'persisted', { value: true });
      page.window.dispatchEvent(hide); assert.equal(page.clock.tasks.size, 0);
      const show = new page.window.Event('pageshow'); Object.defineProperty(show, 'persisted', { value: true });
      page.window.dispatchEvent(show); assert.equal(page.clock.tasks.size, 1);
      await page.clock.tick(); assert.ok(page.window.document.querySelector('#job img'));
    } finally { await page.close(); }
  });
  it('replaces reassigned records and renamed controls instead of carrying dirty input across identity', async () => {
    const page = await setup(async () => response(await partial('running')));
    try {
      const input = page.window.document.getElementById('prompt') as unknown as { value: string; focus(): void };
      input.value = 'old field text'; input.focus();
      const region = page.window.document.getElementById('can-main')!;
      const renamed = content('running').replace('id="prompt" name="inputs[prompt]"', 'id="new-prompt" name="inputs[caption]"');
      applyPollResponse(page.window.document as unknown as DocumentLike, region as unknown as ElementLike,
        await renderPage({ ...context, isPartial: true }, descriptor, [renamed], shell), 200);
      assert.equal((page.window.document.getElementById('new-prompt') as unknown as { value: string }).value, '');
      const recordForm = (id: string) => `<form id="record-form" action="/operations"><input type="hidden" name="inputs[job][id]" value="${id}"><input id="caption" name="inputs[caption]" value=""></form>`;
      applyPollResponse(page.window.document as unknown as DocumentLike, region as unknown as ElementLike,
        await renderPage({ ...context, isPartial: true }, descriptor, [recordForm('one')], shell), 200);
      const caption = page.window.document.getElementById('caption') as unknown as { value: string }; caption.value = 'record one edit';
      const oldForm = page.window.document.getElementById('record-form');
      applyPollResponse(page.window.document as unknown as DocumentLike, region as unknown as ElementLike,
        await renderPage({ ...context, isPartial: true }, descriptor, [recordForm('two')], shell), 200);
      assert.notEqual(page.window.document.getElementById('record-form'), oldForm);
      assert.equal((page.window.document.getElementById('caption') as unknown as { value: string }).value, '');
    } finally { await page.close(); }
  });
  it('default morph rejects nested/full documents and executable partials', async () => {
    const page = await setup(async () => response(await partial('completed')));
    try {
      const doc = page.window.document as unknown as DocumentLike;
      const main = page.window.document.getElementById('can-main') as unknown as ElementLike;
      assert.equal(applyPollResponse(doc, main, `${await partial('completed')}<aside>extra</aside>`, 200), false);
      assert.equal(applyPollResponse(doc, main, (await partial('completed')).replace('</main>', '<script>bad()</script></main>'), 200), false);
      assert.equal(page.window.document.querySelector('#job img'), null);
    } finally { await page.close(); }
  });
});
