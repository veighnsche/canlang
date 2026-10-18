#!/usr/bin/env node
// Capture the actual installed dev preview; no replacement application is served.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const controlBin = process.env.CAN_DEV_BIN ?? 'can';
const controlPrefix = process.env.CAN_DEV_BIN === undefined ? ['dev'] : [];
const root = process.cwd();
// Resolve browser/auth clients from the selected execution root, including frozen snapshots.
const runtimeRequire = createRequire(resolve(root, 'package.json'));
const browserModule = await import(pathToFileURL(runtimeRequire.resolve('@playwright/test')).href);
const chromium = browserModule.chromium ?? browserModule.default?.chromium;
const { deriveCsrfToken } = await import(pathToFileURL(runtimeRequire.resolve('@canlang/identity')).href);
const args = process.argv.slice(2);
const options = { routes: [], timeout: 120, examples: false };
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--help') {
    console.log('node scripts/capture-dev-frontend.mjs (--source FILE | --session ID) --out DIR [--app NAME] [--route /path ...] [--timeout SECONDS] [--examples]');
    process.exit(0);
  }
  if (flag === '--examples') { options.examples = true; continue; }
  if (!['--source', '--session', '--app', '--out', '--route', '--timeout'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid capture arguments; use --help');
  const value = args[++i];
  if (flag === '--route') options.routes.push(value);
  else options[flag.slice(2)] = value;
}
if ((!options.source === !options.session) || !options.out) throw new Error('Specify exactly one of --source or --session, and --out');
options.timeout = Number(options.timeout);
if (!Number.isFinite(options.timeout) || options.timeout < 10 || options.timeout > 600) throw new Error('--timeout must be 10..600 seconds');
if (!options.routes.length) options.routes.push('/');
if (options.routes.some(route => !route.startsWith('/') || route.startsWith('//') || /[?#\\\u0000-\u0020]/.test(route))) throw new Error('--route must be an app-relative path without query, fragment or backslash');
const output = resolve(options.out);
await mkdir(output, { recursive: true });
const deadline = Date.now() + options.timeout * 1000;
const remaining = () => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error('Capture deadline exceeded');
  return ms;
};
const privateValues = new Set();
function sanitize(value) {
  let text = String(value);
  for (const secret of privateValues) if (secret) text = text.split(secret).join('[private]');
  return text.replace(/https?:\/\/[^\s"'<>]+/g, url => {
    try { return new URL(url).pathname; } catch { return '[url]'; }
  }).replace(/(?:can_session|password|_presession|_csrf|token)\s*[=:]\s*[^\s,;]+/gi, '[private]');
}
function sanitizeTree(value) {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeTree);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeTree(entry)]));
  return value;
}
async function control(command, flags = [], cleanup = false) {
  let result;
  try {
    result = await exec(controlBin, [...controlPrefix, command, ...flags],
      { cwd: root, timeout: cleanup ? 15000 : Math.min(60000, remaining()), maxBuffer: 256 * 1024 });
  } catch (error) {
    // Decode typed control failures privately; never print raw CLI output.
    result = { stdout: error.stdout ?? '' };
  }
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { throw new Error(`Control ${command} failed or returned invalid JSON`); }
  if (!envelope.ok) {
    const error = new Error(sanitize(`${command}: ${envelope.code}: ${envelope.detail}`));
    error.controlCode = envelope.code;
    error.controlDetail = envelope.detail;
    throw error;
  }
  return envelope;
}
let session = options.session;
let owned = false;
let browser;
let phase = 'session selection';
const deadlineTimer = setTimeout(() => { void browser?.close().catch(() => {}); }, Math.max(1, deadline - Date.now()));
deadlineTimer.unref();
const report = { schema: 'can.dev.frontend-capture.v1', source: options.source ? relative(root, resolve(options.source)) : null,
  executionRoot: root,
  scope: 'actual compiled dev preview; requested routes and read-only browser audit', routes: options.routes,
  generation: 'not-tested', visualVerdict: 'pending visual inspection of screenshots',
  examples: null, pages: [], failures: [], ok: false };
const flags = () => ['--root', root, '--session', session, ...(options.app ? ['--app', options.app] : [])];
const current = state => state.preview === 'ready' && !state.dirty && !state.stale && state.revision !== null && state.serving_revision === state.revision;
try {
  if (options.source) {
    const started = await control('start', ['--source', resolve(options.source), '--root', root, ...(options.app ? ['--app', options.app] : [])]);
    session = started.session;
    owned = started.result.attached === false;
    if (!owned) throw new Error('An existing session owns this source; attachment requires explicit --session');
  }
  let status;
  phase = 'current preview preparation';
  while (true) {
    status = (await control('status', flags())).result;
    if (current(status)) break;
    if (status.revision !== null) {
      const checked = (await control('check', flags())).result;
      report.check = sanitizeTree(checked);
      if (!current((await control('status', flags())).result)) throw new Error('Current source has no admitted serving preview; see check result');
      break;
    }
    await new Promise(done => setTimeout(done, Math.min(500, remaining())));
  }
  status = (await control('status', flags())).result;
  if (!current(status)) throw new Error('Current preview is unavailable');
  report.revision = status.revision;
  report.source_revision = status.source_revision;
  report.serving_build = status.serving_build;
  report.app = status.app;
  if (options.examples) {
    phase = 'source examples';
    try {
      report.examples = (await control('example.run', [...flags(), '--expected-revision', status.revision])).result;
      if (!report.examples.ok || report.examples.current !== true || !(report.examples.executed > 0) ||
        !(report.examples.summary?.total > 0) || report.examples.serving_build !== report.serving_build || report.examples.revision !== report.revision) {
        report.failures.push('Source examples failed, executed no rows, or did not retain the captured serving revision');
      }
    } catch (error) {
      report.examples = { ok: false, error: sanitize(error.message) };
      report.failures.push(`Source examples: ${sanitize(error.message)}`);
    }
    const afterExamples = (await control('status', flags())).result;
    if (!current(afterExamples) || afterExamples.revision !== report.revision || afterExamples.serving_build !== report.serving_build) throw new Error('Current preview changed during source examples');
  }
  const initialOpen = (await control('preview.open', flags())).result;
  phase = 'browser launch';
  const actor = initialOpen.actors?.find(value => value.label === 'Ava') ?? initialOpen.actors?.find(value => value.teams?.length);
  if (!actor) throw new Error('Preview did not issue a local member actor');
  for (const value of [actor.password, actor.email, initialOpen.url]) privateValues.add(value);
  const initialUrl = new URL(initialOpen.url);
  if (initialUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(initialUrl.hostname)) throw new Error('Preview URL must be loopback HTTP');
  browser = await chromium.launch({ timeout: Math.min(30000, remaining()) });
  for (const [viewportName, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    phase = `${viewportName} authentication`;
    const context = await browser.newContext({ viewport });
    try {
      context.setDefaultTimeout(Math.min(10000, remaining()));
      context.setDefaultNavigationTimeout(Math.min(15000, remaining()));
      const page = await context.newPage();
      const opened = viewportName === 'desktop' ? initialOpen : (await control('preview.open', flags())).result;
      privateValues.add(opened.url);
      if (opened.serving_build !== report.serving_build || new URL(opened.url).origin !== initialUrl.origin) throw new Error('Serving preview changed before browser authentication');
      // Bootstrap establishes the bridge access cookie even when the owning page refuses anonymous users.
      const bootstrap = await page.goto(opened.url, { waitUntil: 'domcontentloaded', timeout: Math.min(15000, remaining()) });
      if (!bootstrap || ![200, 401, 403].includes(bootstrap.status())) throw new Error(`Preview bootstrap returned HTTP ${bootstrap?.status() ?? 'absent'}`);
      const origin = initialUrl.origin;
      const descriptor = await context.request.get(`${origin}/auth/login`, { timeout: Math.min(10000, remaining()) });
      if (descriptor.status() !== 200) throw new Error(`Login descriptor returned HTTP ${descriptor.status()}`);
      const { preSessionToken } = await descriptor.json();
      if (typeof preSessionToken !== 'string') throw new Error('Login descriptor lacks preSessionToken');
      privateValues.add(preSessionToken);
      const login = await context.request.post(`${origin}/auth/login`, { headers: { origin },
        data: { email: actor.email, password: actor.password, _presession: preSessionToken }, timeout: Math.min(10000, remaining()) });
      if (login.status() !== 200) throw new Error(`Local actor login returned HTTP ${login.status()}`);
      const cookie = (await context.cookies()).find(value => value.name === 'can_session');
      if (!cookie) throw new Error('Local actor login did not issue a session cookie');
      privateValues.add(cookie.value);
      const csrf = await deriveCsrfToken(decodeURIComponent(cookie.value));
      privateValues.add(csrf);
      if (actor.teams.length) {
        const listing = await context.request.get(`${origin}/auth/teams`, { timeout: Math.min(10000, remaining()) });
        if (listing.status() !== 200) throw new Error(`Team discovery returned HTTP ${listing.status()}`);
        const discovered = await listing.json();
        // Actor teams are human labels; selection uses the actual Identity-owned team ID.
        if (!Array.isArray(discovered.teams) || discovered.teams.length !== 1 || typeof discovered.teams[0]?.team_id !== 'string') throw new Error('Local member team discovery did not return one owned team');
        const selection = await context.request.post(`${origin}/auth/select-team`, { headers: { origin, 'x-csrf-token': csrf },
          data: { team: discovered.teams[0].team_id, _csrf: csrf }, timeout: Math.min(10000, remaining()) });
        if (selection.status() !== 200) throw new Error(`Team selection returned HTTP ${selection.status()}`);
      }
      let active;
      page.on('pageerror', error => active?.pageErrors.push(sanitize(error.message)));
      page.on('console', message => { if (message.type() === 'error') active?.consoleErrors.push(sanitize(message.text())); });
      page.on('requestfailed', request => active?.failedResources.push({ path: new URL(request.url()).pathname, error: sanitize(request.failure()?.errorText) }));
      page.on('response', response => { if (response.status() >= 400) active?.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });
      for (const [index, route] of options.routes.entries()) {
        phase = `${viewportName} ${route} capture`;
        remaining();
        active = { viewport: viewportName, route, pageErrors: [], consoleErrors: [], failedResources: [], httpErrors: [] };
        report.pages.push(active);
        const response = await page.goto(`${origin}${route}`, { waitUntil: 'networkidle', timeout: Math.min(15000, remaining()) });
        active.status = response?.status() ?? null;
        active.contentType = response?.headers()['content-type'] ?? null;
        active.title = sanitize(await page.title());
        active.audit = await page.evaluate(() => {
          const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
          const controls = [...document.querySelectorAll('input:not([type=hidden]),select,textarea,button,[role=button]')].filter(visible);
          const labelled = node => !!(node.getAttribute('aria-label')?.trim() ||
            node.getAttribute('aria-labelledby')?.split(/\s+/).some(id => document.getElementById(id)?.textContent?.trim()) ||
            [...(node.labels ?? [])].some(label => label.textContent?.trim()) ||
            ((node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') && node.textContent?.trim()) ||
            (node.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(node.type) && node.value?.trim()));
          const images = [...document.images].filter(visible);
          const main = document.querySelector('#can-main');
          const canonicalStylesheetLoaded = [...document.styleSheets].some(sheet => {
            if (!sheet.href || new URL(sheet.href).pathname !== '/assets/browser/can-style.css') return false;
            try { return sheet.cssRules.length > 0; } catch { return false; }
          });
          return { mainVisible: main !== null && visible(main), canonicalStylesheetLoaded,
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            controlCount: controls.length, unlabelledControls: controls.filter(node => !labelled(node)).map(node => ({ tag: node.tagName, type: node.getAttribute('type') })),
            imageCount: images.length, brokenImages: images.filter(node => node.complete && node.naturalWidth === 0).length,
            imagesMissingAlt: images.filter(node => !node.hasAttribute('alt')).length };
        });
        active.screenshot = `${viewportName}-${String(index + 1).padStart(2, '0')}.png`;
        await page.screenshot({ path: resolve(output, active.screenshot), fullPage: true, timeout: Math.min(15000, remaining()) });
        if (active.status !== 200 || !active.contentType?.startsWith('text/html') || !active.audit.mainVisible || !active.audit.canonicalStylesheetLoaded ||
          active.pageErrors.length || active.consoleErrors.length || active.failedResources.length || active.httpErrors.length ||
          active.audit.horizontalOverflow || active.audit.unlabelledControls.length || active.audit.brokenImages || active.audit.imagesMissingAlt) report.failures.push(`${viewportName} ${route}: browser audit failed`);
      }
    } finally { await context.close(); }
  }
  const final = (await control('status', flags())).result;
  if (!current(final) || final.revision !== report.revision || final.serving_build !== report.serving_build) throw new Error('Source or serving build changed during capture; captures invalidated');
  report.ok = report.failures.length === 0;
} catch (error) {
  report.failurePhase = phase;
  report.failures.push(sanitize(error.message));
} finally {
  clearTimeout(deadlineTimer);
  try { await browser?.close(); } catch { report.failures.push('Browser cleanup failed'); report.ok = false; }
  if (owned && session) {
    try {
      await control('stop', flags(), true);
      report.cleanup = { owned: true, released: true };
    } catch (error) {
      // The endpoint may disappear before the stop adapter finishes its acknowledgement.
      // Verify absence for this exact owned session; never stop or kill another owner.
      try {
        await control('discover', flags(), true);
        report.failures.push(`Owned session cleanup failed: ${sanitize(error.message)}`);
        report.ok = false;
      } catch (discovery) {
        if (discovery.controlCode === 'CONTROL_IO' && discovery.controlDetail === 'No such file or directory (os error 2)') {
          report.cleanup = { owned: true, released: true, note: 'Owned endpoint absence verified after stop acknowledgement failure' };
        } else {
          report.failures.push(`Owned session cleanup could not be verified: ${sanitize(discovery.message)}`);
          report.ok = false;
        }
      }
    }
  }
  // Never save raw CLI envelopes, browser storage, login payloads or bootstrap URLs.
  const safe = sanitizeTree(report);
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(safe, null, 2)}\n`);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Can frontend capture</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:1rem}img{max-width:100%;border:1px solid #ccc}pre{white-space:pre-wrap}</style><h1>Actual dev preview capture</h1><p>${safe.ok ? 'Passed requested browser audits' : 'Failed or blocked'}; ${escape(safe.source ?? 'explicit session attachment')}</p>${safe.pages.filter(page => page.screenshot).map(page => `<h2>${escape(page.viewport)} ${escape(page.route)}</h2><a href="${escape(page.screenshot)}"><img src="${escape(page.screenshot)}" alt="Captured ${escape(page.viewport)} page"></a>`).join('')}<p><a href="report.json">Structured report</a></p><pre>${escape(JSON.stringify(safe, null, 2))}</pre>`;
  await writeFile(resolve(output, 'report.html'), html);
  console.log(JSON.stringify({ ok: safe.ok, report: resolve(output, 'report.json'), captures: safe.pages.filter(page => page.screenshot).length, failures: safe.failures }));
  process.exitCode = safe.ok ? 0 : 1;
}
