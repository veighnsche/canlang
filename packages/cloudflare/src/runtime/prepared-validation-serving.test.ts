import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
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
      assert.equal(((rejected.body['error'] ?? rejected.body) as Record<string, unknown>)['code'], 'validation', JSON.stringify(rejected));
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
    assert.equal(((rejectedUpdate.body['error'] ?? rejectedUpdate.body) as Record<string, unknown>)['code'], 'validation', JSON.stringify(rejectedUpdate));
    assert.equal((await store.load(model, id))?.version, 2);
    const removed = await invoke('delete', { record: { id, version: '2' } });
    assert.equal(removed.status, 200, JSON.stringify(removed));
    assert.equal((await store.load(model, id))?.archivedAt, FIXED_NOW);
  } finally {
    await miniflare?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});


test('native HTTP preparation preserves nullable model defaults and strict user input wrappers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-prepared-model-wrappers-'));
  try {
    const source = join(dir, 'ModelWrappers.can');
    await writeFile(source, `app ModelWrappers
Given
 Container {name:text}
 Other {name:text}
 Item in Container {name:text,optional_owner:user?=null,recorded_at:datetime?=null,watchers:user[]=[],required_owner:user}
 policy Container read=members
 policy Other read=members
 policy Item read=members
When
 crud Container by=members fields=name
 crud Other by=members fields=name
 crud Item by=members fields=name,optional_owner,recorded_at,watchers,required_owner
Then
`);
    const artifact = JSON.parse(execFileSync(process.env['CAN_COMPILER_BIN'] ?? 'compiler/target/debug/can',
      ['compile', '--format=json', '--catalog=packages/values/dist/catalog.json', source],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const clock = { nowMs: () => FIXED_NOW }, identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'model-wrappers@test.invalid', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = 'model-wrapper-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!, csrf = await deriveCsrfToken(token);
    const { store } = createTestMemoryStorage(), catalog = catalogFromArtifactOperations(artifact);
    const derivedInputs = Object.fromEntries(artifact.operations!.map(operation => [operation.name, catalog.derivedFor(operation.name)!]));
    const worker = await assembleWorker(artifact, asm, { store, identityStore: identities, now: clock.nowMs,
      http: { derivedInputs, createOperationHandler: deps => (request, operation) =>
        handleOperationRequest(deps as unknown as HttpDeps, request, operation) } }, { active: true });
    let sequence = 0;
    let parent: string | undefined;
    const post = async (inputs: Record<string, unknown>, operation = 'Item') => {
      const operationId = uuidv7(FIXED_NOW, ++sequence);
      const response = await worker.fetch(new Request(`https://test.invalid/api/operations/ModelWrappers.${operation}.create`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ operation_id: operationId, inputs: {
          ...(operation === 'Item' && parent !== undefined ? { parent: { id: parent } } : {}), ...inputs } }),
      }));
      return { id: asId(operationId), status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const container = await post({ name: 'Container' }, 'Container');
    assert.equal(container.status, 200, JSON.stringify(container.body));
    parent = container.id;
    const other = await post({ name: 'Other' }, 'Other');
    assert.equal(other.status, 200, JSON.stringify(other.body));
    const first = await post({ name: 'Defaults', required_owner: { id: user.user_id } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual((await store.load(asModel('ModelWrappers.Item'), first.id))?.data,
      { name: 'Defaults', optional_owner: null, recorded_at: null, watchers: [], required_owner: { id: user.user_id } });
    assert.deepEqual((await store.load(asModel('ModelWrappers.Item'), first.id))?.parent,
      { model: 'ModelWrappers.Container', id: parent });
    const second = await post({ name: 'Explicit', required_owner: { id: user.user_id }, optional_owner: { id: user.user_id },
      recorded_at: '2026-10-15T00:00:00.000Z', watchers: [{ id: user.user_id }] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    for (const invalid of [{ required_owner: null }, { required_owner: { id: 17 } }, { optional_owner: { id: 17 } }, { watchers: null }]) {
      const rejected = await post({ name: 'Invalid', required_owner: { id: user.user_id }, ...invalid });
      assert.equal(rejected.body['code'], 'validation', JSON.stringify(rejected));
      assert.equal(await store.load(asModel('ModelWrappers.Item'), rejected.id), null);
    }
    for (const invalidParent of [undefined, null, { id: other.id }, { id: parent, version: '999' }, { id: 17 }]) {
      const rejected = await post({ name: 'Invalid parent', required_owner: { id: user.user_id }, parent: invalidParent });
      assert.ok(rejected.status >= 400, JSON.stringify(rejected));
      assert.equal(await store.load(asModel('ModelWrappers.Item'), rejected.id), null);
    }
    const callable = artifact.callables.find(value => value.id === 'ModelWrappers.Item.create');
    assert.ok(callable);
    const declaration = await importVerifiedAssemblyModule(asm, callable.module, artifact) as {
      appDefinition: { models: Record<string, { parent?: string }>;
        operations: Record<string, { inputs: { fields: string[] } }> };
    };
    const item = declaration.appDefinition.models['ModelWrappers.Item']!;
    const writable = declaration.appDefinition.operations['ModelWrappers.Item.create']!.inputs.fields;
    const revision = await store.readRevision();
    for (const wrongParent of [undefined, 'ModelWrappers.Other']) {
      if (wrongParent === undefined) delete item.parent;
      else item.parent = wrongParent;
      const rejected = await post({ name: 'Changed containment', required_owner: { id: user.user_id } });
      assert.equal(rejected.status, 422, JSON.stringify(rejected));
      assert.equal(await store.readRevision(), revision);
    }
    item.parent = 'ModelWrappers.Container';
    writable.push('parent');
    const extra = await post({ name: 'Changed writable census', required_owner: { id: user.user_id } });
    assert.equal(extra.status, 422, JSON.stringify(extra));
    assert.equal(await store.readRevision(), revision);
    writable.pop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
