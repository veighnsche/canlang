/** Emitted protected row actions and poll markers in the installed browser. */
import { createCheckoutScratch } from '../src/dev/checkout-scratch.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { promisify } from 'node:util';
import { test } from 'vitest';
import type { CompileArtifact, PageDescriptor, ShellData } from '@canlang/contracts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (name: string) => pathToFileURL(require.resolve(name)).href;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

test('emitted protected row action and poll drop held bodies after context/logout/stop', { timeout: 120000 }, async () => {
  const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { loadInstalledChromium, prepareLocalPreviewCapture } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
  const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
  const { buildPresentationContext, createSourceFormBindings, catalogFromArtifactOperations } =
    await nodeImport(producer('@canlang/interfaces')) as typeof import('@canlang/interfaces');
  const { renderPage } = await nodeImport(producer('@canlang/ui')) as typeof import('@canlang/ui');
  const { distribution: uiDistribution } = await nodeImport(producer('@canlang/ui/distribution')) as typeof import('@canlang/ui/distribution');
  const { makeIdentity, uuidv7, FIXED_NOW } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as
    typeof import('@canlang/state/testing/invocation/fixtures');
  const originalPath = join(root, 'compiler/tests/fixtures/view-reuse.can');
  const original = await readFile(originalPath);
  const text = original.toString('utf8');
  assert.equal(text.split(' page /views title="Views"').length, 2);
  const authored = text.replace(' page /views title="Views"', ' page /views title="Views" poll=1s');
  assert.equal(authored.replace(' poll=1s', ''), text);
  const directory = await createCheckoutScratch(root, 'protected-poll-browser-');
  const sourcePath = join(directory, 'view-reuse-poll.can');
  const sourceBytes = Buffer.from(authored);
  let server: ReturnType<typeof createServer> | undefined;
  let lease: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof loadInstalledChromium>>>['producer']['acquireChromium']>> | undefined;
  let context: ReturnType<NonNullable<typeof lease>['browser']['contexts']>[number] | undefined;
  try {
    await writeFile(sourcePath, sourceBytes);
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
      compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: join(root, 'packages/values/dist/catalog.json'),
      helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    assert.equal(capture.sourceSha256, sha(sourceBytes));
    const env = { ...process.env }; delete env.CAN_CATALOG;
    const { stdout } = await promisify(execFile)(join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--catalog', join(root, 'packages/values/dist/catalog.json'), capture.compilerOperand],
      { cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
    const assembly = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'),
      stdlibUrl: producer('@canlang/cloudflare/runtime/stdlib'), uiUrl: producer('@canlang/ui') });
    const generated = await nodeImport(assembly.entryUrl) as { appDefinition: { pages: PageDescriptor[] } };
    const pageDefinition = generated.appDefinition.pages[0]!;
    assert.equal(pageDefinition.poll, 1000n);
    const card = Object.freeze({ id: uuidv7(FIXED_NOW, 1), version: '1', fields: Object.freeze({ title: 'Original card', flag: true }) });
    const detail = Object.freeze({ id: uuidv7(FIXED_NOW, 2), version: '1', fields: Object.freeze({ label: 'Original detail' }) });
    const identity = makeIdentity({ actor: null, team: null, membership: null });
    const formBindings = await createSourceFormBindings(randomBytes(32), JSON.stringify(artifact.sources));
    const catalog = catalogFromArtifactOperations(artifact);
    const shell: ShellData = { brand: 'ViewReuse', navigation: { groups: [], incomplete: false },
      routes: { signIn: '/sign-in', signOut: '/sign-out', switchTeam: '/team' },
      account: { authenticated: false, teams: [] }, settings: { sections: [] } };
    const render = async (path: string, title: string, partial: boolean) => {
      const current = { ...card, fields: { ...card.fields, title } };
      const base = buildPresentationContext({ request: new Request(new URL(path, 'https://fixture.test')),
        pathname: '/views', isPartial: partial, appDefaultLocale: 'es', csrfToken: 'csrf', principal: identity,
        catalog, formBindings, appId: 'ViewReuse', sessionToken: 'view-reuse-session',
        clock: { nowMs: () => FIXED_NOW }, query: async (_invocation, model) => ({
          rows: model === 'ViewReuse.Card' ? [current] : [detail],
          columns: model === 'ViewReuse.Card' ? [{ field: 'title', label: 'Card title', type: 'text' },
            { field: 'flag', label: 'Card flag', type: 'bool' }] : [],
        }) });
      const presentation = { ...base, pollContext: 'owner-one', pollUrl: path };
      const admitted = await pageDefinition.admit(presentation);
      const body = await pageDefinition.render(presentation, admitted);
      return renderPage(presentation, pageDefinition, [body], shell);
    };
    const unselected = await render('/views', 'Original card', false);
    const links = [...unselected.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://fixture.test'));
    const selected = links.find(url => [...url.searchParams].some(([key, value]) => key.startsWith('can-row:') && value === card.id));
    assert.ok(selected, 'compiled split row supplies its own selection URL');
    const selectedPath = selected.pathname + selected.search;
    const initial = await render(selectedPath, 'Original card', false);
    const fresh = await render(selectedPath, 'Fresh card', true);
    const stale = await render(selectedPath, 'STALE-PROTECTED-CARD', true);
    assert.match(initial, /data-can-poll/);
    assert.match(initial, /data-can-generated-form/);
    assert.match(initial, /form_binding/);
    assert.match(initial, /ViewReuse\.bind_card/);
    const browserScript = await readFile(new URL('bootstrap.js', uiDistribution.browser));
    let views = 0, operations = 0;
    let heldView: ServerResponse | undefined, heldAction: ServerResponse | undefined;
    let viewArrived!: () => void, actionArrived!: () => void;
    const viewWait = new Promise<void>(resolve => { viewArrived = resolve; });
    const actionWait = new Promise<void>(resolve => { actionArrived = resolve; });
    const hostFailures: unknown[] = [];
    server = createServer((request, response) => {
      void (async () => {
        if (request.url === '/can-bootstrap.js') {
          response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(browserScript); return;
        }
        if (request.method === 'GET' && request.url === selectedPath) {
          views++;
          if (views === 1) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(initial); return; }
          if (views === 2) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(fresh); return; }
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.flushHeaders();
          heldView = response; viewArrived(); return;
        }
        if (request.method === 'POST' && request.url === '/api/operations/ViewReuse.bind_card') {
          operations++;
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const submitted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          assert.equal(request.headers['x-csrf-token'], 'csrf');
          assert.equal(submitted.operation, 'ViewReuse.bind_card');
          assert.equal(typeof submitted.form_binding, 'string');
          response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
          heldAction = response; actionArrived(); return;
        }
        response.writeHead(404); response.end();
      })().catch(error => { hostFailures.push(error); if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
    const chromium = await loadInstalledChromium(root); assert.ok(chromium);
    const availability = await chromium.producer.chromiumAvailability(); assert.ok(availability.available);
    lease = await chromium.producer.acquireChromium({ signal: new AbortController().signal });
    context = await lease.browser.newContext();
    const browserPage = await context.newPage();
    const errors: string[] = []; browserPage.on('pageerror', error => errors.push(error.message));
    assert.equal((await browserPage.goto(`http://127.0.0.1:${address.port}${selectedPath}`, { waitUntil: 'domcontentloaded' }))!.status(), 200);
    assert.equal(await browserPage.locator('form[action="/api/operations/ViewReuse.bind_card"]').count(), 2);
    await browserPage.evaluate(async () => {
      const load = new Function('path', 'return import(path)') as (path: string) => Promise<{ startNativeBrowserClient(native: unknown): unknown }>;
      const module = await load('/can-bootstrap.js');
      const native = globalThis as unknown as { canClient: { rescan(restart?: boolean): void; stop(): void } };
      native.canClient = module.startNativeBrowserClient(globalThis) as typeof native.canClient;
    });
    await browserPage.getByText('Fresh card').first().waitFor();
    assert.equal(views, 2, 'one actual emitted poll response paints the current view');
    const action = browserPage.locator('form[action="/api/operations/ViewReuse.bind_card"]').first();
    await action.locator('button[type="submit"]').click();
    await actionWait;
    assert.equal(operations, 1);
    await viewWait;
    await browserPage.evaluate(() => {
      const native = globalThis as unknown as { document: { body: { setAttribute(name: string, value: string): void } };
        canClient: { rescan(restart?: boolean): void } };
      native.document.body.setAttribute('data-can-context', 'owner-two');
      native.document.body.setAttribute('data-can-logged-out', 'true');
      native.canClient.rescan(true);
    });
    try { heldView?.end(stale); } catch { /* The browser may have aborted the owned body. */ }
    try { heldAction?.end(JSON.stringify({ status: 'committed', operation_id: 'stale', records: [], deliveries: [], result: null })); }
    catch { /* The browser may have aborted the owned body. */ }
    await browserPage.waitForTimeout(150);
    assert.equal(await browserPage.getByText('STALE-PROTECTED-CARD').count(), 0);
    assert.notEqual(await action.getAttribute('data-can-submit-state'), 'committed');
    const stoppedViews = views;
    await browserPage.evaluate(() => (globalThis as unknown as { canClient: { stop(): void } }).canClient.stop());
    await browserPage.waitForTimeout(1100);
    assert.equal(views, stoppedViews, 'logout and stop disarm the actual poll');
    assert.deepEqual(hostFailures, []); assert.deepEqual(errors, []);
    assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assert.deepEqual(await readFile(originalPath), original);
    await context.close(); assert.equal(browserPage.isClosed(), true);
    await lease.close(); assert.equal(lease.browser.isConnected(), false);
  } finally {
    try { await context?.close(); } finally {
      try { await lease?.close(); } finally {
        try { if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); } }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
    assert.deepEqual(await readFile(originalPath), original);
  }
});
