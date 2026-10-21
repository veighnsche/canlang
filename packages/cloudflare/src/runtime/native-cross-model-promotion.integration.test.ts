/** A checked first query, two different creates, and one returned model run together in State. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact } from '@canlang/contracts';
import { finalizeProviderOutput, observeFinalizedFile, recordAttachment,
  revalidateRetainedFinalizedFile } from '@canlang/files/finalize';
import { TestOnlyCounterFileIds, TestOnlyCounterIntentIds, TestOnlyMemoryBlobStore,
  TestOnlyMemoryFinalizedStore, TestOnlyMemoryIntentStore } from '@canlang/files/ports';
import { DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/native-cross-model-promotion.can');
const handoffSource = join(root, 'packages/cloudflare/test/fixtures/native-cross-model-handoff.can');
const requiredSetSource = join(root, 'packages/cloudflare/test/fixtures/native-created-result-required-set.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const dealModel = asModel('CrossModelPromotion.Deal');
const intakeModel = asModel('CrossModelPromotion.Intake');

function operationId(now: number): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('commits one cross-model promotion, replays its selected result, and rejects changed evidence',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-cross-model-promotion-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const now = Date.now(), clock = createFrozenClock(now);
      const identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'promoter@example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = `promotion-${randomBytes(8).toString('hex')}`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const store = createMemoryStorage();
      const sourceId = asId('source-1');
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('CrossModelPromotion.Source'),
          row: { ...makeRow({ id: sourceId, data: { active: true } }), parent: null } },
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const lead = { source: { id: sourceId, version: '1' }, title: 'Reviewed lead' };
      const invoke = (key: string, title = lead.title) => invoker.invokeMutation({
        operation: 'CrossModelPromotion.promote', operation_id: operationId(now),
        inputs: { key, lead: { ...lead, title } },
      }, identity);

      const fresh = await invoke('lead:one');
      assert.ok('result' in fresh, JSON.stringify(fresh));
      assert.equal(fresh.result.status, 'committed');
      const createdId = (fresh.result.result as { id: string }).id;
      const deals = await store.query({ model: dealModel, authority: 'owner' });
      const intakes = await store.query({ model: intakeModel, authority: 'owner' });
      assert.equal(deals.length, 1);
      assert.equal(intakes.length, 1);
      assert.equal(deals[0]!.id, createdId);
      assert.equal((intakes[0]!.data.deal as { id: string }).id, createdId);
      assert.equal((intakes[0]!.data.lead as { title: string }).title, lead.title);

      const replay = await invoke('lead:one');
      assert.ok('result' in replay, JSON.stringify(replay));
      assert.equal(replay.result.status, 'committed');
      assert.equal((replay.result.result as { id: string }).id, createdId);
      assert.equal((await store.query({ model: dealModel, authority: 'owner' })).length, 1);
      assert.equal((await store.query({ model: intakeModel, authority: 'owner' })).length, 1);

      const changed = await invoke('lead:one', 'Changed approval');
      assert.ok('error' in changed, JSON.stringify(changed));
      assert.equal(changed.error.code, 'rule_failed');
      assert.equal((await store.query({ model: dealModel, authority: 'owner' })).length, 1);
      assert.equal((await store.query({ model: intakeModel, authority: 'owner' })).length, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('observes an absent repair, joins a child create, and stores its returned reference atomically',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-cross-model-handoff-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, handoffSource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: handoffSource }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const now = Date.now(), clock = createFrozenClock(now);
      const identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'handoff@example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = `handoff-${randomBytes(8).toString('hex')}`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const store = createMemoryStorage();
      const location = asId('location-1'), asset = asId('asset-1'), ticket = asId('ticket-1');
      const photoTicket = asId('ticket-2');
      const locationModel = asModel('CrossModelHandoff.Location');
      const assetModel = asModel('CrossModelHandoff.Asset');
      const ticketModel = asModel('CrossModelHandoff.Ticket');
      const repairModel = asModel('CrossModelHandoff.Repair');
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: locationModel,
          row: { ...makeRow({ id: location, data: { active: true } }), parent: null } },
        { kind: 'insert', model: assetModel,
          row: { ...makeRow({ id: asset, data: { location: { id: location }, active: true } }), parent: null } },
        { kind: 'insert', model: ticketModel,
          row: { ...makeRow({ id: ticket, data: { location: { id: location }, subject: 'Router offline', repair: null } }), parent: null } },
        { kind: 'insert', model: ticketModel,
          row: { ...makeRow({ id: photoTicket, data: { location: { id: location }, subject: 'Display broken', repair: null } }), parent: null } },
      ] }));
      const receiver = { app: 'CrossModelHandoff', team: team.team_id, owner: team.team_id,
        principal: user.user_id };
      const retention = { unattachedHorizonMs: 3_600_000, retentionMs: 86_400_000 };
      const fileClock = { nowMs: () => now };
      const intents = new TestOnlyMemoryIntentStore(), blobs = new TestOnlyMemoryBlobStore();
      const finalized = new TestOnlyMemoryFinalizedStore();
      const upload = { clock: fileClock, intents, blobs, intentIds: new TestOnlyCounterIntentIds(),
        policy: DEFAULT_FILE_POLICY, intentTtlMs: 60_000, urlBase: 'https://files.example.test' };
      const physical = { clock: fileClock, intents, blobs, files: finalized, fileIds: new TestOnlyCounterFileIds() };
      const output = finalizeProviderOutput(upload, physical, { receiver,
        binding: { adapter: 'test-photo-provider', deliveryId: 'photo-delivery-1', resultPath: 'outputs/0/image' },
        operation: 'CrossModelHandoff.handoff', field: '/photo', args: {}, name: 'display.png',
        claimedType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]) });
      assert.equal(output.status, 'finalized');
      const photoRef = output.file.id;
      let fileAccesses = 0, retained = 0;
      const files = {
        validate: async (ref: string) => { fileAccesses++;
          return ref === photoRef && observeFinalizedFile(physical, ref as typeof photoRef, receiver,
            { policy: DEFAULT_FILE_POLICY, retention }) !== null; },
        retain: async (ref: string, record: string) => { fileAccesses++;
          assert.equal(recordAttachment(physical, ref as typeof photoRef, record, receiver).status, 'attached');
          retained++; },
        observe: async (ref: string) => { fileAccesses++;
          return observeFinalizedFile(physical, ref as typeof photoRef, receiver,
            { policy: DEFAULT_FILE_POLICY, retention }); },
        revalidate: async (saved: Parameters<typeof revalidateRetainedFinalizedFile>[1], receiving: typeof receiver) => {
          fileAccesses++;
          return revalidateRetainedFinalizedFile(physical, saved, receiving,
            { policy: DEFAULT_FILE_POLICY, retention }); },
      };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now,
        files });
      const invoke = (recordId: string, version: string, photo?: { readonly id: string },
        id = operationId(now)) => invoker.invokeMutation({
        operation: 'CrossModelHandoff.handoff', operation_id: id,
        inputs: { ticket: { id: recordId, version }, asset: { id: asset, version: '1' },
          ...(photo === undefined ? {} : { photo }) },
      }, identity);

      const nonNullPhoto = await invoke(ticket, '1', { id: 'unproven-photo' });
      assert.ok('error' in nonNullPhoto, JSON.stringify(nonNullPhoto));
      assert.equal(nonNullPhoto.error.code, 'validation');
      assert.match(nonNullPhoto.error.message, /[Ff]ile/);
      assert.equal((await store.query({ model: repairModel, authority: 'owner' })).length, 0);

      const beforeNull = fileAccesses;
      const fresh = await invoke(ticket, '1');
      assert.ok('result' in fresh, JSON.stringify(fresh));
      assert.equal(fresh.result.status, 'committed');
      assert.equal(fileAccesses, beforeNull);
      const repairId = (fresh.result.result as { id: string }).id;
      const repairs = await store.query({ model: repairModel, authority: 'owner' });
      const tickets = await store.query({ model: ticketModel, authority: 'owner' });
      assert.equal(repairs.length, 1);
      assert.equal(repairs[0]!.id, repairId);
      assert.equal(repairs[0]!.parent?.id, asset);
      assert.equal(tickets.length, 2);
      assert.equal((tickets.find(row => row.id === ticket)!.data.repair as { id: string }).id, repairId);

      const repeated = await invoke(ticket, String(tickets.find(row => row.id === ticket)!.version));
      assert.ok('error' in repeated, JSON.stringify(repeated));
      assert.equal(repeated.error.code, 'rule_failed');
      assert.equal((await store.query({ model: repairModel, authority: 'owner' })).length, 1);
      assert.deepEqual((await store.query({ model: ticketModel, authority: 'owner' })).find(row => row.id === ticket)!.data.repair,
        tickets.find(row => row.id === ticket)!.data.repair);

      const photoOperationId = operationId(now);
      const withPhoto = await invoke(photoTicket, '1', { id: photoRef }, photoOperationId);
      assert.ok('result' in withPhoto, JSON.stringify(withPhoto));
      assert.equal(withPhoto.result.status, 'committed');
      const photoRepair = (await store.query({ model: repairModel, authority: 'owner' }))
        .find(row => row.id === (withPhoto.result.result as { id: string }).id);
      assert.equal((photoRepair?.data.photo as { id: string }).id, photoRef);
      assert.ok(fileAccesses > beforeNull);
      assert.ok(retained > 0);
      const replayPhoto = await invoke(photoTicket, '1', { id: photoRef }, photoOperationId);
      assert.ok('result' in replayPhoto, JSON.stringify(replayPhoto));
      assert.equal((replayPhoto.result.result as { id: string }).id, photoRepair!.id);
      assert.equal((await store.query({ model: repairModel, authority: 'owner' })).length, 2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('creates a result, sets an original required model input, and returns the same row',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-created-result-required-set-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, requiredSetSource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: requiredSetSource }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const now = Date.now(), clock = createFrozenClock(now);
      const identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'required-set@example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = `required-set-${randomBytes(8).toString('hex')}`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const store = createMemoryStorage();
      const invoiceId = asId('invoice-1');
      const invoiceModel = asModel('CrossModelRequiredSet.Invoice');
      const payableModel = asModel('CrossModelRequiredSet.Payable');
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: invoiceModel,
          row: { ...makeRow({ id: invoiceId, data: { payable: null } }), parent: null } },
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const invoke = (version: string) => invoker.invokeMutation({
        operation: 'CrossModelRequiredSet.accept', operation_id: operationId(now),
        inputs: { invoice: { id: invoiceId, version }, amount: '7' },
      }, identity);

      const fresh = await invoke('1');
      assert.ok('result' in fresh, JSON.stringify(fresh));
      assert.equal(fresh.result.status, 'committed');
      const payableId = (fresh.result.result as { id: string }).id;
      const payables = await store.query({ model: payableModel, authority: 'owner' });
      const invoices = await store.query({ model: invoiceModel, authority: 'owner' });
      assert.equal(payables.length, 1);
      assert.equal(payables[0]!.id, payableId);
      assert.equal(payables[0]!.data.amount, '7');
      assert.equal((invoices[0]!.data.payable as { id: string }).id, payableId);

      const repeated = await invoke(String(invoices[0]!.version));
      assert.ok('error' in repeated, JSON.stringify(repeated));
      assert.equal(repeated.error.code, 'rule_failed');
      assert.equal((await store.query({ model: payableModel, authority: 'owner' })).length, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
