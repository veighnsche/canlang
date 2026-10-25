/** Actual HelpOffice cancellation and authenticated public export/Print through installed Chromium. */
import assert from 'node:assert/strict';
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

const project = resolve(import.meta.dirname, '../../..');

it('cancels the genuine whole HelpOffice browser consumer after authenticated Dee and awaits every owned context', async () => {
  const nativeImport = compileFunction('return import(url)', ['url'], {
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const installed = (file: string) => nativeImport(pathToFileURL(join(project, 'packages/cloudflare/dist/runtime', file)).href);
  const native = await installed('native-dev.test-support.js') as typeof import('../src/runtime/native-dev.test-support.js');
  const { runNativeBrowser } = await installed('native-preview.test-support.js') as typeof import('../src/runtime/native-preview.test-support.js');
  const require = createRequire(join(project, 'package.json'));
  const { createD1IdentityStore, resolveIdentity, deriveCsrfToken } = await nativeImport(
    pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
  const controller = new AbortController();
  const capture = await native.captureSingleFileSource(native.prepareLocalPreviewCapture({ checkoutRoot: project,
    appPath: join(project, 'compiler/tests/fixtures/construct-help-first-profile.can'),
    compilerPath: process.env.CAN_COMPILER_BIN ?? join(project, 'compiler/target/debug/can'),
    catalogPath: join(project, 'packages/values/dist/catalog.json'),
    helpIndexPath: join(project, 'docs/specification/CONSTRUCT-HELP.md') }));
  const compiled = await native.compileCapturedSingleFile(capture, controller.signal);
  assert.equal(compiled.kind, 'artifact', 'unchanged owning whole HelpOffice must actually compile');
  if (compiled.kind !== 'artifact') throw new Error('whole HelpOffice did not compile');
  assert.equal(native.verifyCompilerSources(capture, { complete: true, sources: compiled.artifact.sources }).ok, true);
  const chromium = await native.loadInstalledChromium(project);
  assert.ok(chromium, 'installed owning Chromium producer is required for this actual browser check');
  const availability = await chromium.producer.chromiumAvailability();
  assert.ok(availability.available, 'actual installed Chromium executable is required');
  assert.equal(capture.inputs.find(input => input.name === 'extra:browser:producer')?.canonicalPath, chromium.entryPath);
  assert.equal(capture.inputs.find(input => input.name === 'extra:browser:executable')?.requestedPath, availability.identity.executablePath);
  type Browser = Awaited<ReturnType<ChromiumProducer['acquireChromium']>>['browser'];
  type Context = ReturnType<Browser['contexts']>[number];
  let browser: Browser | undefined, browserHandle: string | undefined;
  let identityDb: D1Database | undefined;
  const owners = new Map<string, D1Database>();
  const expectedActors = {} as Record<'Ava' | 'Ben' | 'Cal' | 'Dee', { owner: string | null; principal: string }>;
  const authenticated: string[] = [], csrfByCookie = new Map<string, string>(), closed = new Set<Context>();
  let observedContexts: Context[] = [], servingBefore: unknown, afterLogin: unknown, afterClose: unknown;
  let mutations = 0, preferences = 0, proofsReturned = false, closedAtBoundary = false;
  const snapshot = async () => {
    assert.ok(identityDb);
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
  try {
    await assert.rejects(async () => {
      await runNativeBrowser(compiled.artifact, capture, compiled.artifactBytes, {
        'browser.launch': async (payload, signal, registry, parent) => {
          const runtimes = [...registry.resources.values()].filter(entry => entry.kind === 'mf' && !entry.physicallyDisposed);
          assert.equal(runtimes.length, 1, 'native preview must retain exactly its serving SDK runtime');
          const runtime = runtimes[0]!;
          identityDb = await runtime.value.getD1Database('DB', runtime.workerName) as D1Database;
          const store = createD1IdentityStore(identityDb);
          for (const label of ['Ava', 'Ben', 'Cal', 'Dee'] as const) {
            const user = await store.findUserByEmail(`${label.toLowerCase()}@preview.can.test`); assert.ok(user);
            const memberships = (await store.listUserMemberships(user.user_id)).filter(member => member.status === 'active');
            assert.equal(memberships.length, label === 'Dee' ? 0 : 1);
            const owner = memberships[0]?.team_id ?? null;
            if (owner !== null) assert.ok(await store.findTeamById(owner));
            expectedActors[label] = { owner, principal: user.user_id };
          }
          assert.equal(expectedActors.Ava.owner, expectedActors.Ben.owner);
          assert.notEqual(expectedActors.Ava.owner, expectedActors.Cal.owner);
          assert.equal(expectedActors.Dee.owner, null);
          for (const [owner, binding] of [[expectedActors.Ava.owner, 'STATE_CEDAR_DB'], [expectedActors.Cal.owner, 'STATE_OAK_DB']] as const) {
            assert.ok(owner); owners.set(owner, await runtime.value.getD1Database(binding, runtime.workerName) as D1Database);
          }
          servingBefore = await snapshot();
          for (const [owner, db] of owners) {
            const records = (await db.prepare('SELECT data FROM records WHERE model=? AND archived_at IS NULL')
              .bind('HelpOffice.Supply').all<{ data: string }>()).results;
            assert.equal(records.length, owner === expectedActors.Ava.owner ? 1 : 0,
              'preview staging retains the authored editable fixture only in Cedar');
            if (records.length === 1) assert.equal(JSON.parse(records[0]!.data).name, 'Printer paper');
          }
          const lease = await registry.api('browser.launch', payload, parent, signal);
          browser = registry.resources.get(payload.handle)!.value as Browser; browserHandle = payload.handle;
          assert.deepEqual(lease.identity, availability.identity);
          return lease;
        },
        'identity.csrf': async (payload, signal, registry, parent) => {
          const result = await registry.api('identity.csrf', payload, parent, signal);
          csrfByCookie.set(payload.cookie, result.csrf); return result;
        },
        'identity.resolve': async (payload, signal, registry, parent) => {
          const result = await registry.api('identity.resolve', payload, parent, signal) as Awaited<ReturnType<typeof resolveIdentity>>;
          // Preview admission resolves real Identity before it launches the owned
          // browser. Browser-login evidence begins only after that launch.
          if (browserHandle === undefined) { assert.equal(browser, undefined); return result; }
          assert.ok(browser);
          assert.ok(identityDb);
          const label = (['Ava', 'Ben', 'Cal', 'Dee'] as const).find(name => expectedActors[name].principal === result.actor?.user_id); assert.ok(label);
          assert.ok(payload.cookie.startsWith('can_session='));
          const token = decodeURIComponent(payload.cookie.slice('can_session='.length));
          const actual = await resolveIdentity(createD1IdentityStore(identityDb), { session_token: token });
          assert.equal(actual.actor?.user_id, expectedActors[label].principal);
          assert.equal(actual.team?.team_id ?? null, expectedActors[label].owner);
          assert.equal(actual.membership?.status ?? null, expectedActors[label].owner === null ? null : 'active');
          assert.equal(csrfByCookie.get(payload.cookie), await deriveCsrfToken(token));
          authenticated.push(label); return result;
        },
        'browser.locator': async (payload, signal, registry, parent) => {
          if (authenticated.length < 4) {
            assert.equal(payload.selector, 'form[action="/auth/login"] input[name="_presession"]');
            assert.equal(payload.method, 'inputValue');
            return registry.api('browser.locator', payload, parent, signal);
          }
          assert.deepEqual(authenticated, ['Ava', 'Ben', 'Cal', 'Dee']);
          assert.ok(browser); observedContexts = browser.contexts(); assert.equal(observedContexts.length, 4);
          for (const context of observedContexts) context.once('close', () => closed.add(context));
          afterLogin = await snapshot(); controller.abort(); throw controller.signal.reason;
        },
        'browser.submit': async () => { mutations++; preferences++; throw new Error('cancelled browser must not reach authored submits'); },
        'browser.close': async (payload, signal, registry, parent) => {
          const result = await registry.api('browser.close', payload, parent, signal);
          if (payload.handle === browserHandle) {
            assert.ok(browser); assert.equal(closed.size, observedContexts.length);
            assert.equal(browser.contexts().length, 0); assert.equal(browser.isConnected(), false);
            afterClose = await snapshot(); closedAtBoundary = true;
          }
          return result;
        },
      });
      proofsReturned = true;
    }, error => {
      assert.equal((error as Error).name, 'AbortError', (error as Error).stack ?? String(error));
      assert.equal(closedAtBoundary, true, 'native consumer must close every context before rejecting');
      return true;
    });
    assert.deepEqual(authenticated, ['Ava', 'Ben', 'Cal', 'Dee']);
    assert.equal(proofsReturned, false); assert.equal(mutations, 0); assert.equal(preferences, 0);
    assert.ok(afterLogin); assert.ok(isDeepStrictEqual(afterClose, afterLogin), 'cancellation must preserve all post-login resources');
    for (const owner of owners.keys()) assert.ok(isDeepStrictEqual((afterClose as Record<string, unknown>)[owner], (servingBefore as Record<string, unknown>)[owner]), 'browser authentication/cancellation must preserve all owner resources');
  } finally {
    assert.equal(await native.captureIsCurrent(capture), true, 'owning native/browser inputs must stay current through cleanup');
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
      const exported = await exportModule.submitExportRequest({ fetchImpl: (url, init) => fetch(url, init as RequestInit), action: '/api/exports', csrf, operation });
      if (!exported.ok) return { exported, print: null, saved: null };
      const saves: Array<{ filename: string; text: string; mime: string }> = [];
      exportModule.downloadInlineCsv({ save: (filename, text, mime) => { saves.push({ filename, text, mime }); } }, exported.outcome, Date.now());
      const print = await printModule.fetchPrintView({ fetchImpl: (url, init) => fetch(url, init as RequestInit), printBase: '/print', view: 'invoice-register' });
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
        exported: await exportModule.submitExportRequest({ fetchImpl: (url, init) => fetch(url, init as RequestInit), action: '/api/exports', csrf, operation }),
        print: await printModule.fetchPrintView({ fetchImpl: (url, init) => fetch(url, init as RequestInit), printBase: '/print', view: 'invoice-register' }),
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
