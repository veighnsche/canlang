/** Real emitted/installed HTTP serving association, using the existing
 * original typed-operation source and canonical State memory producer. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import type { CompileArtifact, DerivedOperationInputs } from '@canlang/contracts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const load = (specifier: string) => nodeImport(pathToFileURL(require.resolve(specifier)).href);
function operationId(): string {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

test('genuine installed HTTP plans preserve canonical defaults/errors and refuse copied/stale/mutated source before effects',
  { timeout: 120000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'can-serving-validation-'));
    try {
      const source = join(root, 'packages/cloudflare/test/fixtures/typed-operation-forms.can');
      const originalSource = await readFile(source);
      const compiler = join(root, 'compiler/target/debug/can');
      const artifact = JSON.parse(execFileSync(compiler, ['compile', '--format=json', source], { encoding: 'utf8' })) as CompileArtifact;
      const { assembleModules, importVerifiedAssemblyModule } = await load('@canlang/cloudflare/runtime/modules') as typeof import('../src/runtime/modules.js');
      const { assembleWorker } = await nodeImport(pathToFileURL(join(root, 'packages/cloudflare/dist/worker/assembly.js')).href) as typeof import('../src/worker/assembly.js');
      const { createPreparedValidationCatalog } = await nodeImport(pathToFileURL(join(root, 'packages/cloudflare/dist/runtime/prepared-validation.js')).href) as typeof import('../src/runtime/prepared-validation.js');
      const { catalogFromArtifactOperations, handleOperationRequest } = await load('@canlang/interfaces/http/operations') as typeof import('@canlang/interfaces/http/operations');
      const { handlePageRequest } = await load('@canlang/interfaces') as typeof import('@canlang/interfaces');
      const { createTestDeps, testRequest } = await load('@canlang/interfaces/testing') as typeof import('@canlang/interfaces/testing');
      const { createTestMemoryStorage } = await load('@canlang/state/storage/memory') as typeof import('@canlang/state/storage/memory');
      const { deriveCsrfToken, sha256HexText } = await load('@canlang/identity') as typeof import('@canlang/identity');
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(dir, 'modules'),
        stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
      const base = catalogFromArtifactOperations(artifact);
      await assert.rejects(() => createPreparedValidationCatalog(artifact, Object.freeze({ ...asm }), base, 'TypedOperationForms'), /not assembler-owned/);
      const changed = structuredClone(artifact); changed.sources[0]!.sha256 = '0'.repeat(64);
      await assert.rejects(() => createPreparedValidationCatalog(changed, asm, base, 'TypedOperationForms'), /differs from assembled source/);
      const deps = await createTestDeps();
      const session = await deps.deps.identity.store.findSessionByTokenHash(await sha256HexText(deps.identity.sessionToken));
      assert.ok(session);
      await deps.deps.identity.store.setSessionTeam(session.session_id, deps.identity.teamId);
      const csrf = await deriveCsrfToken(deps.identity.sessionToken);
      const store = createTestMemoryStorage().store;
      const derivedInputs = Object.fromEntries((artifact.operations ?? []).map(op => [op.name, base.derivedFor(op.name)!])) as Record<string, DerivedOperationInputs>;
      const worker = await assembleWorker(artifact, asm, { store, identityStore: deps.deps.identity.store,
        http: { derivedInputs, createPageHandler: http => request => handlePageRequest(http as Parameters<typeof handlePageRequest>[0], request),
          createOperationHandler: http => (request, operation) =>
          handleOperationRequest(http as Parameters<typeof handleOperationRequest>[0], request, operation) } }, { active: true });
      const request = (inputs: unknown, extraHeaders: Record<string, string> = {}) => testRequest('/api/operations/TypedOperationForms.Entry.create', {
        method: 'POST', cookie: deps.identity.cookie, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...extraHeaders },
        body: JSON.stringify({ operation_id: operationId(), inputs }),
      });
      const success = await worker.fetch(request({ label: 'owned body' }));
      assert.equal(success.status, 200, await success.clone().text());
      const result = await success.json() as { records: Array<{ data: Record<string, unknown> }> };
      assert.equal(result.records[0]!.data.label, 'owned body');
      assert.equal(result.records[0]!.data.count, '1', 'default remains canonical State admission, not HTTP manufacture');
      const revision = await store.readRevision();
      const namespace = await importVerifiedAssemblyModule(asm, artifact.callables.find(callable => callable.id === 'TypedOperationForms.Entry.create')!.module, artifact) as {
        appDefinition: { operations: Record<string, { kind: string; inputs: { fields?: string[]; record?: { type: string } } }>; models: Record<string, { fields: Record<string, { type: string; default?: unknown }> }> };
      };
      const count = namespace.appDefinition.models['TypedOperationForms.Entry']!.fields.count!;
      const originalType = count.type, originalDefault = count.default;
      for (const mutate of [() => { count.type = 'text'; }, () => { count.default = 2n; }]) {
        mutate();
        try {
          const mismatch = await worker.fetch(request({ label: 'must refuse initial metadata mismatch' }));
          assert.notEqual(mismatch.status, 200); assert.equal(await store.readRevision(), revision);
        } finally { count.type = originalType; count.default = originalDefault; }
      }
      const createInputs = namespace.appDefinition.operations['TypedOperationForms.Entry.create']!.inputs;
      const originalAllowlist = createInputs.fields!;
      try {
        createInputs.fields = [];
        const mismatch = await worker.fetch(request({ label: 'must refuse omitted source input census' }));
        assert.notEqual(mismatch.status, 200); assert.equal(await store.readRevision(), revision);
      } finally { createInputs.fields = originalAllowlist; }
      for (const [inputs, message] of [[{ unknown: 1, count: 'bad' }, 'Unknown input'], [{ count: 'bad' }, 'Missing required input'],
        [{ label: 'ok', count: 'bad' }, 'bind']] as const) {
        const denied = await worker.fetch(request(inputs));
        assert.equal(denied.status, 400); assert.match(await denied.text(), new RegExp(message));
        assert.equal(await store.readRevision(), revision);
      }
      const noCsrf = await worker.fetch(request({ label: 'csrf refused' }, { 'x-csrf-token': 'wrong' }));
      assert.equal(noCsrf.status, 403); assert.equal(await store.readRevision(), revision);
      const oversized = await worker.fetch(testRequest('/api/operations/TypedOperationForms.Entry.create', {
        method: 'POST', cookie: deps.identity.cookie, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: 'x'.repeat(1_048_577),
      }));
      assert.equal(oversized.status, 429); assert.equal(await store.readRevision(), revision);
      // Mutation after source-plan registration, during the existing final
      // credential read, must be observed before canonical invocation.
      const originalKind = namespace.appDefinition.operations['TypedOperationForms.Entry.create']!.kind;
      const findSession = deps.deps.identity.store.findSessionByTokenHash;
      let reads = 0;
      deps.deps.identity.store.findSessionByTokenHash = async hash => {
        const session = await findSession(hash);
        if (++reads === 2) namespace.appDefinition.operations['TypedOperationForms.Entry.create']!.kind = 'delete';
        return session;
      };
      try {
        const mutated = await worker.fetch(request({ label: 'must refuse after final await' }));
        assert.notEqual(mutated.status, 200); assert.equal(await store.readRevision(), revision);
        assert.equal(reads, 2);
      } finally {
        deps.deps.identity.store.findSessionByTokenHash = findSession;
        namespace.appDefinition.operations['TypedOperationForms.Entry.create']!.kind = originalKind;
      }
      const staged = fileURLToPath(asm.moduleUrls[artifact.callables.find(callable => callable.id === 'TypedOperationForms.Entry.create')!.module]!);
      const originalBytes = await readFile(staged);
      try {
        await writeFile(staged, Buffer.concat([originalBytes, Buffer.from('\n// stale closure\n')]));
        const stale = await worker.fetch(request({ label: 'must refuse stale code' }));
        assert.notEqual(stale.status, 200); assert.equal(await store.readRevision(), revision);
      } finally { await writeFile(staged, originalBytes); }
      assert.deepEqual(await readFile(source), originalSource);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test('installed serving refuses a stale derived catalog before any effect',
  { timeout: 120000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'can-serving-stale-catalog-'));
    try {
      const source = join(root, 'packages/cloudflare/test/fixtures/typed-operation-forms.can');
      const compiler = join(root, 'compiler/target/debug/can');
      const artifact = JSON.parse(execFileSync(compiler, ['compile', '--format=json', source], { encoding: 'utf8' })) as CompileArtifact;
      const { assembleModules } = await load('@canlang/cloudflare/runtime/modules') as typeof import('../src/runtime/modules.js');
      const { assembleWorker } = await nodeImport(pathToFileURL(join(root, 'packages/cloudflare/dist/worker/assembly.js')).href) as typeof import('../src/worker/assembly.js');
      const { catalogFromArtifactOperations, handleOperationRequest } = await load('@canlang/interfaces/http/operations') as typeof import('@canlang/interfaces/http/operations');
      const { handlePageRequest } = await load('@canlang/interfaces') as typeof import('@canlang/interfaces');
      const { createTestDeps, testRequest } = await load('@canlang/interfaces/testing') as typeof import('@canlang/interfaces/testing');
      const { createTestMemoryStorage } = await load('@canlang/state/storage/memory') as typeof import('@canlang/state/storage/memory');
      const { deriveCsrfToken, sha256HexText } = await load('@canlang/identity') as typeof import('@canlang/identity');
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(dir, 'modules'),
        stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
      const base = catalogFromArtifactOperations(artifact);
      const deps = await createTestDeps();
      const session = await deps.deps.identity.store.findSessionByTokenHash(await sha256HexText(deps.identity.sessionToken));
      assert.ok(session);
      await deps.deps.identity.store.setSessionTeam(session.session_id, deps.identity.teamId);
      const csrf = await deriveCsrfToken(deps.identity.sessionToken);
      const store = createTestMemoryStorage().store;
      // Shape-valid but stale: flipping one derived required flag keeps the
      // baked-inputs shape check green while breaking equality with the
      // checked owning operation, so the prepared loader must refuse.
      const stale = Object.fromEntries((artifact.operations ?? []).map(op => [op.name, base.derivedFor(op.name)!])) as Record<string, DerivedOperationInputs>;
      const first = (stale['TypedOperationForms.Entry.create']!.inputs as Array<{ required: boolean }>)[0]!;
      first.required = !first.required;
      const worker = await assembleWorker(artifact, asm, { store, identityStore: deps.deps.identity.store,
        http: { derivedInputs: stale, createPageHandler: http => request => handlePageRequest(http as Parameters<typeof handlePageRequest>[0], request),
          createOperationHandler: http => (request, operation) =>
          handleOperationRequest(http as Parameters<typeof handleOperationRequest>[0], request, operation) } }, { active: true });
      const before = await store.readRevision();
      const refused = await worker.fetch(testRequest('/api/operations/TypedOperationForms.Entry.create', {
        method: 'POST', cookie: deps.identity.cookie, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ operation_id: operationId(), inputs: { label: 'must refuse stale catalog' } }),
      }));
      assert.notEqual(refused.status, 200);
      assert.equal(await store.readRevision(), before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
