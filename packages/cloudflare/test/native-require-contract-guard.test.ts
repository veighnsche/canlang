/** Actual CLI -> verified loader -> D1: lazy Contract guard authority stays separate from output. */
import { createCheckoutScratch } from '../src/dev/checkout-scratch.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const SOURCE = `app Intake
Given
 contract Input {title:text}
 Deal {value:int}
 Evidence {source:text unique,input:Input,deal:Deal}
 policy Deal read=members
 policy Evidence read=owner
 policy Evidence read=members fields=source,deal
When
 scenario promote(source:text,input:Input,gate:bool) -> Deal by=members
  do
   let existing=first(Evidence as evidence where evidence.source==source)
   if existing!=null
    require gate and existing.input==input
    return existing.deal
   create Deal {value=1} as deal
   create Evidence {source,input,deal} as evidence
   return deal
Then
`;

test('native selected Contract Require checks its executed field without tainting the independent result', async () => {
  const directory = await createCheckoutScratch(root, 'native-contract-guard-');
  let worker: Miniflare | undefined;
  try {
    const sourcePath = join(directory, 'intake.can'); await writeFile(sourcePath, SOURCE);
    const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
    const { captureSingleFileSource, captureIsCurrent } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
    const compilerPath = join(root, 'compiler/target/debug/can');
    const capture = await captureSingleFileSource({ checkoutRoot: root, appPath: sourcePath, compilerPath,
      profile: 'native-contract-guard', catalogPath: join(root, 'packages/values/dist/catalog.json'),
      helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
      ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
      semanticOptions: { nativeScenarioReceipts: 'true' } });
    assert.equal(await captureIsCurrent(capture), true);
    const compiled = await promisify(execFile)(compilerPath, ['compile', '--format=json', '--native-scenario-receipts',
      `--catalog=${join(root, 'packages/values/dist/catalog.json')}`, capture.compilerOperand], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const artifact: CompileArtifact = JSON.parse(compiled.stdout);
    assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(artifact.sources.map(({ path, sha256 }) => ({ path, sha256 })),
      [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
    const plan = artifact.operations?.find(operation => operation.name === 'Intake.promote')?.result?.disclosure;
    assert.ok(plan); assert.ok(plan.returns.every(returned => returned.dependencies.every(dependency => dependency.field !== 'input')));
    const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: { IDENTITY: 'guard-identity', OWNER: 'guard-owner' } });
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
    const now = Date.now(), clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    async function actor(name: string, owner: boolean) {
      const user = await identities.createUser({ email: `${name}@guard.example.test`, password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: owner, roles: [] });
      const token = `guard-${user.user_id}`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
        expires_at: new Date(now + 3600_000).toISOString() });
      return { user, membership, identity: await resolveIdentity(identities, { session_token: token }, { clock }) };
    }
    const owner = await actor('owner', true), member = await actor('member', false), store = createD1Storage(ownerDb);
    const invoker = buildInvoker(artifact, asm, store, { appId: 'Intake', memberships: identities, source: 'http', now: clock.nowMs });
    let sequence = 0;
    const call = (gate: boolean, title = 'reviewed'): MutationEnvelope => ({ operation: 'Intake.promote',
      operation_id: uuidv7(now, ++sequence), inputs: { source: 'review-1', input: { title }, gate } });
    const first = await invoker.invokeMutation(call(true), owner.identity);
    assert.ok('result' in first, JSON.stringify(first)); assert.equal(first.result.status, 'committed');
    const existingCall = call(true), existing = await invoker.invokeMutation(existingCall, owner.identity);
    assert.ok('result' in existing, JSON.stringify(existing)); assert.equal(existing.result.status, 'committed');
    assert.deepEqual(existing.result.result, first.result.result);
    const receipt = await store.readReceipt({ app: 'Intake', owner: team.team_id, principal: owner.user.user_id,
      operation: asOperation(existingCall.operation), operationId: asOperationId(existingCall.operation_id) });
    assert.ok(receipt); const saved = readScenarioReceiptAssociation(receipt); assert.ok(saved);
    assert.ok(saved.observations.every(observation => observation.field !== 'input'));
    assert.equal((await invoker.invokeMutation(existingCall, owner.identity) as typeof existing).result.status, 'replayed');
    for (const [who, gate, title, code] of [[member, false, 'reviewed', 'rule_failed'],
      [member, true, 'reviewed', 'forbidden'], [owner, true, 'changed', 'rule_failed']] as const) {
      const outcome = await invoker.invokeMutation(call(gate, title), who.identity);
      assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, code);
    }
    await actor('steward', true);
    await identities.setMembershipOwner(owner.membership.membership_id, false);
    const retained = await invoker.invokeMutation(existingCall, owner.identity);
    assert.ok('result' in retained, JSON.stringify(retained)); assert.equal(retained.result.status, 'replayed');
    assert.deepEqual(retained.result.result, existing.result.result);
    const revoked = await invoker.invokeMutation(call(true), owner.identity);
    assert.ok('error' in revoked, JSON.stringify(revoked)); assert.equal(revoked.error.code, 'forbidden');
    for (const model of ['Intake.Deal', 'Intake.Evidence']) {
      assert.equal((await store.query({ model: asModel(model), authority: 'owner' })).length, 1);
    }
    assert.equal(await captureIsCurrent(capture), true);
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 120000);
