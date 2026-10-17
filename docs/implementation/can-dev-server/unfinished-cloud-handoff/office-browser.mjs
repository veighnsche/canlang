import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function runOfficeBrowserProbe(options = {}) {
  const installed = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
  assert.ok(options !== null && typeof options === 'object' && !Array.isArray(options), 'probe options');
  const borrowed = options.checkoutRoot !== undefined || options.session !== undefined;
  assert.equal(options.afterBrowserWorkflow === undefined || typeof options.afterBrowserWorkflow === 'function', true, 'workflow callback');
  if (borrowed) {
    assert.equal(typeof options.checkoutRoot, 'string', 'caller-owned checkout root');
    assert.match(options.session, /^[A-Za-z0-9_-]+$/, 'caller-owned exact session');
  }
  const deleteOnly = !borrowed && process.argv.includes('--delete-only');
  const fixtureName = deleteOnly ? 'office-browser-delete' : 'office-browser';
  const root = borrowed ? await realpath(options.checkoutRoot) : join(installed, `test-results/can-dev-server/${fixtureName}-root`);
  assert.notEqual(root, installed, 'probe edits require a private checkout copy');
  const manifest = join(installed, `test-results/can-dev-server/${fixtureName}-capture.json`);
  const runtime = join(await realpath(tmpdir()), `cv-${process.getuid()}`);
  const descriptorPath = join(runtime, createHash('sha256').update(root).digest('hex').slice(0, 24), 'descriptor.json');
  const require = createRequire(join(installed, 'package.json'));
  const { chromium } = require('@playwright/test');
  const { deriveCsrfToken } = await import(pathToFileURL(require.resolve('@canlang/identity')).href);
  const { FORM_REFUSAL_HEADER, isBusinessErrorCode, PUBLIC_ERROR_MESSAGES } = await import(pathToFileURL(require.resolve('@canlang/interfaces')).href);
  const { prepareLocalPreviewCapture } = await import(pathToFileURL(join(installed, 'packages/cloudflare/dist/dev/preview-inputs.js')).href);
  const exec = promisify(execFile);
  const facts = { schema: 'office-browser-journey.v1', checks: {} };
  const sourcePath = join(root, 'tests/integration/can-dev-server/OfficeSupplies.can');
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  let ownSession = borrowed ? options.session : null;
  const browserContexts = [];
  let originalSource, originalSourceSha, sourceEdited = false;

  async function prepareRoot() {
    const hasDescriptor = await stat(descriptorPath).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    assert.equal(hasDescriptor, false, 'private browser root has an existing owner descriptor; refuse replacement');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const path of ['package.json', 'compiler/Cargo.toml', 'compiler/Cargo.lock',
      'compiler/src', 'compiler/target/debug/can', 'docs/specification/GRAMMAR.md',
      'docs/specification/CONSTRUCT-HELP.md', 'docs/specification/DESIGN.md',
      'docs/design/UI-COMPONENTS.md', 'packages/ui/src/catalog.ts', 'packages/values/src/catalog.ts',
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
      ['dev', command, ...(command === 'start' ? ['--capture', manifest] : ['--root', root]),
        ...(ownSession === null ? [] : ['--session', ownSession, '--app', 'OfficeSupplies', '--profile', 'local-d1-identity']), ...options],
      { cwd: root, env: { ...process.env, CAN_DEV_BIN: join(installed, 'packages/cloudflare/dist/dev/control-cli.js') },
        timeout: 90000, maxBuffer: 200000 })); }
    catch (error) { if (!error.stdout?.trim()) throw error; stdout = error.stdout; }
    assert.equal(stdout.trimEnd().split('\n').length, 1);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true, command + ': ' + (envelope.code ?? 'failed'));
    if (command === 'start') {
      ownSession = envelope.session;
      assert.match(ownSession, /^[A-Za-z0-9_-]+$/);
    }
    assert.equal(envelope.session, ownSession, command + ': exact private owner');
    return envelope.result;
  }
  async function settledCheck() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const checked = await control('check');
      if (checked.state !== 'superseded' || attempt === 3) return checked;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  function assertReady(checked, status) {
    assert.equal(checked.session, ownSession);
    assert.equal(checked.preview, 'ready', 'preview: ' + checked.preview_reason);
    assert.equal(checked.current, true);
    assert.equal(checked.state, 'valid');
    assert.equal(status.session, ownSession);
    assert.equal(status.app, 'OfficeSupplies');
    assert.equal(status.profile, 'local-d1-identity');
    assert.equal(status.revision, checked.revision);
    assert.equal(status.serving_revision, checked.revision);
    assert.equal(status.source_revision, checked.source_revision);
    assert.equal(typeof status.serving_build, 'string');
    assert.equal(status.stale, false);
  }
  async function changedRevision(previous) {
    assert.match(previous, /^r[1-9][0-9]*$/);
    const baseline = Number(previous.slice(1));
    assert.ok(Number.isSafeInteger(baseline));
    for (let attempt = 0; attempt < 90; attempt++) {
      const status = await control('status');
      if (Number(status.revision?.slice(1)) > baseline) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('private source edit did not advance the session revision');
  }
  async function blankFailure(checked, serving, baseline) {
    const listed = await control('failures', ['--revision', checked.revision, '--after', '-1', '--limit', '25']);
    facts.blank_failure_observation = { revision: listed.revision, total: listed.total_retained, count: listed.failures?.length, codes: listed.failures?.map(value => value.code) };
    assert.equal(listed.schema, 'can.dev.failures.v1');
    assert.equal(listed.session, ownSession);
    assert.equal(listed.revision, checked.revision);
    assert.equal(baseline.session, ownSession);
    assert.equal(baseline.revision, checked.revision);
    assert.equal(baseline.next_after, null, 'complete bounded pre-action refusal baseline');
    assert.equal(listed.next_after, null, 'complete bounded post-action refusal inventory');
    for (const prior of baseline.failures) assert.deepEqual(listed.failures.find(value => value.ref === prior.ref), prior);
    const beforeRefs = new Set(baseline.failures.map(value => value.ref));
    const fresh = listed.failures.filter(value => !beforeRefs.has(value.ref));
    assert.equal(listed.total_retained, baseline.total_retained + 1);
    assert.equal(fresh.length, 1, 'exactly the actual blank-name action adds one refusal');
    const listedFailure = fresh[0];
    const occurrence = await control('failure.lookup', ['--ref', listedFailure.ref]);
    assert.deepEqual(occurrence, listedFailure);
    assert.equal(occurrence.schema, 'can.dev.failure.v1');
    assert.equal(occurrence.session, ownSession);
    assert.equal(occurrence.revision, checked.revision);
    assert.equal(occurrence.source_revision, checked.source_revision);
    assert.equal(occurrence.serving_build, serving.serving_build);
    assert.equal(occurrence.origin, 'http');
    assert.equal(occurrence.phase, 'unknown');
    assert.equal(occurrence.code, 'validation');
    assert.equal(occurrence.summary, PUBLIC_ERROR_MESSAGES.validation);
    assert.equal(occurrence.at, undefined);
    assert.deepEqual(occurrence.evidence, { state: 'partial',
      missing: ['source_mapping_unavailable', 'trace_unavailable', 'operation_identity_withheld'] });
    assert.deepEqual(Object.keys(occurrence).sort(), ['schema', 'ref', 'session', 'revision',
      'source_revision', 'serving_build', 'origin', 'phase', 'code', 'summary', 'owner_ref', 'evidence', 'detail_ref'].sort());
    assert.deepEqual(Object.keys(occurrence.owner_ref).sort(), ['request_id', 'status']);
    assert.equal(occurrence.owner_ref.status, 400);
    assert.match(occurrence.owner_ref.request_id, /^[A-Za-z0-9_-]+$/);
    assert.equal(occurrence.ref, `${ownSession}/${checked.revision}/${occurrence.owner_ref.request_id}/f0`);
    assert.equal(occurrence.detail_ref, `${occurrence.ref}/detail`);
    const detail = await control('failure.detail', ['--ref', occurrence.ref]);
    assert.deepEqual(detail, { schema: 'can.dev.failure-detail.v1', ref: occurrence.ref,
      revision: checked.revision, source_revision: checked.source_revision,
      detail: { ref: occurrence.ref, status: 400, retryable: false } });
    assert.ok(Buffer.byteLength(JSON.stringify({ occurrence, detail })) <= 4096, 'bounded redacted failure');
    const current = await control('status');
    assertReady(checked, current);
    assert.equal(current.serving_build, serving.serving_build);
    facts.blank_failure = { ref: occurrence.ref, session: occurrence.session, revision: occurrence.revision,
      source_revision: occurrence.source_revision, serving_build: occurrence.serving_build,
      code: occurrence.code, status: detail.detail.status, retryable: detail.detail.retryable,
      operation_identity: 'withheld', evidence: occurrence.evidence };
    facts.checks.blank_business_refusal_session_occurrence = true;
    return { occurrence, detail };
  }
  async function assertRetainedFailure(saved) {
    const { occurrence, detail } = saved;
    const listed = await control('failures', ['--revision', occurrence.revision, '--after', '-1', '--limit', '25']);
    assert.equal(listed.session, ownSession);
    assert.equal(listed.revision, occurrence.revision);
    assert.deepEqual(listed.failures.find(value => value.ref === occurrence.ref), occurrence);
    assert.deepEqual(await control('failure.lookup', ['--ref', occurrence.ref]), occurrence);
    assert.deepEqual(await control('failure.detail', ['--ref', occurrence.ref]), detail);
  }
  async function retainAcrossPrivateEdit(saved, initialChecked) {
    // Only the owned copy changes; finish the shared business journey before resetting its preview.
    assert.equal(sha256(await readFile(sourcePath)), originalSourceSha);
    assertReady(initialChecked, await control('status'));
    sourceEdited = true;
    await writeFile(sourcePath, Buffer.concat([originalSource, Buffer.from('\n## Private retained failure continuity check.\n')]));
    await changedRevision(initialChecked.revision);
    const edited = await settledCheck();
    const editedStatus = await control('status');
    assertReady(edited, editedStatus);
    assert.notEqual(edited.source_revision, initialChecked.source_revision);
    assert.notEqual(editedStatus.serving_build, saved.occurrence.serving_build);
    await assertRetainedFailure(saved);
    await writeFile(sourcePath, originalSource);
    sourceEdited = false;
    assert.equal(sha256(await readFile(sourcePath)), originalSourceSha);
    await changedRevision(edited.revision);
    const restored = await settledCheck();
    assertReady(restored, await control('status'));
    assert.equal(restored.source_revision, initialChecked.source_revision);
    assert.notEqual(restored.revision, initialChecked.revision);
    await assertRetainedFailure(saved);
    facts.checks.blank_failure_retained_after_private_edit = true;
    facts.checks.blank_failure_retained_after_source_restore = true;
  }
  async function login(browser, opened, label) {
    const actor = opened.actors.find(item => item.label === label);
    assert.ok(actor, label + ' actor');
    const context = await browser.newContext();
    browserContexts.push(context);
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
      const contentType = result.headers()['content-type']?.split(';', 1)[0] ?? null;
      let jsonCode = null;
      if (contentType === 'application/json') {
        const bytes = await result.body();
        if (bytes.length <= 8192) {
          try {
            const body = JSON.parse(bytes.toString('utf8'));
            if (isBusinessErrorCode(body?.code)) jsonCode = body.code;
          } catch {}
        }
      }
      facts.failure_response = { operation, status,
        content_type: contentType, json_code: jsonCode,
        refusal_header_present: typeof raw === 'string',
        refusal_metadata: metadata?.version === 1 && isBusinessErrorCode(metadata.code) &&
          typeof metadata.retryable === 'boolean'
          ? { version: 1, code: metadata.code, retryable: metadata.retryable } : null };
    }
    assert.equal(status, 200, operation + ' status=' + status + ': ' + error);
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
    if (!borrowed) await prepareRoot();
    assert.equal(await realpath(sourcePath), sourcePath, 'private source must not alias another checkout');
    originalSource = await readFile(sourcePath);
    originalSourceSha = sha256(originalSource);
    assert.equal(originalSourceSha, sha256(await readFile(join(installed, 'tests/integration/can-dev-server/OfficeSupplies.can'))));
    facts.source_original_sha256 = originalSourceSha;
    if (borrowed) {
      // Native discover performs the handshake with the already-owned in-process service.
      // Its public result has no `attached` field; do not substitute a fabricated start result.
      const found = await control('discover');
      assert.equal(found.schema, 'can.dev.discover.v1');
      assert.equal(found.root, root, 'same caller-owned canonical checkout');
      assert.equal(found.status.session, ownSession);
      assert.equal(found.status.app, 'OfficeSupplies');
      assert.equal(found.status.profile, 'local-d1-identity');
      facts.checks.native_discover_same_owned_cohort = true;
    } else {
      const session = await control('start'); started = true;
      assert.equal(session.attached, false, 'private root attached elsewhere');
      assert.equal(session.root, root);
      facts.checks.private_owner = true;
    }
    const checked = await settledCheck();
    const serving = await control('status');
    assertReady(checked, serving);
    const failures = await control('failures', ['--revision', checked.revision, '--after', '-1']);
    assert.deepEqual(failures.failures, [], 'CLI failures --after -1');
    facts.checks.native_cli_failures_minus_one = true;
    facts.checks.current_artifact = true;
    const opened = await control('preview.open');
    browser = await chromium.launch({ headless: true });
    const ava = await login(browser, opened, 'Ava');
    const { page, origin } = ava;
    if (deleteOnly) {
      await create(page, origin, 'Delete probe', '1');
      const form = rows(page).filter({ hasText: 'Delete probe' }).locator('form[action*="Supply.delete"]');
      assert.equal(await form.count(), 1, 'actual generated delete form');
      facts.delete_form = await form.evaluate(element => ({
        path: new URL(element.action).pathname,
        method: element.method,
        controls: [...element.elements].map(control => ({
          name: control.name, type: control.type,
          ...(control.name === '_nonce' ? { version_shape: /^v[0-9]+\./.test(control.value) ? 'version-prefixed' : 'opaque' } : {}),
        })),
      }));
      await submit(page, form, 'Supply.delete');
      await reload(page, origin);
      assert.equal(await count(page), 0, 'generated delete removes created row');
      assert.equal(await rows(page).count(), 0);
      facts.checks.generated_delete_no_rows = true;
    } else {
    assert.equal(await count(page), 0);
    assert.equal(await page.locator('form[action*="Supply.create"] input[name="inputs[quantity]"]').count(), 1);
    facts.checks.source_form = true;
    const beforeBlankFailure = await control('failures', ['--revision', checked.revision, '--after', '-1', '--limit', '25']);
    await rejectBlankName(page, origin);
    const savedBlankFailure = await blankFailure(checked, serving, beforeBlankFailure);
    await create(page, origin, 'Paper', '');
    assert.equal(await count(page), 1); facts.checks.paper_optional_blank = true;
    await create(page, origin, 'Pens', '4');
    await create(page, origin, 'Tape', '2');
    assert.equal(await count(page), 3); facts.checks.three_creates = true;
    const benOpened = await control('preview.open');
    assert.notEqual(benOpened.url, opened.url, 'second member receives a fresh one-use bootstrap');
    assert.equal(new URL(benOpened.url).origin, origin, 'second member joins the same preview');
    const ben = await login(browser, benOpened, 'Ben');
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
    if (options.afterBrowserWorkflow !== undefined) {
      // Use the rendered source form; archive/history remain in the actual serving D1.
      const paper = rows(page).filter({ hasText: 'Paper' });
      assert.equal(await paper.count(), 1);
      await submit(page, paper.locator('form[action*="Supply.delete"]'), 'Supply.delete');
      await reload(page, origin);
      await reload(ben.page, ben.origin);
      assert.equal(await count(page), 0);
      assert.equal(await rows(page).count(), 0);
      assert.equal(await count(ben.page), 0);
      assert.equal(await rows(ben.page).count(), 0);
      const workflowStatus = await control('status');
      assertReady(checked, workflowStatus);
      assert.equal(workflowStatus.serving_build, serving.serving_build);
      assert.equal(sha256(await readFile(sourcePath)), originalSourceSha);
      facts.checks.browser_rows_empty_before_joined_workflow = true;
      await options.afterBrowserWorkflow();
      facts.checks.joined_business_workflow_completed = true;
    }
    await retainAcrossPrivateEdit(savedBlankFailure, checked);
    }
    facts.result = 'passed';
  } catch (error) {
    facts.result = 'failed'; facts.failure = {
      name: error.name,
      message: String(error.message).split('\n', 1)[0].slice(0, 240),
      point: String(error.stack).match(/office-browser\.mjs:[0-9]+:[0-9]+/)?.[0] ?? null,
    };
  } finally {
    try {
      if (sourceEdited) await writeFile(sourcePath, originalSource);
      if (originalSource !== undefined) {
        assert.equal(sha256(await readFile(sourcePath)), originalSourceSha);
        assert.equal(sha256(await readFile(join(installed, 'tests/integration/can-dev-server/OfficeSupplies.can'))), originalSourceSha);
        facts.checks.source_restored_exactly = true;
      }
    } catch (error) { facts.result = 'failed'; facts.source_restore_failure = String(error.message).split('\n', 1)[0].slice(0, 160); }
    try {
      const closed = await Promise.allSettled(browserContexts.map(context => context.close()));
      assert.equal(closed.every(result => result.status === 'fulfilled'), true, 'owned browser contexts close');
    } catch (error) { facts.result = 'failed'; facts.browser_context_cleanup_failure = String(error.message).split('\n', 1)[0].slice(0, 160); }
    try { await browser?.close(); }
    catch (error) { facts.result = 'failed'; facts.browser_cleanup_failure = String(error.message).split('\n', 1)[0].slice(0, 160); }
    finally {
      if (started) {
        try {
          const stopped = await control('stop');
          assert.equal(stopped.schema, 'can.dev.stop.v1');
          assert.equal(stopped.stopped, true);
          assert.equal(await stat(descriptorPath).then(() => true, error => {
            if (error.code === 'ENOENT') return false;
            throw error;
          }), false, 'owned stop removes descriptor');
          facts.checks.owned_stop_descriptor_removed = true;
        } catch (error) { facts.result = 'failed'; facts.stop_failure = String(error.message).split('\n', 1)[0].slice(0, 160); }
      }
    }
  }
  return facts;
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  const facts = await runOfficeBrowserProbe();
  const installed = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
  const fixtureName = process.argv.includes('--delete-only') ? 'office-browser-delete' : 'office-browser';
  await writeFile(join(installed, `test-results/can-dev-server/${fixtureName}-journey.json`), JSON.stringify(facts, null, 2));
  if (facts.result !== 'passed') process.exitCode = 1;
  console.log(JSON.stringify(facts));
}
