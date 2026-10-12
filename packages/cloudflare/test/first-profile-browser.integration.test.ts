/** Actual HelpOffice cancellation and authenticated public export/Print through installed Chromium. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compileFunction, constants as vmConstants } from 'node:vm';
import type { D1Database } from '@cloudflare/workers-types';
import type { ListQueryResult } from '@canlang/contracts';
import type { ChromiumProducer } from '@canlang/contracts/browser/chromium';
import { it } from 'vitest';
import type { FirstProfileBrowserInput } from '../src/dev/first-profile-browser.js';
import type { LocalPreviewWithActors } from '../src/dev/preview-builder.js';

const project = resolve(import.meta.dirname, '../../..');

it('cancels the genuine whole HelpOffice browser consumer after authenticated Dee and awaits every owned context', async () => {
  // Vite export getters cannot stand in for issuer-owned installed ESM namespaces.
  const nativeImport = compileFunction('return import(url)', ['url'], {
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const installed = (file: string) => nativeImport(pathToFileURL(join(project, 'packages/cloudflare/dist/dev', file)).href);
  const { prepareLocalPreviewCapture, loadInstalledChromium } = await installed('preview-inputs.js') as typeof import('../src/dev/preview-inputs.js');
  const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await installed('source-capture.js') as typeof import('../src/dev/source-capture.js');
  const { compileCapturedSingleFile } = await installed('compiler-check.js') as typeof import('../src/dev/compiler-check.js');
  const { createLocalPreviewBuilder } = await installed('preview-builder.js') as typeof import('../src/dev/preview-builder.js');
  const host = await installed('preview-host.js') as typeof import('../src/dev/preview-host.js');
  const { qualifyFirstProfileBrowser } = await installed('first-profile-browser.js') as typeof import('../src/dev/first-profile-browser.js');
  const require = createRequire(join(project, 'package.json'));
  const { createD1IdentityStore, resolveIdentity, deriveCsrfToken } = await nativeImport(
    pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
  const controller = new AbortController();
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: project,
    appPath: join(project, 'compiler/tests/fixtures/construct-help-first-profile.can'),
    compilerPath: join(project, 'compiler/target/debug/can'),
    catalogPath: join(project, 'packages/values/dist/catalog.json'),
    helpIndexPath: join(project, 'docs/specification/CONSTRUCT-HELP.md') }));
  const compiled = await compileCapturedSingleFile(capture, controller.signal);
  assert.equal(compiled.kind, 'artifact', 'unchanged owning whole HelpOffice must actually compile');
  if (compiled.kind !== 'artifact') throw new Error('whole HelpOffice did not compile');
  assert.equal(verifyCompilerSources(capture, { complete: true, sources: compiled.artifact.sources }).ok, true);
  const chromium = await loadInstalledChromium(project);
  assert.ok(chromium, 'installed owning Chromium producer is required for this actual browser check');
  const availability = await chromium.producer.chromiumAvailability();
  assert.ok(availability.available, 'actual installed Chromium executable is required');
  assert.equal(capture.inputs.find(input => input.name === 'extra:browser:producer')?.canonicalPath, chromium.entryPath);
  assert.equal(capture.inputs.find(input => input.name === 'extra:browser:executable')?.requestedPath, availability.identity.executablePath);
  let identityDb: D1Database | undefined;
  const owners = new Map<string, D1Database>();
  const build = createLocalPreviewBuilder({
    resources: { d1: { binding: 'DB', availability: 'real_local' }, identity: { backingBinding: 'DB', availability: 'real_local' } },
    activationVerdict: host.preflightLocalPreviewActivation,
    produceBundle: host.produceInstalledPortableBundle,
    seedLocalActors: host.seedLocalPreviewActors,
    workerVarsForOrigin: () => ({ CAN_FORM_BINDING_KEY: randomBytes(32).toString('base64url') }),
    confirmRunningActivation: async (artifact, source, db, id, owner, identities) => {
      assert.ok(owner && identities, 'actual bound owner and Identity databases are required');
      owners.set(owner, db); identityDb = identities;
      return host.localPreviewActivationVerdict(artifact, source, db, id, owner, identities);
    },
  });
  let preview: LocalPreviewWithActors | undefined;
  let lease: Awaited<ReturnType<typeof chromium.producer.acquireChromium>> | undefined;
  try {
    preview = await build(compiled.artifact, capture, compiled.artifactBytes);
    assert.ok(identityDb); assert.equal(owners.size, 2);
    const identityStore = createD1IdentityStore(identityDb);
    const expectedActors = {} as Record<'Ava' | 'Ben' | 'Cal' | 'Dee', { owner: string | null; principal: string }>;
    for (const label of ['Ava', 'Ben', 'Cal', 'Dee'] as const) {
      const seed = preview.issueLocalActors().find(actor => actor.label === label); assert.ok(seed);
      const user = await identityStore.findUserByEmail(seed.email); assert.ok(user);
      const memberships = (await identityStore.listUserMemberships(user.user_id)).filter(member => member.status === 'active');
      assert.equal(memberships.length, label === 'Dee' ? 0 : 1);
      const owner = memberships[0]?.team_id ?? null;
      if (owner !== null) assert.ok(await identityStore.findTeamById(memberships[0]!.team_id));
      expectedActors[label] = { owner, principal: user.user_id };
    }
    assert.equal(expectedActors.Ava.owner, expectedActors.Ben.owner);
    assert.notEqual(expectedActors.Ava.owner, expectedActors.Cal.owner);
    const snapshot = async () => {
      const result: Record<string, Record<string, readonly string[]>> = {};
      for (const [label, db] of [['Identity', identityDb], ...owners] as Array<[string, D1Database]>) {
        const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{name: string}>()).results;
        const tables: Record<string, readonly string[]> = {};
        for (const { name } of names) {
          if (name.startsWith('_cf_')) continue;
          assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
          tables[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results.map(row => JSON.stringify(row)).sort();
        }
        result[label] = tables;
      }
      return result;
    };
    const servingBefore = await snapshot();
    const actualInitial = [...owners.values()];
    for (const db of actualInitial) assert.equal((await db.prepare('SELECT id FROM records WHERE model=? AND archived_at IS NULL')
      .bind('HelpOffice.Supply').all()).results.length, 0);
    lease = await chromium.producer.acquireChromium({ signal: controller.signal });
    assert.deepEqual(lease.identity, availability.identity);
    const browser = lease.browser;
    const authenticated: string[] = [];
    const closed = new Set<ReturnType<typeof browser.contexts>[number]>();
    let observedContexts: ReturnType<typeof browser.contexts> = [];
    let afterLogin: Awaited<ReturnType<typeof snapshot>> | undefined;
    let mutations = 0, preferences = 0, proofsReturned = false;
    const input: FirstProfileBrowserInput = {
      browser, preview, signal: controller.signal, expectedActors, initialVisible: [], snapshot,
      mutation: async () => { mutations++; throw new Error('cancelled browser must not reach mutation'); },
      preference: async () => { preferences++; throw new Error('cancelled browser must not reach preference'); },
      onAuthenticated: async (label, facts) => {
        assert.ok(facts.cookie.startsWith('can_session='), 'browser must provide its actual owning session cookie');
        const token = decodeURIComponent(facts.cookie.slice('can_session='.length));
        const identity = await resolveIdentity(identityStore, { session_token: token });
        assert.equal(identity.actor?.user_id, expectedActors[label].principal);
        assert.equal(identity.team?.team_id ?? null, expectedActors[label].owner);
        assert.equal(identity.membership?.status ?? null, expectedActors[label].owner === null ? null : 'active');
        assert.equal(facts.owner, expectedActors[label].owner);
        assert.ok(facts.csrf === await deriveCsrfToken(token), 'browser CSRF must bind to its actual session');
        authenticated.push(label);
        if (label !== 'Dee') return;
        observedContexts = browser.contexts(); assert.equal(observedContexts.length, 4);
        for (const context of observedContexts) context.once('close', () => closed.add(context));
        afterLogin = await snapshot();
        controller.abort();
      },
    };
    await assert.rejects(async () => {
      await qualifyFirstProfileBrowser(input); proofsReturned = true;
    }, error => {
      // Observe cleanup at the rejection boundary, not after a later lease close.
      assert.equal((error as Error).name, 'AbortError');
      assert.equal(closed.size, observedContexts.length);
      assert.equal(browser.contexts().length, 0);
      return true;
    });
    assert.deepEqual(authenticated, ['Ava', 'Ben', 'Cal', 'Dee']);
    assert.equal(proofsReturned, false); assert.equal(mutations, 0); assert.equal(preferences, 0);
    assert.ok(afterLogin); assert.ok(isDeepStrictEqual(await snapshot(), afterLogin), 'cancellation must preserve all post-login resources');
    // Authentication is real setup, so compare its domain owners separately.
    const after = await snapshot();
    for (const owner of owners.keys()) assert.ok(isDeepStrictEqual(after[owner], servingBefore[owner]), 'browser authentication/cancellation must preserve all owner resources');
    await lease.close(); assert.equal(browser.isConnected(), false);
    assert.equal(await captureIsCurrent(capture), true);
  } finally {
    try { await lease?.close(); }
    finally { await preview?.dispose(); }
    assert.equal(await captureIsCurrent(capture), true, 'owning native/browser inputs must stay current through cleanup');
  }
}, 120_000);

it('runs public inline CSV and Print through real authenticated HTTP in installed Chromium', async () => {
  const require = createRequire(join(project, 'package.json'));
  const nativeImport = compileFunction('return import(url)', ['url'], {
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const native = (specifier: string) => nativeImport(pathToFileURL(require.resolve(specifier)).href);
  const interfaces = await native('@canlang/interfaces') as typeof import('@canlang/interfaces');
  const testing = await native('@canlang/interfaces/testing') as typeof import('@canlang/interfaces/testing');
  const distribution = await native('@canlang/interfaces/distribution') as typeof import('@canlang/interfaces/distribution');
  const identity = await native('@canlang/identity') as typeof import('@canlang/identity');
  const exportHandler = await nativeImport(new URL('http/export.js', distribution.distribution.modules).href) as {
    handleExportRequest: (deps: typeof t.deps, request: Request) => Promise<Response>;
  };
  const printHandler = await nativeImport(new URL('http/print.js', distribution.distribution.modules).href) as {
    handlePrintRequest: (deps: typeof t.deps, renderedViews: typeof views, request: Request) => Promise<Response>;
  };
  const operation = 'Billing.Invoice.list';
  const columns = [{ field: 'customer', label: 'Customer', type: 'text' }, { field: 'total', label: 'Total', type: 'money' }];
  const rows: ListQueryResult = { columns, rows: [
    { id: 'inv-1', version: '3', fields: { customer: 'c-1', total: '100' } },
    { id: 'inv-2', fields: { customer: 'c-2', total: '250' } },
  ] };
  const views = { views: () => [{ name: 'invoice-register', title: 'Invoice register', operation,
    columns: [{ field: 'customer', label: 'Customer' }, { field: 'total', label: 'Total' }] }] };
  const t = await testing.createTestDeps({ reads: { [operation]: () => ({ result: rows }) } });
  const csrf = await identity.deriveCsrfToken(t.identity.sessionToken);
  const deps = t.deps;
  const http = interfaces.createHttpHandler(deps, {
    operations: (request, op) => interfaces.handleOperationRequest(deps, request, op),
    auth: request => interfaces.handleAuthRequest(deps, request),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
    csv: request => interfaces.handleCsvRequest(deps, request),
    exports: request => exportHandler.handleExportRequest(deps, request),
    print: request => printHandler.handlePrintRequest(deps, views, request),
  });
  const chromiumEntry = require.resolve('@canlang/testkit/browser/chromium');
  const producer = await nativeImport(pathToFileURL(chromiumEntry).href) as ChromiumProducer;
  const availability = await producer.chromiumAvailability();
  assert.equal(availability.available, true, 'installed Chromium producer and executable are required');
  const uiRequire = createRequire(join(project, 'packages/ui/package.json'));
  const esbuild = uiRequire('esbuild') as { build(options: object): Promise<{ outputFiles?: Array<{ path: string; contents: Uint8Array }> }> };
  const modules = await esbuild.build({ entryPoints: {
    export: uiRequire.resolve('@canlang/ui/browser/export'),
    print: uiRequire.resolve('@canlang/ui/browser/print'),
  }, outdir: '/virtual/can-export-print', bundle: true, platform: 'browser', format: 'esm',
  packages: 'bundle', write: false });
  const assets = new Map(modules.outputFiles?.map(file => [file.path.split('/').at(-1), file.contents]));
  assert.ok(assets.get('export.js') && assets.get('print.js'), 'real public UI modules must bundle for Chromium');
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname;
      const asset = assets.get(path.slice('/ui/'.length));
      if (path.startsWith('/ui/') && asset) {
        outgoing.writeHead(200, { 'content-type': 'text/javascript;charset=utf-8' }); outgoing.end(asset); return;
      }
      if (path === '/') {
        outgoing.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); outgoing.end('<!doctype html><title>Export and Print</title>'); return;
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Uint8Array);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      const response = await http(new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method ?? 'GET', headers,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500); outgoing.end(String(error));
    }
  });
  let lease: Awaited<ReturnType<ChromiumProducer['acquireChromium']>> | undefined;
  try {
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    lease = await producer.acquireChromium();
    assert.deepEqual(lease.identity, availability.identity);
    const context = await lease.browser.newContext();
    await context.addCookies([{ name: 'can_session', value: t.identity.sessionToken, url: base }]);
    const page = await context.newPage();
    await page.goto(base);
    const live = await page.evaluate(async ({ csrf, operation }) => {
      const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
      const exportModule = await load('/ui/export.js') as typeof import('@canlang/ui/browser/export');
      const printModule = await load('/ui/print.js') as typeof import('@canlang/ui/browser/print');
      const exported = await exportModule.submitExportRequest({ fetchImpl: (url, init) => fetch(url, init), action: '/api/exports', csrf, operation });
      if (!exported.ok) return { exported, print: null, saved: null };
      const saves: Array<{ filename: string; text: string; mime: string }> = [];
      exportModule.downloadInlineCsv({ save: (filename, text, mime) => { saves.push({ filename, text, mime }); } }, exported.outcome, Date.now());
      const print = await printModule.fetchPrintView({ fetchImpl: (url, init) => fetch(url, init), printBase: '/print', view: 'invoice-register' });
      return { exported, print, saved: saves[0] ?? null };
    }, { csrf, operation });
    assert.equal(live.exported.ok, true, JSON.stringify(live.exported));
    const csv = 'id,version,customer,total\ninv-1,3,c-1,100\ninv-2,,c-2,250\n';
    assert.equal(live.exported.ok && live.exported.outcome.csv, csv);
    assert.deepEqual(live.saved && { text: live.saved.text, mime: live.saved.mime },
      { text: csv, mime: 'text/csv;charset=utf-8' });
    assert.equal(live.print?.ok, true);
    assert.match(live.print?.ok ? live.print.html : '', /<title>Invoice register<\/title>/);
    assert.match(live.print?.ok ? live.print.html : '', /<td>c-1<\/td>/);
    assert.equal(t.invoker.reads.length, 2);
    await identity.revokeSessionByToken(deps.identity.store, { token: t.identity.sessionToken });
    const denied = await page.evaluate(async ({ csrf, operation }) => {
      const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
      const exportModule = await load('/ui/export.js') as typeof import('@canlang/ui/browser/export');
      const printModule = await load('/ui/print.js') as typeof import('@canlang/ui/browser/print');
      return {
        exported: await exportModule.submitExportRequest({ fetchImpl: (url, init) => fetch(url, init), action: '/api/exports', csrf, operation }),
        print: await printModule.fetchPrintView({ fetchImpl: (url, init) => fetch(url, init), printBase: '/print', view: 'invoice-register' }),
      };
    }, { csrf, operation });
    assert.equal(denied.exported.ok ? '' : denied.exported.error.code, 'forbidden');
    assert.equal(denied.print.ok ? '' : denied.print.error.code, 'forbidden');
    assert.equal(t.invoker.reads.length, 2, 'revoked browser requests may not reach a read');
    await context.close(); assert.equal(lease.browser.contexts().length, 0);
  } finally {
    try { await lease?.close(); }
    finally { await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())); }
  }
}, 60_000);
