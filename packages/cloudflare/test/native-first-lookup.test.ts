/** Original scalar-input first lookup -> captured CLI -> verified module -> real D1/Identity. */
import { createCheckoutScratch } from '../src/dev/checkout-scratch.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, CompileArtifact, MutationEnvelope, ReceiptIdentity, StoragePort, StoredRow } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { hashInputs } from '@canlang/state/invocation/replay';
import { asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const APP = 'LookupSources', ITEM = asModel(`${APP}.Item`), RUN = asModel(`${APP}.Run`);
const fixtureSourcePath = join(root, 'packages/cloudflare/test/fixtures/native-first-lookup.can');
type Tables = Record<string, Array<Record<string, unknown>>>;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(database: D1Database): Promise<Tables> {
  const names = await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name")
    .all<{ name: string }>();
  assert.equal(names.success, true);
  const result: Tables = {};
  for (const { name } of names.results) {
    const rows = await database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  const wire = object(outcome.result.result);
  assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
  return { outcome: outcome.result, id: wire.id as string };
}
const byCreatedId = (left: StoredRow, right: StoredRow) => left.created - right.created ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

for (const spelling of ['inline', 'helper', 'chain'] as const) test(`native ${spelling} first retains the authorized full domain, default ordering, atomic failure and current-authority replay`,
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-lookup-'));
    const sourceDirectory = spelling === 'inline' ? undefined : await createCheckoutScratch(root, 'native-first-helper-');
    const sourcePath = sourceDirectory === undefined ? fixtureSourcePath : join(sourceDirectory, 'helper.can');
    if (spelling !== 'inline') {
      const original = await readFile(fixtureSourcePath, 'utf8');
      const helpers = spelling === 'helper' ? ' derive approved(record:Item):bool = record.approved\n' :
        ' derive approved_leaf(record:Item,enabled:bool=(true)):bool = not enabled or record.approved\n' +
        ' derive approved(record:Item,enabled:bool=(true)):bool = approved_leaf(enabled=enabled,record=record)\n' +
        ' derive ignored(record:Item,probe:bool=record.approved):bool = true\n';
      const call = spelling === 'helper' ? 'approved(record=chosen)' : 'approved(record=((chosen)))';
      let equivalent = original.replace(' policy Run read=members', helpers + ' policy Run read=members')
        .replaceAll('require chosen!=null and chosen.approved', `require chosen!=null and ${call}`);
      assert.equal(equivalent.split(call).length - 1, 2);
      if (spelling === 'chain') equivalent = equivalent.replace('Then\n',
        ' scenario eager_unused(source:text) -> bool by=members\n  do\n' +
        '   let chosen=first(Item as candidate where candidate.source==source)\n' +
        '   require chosen!=null and ignored(record=chosen)\n   return true\n' +
        ' scenario explicit_default(source:text) -> bool by=members\n  do\n' +
        '   let chosen=first(Item as candidate where candidate.source==source)\n' +
        '   require chosen!=null and ignored(record=chosen,probe=true)\n   return true\nThen\n');
      assert.deepEqual(equivalent.split('\n').filter(line => line.trim().startsWith('policy ')),
        original.split('\n').filter(line => line.trim().startsWith('policy ')));
      await writeFile(sourcePath, equivalent);
    }
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/dev/source-capture.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
      const originalSource = await readFile(sourcePath);
      const compilerPath = join(root, 'compiler/target/debug/can');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: sourcePath,
        profile: 'native-first-lookup', compilerPath, catalogPath: join(root, 'packages/cloudflare/dist/native-catalog.json'),
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Original lookup source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      const operation = artifact.operations?.find(operation => operation.name === `${APP}.lookup`); assert.ok(operation);
      assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, RUN);
      const plan = operation.result!.disclosure; assert.ok(plan);
      const [query] = plan.queries ?? []; assert.ok(query);
      assert.equal(query.model, ITEM); assert.deepEqual(query.order, []); assert.equal(query.limit, null);
      assert.equal(query.archived, 'exclude'); assert.equal(query.dependencies.length, 1);
      assert.equal(query.dependencies[0]!.role, 'control'); assert.equal(query.dependencies[0]!.field, 'source');
      assert.equal(query.dependencies[0]!.type, 'text');
      assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
      const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const callable = artifact.callables.find(callable => callable.id === operation.name); assert.ok(callable);
      const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated);
      assert.match(generated.js, /await firstQuery\(c,/);
      assert.match(generated.js, /await executeScenarioReceiptQuery\(c,/);
      assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
      const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
      assert.equal(namespace[callable.export], operation.name);
      const definition = object(namespace.appDefinition); assert.equal(definition.id, APP);
      assert.equal(object(object(definition.operations)[operation.name]).handler, operation.name);
      const moduleBytes = await Promise.all(artifact.modules.map(async module => {
        const path = fileURLToPath(asm.moduleUrls[module.path]!); return { path, bytes: await readFile(path) };
      }));

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-lookup-identity', OWNER: 'first-lookup-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-lookup-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-lookup-member@example.test'), colleague = await actor('first-lookup-other@example.test');
      const underlying = createD1Storage(ownerDb), batches: CommitBatch[] = [];
      const store: StoragePort = { ...underlying, async commit(batch) {
        const result = await underlying.commit(batch); batches.push(batch); return result;
      } };
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const resources = async () => ({ identity: await snapshot(identityDb), owner: await snapshot(ownerDb) });
      let sequence = 0;
      const envelope = (name: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: name.includes('.') ? name : `${APP}.${name}`, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const receiptIdentity = (input: MutationEnvelope): ReceiptIdentity => ({ app: APP, owner: team.team_id,
        principal: member.membership.user_id, operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) });
      const lookup = (source: string, accept = true) => envelope('lookup', { source, accept });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, member.identity);
      const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
      async function rejectedWithoutEffects(input: MutationEnvelope) {
        const before = await resources(), revision = await store.readRevision(), count = batches.length;
        const outcome = await invoke(input); assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt);
        assert.equal(receipt.outcome.status, 'rejected'); assert.equal(receipt.committedRevision, revision + 1);
        assert.equal(Object.hasOwn(receipt.outcome, 'scenario'), false, 'failed branches never retain a successful model/query result');
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(after.owner[table], before.owner[table], table);
        }
        for (const batch of batches.slice(count)) {
          assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
          assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
        }
        const replay = await invoke(input); assert.ok('error' in replay); assert.equal(replay.error.code, 'rule_failed');
        await unchanged(after);
      }
      async function createItem(subject: typeof member, source: string, created: number, active = true): Promise<StoredRow> {
        now = created;
        const input = envelope(`${ITEM}.create`, { account: { id: subject.membership.user_id }, source, active });
        const outcome = await invoker.invokeMutation(input, subject.identity); assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed'); assert.equal(outcome.result.records?.length, 1);
        const projected = object(outcome.result.records![0]); assert.equal(typeof projected.id, 'string');
        const row = await store.load(ITEM, asId(projected.id as string)); assert.ok(row);
        assert.equal(row.created, created); assert.equal(row.createdBy, subject.membership.user_id);
        assert.deepEqual(row.data, { account: { id: subject.membership.user_id }, source, active, approved: true });
        assert.equal((await store.historyFor(ITEM, row.id)).length, 1); return row;
      }

      await rejectedWithoutEffects(lookup('wanted')); // genuine empty -> null before any candidate exists
      const hidden = await createItem(colleague, 'wanted', baseTime + 1);
      await rejectedWithoutEffects(lookup('wanted')); // policy-hidden row supplies neither null replacement nor a false candidate
      const earlierFalse = await createItem(member, 'unrelated', baseTime + 10);
      await rejectedWithoutEffects(lookup('wanted')); // genuine all-false authorized domain -> null
      const inactive = await createItem(member, 'inactive', baseTime + 15, false);
      await rejectedWithoutEffects(lookup('inactive')); // genuine selected row fails its active guard before create
      const later = await createItem(member, 'wanted', baseTime + 30);
      const tieOne = await createItem(member, 'wanted', baseTime + 20);
      const tieTwo = await createItem(member, 'wanted', baseTime + 20);
      const matched = [later, tieOne, tieTwo].sort(byCreatedId), expected = matched[0]!;
      assert.equal(tieOne.created, tieTwo.created); assert.equal(matched.at(-1)!.id, later.id);
      assert.equal(expected.id, [tieOne, tieTwo].sort((a, b) => a.id < b.id ? -1 : 1)[0]!.id);
      now = baseTime + 40;
      await rejectedWithoutEffects(lookup('wanted', false)); // authentic create is staged, then the late guard rolls it back
      assert.deepEqual(await store.query({ model: RUN, authority: 'owner' }), []);
      const independentDefinition = object(object(definition.operations)[`${APP}.lookup_scalar`]);
      const firstMetadata = (independentDefinition.queryFirst as Array<Record<string, unknown>>)[0]!;
      for (const key of ['queryId', 'query', 'node', 'statement'] as const) {
        const previous = firstMetadata[key];
        firstMetadata[key] = key === 'queryId' ? 'foreign-query' : { ...object(previous), start: Number(object(previous).start) + 1 };
        const before = await resources(), batchCount = batches.length;
        const malformed = envelope('lookup_scalar', { source: 'wanted', accept: true });
        let refused: unknown;
        try {
          const fresh = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
          const outcome = await fresh.invokeMutation(malformed, member.identity);
          if ('error' in outcome) refused = outcome.error;
        } catch (error) { refused = error; }
        finally { firstMetadata[key] = previous; }
        assert.ok(refused, `substituted ${key} must refuse`);
        assert.match(String(object(refused).message), /[Ff]irst|checked Let/);
        if (key === 'node' || key === 'statement') {
          const rejected = await store.readReceipt(receiptIdentity(malformed)); assert.ok(rejected);
          assert.equal(rejected.outcome.status, 'rejected');
          assert.equal(object(rejected.outcome).code, 'validation');
          assert.match(String(object(rejected.outcome).message), /first consumer differs/);
          const after = await resources(); assert.deepEqual(after.identity, before.identity);
          for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
            assert.deepEqual(after.owner[table], before.owner[table], table);
          }
          for (const batch of batches.slice(batchCount)) {
            assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
            assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
          }
        } else await unchanged(before);
      }

      const independentResults: Array<{ input: MutationEnvelope; value: boolean | null }> = [];
      // These original-profile variants consume first without disclosing its
      // row/query. They use the same captured CLI/verified module/D1 owners.
      for (const [operation, expectedValue] of [['lookup_scalar', true], ['lookup_void', null]] as const) {
        const independent = envelope(operation, { source: 'wanted', accept: true });
        independentResults.push({ input: independent, value: expectedValue });
        const before = await resources();
        const outcome = await invoke(independent); assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed'); assert.equal(outcome.result.result, expectedValue);
        const receipt = await store.readReceipt(receiptIdentity(independent)); assert.ok(receipt);
        const saved = readScenarioReceiptAssociation(receipt); assert.ok(saved);
        assert.equal(saved.queries, undefined); assert.deepEqual(saved.observations, []);
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        assert.deepEqual(after.owner.records, before.owner.records); assert.deepEqual(after.owner.history, before.owner.history);
        const replay = await invoke(independent); assert.ok('result' in replay); assert.equal(replay.result.status, 'replayed');
        assert.equal(replay.result.result, expectedValue); await unchanged(after);
        await rejectedWithoutEffects(envelope(operation, { source: 'wanted', accept: false }));
        await rejectedWithoutEffects(envelope(operation, { source: 'absent', accept: true }));
        // The business value is true, but its current field grant is absent
        // for this inactive selected row. The Require must fail at the read.
        const denied = envelope(operation, { source: 'inactive', accept: true });
        const beforeDenied = await resources();
        const hidden = await invoke(denied); assert.ok('error' in hidden, JSON.stringify(hidden));
        assert.equal(hidden.error.code, 'forbidden', JSON.stringify(hidden));
        const afterDenied = await resources(); assert.deepEqual(afterDenied.identity, beforeDenied.identity);
        for (const table of Object.keys(beforeDenied.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(afterDenied.owner[table], beforeDenied.owner[table], table);
        }

      }
      if (spelling === 'chain') {
        const beforeEager = await resources();
        const eager = await invoke(envelope(`${APP}.eager_unused`, { source: 'inactive' }));
        assert.ok('error' in eager, JSON.stringify(eager)); assert.equal(eager.error.code, 'forbidden');
        const afterEager = await resources(); assert.deepEqual(afterEager.identity, beforeEager.identity);
        for (const table of Object.keys(beforeEager.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(afterEager.owner[table], beforeEager.owner[table], table);
        }
        const explicitInput = envelope(`${APP}.explicit_default`, { source: 'inactive' });
        const explicit = await invoke(explicitInput); assert.ok('result' in explicit, JSON.stringify(explicit));
        assert.equal(explicit.result.status, 'committed'); assert.equal(explicit.result.result, true);
        const receipt = await store.readReceipt(receiptIdentity(explicitInput)); assert.ok(receipt);
        const saved = readScenarioReceiptAssociation(receipt); assert.ok(saved);
        assert.deepEqual(saved.observations, []); assert.equal(saved.queries, undefined);
        const afterExplicit = await resources();
        for (const table of Object.keys(afterEager.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(afterExplicit.owner[table], afterEager.owner[table], table);
        }
      }
      const input = lookup('wanted'), before = await resources(), revision = await store.readRevision(), count = batches.length;
      const result = committed(await invoke(input));
      assert.equal(batches.length, count + 1); const batch = batches.at(-1)!;
      assert.equal(batch.expectedRevision, revision); assert.equal(batch.writes.length, 1);
      assert.equal(batch.writes[0]!.kind, 'insert'); assert.equal(batch.writes[0]!.model, RUN);
      assert.equal(batch.history.length, 1); assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
      const row = await store.load(RUN, asId(result.id)); assert.ok(row); assert.deepEqual(row.data, { item: { id: expected.id } });
      assert.equal(batch.history[0]!.recordId, row.id); assert.equal(batch.history[0]!.operation, `${APP}.lookup`);
      const physical = await store.readReceipt(receiptIdentity(input)); assert.ok(physical);
      assert.equal(physical.inputHash, await hashInputs(input.inputs));
      const association = readScenarioReceiptAssociation(physical); assert.ok(association);
      assert.deepEqual(association.plan, plan); assert.deepEqual(association.changed.map(change => [change.model, change.row.id]), [[RUN, row.id]]);
      const [saved] = association.queries ?? []; assert.ok(saved);
      assert.equal(saved.queryId, query.id); assert.equal(saved.revision, revision);
      const authorized = [earlierFalse, inactive, later, tieOne, tieTwo];
      assert.deepEqual(saved.candidates.map(candidate => candidate.row.id).sort(), authorized.map(row => row.id).sort());
      assert.equal(saved.candidates.some(candidate => candidate.row.id === hidden.id), false);
      for (const candidate of saved.candidates) {
        const original = authorized.find(row => row.id === candidate.row.id); assert.ok(original);
        assert.deepEqual(candidate.row, original); assert.equal(candidate.matched, original.data.source === 'wanted');
        assert.deepEqual(candidate.dependencies, [query.dependencies[0]!.id]);
      }
      assert.deepEqual(saved.selectedIndices.map(index => saved.candidates[index]!.row.id), matched.map(row => row.id), 'save every ordered match, never first as a limit');
      assert.equal(saved.candidates.find(candidate => candidate.row.id === earlierFalse.id)!.matched, false);
      const after = await resources(); assert.deepEqual(after.identity, before.identity);
      assert.equal(after.owner.records!.length, before.owner.records!.length + 1);
      assert.equal(after.owner.history!.length, before.owner.history!.length + 1);
      assert.equal((await store.query({ model: ITEM, authority: 'owner' })).length, authorized.length + 1);
      for (const dedicated of [false, true]) {
        const replay = committed(await (dedicated ? invoker.invokeRetainedMutation(input, member.identity) : invoke(input)), 'replayed');
        assert.equal(replay.id, row.id); assert.deepEqual(replay.outcome.records, result.outcome.records);
        await unchanged(after); assert.equal(batches.length, count + 1);
        assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);
      }

      // Revoke only the selected Item's source grant through ordinary CRUD.
      // The Run remains readable, so the query source observation must withhold the result.
      const changeAccount = async (account: string) => {
        const current = await store.load(ITEM, expected.id); assert.ok(current);
        const updated = await invoker.invokeMutation(envelope(`${ITEM}.update`, {
          record: { id: current.id, version: String(current.version) }, account: { id: account },
        }), colleague.identity);
        assert.ok('result' in updated, JSON.stringify(updated)); assert.equal(updated.result.status, 'committed');
      };
      await changeAccount(colleague.membership.user_id);
      const sourceRevoked = await resources(), revokedCount = batches.length;
      const sourceHidden = await invoke(input); assert.ok('result' in sourceHidden); assert.equal(sourceHidden.result.status, 'replayed');
      assert.equal(sourceHidden.result.result, null); assert.deepEqual(sourceHidden.result.records, []);
      await unchanged(sourceRevoked); assert.equal(batches.length, revokedCount);
      await changeAccount(member.membership.user_id);
      const sourceRestored = await resources();
      assert.equal(committed(await invoke(input), 'replayed').id, row.id); await unchanged(sourceRestored);
      await identities.removeMembership(member.membership.membership_id);
      const membershipRevoked = await resources(), membershipCount = batches.length;
      const withheld = await invoke(input); assert.ok('result' in withheld); assert.equal(withheld.result.status, 'replayed');
      assert.equal(withheld.result.result, null); assert.deepEqual(withheld.result.records, []);
      const retainedDenied = await invoker.invokeRetainedMutation(input, member.identity);
      assert.ok('error' in retainedDenied); assert.equal(retainedDenied.error.code, 'forbidden');
      await unchanged(membershipRevoked); assert.equal(batches.length, membershipCount);
      await identities.reactivateMembership(member.membership.membership_id, { is_owner: false, roles: [] });
      const restored = await member.current(), restoredResources = await resources();
      assert.equal(committed(await invoker.invokeRetainedMutation(input, restored), 'replayed').id, row.id);
      await unchanged(restoredResources); assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);
      // A later ordinary update revokes only the selected scalar field grant.
      // Fresh execution must recheck it, while earlier scalar results stay independent.
      const setActive = async (active: boolean) => {
        const current = await store.load(ITEM, expected.id); assert.ok(current);
        const updated = await invoker.invokeMutation(envelope(`${ITEM}.update`, {
          record: { id: current.id, version: String(current.version) }, active,
        }), colleague.identity);
        assert.ok('result' in updated, JSON.stringify(updated)); assert.equal(updated.result.status, 'committed');
      };
      await setActive(false);
      for (const operation of [`${APP}.lookup_scalar`, `${APP}.lookup_void`]) {
        const beforeDenied = await resources();
        const denied = await invoke(envelope(operation, { source: 'wanted', accept: true }));
        assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, 'forbidden');
        const afterDenied = await resources(); assert.deepEqual(afterDenied.identity, beforeDenied.identity);
        for (const table of Object.keys(beforeDenied.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(afterDenied.owner[table], beforeDenied.owner[table], table);
        }
      }
      const revokedScalarResources = await resources();
      for (const { input, value } of independentResults) {
        const replay = await invoke(input); assert.ok('result' in replay, JSON.stringify(replay));
        assert.equal(replay.result.status, 'replayed'); assert.equal(replay.result.result, value);
        await unchanged(revokedScalarResources);
      }
      await setActive(true);
      assert.deepEqual(await readFile(sourcePath), originalSource);
      for (const module of moduleBytes) assert.deepEqual(await readFile(module.path), module.bytes);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === sourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
      if (sourceDirectory !== undefined) await rm(sourceDirectory, { recursive: true, force: true });
    }
  });
