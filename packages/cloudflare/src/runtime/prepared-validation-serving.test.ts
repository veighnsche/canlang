import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, DerivedOperationInputs } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asId, asModel, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import {
  buildSessionCookie, createD1IdentityStore, deriveCsrfToken, ensureIdentitySchema,
  sha256HexText,
} from '@canlang/identity';
import { catalogFromArtifactOperations, handleOperationRequest } from '@canlang/interfaces/http/operations';
import { handlePageRequest } from '@canlang/interfaces';
import type { HttpDeps, PageHttpDeps } from '@canlang/interfaces';
import { assembleModules } from './modules.js';
import { assembleWorker } from '../worker/assembly.js';

test('compiler native text bounds prepare HTTP CRUD and preserve receiving validation', async () => {
  const source = resolve('examples/Todo.can');
  const compiler = process.env['CAN_COMPILER_BIN'] ?? 'compiler/target/debug/can';
  const artifact = JSON.parse(execFileSync(compiler, [
    'compile', '--format=json', '--catalog=packages/values/dist/catalog.json', source,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-prepared-text-serving-'));
  let miniflare: Miniflare | undefined;
  try {
    const asm = await assembleModules({ artifact, sourcePath: source }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const definition = (await import(asm.entryUrl)).appDefinition as {
      models: Record<string, { fields: Record<string, { min?: bigint; max?: bigint }> }>;
    };
    assert.equal(definition.models['Todos.Todo']!.fields['title']!.min, 1n);
    assert.equal(definition.models['Todos.Todo']!.fields['title']!.max, 200n);
    miniflare = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'prepared-text-serving' }, d1Persist: join(dir, 'd1') });
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db);
    await ensureIdentitySchema(db);
    const store = createD1Storage(db), clock = { nowMs: () => FIXED_NOW };
    const identities = createD1IdentityStore(db, { clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'prepared-text@example.test',
      password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
      is_owner: false, roles: [] });
    const token = 'prepared-text-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const csrf = await deriveCsrfToken(token);
    const catalog = catalogFromArtifactOperations(artifact);
    const derivedInputs: Record<string, DerivedOperationInputs> = {};
    for (const operation of artifact.operations ?? []) {
      const derived = catalog.derivedFor(operation.name);
      assert.ok(derived);
      derivedInputs[operation.name] = derived;
    }
    const worker = await assembleWorker(artifact, asm, {
      store, identityStore: identities, now: clock.nowMs,
      http: { derivedInputs, createOperationHandler: deps => (request, operation) =>
        handleOperationRequest(deps as unknown as HttpDeps, request, operation),
        createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
    }, { active: true });
    let sequence = 0;
    const invoke = async (kind: string, inputs: Record<string, unknown>, authenticated = true) => {
      const operationId = uuidv7(FIXED_NOW, ++sequence);
      const response = await worker.fetch(new Request(`https://test.invalid/api/operations/Todos.Todo.${kind}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(authenticated ? { cookie, 'x-csrf-token': csrf } : {}) },
        body: JSON.stringify({ operation_id: operationId, inputs }),
      }));
      return { operationId, status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const model = asModel('Todos.Todo');
    // The source validation catalog prepares its Values schema before State
    // applies the existing trim, bool default and model field constraints.
    const created = await invoke('create', { title: '  Try Can  ' });
    assert.equal(created.status, 200, JSON.stringify(created));
    const id = asId(created.operationId);
    const row = await store.load(model, id);
    assert.ok(row);
    assert.deepEqual(row.data, { title: 'Try Can', done: false });
    assert.equal((await invoke('create', { title: 'x'.repeat(200) })).status, 200);
    for (const title of ['', '   ', 'x'.repeat(201)]) {
      const rejected = await invoke('create', { title });
      assert.equal(rejected.status, 400, JSON.stringify(rejected));
      assert.equal(rejected.body['code'], 'validation', JSON.stringify(rejected));
      assert.equal(await store.load(model, asId(rejected.operationId)), null);
    }
    const beforeUnauthorized = await store.readRevision();
    assert.equal((await invoke('create', { title: 'unauthorized' }, false)).status, 403);
    assert.equal(await store.readRevision(), beforeUnauthorized);

    const updated = await invoke('update', { record: { id, version: '1' }, title: '  Updated  ', done: true });
    assert.equal(updated.status, 200, JSON.stringify(updated));
    assert.deepEqual((await store.load(model, id))?.data, { title: 'Updated', done: true });
    const rejectedUpdate = await invoke('update', { record: { id, version: '2' }, title: '' });
    assert.equal(rejectedUpdate.status, 400, JSON.stringify(rejectedUpdate));
    assert.equal(rejectedUpdate.body['code'], 'validation', JSON.stringify(rejectedUpdate));
    assert.equal((await store.load(model, id))?.version, 2);
    const removed = await invoke('delete', { record: { id, version: '2' } });
    assert.equal(removed.status, 200, JSON.stringify(removed));
    assert.equal((await store.load(model, id))?.archivedAt, FIXED_NOW);
  } finally {
    await miniflare?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
