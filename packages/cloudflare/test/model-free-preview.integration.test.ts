/** Model-free only: actual native artifact, installed producer, D1 and HTTP consumer. */
import { resolve, join } from 'node:path';
import { compileFunction, constants } from 'node:vm';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { deriveCsrfToken } from '@canlang/identity';
import { distribution as valuesDistribution } from '@canlang/values/distribution';
import { prepareLocalPreviewCapture } from '../src/runtime/native-dev.test-support.js';
import { captureIsCurrent, captureSingleFileSource } from '../src/runtime/native-dev.test-support.js';
import { compileCapturedSingleFile } from '../src/runtime/native-dev.test-support.js';
import { openNativePreview } from '../src/runtime/native-preview.test-support.js';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

it('starts a source-current native model-free preview through actual global D1 activation', async () => {
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({
    checkoutRoot: repo,
    appPath: join(repo, 'tests/integration/can-dev-server/ModelFreePreview.can'),
    compilerPath: join(repo, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(valuesDistribution.catalog),
    helpIndexPath: join(repo, 'docs/specification/CONSTRUCT-HELP.md'),
  }));
  expect(await captureIsCurrent(capture)).toBe(true);
  const compiled = await compileCapturedSingleFile(capture);
  expect(compiled.kind, JSON.stringify(compiled.kind === 'artifact' ? {} : compiled)).toBe('artifact');
  if (compiled.kind !== 'artifact') throw new Error(`native compilation failed: ${compiled.kind}`);
  expect(compiled.artifact.models ?? []).toEqual([]);
  expect(compiled.artifact.operations).toHaveLength(1);
  expect(compiled.artifact.pages).toHaveLength(1);
  expect(compiled.artifact.sources).toEqual([{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);

  // This public installed producer runs real preflight and serving DB gates;
  // readiness cannot be manufactured with a supplied activation verdict.
  const preview = await openNativePreview(compiled.artifact, capture, compiled.artifactBytes);
  try {
    expect(await captureIsCurrent(capture)).toBe(true);
    const issueOpenUrl = preview.issueOpenUrl;
    if (typeof issueOpenUrl !== 'function') throw new Error('installed preview has no protected-open producer');
    const opened = await issueOpenUrl();
    const origin = new URL(opened).origin;
    expect(new URL(origin).hostname).toBe('127.0.0.1');
    const cookies = new Map<string, string>();
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      if (init.method === 'POST') headers.set('origin', origin);
      const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!;
        const index = pair.indexOf('=');
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    expect((await fetch(origin, { redirect: 'manual' })).status).toBe(401);
    const bootstrap = await request(opened);
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('location')).toBe('/');
    expect((await request(opened)).status).toBe(403);
    const actors = preview.issueLocalActors();
    const actor = actors.find(candidate => candidate.label === 'Ava');
    expect(actor).toBeDefined();
    const descriptor = await request('/auth/login');
    expect(descriptor.status).toBe(200);
    const loginDescriptor = await descriptor.json() as { preSessionToken: string };
    const login = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: actor!.email, password: actor!.password, _presession: loginDescriptor.preSessionToken }) });
    expect(login.status).toBe(200);
    const session = cookies.get('can_session');
    expect(session).toBeDefined();
    const teamsResponse = await request('/auth/teams');
    expect(teamsResponse.status).toBe(200);
    const teams = await teamsResponse.json() as { teams: Array<{ team_id: string }> };
    expect(teams.teams.length).toBeGreaterThan(0);
    const csrf = await deriveCsrfToken(decodeURIComponent(session!));
    const selected = await request('/auth/select-team', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ team: teams.teams[0]!.team_id, _csrf: csrf }) });
    expect(selected.status).toBe(200);
    const page = await request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Model-free preview');
    expect(html).toContain('Model-free generated page');
    expect(html).toContain('/assets/browser/bootstrap.js');
    for (const path of ['/assets/browser/bootstrap.js', '/assets/browser/can-style.css', '/assets/browser/polling.js']) {
      const asset = await request(path);
      expect(asset.status, path).toBe(200);
      expect(asset.headers.get('content-type')).toContain(path.endsWith('.css') ? 'text/css' : 'application/javascript');
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    expect(await captureIsCurrent(capture)).toBe(true);
  } finally { await preview.dispose(); }
  expect(() => preview.issueLocalActors()).toThrow(/disposal/);
}, 120000);


it('stages the genuine removed-member handler once through canonical HTTP, retry and owner D1 reopen', async () => {
  const nativeImport = compileFunction('return import(url)', ['url'], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (url: string) => Promise<unknown>;
  const native = await nativeImport(new URL('../dist/runtime/native-dev.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-dev.test-support.js');
  const hosts = await nativeImport(new URL('../dist/runtime/native-preview.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-preview.test-support.js');
  const capture = await native.captureSingleFileSource(native.prepareLocalPreviewCapture({ checkoutRoot: repo,
    appPath: join(repo, 'packages/cloudflare/test/fixtures/native-identity-removal-source.can'),
    compilerPath: join(repo, 'compiler/target/debug/can'), catalogPath: fileURLToPath(valuesDistribution.catalog),
    helpIndexPath: join(repo, 'docs/specification/CONSTRUCT-HELP.md') }));
  const compiled = await native.compileCapturedSingleFile(capture);
  expect(compiled.kind, JSON.stringify(compiled.kind === 'artifact' ? {} : compiled)).toBe('artifact');
  if (compiled.kind !== 'artifact') throw new Error('Native removal source did not compile.');
  expect(compiled.artifact.callables.some(callable => callable.id === 'NativeIdentityRemoval.observed' && callable.kind === 'handler')).toBe(true);
  const evidence = await hosts.nativePreviewEvidence(compiled.artifact, capture);
  const persistence = await mkdtemp(join(tmpdir(), 'can-native-removal-'));
  const databaseId = `removal-identity-${randomUUID()}`, workerName = `native-removal-${randomUUID()}`;
  let worker: Awaited<ReturnType<typeof hosts.startLocalDev>> | undefined;
  let provision: Awaited<ReturnType<typeof hosts.startLocalDev>> | undefined;
  let gateway: Awaited<ReturnType<typeof hosts.startNativeGateway>> | undefined;
  try {
    provision = await hosts.startLocalDev({ workerName: `${workerName}-seed`, compatibilityDate: '2026-07-15',
      mainModule: 'seed.js', modules: { 'seed.js': 'export default {fetch(){return new Response(null,{status:404})}};' },
      d1Databases: [{ binding: 'DB', id: databaseId }], d1Persist: persistence });
    const seeded = await hosts.seedLocalPreviewActors(await provision.getD1Database('DB'));
    await provision.dispose(); provision = undefined;
    const owners = seeded.owners.map(owner => ({ ...owner, id: `removal-owner-${randomUUID()}` }));
    gateway = await hosts.startNativeGateway();
    const origin = gateway.url;
    const vars = { ...await hosts.selectPreviewWorkerVars({ resources: {
      d1: { binding: 'DB', availability: 'real_local' }, identity: { backingBinding: 'DB', availability: 'real_local' } } }, origin),
      CAN_FORM_BINDING_KEY: randomBytes(32).toString('base64url'),
      CAN_STATE_OWNERS: { version: 1, owners: owners.map(owner => ({ owner: owner.owner, binding: owner.binding, initializeFresh: true })) } };
    const start = () => hosts.startLocalDev({ workerName, compatibilityDate: '2026-07-15',
      mainModule: evidence.bundle.mainModule, modules: evidence.bundle.modules, binaryModules: evidence.bundle.binaries,
      d1Databases: [{ binding: 'DB', id: databaseId }, ...owners.map(owner => ({ binding: owner.binding, id: owner.id }))],
      d1Persist: persistence, vars });
    worker = await start();
    await gateway.setBackend(worker.backend);
    let identityDb = await worker.getD1Database('DB');
    for (const owner of owners) {
      expect((await hosts.localPreviewActivationVerdict(compiled.artifact, capture,
        await worker.getD1Database(owner.binding), owner.id, owner.owner, identityDb)).active).toBe(true);
    }
    const candidates = await identityDb.prepare("SELECT m.team_id, m.user_id, u.email FROM identity_memberships m JOIN identity_users u ON u.user_id=m.user_id WHERE m.status='active' AND m.is_owner=1 ORDER BY m.team_id").all<{ team_id: string; user_id: string; email: string }>();
    const owner = candidates.results.find(candidate => seeded.actors.some(actor => actor.label === 'Ava' && actor.email === candidate.email));
    expect(owner).toBeDefined();
    if (owner === undefined) throw new Error('Real seeded owner is unavailable.');
    const credentials = seeded.actors.find(actor => actor.email === owner.email)!;
    const target = await identityDb.prepare("SELECT membership_id,user_id FROM identity_memberships WHERE team_id=? AND user_id<>? AND status='active' AND is_owner=0 ORDER BY user_id LIMIT 1")
      .bind(owner.team_id, owner.user_id).first<{ membership_id: string; user_id: string }>();
    expect(target).not.toBeNull();
    if (target === null) throw new Error('Real seeded team member is unavailable.');
    const selected = owners.find(item => item.owner === owner.team_id); expect(selected).toBeDefined();
    if (selected === undefined) throw new Error('Serving team owner is unavailable.');
    let ownerDb = await worker.getD1Database(selected.binding);
    const cookies = new Map<string, string>();
    const request = async (path: string, body?: unknown, csrf?: string) => {
      const response = await worker!.dispatchUrl(new URL(path, origin).href, {
        method: body === undefined ? 'GET' : 'POST', headers: {
          cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), origin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!, at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return response;
    };
    const login = await request('/auth/login');
    if (login.status !== 200) {
      // Failure diagnostics deliberately exclude headers, cookies, raw bodies
      // and successful login descriptors (which contain pre-session tokens).
      let failure: unknown;
      try { failure = await login.clone().json(); } catch { failure = null; }
      const body = failure !== null && typeof failure === 'object' && !Array.isArray(failure)
        ? failure as Record<string, unknown> : {};
      const error = body.error !== null && typeof body.error === 'object' && !Array.isArray(body.error)
        ? body.error as Record<string, unknown> : body;
      expect(login.status, JSON.stringify({
        code: typeof error.code === 'string' ? error.code : 'unavailable',
        message: typeof error.message === 'string' ? error.message : 'No structured failure message.',
      })).toBe(200);
    }

    const descriptor = await login.json() as { preSessionToken: string };
    expect((await request('/auth/login', { email: credentials.email, password: credentials.password,
      _presession: descriptor.preSessionToken })).status).toBe(200);
    const session = cookies.get('can_session'); expect(session).toBeDefined();
    const csrf = await deriveCsrfToken(decodeURIComponent(session!));
    expect((await request('/auth/select-team', { team: owner.team_id, _csrf: csrf }, csrf)).status).toBe(200);
    const now = Date.now().toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
    const operationId = `${now.slice(0,8)}-${now.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
    const envelope = { operation_id: operationId, inputs: { member: { id: target.user_id } } };
    const remove = () => request('/api/operations/system.team.remove', envelope, csrf);
    // Interrupt the real cross-owner handoff after Identity has sealed its
    // original removal. The State transaction must roll back in full.
    const beforeFence = (await ownerDb.prepare('SELECT * FROM fence_log').all()).results;
    await ownerDb.exec("CREATE TRIGGER reject_removal_handoff BEFORE INSERT ON records WHEN NEW.model='work.occurrence' BEGIN SELECT RAISE(ABORT, 'interrupted removal handoff'); END");
    const interrupted = await remove();
    const interruption = await interrupted.json() as { code?: string; message?: string };
    expect(interrupted.status, JSON.stringify(interruption)).toBe(422);
    expect(interruption.message).toContain('interrupted removal handoff');
    expect(await identityDb.prepare('SELECT COUNT(*) AS count FROM identity_member_removals WHERE operation_id=?')
      .bind(operationId).first('count')).toBe(1);
    expect((await ownerDb.prepare('SELECT * FROM records WHERE model IN (?,?)')
      .bind('work.occurrence', 'work.handler_occurrence').all()).results).toEqual([]);
    expect((await ownerDb.prepare('SELECT * FROM fence_log').all()).results).toEqual(beforeFence);
    await ownerDb.exec('DROP TRIGGER reject_removal_handoff');
    const recovered = await remove(); expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: 'replayed', operation_id: operationId, result: { removed: true } });
    const snapshot = async () => ({
      removal: (await identityDb.prepare('SELECT * FROM identity_member_removals WHERE operation_id=?').bind(operationId).all()).results,
      member: await identityDb.prepare('SELECT * FROM identity_memberships WHERE membership_id=?').bind(target.membership_id).first(),
      work: (await ownerDb.prepare('SELECT * FROM records WHERE model IN (?,?) ORDER BY model,id')
        .bind('work.occurrence', 'work.handler_occurrence').all<{ id: string; model: string; data: string }>()).results,
      revision: (await ownerDb.prepare('SELECT * FROM fence_log').all()).results,
    });
    const saved = await snapshot();
    expect(saved.removal).toHaveLength(1);
    expect(saved.member).toMatchObject({ status: 'removed' });
    const original = saved.removal[0] as Record<string, unknown>;
    expect(original).toMatchObject({ team_id: owner.team_id, user_id: target.user_id, removed_by: owner.user_id });
    const work = saved.work.map(row => ({ ...row, value: JSON.parse(row.data) as Record<string, unknown> }));
    const source = work.filter(row => row.model === 'work.occurrence');
    const handlers = work.filter(row => row.model === 'work.handler_occurrence');
    expect(source).toHaveLength(1); expect(handlers).toHaveLength(1);
    expect(source[0]!.id).toBe(original.event_id);
    expect(source[0]!.value).toMatchObject({ status: 'completed', result: { kind: 'identity-removal-source',
      envelope: { producerEventId: original.event_id, operationId, membershipRemoval: { user: { id: target.user_id } } } } });
    expect(handlers[0]!.value).toMatchObject({ state: 'pending', sourceOccurrence: original.event_id,
      handler: 'NativeIdentityRemoval.observed', event: 'teams.member_removed', scopeApp: 'NativeIdentityRemoval', scopeOwner: owner.team_id,
      payload: { team_id: owner.team_id, membership_id: target.membership_id, user: { id: target.user_id } } });
    const retry = await remove(); expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'replayed' });
    expect(await snapshot()).toEqual(saved);
    // Retaining the original adapter must never cache its physical-owner grant.
    const foreign = owners.find(candidate => candidate.owner !== owner.team_id)!;
    await ownerDb.prepare('UPDATE state_owner_pin SET owner=? WHERE id=1').bind(foreign.owner).run();
    const repinned = await remove(); expect(repinned.status).toBe(403);
    expect(await snapshot()).toEqual(saved);
    await ownerDb.prepare('UPDATE state_owner_pin SET owner=? WHERE id=1').bind(owner.team_id).run();
    await worker.dispose(); worker = await start();
    identityDb = await worker.getD1Database('DB'); ownerDb = await worker.getD1Database(selected.binding);
    const reopened = await remove(); expect(reopened.status, await reopened.clone().text()).toBe(200);
    expect(await reopened.json()).toMatchObject({ status: 'replayed' });
    expect(await snapshot()).toEqual(saved);
    expect(await native.captureIsCurrent(capture)).toBe(true);
  } finally {
    await worker?.dispose(); await provision?.dispose(); await gateway?.close();
    await rm(persistence, { recursive: true, force: true });
  }
}, 240_000);
