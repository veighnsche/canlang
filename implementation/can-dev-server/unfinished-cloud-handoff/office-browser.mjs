import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installed = fileURLToPath(new URL('../../../', import.meta.url));
const root = join(installed, 'test-results/can-dev-server/office-browser-root');
const log = join(installed, 'test-results/can-dev-server/office-browser-journey.json');
const manifest = join(installed, 'test-results/can-dev-server/office-browser-capture.json');
const require = createRequire(join(installed, 'package.json'));
const { chromium } = require('@playwright/test');
const { deriveCsrfToken } = await import(pathToFileURL(require.resolve('@canlang/identity')).href);
const { FORM_REFUSAL_HEADER, isBusinessErrorCode } = await import(pathToFileURL(require.resolve('@canlang/interfaces')).href);
const { prepareLocalPreviewCapture } = await import(pathToFileURL(join(installed, 'packages/cloudflare/dist/dev/preview-inputs.js')).href);
const exec = promisify(execFile);
const facts = { schema: 'office-browser-journey.v1', checks: {} };

async function prepareRoot() {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const path of ['package.json', 'compiler/Cargo.toml', 'compiler/Cargo.lock',
    'compiler/src', 'compiler/target/debug/can', 'docs/specification/GRAMMAR.md',
    'docs/specification/CONSTRUCT-HELP.md', 'docs/specification/DESIGN.md',
    'design/UI-COMPONENTS.md', 'packages/ui/src/catalog.ts', 'packages/values/src/catalog.ts',
    'tests/integration/can-dev-server/OfficeSupplies.can']) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(installed, path), target, { recursive: true, preserveTimestamps: true });
  }
  await symlink(join(installed, 'node_modules'), join(root, 'node_modules'));
  const capture = prepareLocalPreviewCapture({ checkoutRoot: root,
    appPath: join(root, 'tests/integration/can-dev-server/OfficeSupplies.can'),
    compilerPath: join(root, 'compiler/target/debug/can'),
    catalogPath: join(installed, 'packages/values/dist/catalog.json'),
    helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') });
  await writeFile(manifest, JSON.stringify(capture));
  facts.capture = { source_revision: capture.sourceRevision, epoch_material: capture.epochMaterial };
}
async function control(command, options = []) {
  let stdout;
  try { ({ stdout } = await exec(join(root, 'compiler/target/debug/can'),
    ['dev', command, ...(command === 'start' ? ['--capture', manifest] : ['--root', root]), ...options],
    { cwd: root, env: { ...process.env, CAN_DEV_BIN: join(installed, 'packages/cloudflare/dist/dev/control-cli.js') },
      timeout: 90000, maxBuffer: 200000 })); }
  catch (error) { if (!error.stdout?.trim()) throw error; stdout = error.stdout; }
  assert.equal(stdout.trimEnd().split('\n').length, 1);
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, true, command + ': ' + (envelope.code ?? 'failed'));
  return envelope.result;
}
async function login(browser, opened, label) {
  const actor = opened.actors.find(item => item.label === label);
  assert.ok(actor, label + ' actor');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(opened.url);
  const origin = new URL(opened.url).origin;
  const descriptor = await (await context.request.get(origin + '/auth/login')).json();
  const logged = await context.request.post(origin + '/auth/login', { headers: { origin },
    data: { email: actor.email, password: actor.password, _presession: descriptor.preSessionToken } });
  assert.equal(logged.status(), 200, label + ' login');
  const teams = await (await context.request.get(origin + '/auth/teams')).json();
  assert.equal(teams.teams.length, 1, label + ' teams');
  const cookie = (await context.cookies()).find(item => item.name === 'can_session');
  assert.ok(cookie, label + ' session');
  const csrf = await deriveCsrfToken(decodeURIComponent(cookie.value));
  const selected = await context.request.post(origin + '/auth/select-team', {
    headers: { origin, 'x-csrf-token': csrf }, data: { team: teams.teams[0].team_id, _csrf: csrf } });
  assert.equal(selected.status(), 200, label + ' team selection');
  await page.goto(origin); await page.waitForLoadState('networkidle');
  return { context, page, origin };
}
const rows = page => page.locator('li.list-row');
async function count(page) {
  const text = await page.locator('[data-can-list-count]').innerText();
  const match = text.match(/:\s*(\d+)\s*$/);
  assert.ok(match, 'list count: ' + text);
  return Number(match[1]);
}
async function reload(page, origin) { await page.goto(origin); await page.waitForLoadState('networkidle'); }
async function submit(page, form, operation) {
  const response = page.waitForResponse(item => item.request().method() === 'POST' &&
    decodeURIComponent(new URL(item.url()).pathname).includes(operation), { timeout: 30000 });
  await form.locator('button[type="submit"]').first().click();
  const result = await response;
  const status = result.status();
  let error = '';
  if (status !== 200) {
    // A failed HTML form can contain private draft and credential controls.
    // Report only the owning closed metadata, never a response-body excerpt.
    const raw = result.headers()[FORM_REFUSAL_HEADER];
    let metadata;
    if (typeof raw === 'string' && Buffer.byteLength(raw) <= 256) {
      try { metadata = JSON.parse(raw); } catch {}
    }
    error = metadata?.version === 1 && isBusinessErrorCode(metadata.code) &&
      typeof metadata.retryable === 'boolean'
      ? `${metadata.code}; retryable=${metadata.retryable}` : 'bounded refusal metadata unavailable';
  }
  assert.equal(status, 200, operation + ' status: ' + error);
}
async function create(page, origin, name, quantity) {
  const form = page.locator('form[action*="Supply.create"]').first();
  assert.equal(await form.count(), 1, 'source create form');
  await form.locator('input[name="inputs[name]"]').fill(name);
  await form.locator('input[name="inputs[quantity]"]').fill(quantity);
  await submit(page, form, 'Supply.create');
  await reload(page, origin);
  assert.equal(await rows(page).filter({ hasText: name }).count(), 1, name + ' persisted');
}
async function rejectBlankName(page, origin) {
  const form = page.locator('form[action*="Supply.create"]').first();
  await form.locator('input[name="inputs[name]"]').fill('   ');
  await form.locator('input[name="inputs[quantity]"]').fill('');
  const pending = page.waitForResponse(item => item.request().method() === 'POST' &&
    decodeURIComponent(new URL(item.url()).pathname).includes('Supply.create'), { timeout: 30000 });
  await form.locator('button[type="submit"]').click();
  const response = await pending;
  assert.equal(response.status(), 400, 'trimmed blank name rejected');
  assert.equal((await response.json()).code, 'validation');
  await reload(page, origin);
  assert.equal(await count(page), 0, 'blank refusal leaves no rows');
  facts.checks.blank_name_refused_no_effect = true;
}
async function edit(page, origin, oldName, name, quantity, available) {
  const row = rows(page).filter({ hasText: oldName });
  assert.equal(await row.count(), 1, oldName + ' row');
  const form = row.locator('form[action*="Supply.update"]').first();
  assert.equal(await form.count(), 1, oldName + ' edit form; row text=' + (await row.locator('p').allInnerTexts()).join(' | '));
  await row.locator('label.drawer-button').click();
  await form.locator('input[name="inputs[changes][name]"]').fill(name);
  await form.locator('input[name="inputs[changes][quantity]"]').fill(quantity);
  const toggle = form.locator('input[name="inputs[changes][available]"]');
  if (available) await toggle.check(); else await toggle.uncheck();
  await submit(page, form, 'Supply.update');
  await reload(page, origin);
  const updated = rows(page).filter({ hasText: name });
  assert.equal(await updated.count(), 1, name + ' persisted');
  assert.equal(await updated.locator('form[action*="Supply.update"] input[name="inputs[changes][name]"]').inputValue(), name);
  assert.equal(await updated.locator('form[action*="Supply.update"] input[name="inputs[changes][quantity]"]').inputValue(), quantity);
  assert.equal(await updated.locator('form[action*="Supply.update"] input[name="inputs[changes][available]"]').isChecked(), available);
}
async function searchFor(page, query) {
  const form = page.locator('form[role="search"]');
  await form.locator('input[name="q"]').fill(query);
  await form.locator('button[type="submit"]').click();
  await page.waitForLoadState('networkidle');
}
async function tab(page, value) {
  const form = page.locator('form:has(input[type="radio"][name="view"])');
  assert.equal(await form.count(), 1, 'bound tabs');
  await form.locator('input[type="radio"][name="view"][value="' + value + '"]').check();
  const response = page.waitForResponse(item => item.request().method() === 'POST' &&
    new URL(item.url()).pathname === '/', { timeout: 30000 });
  await form.locator('button[type="submit"]').click();
  assert.equal((await response).status(), 303, 'tab preference POST redirect');
  await page.waitForLoadState('networkidle');
  await reload(page, new URL(page.url()).origin);
  assert.equal(await form.locator('input[value="' + value + '"]').isChecked(), true,
    'persisted tab preference; page=' + new URL(page.url()).pathname);
}
let browser, started = false;
try {
  await prepareRoot();
  const session = await control('start'); started = true;
  assert.equal(session.attached, false, 'private root attached elsewhere');
  facts.checks.private_owner = true;
  const checked = await control('check');
  assert.equal(checked.preview, 'ready', 'preview: ' + checked.preview_reason);
  assert.equal(checked.current, true); assert.equal(checked.state, 'valid');
  const failures = await control('failures', ['--revision', 'r1', '--after', '-1']);
  assert.deepEqual(failures.failures, [], 'CLI failures --after -1');
  facts.checks.native_cli_failures_minus_one = true;
  facts.checks.current_artifact = true;
  const opened = await control('preview.open');
  browser = await chromium.launch({ headless: true });
  const ava = await login(browser, opened, 'Ava');
  const { page, origin } = ava;
  assert.equal(await count(page), 0);
  assert.equal(await page.locator('form[action*="Supply.create"] input[name="inputs[quantity]"]').count(), 1);
  facts.checks.source_form = true;
  await rejectBlankName(page, origin);
  await create(page, origin, 'Paper', '');
  assert.equal(await count(page), 1); facts.checks.paper_optional_blank = true;
  await create(page, origin, 'Pens', '4');
  await create(page, origin, 'Tape', '2');
  assert.equal(await count(page), 3); facts.checks.three_creates = true;
  const ben = await login(browser, opened, 'Ben');
  assert.equal(await count(ben.page), 3);
  assert.equal(await rows(ben.page).filter({ hasText: 'Paper' }).count(), 1);
  const benPens = rows(ben.page).filter({ hasText: 'Pens' });
  assert.equal(await benPens.count(), 1);
  assert.equal(await benPens.locator('form[action*="Supply.update"] input[name="inputs[changes][quantity]"]').inputValue(), '4');
  facts.checks.ben_reads_ava_rows = true;
  await edit(ben.page, ben.origin, 'Pens', 'Blue pens', '8', false);
  facts.checks.edit_unavailable_persisted = true;
  await tab(ben.page, 'restock');
  assert.equal(await count(ben.page), 1);
  assert.equal(await rows(ben.page).filter({ hasText: 'Blue pens' }).count(), 1);
  await tab(ben.page, 'all');
  await reload(page, origin);
  const avaBlue = rows(page).filter({ hasText: 'Blue pens' });
  assert.equal(await avaBlue.count(), 1);
  assert.equal(await avaBlue.locator('form[action*="Supply.update"] input[name="inputs[changes][quantity]"]').inputValue(), '8');
  assert.equal(await avaBlue.locator('form[action*="Supply.update"] input[name="inputs[changes][available]"]').isChecked(), false);
  facts.checks.ava_observes_ben_edit = true;
  await tab(page, 'available');
  assert.equal(await count(page), 2);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).count(), 0);
  facts.checks.available_tab = true;
  await tab(page, 'restock');
  assert.equal(await count(page), 1);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).count(), 1);
  facts.checks.restock_tab = true;
  await tab(page, 'all');
  await searchFor(page, 'pa');
  assert.equal(await count(page), 1);
  assert.equal(await rows(page).count(), 1);
  assert.equal(await rows(page).filter({ hasText: 'Paper' }).count(), 1);
  await tab(page, 'available');
  await searchFor(page, 'ens');
  assert.equal(await count(page), 0);
  assert.equal(await rows(page).count(), 0);
  assert.match(await page.locator('body').innerText(), /No supplies match this view/);
  await tab(page, 'restock');
  await searchFor(page, 'ens');
  assert.equal(await count(page), 1);
  assert.equal(await rows(page).count(), 1);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).count(), 1);
  facts.checks.frozen_search_tab_combinations = true;
  await tab(page, 'all');
  await searchFor(page, 'Blue');
  assert.equal(await count(page), 1);
  await searchFor(page, 'No such supply');
  assert.equal(await count(page), 0);
  assert.match(await page.locator('body').innerText(), /No supplies match this view/);
  facts.checks.search_count_empty = true;
  await reload(page, origin);
  assert.equal(await count(page), 3, 'cleared search restores all rows');
  await edit(ben.page, ben.origin, 'Blue pens', 'Blue pens', '8', true);
  await tab(ben.page, 'restock');
  assert.equal(await count(ben.page), 0); facts.checks.available_restored = true;
  await tab(ben.page, 'all');
  await reload(page, origin);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).count(), 1);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).locator('form[action*="Supply.update"] input[name="inputs[changes][available]"]').isChecked(), true);
  facts.checks.ava_observes_ben_restoration = true;
  await tab(page, 'restock');
  assert.equal(await count(page), 0);
  await tab(page, 'all');
  const blue = rows(page).filter({ hasText: 'Blue pens' });
  assert.equal(await blue.count(), 1);
  await submit(page, blue.locator('form[action*="Supply.delete"]'), 'Supply.delete');
  await reload(page, origin);
  assert.equal(await count(page), 2);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).count(), 0);
  await tab(page, 'available');
  assert.equal(await count(page), 2);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).count(), 0);
  await tab(page, 'restock');
  assert.equal(await count(page), 0);
  assert.equal(await rows(page).filter({ hasText: 'Blue pens' }).count(), 0);
  await tab(page, 'all');
  facts.checks.ava_removes_shared_edited_row = true;
  const tape = rows(page).filter({ hasText: 'Tape' });
  assert.equal(await tape.count(), 1);
  await submit(page, tape.locator('form[action*="Supply.delete"]'), 'Supply.delete');
  await reload(page, origin);
  assert.equal(await count(page), 1);
  assert.equal(await rows(page).filter({ hasText: 'Tape' }).count(), 0);
  facts.checks.archive_count = true;
  await reload(ben.page, ben.origin);
  assert.equal(await count(ben.page), 1);
  assert.equal(await rows(ben.page).filter({ hasText: 'Paper' }).count(), 1);
  assert.equal(await rows(ben.page).filter({ hasText: 'Blue pens' }).count(), 0);
  facts.checks.ben_shared_rows = true;
  facts.result = 'passed';
} catch (error) {
  facts.result = 'failed'; facts.failure = {
    name: error.name,
    message: String(error.message).split('\n', 1)[0].slice(0, 240),
  };
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (started) { try { await control('stop'); } catch (error) { facts.stop_failure = error.message; process.exitCode = 1; } }
  await writeFile(log, JSON.stringify(facts, null, 2));
}
console.log(JSON.stringify(facts));
