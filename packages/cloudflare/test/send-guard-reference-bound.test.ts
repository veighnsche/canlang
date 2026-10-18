/** SEND guard reference traversal refuses past its finite hop bound.
 *
 * A 40-deep `?.peer` guard chain over a 34-node linear chain must refuse
 * with the defining-bound validation once traversal passes 32 hops, and
 * a short chain over the same fixture must still resolve (no false
 * positive). A 40-hop chain over a two-node cycle (A->B->A, Set
 * cardinality stuck at 2) must also refuse by counted hops, and a short
 * 3-hop chain over the same cycle must still commit: repeated identities
 * within the bound stay admitted. The original Maintain retry covers the
 * larger diamond positive.
 */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import type { CompileArtifact, MutationEnvelope, ProjectedRecord, ResolvedIdentity } from '@canlang/contracts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'SendGuardReferenceBound';
const FIXTURE = 'compiler/tests/fixtures/send-guard-reference-bound.can';
const ORIGINAL_SHA256 = '9f4f9093f71a8cc8fa001fc6b854bf44bdc09f32bc4851c83b0b170f10e1d392';
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('SEND guard reference traversal refuses past its finite hop bound', { timeout: 180000 }, async () => {
  const directory = await createCheckoutScratch(root, 'send-guard-bound-');
  try {
    const require = createRequire(import.meta.url);
    const { distribution } = await nodeImport(pathToFileURL(require.resolve('@canlang/values/distribution')).href) as typeof import('@canlang/values/distribution');
    const { createMemoryIdentityStore, createFrozenClock } = await nodeImport(pathToFileURL(require.resolve('@canlang/identity/testing')).href) as typeof import('@canlang/identity/testing');
    const { issueMcpGrant, resolveIdentity } = await nodeImport(pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
    const { createMemoryStorage } = await nodeImport(pathToFileURL(require.resolve('@canlang/state/storage/memory')).href) as typeof import('@canlang/state/storage/memory');
    const { asModel, uuidv7 } = await nodeImport(pathToFileURL(require.resolve('@canlang/state/testing/invocation/fixtures')).href) as typeof import('@canlang/state/testing/invocation/fixtures');
    const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const original = await readFile(join(root, FIXTURE));
    assert.equal(hash(original), ORIGINAL_SHA256);
    const env = { ...process.env };
    delete env.CAN_CATALOG;
    const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', fileURLToPath(distribution.catalog), join(root, FIXTURE)],
      { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.deepEqual(artifact.diagnostics ?? [], []);
    const asm = await assembleModules({ artifact, sourcePath: join(root, FIXTURE) }, {
      workDir: join(directory, 'modules'),
      stdlibUrl: installed('runtime/stdlib.js'),
      uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href,
    });
    const clock = createFrozenClock(Date.now()), identities = createMemoryIdentityStore({ clock }), store = createMemoryStorage();
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'bound@source.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: false, roles: [] });
    const grant = await issueMcpGrant(identities, { user_id: user.user_id, team_id: team.team_id, client_id: 'bound' }, { clock });
    const identity = await resolveIdentity(identities, { mcp_grant_token: grant.token }, { clock }) as ResolvedIdentity;
    const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, now: clock.nowMs });
    let sequence = 0;
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope =>
      ({ operation, operation_id: uuidv7(clock.nowMs(), ++sequence), inputs });
    const recordOf = (result: unknown): ProjectedRecord => {
      assert.ok(result !== null && typeof result === 'object' && 'result' in result, JSON.stringify(result));
      const records = (result as { result: { records?: ProjectedRecord[] } }).result.records;
      assert.ok(records !== undefined && records.length === 1);
      return records[0]!;
    };
    // Long linear chain: 34 nodes, tail peer defaults to null.
    let tail = recordOf(await invoker.invokeMutation(envelope(`${APP}.seed`, { name: 'n34' }), identity));
    for (let depth = 33; depth >= 1; depth -= 1) {
      tail = recordOf(await invoker.invokeMutation(envelope(`${APP}.link`, { name: `n${depth}`, peer: { id: tail.id, version: String(tail.version) } }), identity));
    }
    const leaf = tail;
    const deep = await invoker.invokeMutation(
      envelope(`${APP}.probe`, { node: { id: leaf.id, version: String(leaf.version) } }), identity);
    assert.ok(deep !== null && typeof deep === 'object' && 'error' in deep, JSON.stringify(deep));
    const failure = (deep as { error: { code: string; message: string } }).error;
    assert.equal(failure.code, 'validation');
    assert.match(failure.message, /SEND reference path exceeds its defining bound/);
    // Short chain over the same fixture resolves without tripping the bound.
    let stub = recordOf(await invoker.invokeMutation(envelope(`${APP}.seed`, { name: 's3' }), identity));
    stub = recordOf(await invoker.invokeMutation(envelope(`${APP}.link`, { name: 's2', peer: { id: stub.id, version: String(stub.version) } }), identity));
    stub = recordOf(await invoker.invokeMutation(envelope(`${APP}.link`, { name: 's1', peer: { id: stub.id, version: String(stub.version) } }), identity));
    const shallow = await invoker.invokeMutation(
      envelope(`${APP}.probe`, { node: { id: stub.id, version: String(stub.version) } }), identity);
    assert.ok(shallow !== null && typeof shallow === 'object' && 'result' in shallow, JSON.stringify(shallow));
    assert.equal((shallow as { result: { status: string } }).result.status, 'committed');
    // Two-node cycle A->B->A: Set cardinality sticks at 2, so only the
    // counted hop bound may refuse the 40-hop chain. The refusal must
    // stage no send: the outbox stays empty.
    const fresh = async (id: string) => {
      const rows = await store.query({ model: asModel(`${APP}.Node`), authority: 'owner',
        archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
      const row = rows.find(candidate => candidate.id === id);
      assert.ok(row, id);
      return { id: row.id, version: String(row.version) };
    };
    const cycleA = recordOf(await invoker.invokeMutation(envelope(`${APP}.seed`, { name: 'cA' }), identity));
    const cycleB = recordOf(await invoker.invokeMutation(
      envelope(`${APP}.link`, { name: 'cB', peer: { id: cycleA.id, version: String(cycleA.version) } }), identity));
    const relinked = await invoker.invokeMutation(envelope(`${APP}.relink`,
      { node: await fresh(cycleA.id), peer: await fresh(cycleB.id) }), identity);
    assert.ok(relinked !== null && typeof relinked === 'object' && 'result' in relinked, JSON.stringify(relinked));
    const pendingBefore = (await store.outboxPending()).map(intent => intent.intentId);
    const cyclic = await invoker.invokeMutation(
      envelope(`${APP}.probe`, { node: await fresh(cycleA.id) }), identity);
    assert.ok(cyclic !== null && typeof cyclic === 'object' && 'error' in cyclic, JSON.stringify(cyclic));
    const cyclicFailure = (cyclic as { error: { code: string; message: string } }).error;
    assert.equal(cyclicFailure.code, 'validation');
    assert.match(cyclicFailure.message, /SEND reference path exceeds its defining bound/);
    assert.deepEqual((await store.outboxPending()).map(intent => intent.intentId), pendingBefore);
    // Short 3-hop `==null` chain over the same cycle revisits A within the
    // bound (A->B->A->B, guard false so no send stages) and must still
    // commit: repeated identities stay admitted.
    const diamond = await invoker.invokeMutation(
      envelope(`${APP}.probe2`, { node: await fresh(cycleA.id) }), identity);
    assert.ok(diamond !== null && typeof diamond === 'object' && 'result' in diamond, JSON.stringify(diamond));
    assert.equal((diamond as { result: { status: string } }).result.status, 'committed');
    assert.deepEqual((await store.outboxPending()).map(intent => intent.intentId), pendingBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
