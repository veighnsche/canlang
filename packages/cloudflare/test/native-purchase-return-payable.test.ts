/** Original Purchase record_payable and return_goods through installed State/Identity/D1.
 * Canonical example snapshots only establish authoritative initial records.
 */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, CommitBatch, ModelName, MutationEnvelope, OperationId, OperationName, RecordId, StoredRow, StoragePort } from '@canlang/contracts';
import type { MutationOutcome } from '../src/worker/assembly.js';
import { preparePurchaseSource } from './purchase-source.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
const APP = 'CanPurchase', RECORD_PAYABLE = 'purchase.record_payable', RETURN_GOODS = 'purchase.return_goods';
const model = (name: string) => name as ModelName;
const LOCATION = model('rent_catalog.Location'), EMPLOYEE = model('employee.Employee'), SUPPLIER = model('supplier.Supplier');
const BUDGET = model('purchase.Budget'), REQUEST = model('purchase.Request'), ORDER = model('purchase.Order');
const LINE = model('purchase.Line'), RECEIPT = model('purchase.Receipt'), RETURN = model('purchase.Return'), PAYABLE = model('purchase.Payable');
const ref = (row: StoredRow) => ({ id: row.id, version: String(row.version) });
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, status);
  const result = outcome.result.result;
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result));
  assert.deepEqual(Object.keys(result), ['id']); assert.equal(typeof (result as { id: unknown }).id, 'string');
  return { id: (result as { id: RecordId }).id, outcome: outcome.result };
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(names.success, true);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); tables[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return tables;
}

test('original Purchase records payables and returns once, stages Stock reversal, refuses conflicts and replays real receipts',
  { timeout: 1200000 }, async () => {
    const directory = await createCheckoutScratch(root, 'purchase-');
    let worker: Miniflare | undefined;
    try {
      const fixture = await preparePurchaseSource(directory);
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker, createTeamOwnerStorageBoundary } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { materializeCanonicalExampleSnapshots } = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
      const { createD1OwnerRouter } = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
      const { uuidv7 } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
      const { readScenarioReceiptAssociation } = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
      const { hashInputs } = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const inventory = installedLocalPreviewInputInventory(root, compilerPath);
      const capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixture.sourcePath, compilerPath,
        catalogPath: process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'),
        profile: 'native-original-purchase-return-payable', helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'), ...inventory,
        extraInputPaths: [...inventory.extraInputPaths, ...fixture.originalInputPaths.map(path => ({ name: `purchase-original:${relative(root, path)}`, path }))],
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      const compiled = await promisify(execFile)(compilerPath, ['compile', '--format=json', '--native-scenario-receipts',
        `--catalog=${capture.inputs.find(input => input.name === 'catalog')!.requestedPath}`, capture.compilerOperand],
        { cwd: root, maxBuffer: 32 * 1024 * 1024 });
      const artifact: CompileArtifact = JSON.parse(compiled.stdout);
      assert.equal(artifact.runtimeBindings?.some(binding => binding.name === 'StockReceipt'), false,
        'an imported payload Contract is not a deployment service');
      assert.equal(await captureIsCurrent(capture), true);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.deepEqual(artifact.operations?.filter(operation => operation.kind !== 'read').map(operation => operation.name).sort(), [RECORD_PAYABLE, RETURN_GOODS]);
      for (const name of [RECORD_PAYABLE, RETURN_GOODS]) assert.ok(artifact.operations?.find(operation => operation.name === name)?.result?.disclosure, `${name} has a native receipt`);
      assert.ok(fixture.source.includes(fixture.recordPayable) && fixture.source.includes(fixture.returnGoods));
      const asm = await assembleModules({ artifact, sourcePath: fixture.sourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}', d1Persist: join(directory, 'd1'),
        d1Databases: { IDENTITY: 'purchase-identity', OWNER: 'purchase-owner' } });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb);
      const now = Date.parse('2026-10-18T12:00:00Z'), clock = { nowMs: () => now }; let sequence = 1000;
      const identities = createD1IdentityStore(identityDb, { clock }), team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(name: string, role?: string) {
        const user = await identities.createUser({ email: `${name}@purchase.example.test`, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false,
          roles: role === undefined ? [] : [{ role, granted_at: new Date(now).toISOString(), granted_by: user.user_id }] });
        const token = `purchase-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        return { user, membership, identity: await resolveIdentity(identities, { session_token: token }, { clock }) };
      }
      const buyer = await actor('buyer', 'supplier.buyer'), noStaff = await actor('no-staff', 'supplier.buyer');
      const manager = await actor('manager', 'supplier.budget_manager'), managerNoStaff = await actor('manager-no-staff', 'supplier.budget_manager');
      const batches: CommitBatch[] = [];
      let onOwnerPayableAggregateQuery: (() => Promise<void>) | undefined;
      const router = createD1OwnerRouter({ resolveBinding: scope => scope.app === APP && scope.owner === team.team_id
        ? { ...scope, db: ownerDb, initializeFresh: true } : null });
      let retained: StoragePort | undefined;
      const boundary = await createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities, router: {
        async ownerScopedStoragePort(scope) {
          const checked = await router.ownerScopedStoragePort(scope);
          retained ??= { ...checked,
            async query(spec) {
              const rows = await checked.query(spec);
              // The native FIRST consumes its cohort reader. The original body
              // SUM borrows this complete parent-scoped, id-ordered owner domain.
              if (onOwnerPayableAggregateQuery !== undefined && spec.model === PAYABLE && spec.authority === 'owner' &&
                  spec.parent?.model === ORDER && spec.parent.id === orderId && spec.order?.[0]?.field === 'id') {
                const reached = onOwnerPayableAggregateQuery; onOwnerPayableAggregateQuery = undefined; await reached();
              }
              return rows;
            },
            async commit(batch) { const result = await checked.commit(batch); batches.push(batch); return result; },
          };
          return retained;
        },
      } });
      const store = await boundary.forIdentity(buyer.identity), id = () => uuidv7(now, ++sequence) as RecordId;
      const siteId = id(), supplierId = id(), budgetId = id(), requestId = id(), orderId = id(), lineId = id(), priorReceiptId = id(), pendingReceiptId = id();
      const money = (minor: string) => ({ minor, currency: 'EUR' });
      const employee = (user: string) => ({ user: { id: user }, home: { id: siteId }, locations: [{ id: siteId }], operator_wide: false,
        active: true, start: '2026-10-01', role: 'buyer', skills: [] });
      await materializeCanonicalExampleSnapshots({ asm, artifact, store, identity: buyer.identity, now, operationId: uuidv7(now, ++sequence), snapshots: [
        { model: LOCATION, id: siteId, data: { name: 'Main', address: '1 Example Road', timezone: 'Europe/Brussels', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true } },
        { model: EMPLOYEE, id: id(), data: employee(buyer.user.user_id) }, { model: EMPLOYEE, id: id(), data: employee(manager.user.user_id) },
        { model: SUPPLIER, id: supplierId, data: { name: 'Supplies', contact: 'vendor@example.test', locations: [{ id: siteId }], active: true } },
        { model: BUDGET, id: budgetId, data: { name: 'Furniture', locations: [{ id: siteId }], total: money('10000'), active: true } },
        { model: REQUEST, id: requestId, parent: { model: BUDGET, id: budgetId }, data: { location: { id: siteId }, supplier: { id: supplierId }, requester: { id: buyer.user.user_id }, reviewer: { id: manager.user.user_id }, purpose: 'Boxes', category: 'Equipment', required_by: '2099-01-01', amount: money('6000'), state: 'closed', actual: money('2000'), evidence: 'Closed spending' } },
        { model: ORDER, id: orderId, parent: { model: REQUEST, id: requestId }, data: { reference: 'PO-1', supplier_name: 'Supplies', supplier_contact: 'vendor@example.test', location: { id: siteId }, state: 'closed' } },
        { model: LINE, id: lineId, parent: { model: ORDER, id: orderId }, data: { sku: 'boxes', unit: 'box', quantity: '6', unit_price: money('1000') } },
        { model: RECEIPT, id: priorReceiptId, parent: { model: LINE, id: lineId }, data: { source: 'delivery-A', accepted: '2', rejected: '0', received: '2099-01-02', evidence: 'Delivery A', posting: 'confirmed', revision: '1', attempts: '0' } },
        { model: RECEIPT, id: pendingReceiptId, parent: { model: LINE, id: lineId }, data: { source: 'delivery-pending', accepted: '1', rejected: '0', received: '2099-01-02', evidence: 'Pending delivery', posting: 'pending', revision: '1', attempts: '0' } },
      ] });
      batches.length = 0;
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage: boundary });
      const row = async (name: ModelName, recordId: RecordId) => { const found = await store.load(name, recordId); assert.ok(found); return found; };
      const recordPayable = async (source = 'invoice-A', invoice = 'SUP-001', amount = money('1000'), evidence = 'Supplier invoice'): Promise<MutationEnvelope> => ({ operation: RECORD_PAYABLE,
        operation_id: uuidv7(now, ++sequence), inputs: { order: ref(await row(ORDER, orderId)), source, invoice, amount, issued: '2099-01-03', evidence } });
      const returnGoods = async (source = 'return-A', quantity = '1', evidence = 'Supplier return', receiptId = priorReceiptId): Promise<MutationEnvelope> => ({ operation: RETURN_GOODS,
        operation_id: uuidv7(now, ++sequence), inputs: { receipt: ref(await row(RECEIPT, receiptId)), source, quantity, returned: '2099-01-03', evidence } });
      const receiptIdentity = (input: MutationEnvelope) => ({ app: APP, owner: team.team_id, principal: input.operation === RECORD_PAYABLE ? manager.user.user_id : buyer.user.user_id,
        operation: input.operation as OperationName, operationId: input.operation_id as OperationId });
      const resources = async () => ({ identity: await snapshot(identityDb), owner: await snapshot(ownerDb) });
      function emptyEffects(batch: CommitBatch) {
        for (const name of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const) assert.deepEqual(batch[name] ?? [], [], name);
      }
      async function noEffects(input: MutationEnvelope, identity = input.operation === RECORD_PAYABLE ? manager.identity : buyer.identity, code = 'rule_failed') {
        const before = await resources(), count = batches.length;
        const outcome = await invoker.invokeMutation(input, identity);
        assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, code, JSON.stringify(outcome));
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        for (const name of new Set([...Object.keys(before.owner), ...Object.keys(after.owner)])) {
          if (!['receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name)) assert.deepEqual(after.owner[name], before.owner[name], name);
        }
        if (batches.length === count) assert.deepEqual(after.owner, before.owner);
        for (const batch of batches.slice(count)) { emptyEffects(batch); assert.equal(batch.receipt?.outcome.status, 'rejected'); }
      }
      async function realReceipt(input: MutationEnvelope, resultId: RecordId, mode: 'physical' | 'retained') {
        const physical = await store.readReceipt(receiptIdentity(input)); assert.ok(physical);
        assert.equal(physical.inputHash, await hashInputs(input.inputs));
        const association = readScenarioReceiptAssociation(physical); assert.ok(association);
        assert.equal(association.resultType, input.operation === RECORD_PAYABLE ? PAYABLE : RETURN);
        assert.deepEqual(association.plan, artifact.operations!.find(operation => operation.name === input.operation)!.result!.disclosure);
        assert.ok(association.queries?.length);
        const before = await resources(), count = batches.length, identity = input.operation === RECORD_PAYABLE ? manager.identity : buyer.identity;
        const outcome = mode === 'physical' ? await invoker.invokeMutation(input, identity)
          : await invoker.invokeRetainedMutation(input, identity);
        assert.equal(committed(outcome, 'replayed').id, resultId);
        assert.deepEqual(await resources(), before); assert.equal(batches.length, count);
        assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);
      }
      function stockPost(batch: CommitBatch, operation: string, source: string, quantity: string, reversal: string | null, delivery: unknown) {
        assert.equal(batch.outbox.length, 1); const send = batch.outbox[0]!;
        assert.equal(send.operation, operation); assert.equal(send.target, 'stock.StockV1.post');
        assert.equal(send.intentId, delivery);
        assert.deepEqual(send.arguments, { binding: 'purchase.Stock', from: 'deployment.stock',
          arguments: { value: { source, order: 'PO-1', sku: 'boxes', unit: 'box', location: siteId, quantity, revision: '1', reversal } } });
      }
      const priorLine = await row(LINE, lineId), priorReceipt = await row(RECEIPT, priorReceiptId), priorOrder = await row(ORDER, orderId);
      const returnInput = await returnGoods(), beforeReturnOrder = await row(ORDER, orderId);
      const returned = committed(await invoker.invokeMutation(returnInput, buyer.identity)), returnBatch = batches.at(-1)!;
      const returnedRow = await row(RETURN, returned.id);
      assert.equal(returnedRow.parent?.id, priorReceiptId);
      assert.deepEqual(returnedRow.data, { source: 'return-A', quantity: '1', returned: '2099-01-03', evidence: 'Supplier return', revision: '1', posting: 'pending', attempts: '1', delivery: returnedRow.data.delivery });
      stockPost(returnBatch, RETURN_GOODS, 'return-A', '-1', 'delivery-A', returnedRow.data.delivery);
      assert.deepEqual(await row(RECEIPT, priorReceiptId), priorReceipt); assert.deepEqual(await row(ORDER, orderId), beforeReturnOrder);
      assert.equal((await store.query({ model: RETURN, authority: 'owner' })).length, 1);
      assert.equal((await store.historyFor(RETURN, returned.id)).length, 1);
      const payableInput = await recordPayable();
      const payable = committed(await invoker.invokeMutation(payableInput, manager.identity)), payableBatch = batches.at(-1)!;
      const payableRow = await row(PAYABLE, payable.id);
      assert.equal(payableRow.parent?.id, orderId);
      assert.deepEqual(payableRow.data, { source: 'invoice-A', invoice: 'SUP-001', amount: money('1000'), issued: '2099-01-03', evidence: 'Supplier invoice', posting: 'pending', revision: '1', attempts: '0', delivery: null, reference: null });
      assert.deepEqual(payableBatch.outbox, []); assert.deepEqual(payableBatch.schedules, []);
      assert.equal((await store.query({ model: PAYABLE, authority: 'owner' })).length, 1);
      assert.equal((await store.historyFor(PAYABLE, payable.id)).length, 1);
      assert.deepEqual(await row(LINE, lineId), priorLine); assert.deepEqual(await row(RECEIPT, priorReceiptId), priorReceipt); assert.deepEqual(await row(ORDER, orderId), priorOrder);
      const againInput = await recordPayable(), beforeAgain = await resources(), againCount = batches.length;
      assert.equal(committed(await invoker.invokeMutation(againInput, manager.identity)).id, payable.id);
      assert.equal(batches.length, againCount + 1); emptyEffects(batches.at(-1)!);
      const afterAgain = await resources(); assert.deepEqual(afterAgain.identity, beforeAgain.identity);
      for (const name of Object.keys(beforeAgain.owner)) if (!['receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name)) assert.deepEqual(afterAgain.owner[name], beforeAgain.owner[name], name);
      await noEffects(await recordPayable('invoice-A', 'SUP-001', money('1000'), 'Changed invoice proof'));
      await noEffects(await recordPayable('invoice-B', 'SUP-002', money('1001')));
      await identities.setMembershipRoles(manager.membership.membership_id, []);
      await noEffects(await recordPayable(), manager.identity, 'forbidden');
      await identities.setMembershipRoles(manager.membership.membership_id, [{ role: 'supplier.budget_manager', granted_at: new Date(now).toISOString(), granted_by: manager.user.user_id }]);
      await noEffects(await recordPayable(), buyer.identity, 'forbidden');
      await noEffects(await recordPayable(), managerNoStaff.identity, 'forbidden');
      await noEffects(await returnGoods(), manager.identity, 'forbidden');
      await noEffects(await returnGoods(), noStaff.identity, 'forbidden');
      await noEffects(await returnGoods('return-zero', '0'));
      await noEffects(await returnGoods('return-pending', '1', 'Pending receipt', pendingReceiptId));
      await noEffects(await recordPayable('invoice-usd', 'SUP-USD', {minor: '1000', currency: 'USD'}));
      await noEffects(await recordPayable('invoice-over-cap', 'SUP-OVER', money('2001')));
      const returnAgain = await returnGoods(), returnBeforeAgain = await resources(), returnCount = batches.length;
      assert.equal(committed(await invoker.invokeMutation(returnAgain, buyer.identity)).id, returned.id);
      assert.equal(batches.length, returnCount + 1); emptyEffects(batches.at(-1)!);
      const returnAfterAgain = await resources(); assert.deepEqual(returnAfterAgain.identity, returnBeforeAgain.identity);
      for (const name of Object.keys(returnBeforeAgain.owner)) if (!['receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name)) assert.deepEqual(returnAfterAgain.owner[name], returnBeforeAgain.owner[name], name);
      await noEffects(await returnGoods('return-A', '1', 'Changed return proof'));
      await noEffects(await returnGoods('return-too-many', '2'));
      // Revoke after the real body sum has read its owner domain, while the
      // stale resolved manager still carries its original role snapshot.
      const lateInput = await recordPayable('invoice-late', 'SUP-LATE'), lateBefore = await snapshot(ownerDb), lateCount = batches.length;
      let lateReached = false;
      onOwnerPayableAggregateQuery = async () => { lateReached = true; await identities.setMembershipRoles(manager.membership.membership_id, []); };
      try {
        const late = await invoker.invokeMutation(lateInput, manager.identity);
        assert.equal(lateReached, true, 'late revocation reached the actual body Require aggregate source query');
        assert.ok('error' in late, JSON.stringify(late)); assert.equal(late.error.code, 'forbidden');
        const lateAfter = await snapshot(ownerDb);
        if (batches.length === lateCount) assert.deepEqual(lateAfter, lateBefore);
        for (const name of new Set([...Object.keys(lateBefore), ...Object.keys(lateAfter)])) {
          if (!['receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name)) assert.deepEqual(lateAfter[name], lateBefore[name], name);
        }
        for (const batch of batches.slice(lateCount)) { emptyEffects(batch); assert.equal(batch.receipt?.outcome.status, 'rejected'); }
      } finally {
        onOwnerPayableAggregateQuery = undefined;
        await identities.setMembershipRoles(manager.membership.membership_id, [{ role: 'supplier.budget_manager', granted_at: new Date(now).toISOString(), granted_by: manager.user.user_id }]);
      }
      // Cover every operation/return branch and both existing replay entry
      // points without multiplying unchanged adapter checks for each receipt.
      for (const [original, resultId, mode] of [[payableInput, payable.id, 'physical'], [againInput, payable.id, 'retained'],
        [returnInput, returned.id, 'retained'], [returnAgain, returned.id, 'physical']] as const) await realReceipt(original, resultId, mode);
      assert.equal(await captureIsCurrent(capture), true);
      for (let index = 0; index < fixture.originalInputPaths.length; index++) assert.deepEqual(await readFile(fixture.originalInputPaths[index]!), fixture.originalBytes[index]);
    } finally { try { await worker?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
