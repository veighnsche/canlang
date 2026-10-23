/** Actual captured native source, generated invoker and D1; ordinary void results. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, ResolvedIdentity, ScenarioReceiptAssociation } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { hashInputs } from '@canlang/state/invocation/replay';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import {
  FIXED_NOW, asId, asModel, asOperation, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7, makeRow, makeBatch, asVersion,
} from '@canlang/state/testing/invocation/fixtures';
import { distribution } from '@canlang/values/distribution';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { buildInvoker, type MutationOutcome } from '../worker/assembly.js';
import { prepareLocalPreviewCapture } from './native-dev.test-support.js';
import { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } from './native-dev.test-support.js';
import { compileCapturedSingleFile } from './native-dev.test-support.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const APP = 'NativeRefArrays';
const MODEL = asModel(`${APP}.Item`);
const fixturePath = join(root, 'tests/integration/can-dev-server/NativeRefArrays.can');
interface Projection { id: string; version: number; data: { value: string } }
type Tables = Record<string, Array<Record<string, unknown>>>;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function projection(value: unknown): Projection {
  const row = object(value), data = object(row.data);
  assert.equal(typeof row.id, 'string'); assert.equal(typeof row.version, 'number');
  assert.equal(typeof data.value, 'string'); assert.match(data.value as string, /^-?(0|[1-9][0-9]*)$/);
  return { id: row.id as string, version: row.version as number, data: { value: data.value as string } };
}
function committed(outcome: MutationOutcome, status = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  assert.ok(Object.hasOwn(outcome.result, 'result'));
  assert.equal(outcome.result.result, null, 'actual void becomes canonical null');
  return outcome.result;
}
async function snapshot(database: D1Database): Promise<Tables> {
  // Miniflare's private metadata is not a State table and D1 forbids reads.
  // Retain every application/State table and SQLite's history sequence.
  const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name")
    .all<{ name: string }>();
  assert.equal(tables.success, true);
  const result: Tables = {};
  for (const { name } of tables.results) {
    const rows = await database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function unchangedExcept(before: Tables, after: Tables, allowed: readonly string[]): void {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const name of Object.keys(before)) {
    if (!allowed.includes(name)) assert.deepEqual(after[name], before[name], `unchanged State table ${name}`);
  }
}

test('captured native reference arrays preserve D1 stages, genuine void replay and owning refusals',
  { timeout: 120000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'can-native-ref-arrays-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof captureSingleFileSource>> | undefined;
    let sequence = 0;
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
      operation: `${APP}.${operation}`, inputs, operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
    });
    try {
      capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
        appPath: fixturePath, compilerPath: process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
        catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics'
        ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('NativeRefArrays did not produce an actual native artifact');
      const artifact: CompileArtifact = compiled.artifact;
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      const step = artifact.operations?.find(operation => operation.name === `${APP}.step`);
      assert.ok(step); assert.equal(step.kind, 'scenario');
      assert.ok(step.result); assert.equal(step.result.type, 'void');
      const disclosure = step.result.disclosure;
      assert.ok(disclosure, 'actual checked array loop carries its Compiler-issued disclosure');
      assert.equal(disclosure.version, 1); assert.equal(disclosure.returns.length, 2);
      const emptyPath = disclosure.returns.find(path => path.dependencies.length === 0);
      const populatedPath = disclosure.returns.find(path => path.dependencies.length === 1);
      assert.ok(emptyPath); assert.ok(populatedPath); assert.notEqual(emptyPath.id, populatedPath.id);
      const dependency = populatedPath.dependencies[0]!;
      assert.equal(dependency.model, MODEL); assert.equal(dependency.field, 'value');
      assert.equal(dependency.type, 'int'); assert.equal(dependency.role, 'data');
      for (const path of disclosure.returns) {
        assert.deepEqual(path.influences, []); assert.deepEqual(path.intrinsics ?? [], []);
      }
      assert.equal(step.inputs.fields.length, 1);
      const input = step.inputs.fields[0]!;
      assert.equal(input.name, 'items'); assert.equal(input.required, false);
      assert.deepEqual(input.field, { kind: 'ref', model: MODEL, requireVersion: true });
      assert.deepEqual(input.array, { required: false });
      const callable = artifact.callables.find(item => item.id === step.name);
      assert.ok(callable); assert.equal(callable.inputStyle, 'parameters');
      const generated = artifact.modules.find(module => module.path === callable.module);
      assert.ok(generated);
      assert.match(generated.js, /for \(const [$\w]+ of [$\w]+\) \{/);
      assert.match(generated.js, /check\([^\n]+\.length<=[^\n]+,"limit"\)/);
      assert.match(generated.js, /await set\(c,/);
      const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
        workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui'),
      });
      const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
      assert.equal(namespace[callable.export], step.name);
      assert.equal(typeof namespace.canApp, 'function');
      const registry = object((namespace.canApp as () => unknown)());
      assert.deepEqual(registry.operations, artifact.operations, 'actual callable carrier matches the compiler artifact');
      let handler: unknown = registry;
      for (const member of callable.member) handler = object(handler)[member];
      assert.equal(typeof handler, 'function', 'actual generated callable exists');
      const definition = object(namespace.appDefinition);
      assert.equal(definition.id, APP);
      const declaration = object(object(definition.operations)[step.name]);
      assert.equal(declaration.by, 'members');
      assert.deepEqual(object(declaration.inputs).items, { type: MODEL, array: true });

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { DB: 'native-reference-arrays' }, d1Persist: join(dir, 'd1') });
      const database = await worker.getD1Database('DB') as unknown as D1Database;
      await ensureSchema(database);
      const store = createD1Storage(database);
      // Identity/membership uses the actual existing fixture; State persistence is real D1.
      const memberships = createMemoryIdentityStore();
      const member = await seedMember(memberships, { isOwner: false });
      const identity = makeIdentity({ membership: member.membership, email: member.user.email });
      const outsider = makeIdentity({ userId: 'nonmember', team: member.team, membership: null });
      const publicIdentity = makeIdentity({ actor: null, team: member.team, membership: null });
      const identitySnapshot = async () => ({ team: await memberships.findTeamById(member.team.team_id),
        member: await memberships.findMembershipById(member.membership.membership_id),
        user: await memberships.findUserById(member.user.user_id),
        outsider: await memberships.findMembership(member.team.team_id, 'nonmember') });
      const originalIdentity = await identitySnapshot();
      const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
      const createA = envelope('Item.create', {}), createB = envelope('Item.create', {});
      const aOutcome = committed(await invoker.invokeMutation(createA, identity));
      const bOutcome = committed(await invoker.invokeMutation(createB, identity));
      assert.equal(aOutcome.records?.length, 1); assert.equal(bOutcome.records?.length, 1);
      const a = projection(aOutcome.records![0]), b = projection(bOutcome.records![0]);
      assert.notEqual(a.id, b.id); assert.equal(a.version, 1); assert.equal(b.version, 1);
      assert.equal(a.data.value, '0'); assert.equal(b.data.value, '0');
      const ref = (row: Projection) => ({ id: row.id, version: String(row.version) });
      const receiptIdentity = (request: MutationEnvelope) => ({ app: APP,
        owner: identity.team!.team_id, principal: identity.actor!.user_id,
        operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
      const request = envelope('step', { items: [ref(a), ref(b), ref(a)] });
      const originalInputs = structuredClone(request.inputs);
      const before = await snapshot(database), revision = await store.readRevision();
      for (const table of ['outbox', 'schedules', 'unique_claims']) assert.deepEqual(before[table], []);
      const aHistory = await store.historyFor(MODEL, asId(a.id)), bHistory = await store.historyFor(MODEL, asId(b.id));
      const stepResult = committed(await invoker.invokeMutation(request, identity));
      assert.deepEqual(request.inputs, originalInputs, 'submitted versions remain the original three slots');
      const currentA = await store.load(MODEL, asId(a.id)), currentB = await store.load(MODEL, asId(b.id));
      assert.ok(currentA); assert.ok(currentB);
      assert.deepEqual(currentA.data, { value: '2' }); assert.deepEqual(currentB.data, { value: '1' });
      assert.equal(currentA.version, 2); assert.equal(currentB.version, 2);
      const updatesA = (await store.historyFor(MODEL, asId(a.id))).slice(aHistory.length);
      const updatesB = (await store.historyFor(MODEL, asId(b.id))).slice(bHistory.length);
      assert.deepEqual(updatesA.map(entry => [entry.change, entry.version, entry.before?.value, entry.after?.value]),
        [['update', 2, '0', '1'], ['update', 2, '1', '2']]);
      assert.deepEqual(updatesB.map(entry => [entry.change, entry.version, entry.before?.value, entry.after?.value]),
        [['update', 2, '0', '1']]);
      for (const entry of [...updatesA, ...updatesB]) {
        assert.equal(entry.operationId, request.operation_id); assert.equal(entry.operation, request.operation);
        assert.equal(entry.actor, identity.actor!.user_id);
      }
      assert.equal(await store.readRevision(), revision + 1, 'one net root commit');
      const physical = await store.readReceipt(receiptIdentity(request)); assert.ok(physical);
      assert.equal(physical.inputHash, await hashInputs(originalInputs));
      assert.equal(physical.committedRevision, revision + 1);
      assert.ok(physical.outcome.status === 'committed'); assert.equal(physical.outcome.result, null);
      assert.deepEqual([...physical.outcome.recordVersions].sort((a, b) => a.id.localeCompare(b.id)),
        [{ model: MODEL, id: a.id, version: 2 }, { model: MODEL, id: b.id, version: 2 }]
          .sort((a, b) => a.id.localeCompare(b.id)));
      const association = readScenarioReceiptAssociation(physical);
      assert.ok(association, 'the actual State framework retains the generated loop association');
      assert.deepEqual(association.plan, disclosure); assert.equal(association.resultType, 'void');
      assert.equal(association.returnId, populatedPath.id);
      assert.deepEqual(association.observations.map(value => value.dependencyId),
        [dependency.id, dependency.id, dependency.id]);
      assert.deepEqual(association.observations.map(value => value.model), [MODEL, MODEL, MODEL]);
      assert.deepEqual(association.observations.map(value => value.row.id), [a.id, b.id, a.id]);
      assert.deepEqual(association.observations.map(value => value.row.data.value), ['0', '0', '1']);
      assert.deepEqual(association.observations.map(value => value.row.version), [1, 1, 2]);
      assert.equal(association.changed.length, 2);
      for (const row of [currentA, currentB]) {
        const changed: ScenarioReceiptAssociation['changed'][number] | undefined =
          association.changed.find(value => value.row.id === row.id);
        assert.ok(changed); assert.equal(changed.model, MODEL); assert.deepEqual(changed.row, row);
        assert.deepEqual(changed.fieldTypes, { value: 'int' });
        assert.deepEqual(changed.secretFields, []); assert.deepEqual(changed.withheldFields, []);
      }
      assert.deepEqual(stepResult.records?.map(projection).sort((a, b) => a.id.localeCompare(b.id)),
        [{ id: a.id, version: 2, data: { value: '2' } }, { id: b.id, version: 2, data: { value: '1' } }]
          .sort((a, b) => a.id.localeCompare(b.id)));
      const after = await snapshot(database);
      unchangedExcept(before, after, ['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence']);
      assert.equal(after.receipts!.length, before.receipts!.length + 1);
      assert.equal(after.fence_log!.length, before.fence_log!.length + 1);
      assert.equal(after.history!.length, before.history!.length + 3);
      assert.equal(after.records!.length, before.records!.length);
      const replayVoid = async (savedRequest: MutationEnvelope, savedResult: ReturnType<typeof committed>, savedTables: Tables) => {
        const savedInputs = structuredClone(savedRequest.inputs);
        const savedReceipt = await store.readReceipt(receiptIdentity(savedRequest));
        assert.ok(savedReceipt); assert.ok(readScenarioReceiptAssociation(savedReceipt));
        assert.equal(savedReceipt.inputHash, await hashInputs(savedInputs));
        const replay = committed(await invoker.invokeMutation(savedRequest, identity), 'replayed');
        assert.deepEqual(replay.records, savedResult.records);
        assert.deepEqual(savedRequest.inputs, savedInputs);
        assert.deepEqual(await snapshot(database), savedTables, 'genuine void replay adds no rows, history, receipts or effects');
        assert.deepEqual(await store.readReceipt(receiptIdentity(savedRequest)), savedReceipt);
      };
      await replayVoid(request, stepResult, after);
      assert.deepEqual(request.inputs, originalInputs);
      assert.deepEqual(await store.readReceipt(receiptIdentity(request)), physical);

      for (const inputs of [{ items: [] }, {}]) {
        const empty = envelope('step', inputs), prior = await snapshot(database), priorRevision = await store.readRevision();
        const emptyResult = committed(await invoker.invokeMutation(empty, identity));
        assert.deepEqual(emptyResult.records, []);
        const emptyReceipt = await store.readReceipt(receiptIdentity(empty)); assert.ok(emptyReceipt);
        const emptyAssociation = readScenarioReceiptAssociation(emptyReceipt); assert.ok(emptyAssociation);
        assert.deepEqual(emptyAssociation.plan, disclosure); assert.equal(emptyAssociation.returnId, emptyPath.id);
        assert.deepEqual(emptyAssociation.observations, []); assert.deepEqual(emptyAssociation.changed, []);
        assert.equal(emptyReceipt.inputHash, await hashInputs(inputs));
        assert.equal(await store.readRevision(), priorRevision + 1);
        const next = await snapshot(database);
        unchangedExcept(prior, next, ['receipts', 'fence', 'fence_log']);
        assert.equal(next.receipts!.length, prior.receipts!.length + 1);
        await replayVoid(empty, emptyResult, next);
      }
      const freshA = { id: a.id, version: '2' }, freshB = { id: b.id, version: '2' };
      const limited = envelope('step', { items: [freshA, freshB, freshA, freshB] });
      const limitBefore = await snapshot(database), limitRevision = await store.readRevision();
      const limitOutcome = await invoker.invokeMutation(limited, identity);
      assert.ok('error' in limitOutcome, JSON.stringify(limitOutcome));
      assert.equal(limitOutcome.error.code, 'rule_failed');
      const limitReceipt = await store.readReceipt(receiptIdentity(limited)); assert.ok(limitReceipt);
      assert.equal(limitReceipt.outcome.status, 'rejected');
      assert.equal(readScenarioReceiptAssociation(limitReceipt), null, 'the bound refuses before capture selection or writes');
      assert.equal(limitReceipt.inputHash, await hashInputs(limited.inputs));
      assert.equal(limitReceipt.committedRevision, limitRevision + 1);
      const limitAfter = await snapshot(database);
      unchangedExcept(limitBefore, limitAfter, ['receipts', 'fence', 'fence_log']);
      assert.equal(limitAfter.receipts!.length, limitBefore.receipts!.length + 1);
      assert.equal(limitAfter.fence_log!.length, limitBefore.fence_log!.length + 1);
      assert.equal(await store.readRevision(), limitRevision + 1);
      assert.deepEqual(await identitySnapshot(), originalIdentity);
      const qualified = artifact.operations?.find(operation => operation.name === `${APP}.captured`);
      assert.ok(qualified?.result?.disclosure, 'unused array inputs have a genuine Compiler-issued scalar plan');
      assert.equal(qualified.result.type, 'int');
      const retained = envelope('captured', { items: [freshA, freshB, freshA] });
      const retainedBefore = await snapshot(database), retainedRevision = await store.readRevision();
      const result = await invoker.invokeMutation(retained, identity);
      assert.ok('result' in result, JSON.stringify(result));
      assert.equal(result.result.status, 'committed'); assert.equal(result.result.result, '7');
      assert.equal(await store.readRevision(), retainedRevision + 1);
      const retainedAfter = await snapshot(database);
      unchangedExcept(retainedBefore, retainedAfter, ['records', 'receipts', 'fence', 'fence_log']);
      assert.deepEqual(retainedAfter.records!.filter(row => row.model === MODEL),
        retainedBefore.records!.filter(row => row.model === MODEL), 'qualified capture changes no domain rows');
      const retainedReceipt = await store.readReceipt(receiptIdentity(retained));
      assert.ok(retainedReceipt); assert.equal(retainedReceipt.outcome.status, 'committed');
      assert.ok(retainedReceipt.outcome.scenario, 'the actual State framework retains its execution association');
      assert.equal(retainedReceipt.inputHash, await hashInputs(retained.inputs));
      const replayed = await invoker.invokeMutation(retained, identity);
      assert.ok('result' in replayed, JSON.stringify(replayed));
      assert.equal(replayed.result.status, 'replayed'); assert.equal(replayed.result.result, '7');
      assert.deepEqual(await snapshot(database), retainedAfter, 'qualified native replay has no additional effects');
      assert.deepEqual(await store.readReceipt(receiptIdentity(retained)), retainedReceipt);
      const denied: Array<{ inputs: MutationEnvelope['inputs']; actor: ResolvedIdentity; code: string }> = [
        { inputs: { items: [freshB, ref(a)] }, actor: identity, code: 'conflict' },
        { inputs: { items: [freshA, { id: uuidv7(FIXED_NOW, 9999), version: '1' }] }, actor: identity, code: 'not_found' },
        { inputs: { items: [freshA, { id: b.id }] }, actor: identity, code: 'validation' },
        { inputs: { items: [freshA, freshB] }, actor: outsider, code: 'forbidden' },
        { inputs: { items: [freshA, freshB] }, actor: publicIdentity, code: 'forbidden' },
      ];
      for (const { inputs, actor, code } of denied) {
        const deniedRequest = envelope('step', inputs), prior = await snapshot(database);
        const outcome = await invoker.invokeMutation(deniedRequest, actor);
        assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, code);
        assert.deepEqual(await snapshot(database), prior, `${code} refuses before any physical write`);
        assert.equal(await store.readReceipt(receiptIdentity(deniedRequest)), null);
        assert.deepEqual(await identitySnapshot(), originalIdentity);
      }
      assert.deepEqual(await identitySnapshot(), originalIdentity);
      assert.equal(await captureIsCurrent(capture), true);
    } finally {
      try { await worker?.dispose(); }
      finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

// The real authored decision exercises both input reference arrays and stored
// reference arrays through the shared source observer and ordinary SET path.
for (const renamed of [false, true]) test(`${renamed ? 'renamed' : 'original'} account approval preserves complete location decisions, D1 atomicity and replay`,
  { timeout: 180000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'can-native-account-arrays-'));
    let worker: Miniflare | undefined;
    try {
      const original = await readFile(join(root, 'draft/apps/CanCustomer/CanCustomer.can'), 'utf8');
      const employeeProbe = await readFile(join(root, 'packages/cloudflare/test/fixtures/refer-reject-source-owner-probe.can'), 'utf8');
      const invoice = await readFile(join(root, 'draft/apps/CanInvoice/CanInvoice.can'), 'utf8');
      const lines = original.split('\n');
      const declaration = (prefix: string) => {
        const line = lines.find(line => line.startsWith(prefix));
        assert.ok(line, prefix); return line;
      };
      const start = original.indexOf('  export scenario approve_account(');
      const end = original.indexOf('   examples seed=', start);
      assert.ok(start >= 0 && end > start);
      const finance = invoice.split('\n').find(line => line.startsWith('  export role finance '));
      assert.ok(finance);
      const fixture = join(dir, 'account.can');
      let decision = original.slice(start, end).trimEnd();
      if(renamed)decision=decision.replace(/\bprofile\b/g,'account')
        .replace('locations:Location[]','reviewed:Location[]').replace('all(locations as','all(reviewed as')
        .replace('count(locations)','count(reviewed)').replace('approved_locations=locations','approved_locations=reviewed');
      let fixtureSource = [
        'app CanCustomer uses=[customer]',
        employeeProbe.slice(employeeProbe.indexOf('package rent_catalog'), employeeProbe.indexOf('package invoice')),
        'package invoice', ' Given', finance, ' When', ' Then',
        'package customer', ' use rent_catalog {Location}', ' use employee {can_work}', ' use invoice {finance}', ' Given',
        declaration('  export Customer {'), declaration('  export Contact in Customer {'),
        declaration('  export BillingProfile in Customer {'), declaration('  derive customer_staff('),
        declaration('  policy Customer read=finance '), declaration('  policy BillingProfile read=finance '),
        declaration('  invariant BillingProfile:'), ...lines.filter(line => line.startsWith('  message ')),
        ' When', decision, ' Then', '',
      ].join('\n');
      if(renamed)fixtureSource=fixtureSource.replace(/\bcustomer\b/g,'directory').replace(/\bBillingProfile\b/g,'AccountProfile')
        .replace(/\bcustomer_staff\b/g,'directory_staff').replace(/\bapprove_account\b/g,'review_account').replace(/\bCanCustomer\b/g,'CanDirectory');
      await writeFile(fixture,fixtureSource);
      const { stdout } = await promisify(execFile)(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
          process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), fixture],
        { cwd: root, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(dir, 'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { DB: 'native-account-arrays' }, d1Persist: join(dir, 'd1') });
      const database = await worker.getD1Database('DB') as unknown as D1Database;
      await ensureSchema(database);
      const backing = createD1Storage(database);
      let sequence = 20000;
      for (const mode of ['approve', 'revoke', 'empty-approve', 'foreign-location', 'unworkable-location',
        'unworkable-stored-revoke', 'missing-role', 'inactive-worker', 'inactive-customer', 'empty-reason',
        'missing-location-version', 'missing-location', 'stale-profile', 'stale-location',
        'customer-locations-at-commit', 'membership-revoked-during-owner-query'] as const) {
        const memberships = createMemoryIdentityStore();
        const member = await seedMember(memberships, { isOwner: false,
          roles: mode === 'missing-role' ? [] : ['invoice.finance'] });
        const identity = makeIdentity({ membership: member.membership, email: member.user.email });
        const model = (name: string) => asModel(renamed ? name.replace(/^customer\./,'directory.').replace(/\.BillingProfile$/,'.AccountProfile') : name);
        const row = (data: Record<string, unknown>) => ({ ...makeRow({
          id: asId(uuidv7(FIXED_NOW, ++sequence)), data }), parent: null });
        const site = row({ name: 'Reviewed', address: 'A', timezone: 'UTC', currency: 'EUR', hours: 'Open', arrival: 'Door', active: true });
        const other = row({ ...site.data, name: 'Other' });
        const customer = row({ name: 'Customer', kind: 'company',
          locations: mode==='unworkable-location'?[{ id: site.id },{ id: other.id }]:[{ id: site.id }], active: mode !== 'inactive-customer' });
        const contact = { ...row({ name: 'Contact', email: 'contact@example.test', account: null,
          verified: false, phone: null, external_id: null }), parent: { model: model('customer.Customer'), id: customer.id } };
        const profile = { ...row({ contact: { id: contact.id }, address: 'Billing', tax_reference: null,
          on_account: true, approved_locations: [{ id: mode === 'unworkable-stored-revoke' ? other.id : site.id }],
          approval_reason: 'Prior review', approved_by: { id: member.user.user_id },
          approved_at: '2026-01-01T00:00:00.000Z' }), parent: { model: model('customer.Customer'), id: customer.id } };
        const employee = row({ user: { id: member.user.user_id }, name: 'Finance employee', home: { id: site.id },
          locations: mode === 'foreign-location' ? [{ id: other.id }] : [], operator_wide: false,
          active: mode !== 'inactive-worker', start: '2026-01-01', end: null, manager: null,
          role: 'finance', skills: [], private_notes: 'NEVER-DISCLOSE-ACCOUNT-PRIVATE-NOTES', document: null });
        await backing.commit(makeBatch(await backing.readRevision(), { writes: [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('rent_catalog.Location'), row: other },
          { kind: 'insert', model: model('employee.Employee'), row: employee },
          { kind: 'insert', model: model('customer.Customer'), row: customer },
          { kind: 'insert', model: model('customer.Contact'), row: contact },
          { kind: 'insert', model: model('customer.BillingProfile'), row: profile },
        ] }));
        let injected = false;
        const store = { ...backing,
          query: async (query: Parameters<typeof backing.query>[0]) => {
            const rows = await backing.query(query);
            if (mode === 'membership-revoked-during-owner-query' && !injected && query.model === model('employee.Employee')) {
              injected = true;
              await memberships.removeMembership(member.membership.membership_id);
            }
            return rows;
          },
          commit: async (batch: Parameters<typeof backing.commit>[0]) => {
          if (mode.endsWith('-at-commit') && !injected && batch.writes.length > 0) {
            injected = true;
            await backing.commit(makeBatch(await backing.readRevision(), { writes: [{ kind: 'update',
              model: model('customer.Customer'), id: customer.id, expectedVersion: customer.version,
              row: { ...customer, version: asVersion(2), data: { ...customer.data, locations: [{ id: other.id }] } } }] }));
          }
          return backing.commit(batch);
        } };
        const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
        const ref = (id: string) => ({ id, version: '1' });
        const approve = mode !== 'revoke' && mode !== 'unworkable-stored-revoke';
        const locations = mode === 'revoke' || mode === 'empty-approve' || mode === 'unworkable-stored-revoke' ? [] :
          mode === 'missing-location-version' ? [{ id: site.id }] :
          mode === 'missing-location' ? [ref(uuidv7(FIXED_NOW, ++sequence))] :
          mode === 'stale-location' ? [{ id: site.id, version: '2' }] :
          mode === 'foreign-location' || mode === 'unworkable-location' ? [ref(other.id)] : [ref(site.id), ref(site.id)];
        const request: MutationEnvelope = { operation: renamed ? 'directory.review_account' : 'customer.approve_account',
          operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs: {
            [renamed ? 'account' : 'profile']: { id: profile.id, version: mode === 'stale-profile' ? '2' : '1' },
            approve, [renamed ? 'reviewed' : 'locations']: locations, reason: mode === 'empty-reason' ? '' : 'Finance reviewed',
          } };
        const before = await snapshot(database);
        const outcome = await invoker.invokeMutation(request, identity);
        assert.equal(JSON.stringify(outcome).includes('NEVER-DISCLOSE-ACCOUNT-PRIVATE-NOTES'), false, mode);
        const current = await backing.load(model('customer.BillingProfile'), profile.id); assert.ok(current);
        if (mode === 'approve' || mode === 'revoke') {
          committed(outcome);
          assert.equal(current.data.on_account, approve, mode);
          assert.deepEqual(current.data.approved_locations, approve ? [{ id: site.id }, { id: site.id }] : [], mode);
          assert.equal(current.data.approval_reason, 'Finance reviewed', mode);
          assert.deepEqual(current.data.approved_by, { id: member.user.user_id }, mode);
          assert.equal(current.data.approved_at, new Date(FIXED_NOW).toISOString(), mode);
          const after = await snapshot(database);
          committed(await invoker.invokeMutation(request, identity), 'replayed');
          assert.deepEqual(await snapshot(database), after, `${mode}: replay produces no writes or effects`);
          const changed = await invoker.invokeMutation({ ...request, inputs: { ...request.inputs, reason: 'Changed' } }, identity);
          assert.ok('error' in changed, `${mode}: changed-input replay refuses`);
          assert.deepEqual(await snapshot(database), after);
        } else {
          assert.ok('error' in outcome, `${mode}: ${JSON.stringify(outcome)}`);
          const codes=mode==='missing-location-version'?['validation']:mode==='missing-location'?['not_found']:
            mode==='stale-profile'||mode==='stale-location'?['conflict']:mode==='customer-locations-at-commit'?['rule_failed']:
            mode==='membership-revoked-during-owner-query'?['rule_failed','forbidden']:
            mode==='missing-role'?['forbidden']:['rule_failed'];
          assert.ok(codes.includes(outcome.error.code), `${mode}: ${JSON.stringify(outcome)}`);
          assert.deepEqual(current, profile, `${mode}: profile remains atomic`);
          assert.deepEqual(await backing.historyFor(model('customer.BillingProfile'), profile.id), [], mode);
          if (!mode.endsWith('-at-commit')) unchangedExcept(before,await snapshot(database),['receipts','fence','fence_log']);
        }
        if (mode.endsWith('-at-commit') || mode === 'membership-revoked-during-owner-query') assert.equal(injected, true, `${mode}: race hook reached`);
      }
    } finally {
      try { await worker?.dispose(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
