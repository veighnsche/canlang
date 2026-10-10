/** Actual whole native HelpOffice + owned installed Chromium cancellation; no declaration-only fixture. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compileFunction, constants as vmConstants } from 'node:vm';
import type { D1Database } from '@cloudflare/workers-types';
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
