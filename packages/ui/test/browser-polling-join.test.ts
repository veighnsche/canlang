import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type { PageDescriptor, PresentationContext, ShellData } from '@canlang/contracts';
import { list } from '../src/collections.js';
import { renderPage } from '../src/shell.js';
import { startBrowserClient, type BrowserClientOptions } from '../src/browser/bootstrap.js';
import type { SubmitFetch, SubmitFetchResponse } from '../src/client.js';

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
