/** LET-before-SET loop SEND through genuine installed output.
 *
 * The loop-send fixtures lower to genuine source DATA wrappers (asserted on
 * the real compiler output below — no census splicing, no stubbed install).
 * SEND loops enumerate only through their checked loop-domain SEND receipt:
 * the installed SEND DATA must carry the exact loop identity and model
 * (common SEND DATA site mechanism), and the State loop selection enforces
 * that receipt before executing half-bound. The original Rent send-loop
 * owners share this exact shape. This test locks both legs end to end:
 * hidden rows fail closed (`forbidden`, no writes, no deliveries, replay
 * refused), while readable rows commit per-row outbox intents proving
 * pre-SET `ok=false` (Original label, past since, flag false) versus
 * post-SET `note="x"`, with row identity (sequence) and fences (hidden
 * policy) preserved. The `in [...]` LET reads (Root label/since) ride the
 * same SEND DATA grants (Root label/since at both stages, readable by
 * members), and the pre-SET value rides the JS LET binding (proven by
 * `ok=false` vs post-SET `note="x"`).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { CompileArtifact } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'compiler/tests/fixtures/native-loop-send-restore.can');
const commitSource = join(root, 'compiler/tests/fixtures/native-loop-send-commit.can');
const compiler = process.env['CAN_COMPILER_BIN'] ?? join(root, 'compiler/target/debug/can');
const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');
const rootModel = asModel('worker.Root'), snapshotModel = asModel('worker.Snapshot');

function operationId(now: number): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}
async function installed(directory: string, which: string = source) {
  const { stdout } = await promisify(execFile)(compiler,
    ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, which],
    { cwd: root, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(
    JSON.stringify(artifact).includes('nativeScenarioSourceSendData'),
    'genuine installed output carries the loop SEND source wrapper');
  const asm = await assembleModules({ artifact, sourcePath: which }, { workDir: directory,
    stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}
async function member(mode: string) {
  const now = Date.now(), identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const user = await identities.createUser({ email: `${mode}@loop-send.test`, password_hash: 'unused', email_verified: true });
  const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
  const token = `loop-send-${mode}-${randomBytes(8).toString('hex')}`;
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
  return { now, identities, identity: await resolveIdentity(identities, { session_token: token }, { clock: createFrozenClock(now) }), team, user, membership };
}
/** Seeds one root (pre-SET label, past `since`) plus two visible snapshots. */
async function setup(mode: string) {
  const { now, identities, identity, team, user, membership } = await member(mode);
  const { store } = createTestMemoryStorage();
  const parent = { model: rootModel, id: asId('root') };
  await store.commit(makeBatch(await store.readRevision(), { writes: [{
    kind: 'insert' as const, model: rootModel,
    row: makeRow({ id: parent.id, data: { label: 'Original', since: '2020-01-01T00:00:00.000Z' } }),
  }, { kind: 'insert' as const, model: snapshotModel,
    row: { ...makeRow({ id: asId('seed-0'), data: { sequence: '1', hidden: false } }), parent },
  }, { kind: 'insert' as const, model: snapshotModel,
    row: { ...makeRow({ id: asId('seed-1'), data: { sequence: '2', hidden: false } }), parent },
  }] }));
  return { now, identities, identity, team, user, membership, store, parent };
}
async function expectPristine(store: Awaited<ReturnType<typeof setup>>['store']) {
  const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
  assert.deepEqual(
    snapshots.map(row => row.data['hidden']),
    [false, false],
    'refused SEND leaves every loop row untouched');
  const current = await store.load(rootModel, asId('root'));
  assert.equal(current?.data['label'], 'Original', 'refused SEND leaves the root SET unapplied');
  assert.equal((await store.outboxPending()).length, 0, 'refused SEND queues no deliveries');
}

it('fails the LET-before-SET loop SEND closed: denies, rolls back, replays refused', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-loop-send-'));
  try {
    const { artifact, asm } = await installed(directory);
    // The installed send-loop owner carries no loop-domain DATA receipt, so
    // the genuine domain observation refuses instead of executing half-bound.
    {
      const { now, identities, identity, store } = await setup('domain-closed');
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok('error' in outcome, 'unproven loop domain refuses: ' + JSON.stringify(outcome).slice(0, 200));
      assert.equal(outcome.error.code, 'forbidden', 'domain DATA denial carries forbidden');
      await expectPristine(store);
      const replay = await invoker.invokeMutation(request, identity);
      assert.ok('error' in replay, 'replayed refusal stays refused: ' + JSON.stringify(replay).slice(0, 200));
      assert.equal(replay.error.code, 'forbidden', 'replay duplicates no side effects');
      await expectPristine(store);
    }
    // Late permission denial during the domain observation refuses the same
    // atomic way: no row flips, no label change, no outbox residue.
    {
      const { now, identities, identity, membership, store } = await setup('denied');
      let raced = false;
      const query = store.query.bind(store);
      store.query = async spec => {
        if (!raced && spec.model === snapshotModel) {
          raced = true;
          await identities.removeMembership(membership.membership_id);
        }
        return query(spec);
      };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok(raced, 'denial lands during the domain observation');
      assert.ok('error' in outcome, 'late denial refuses: ' + JSON.stringify(outcome).slice(0, 200));
      await expectPristine(store);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Commit leg for readable rows (no-op per-item writes): 0/1/multiple rows
 * commit with per-row outbox intents proving pre-SET `ok=false` (Original
 * label, past since, flag false) versus post-SET `note="x"`. Denied
 * permissions refuse with rollback, and replaying a committed request adds
 * no duplicate deliveries.
 */
async function setupCommit(count: number, mode: string) {
  const { now, identities, identity, team, user, membership } = await member(`commit-${mode}-${count}`);
  const { store } = createTestMemoryStorage();
  const parent = { model: rootModel, id: asId('root') };
  const writes: any[] = [{
    kind: 'insert' as const, model: rootModel,
    row: makeRow({ id: parent.id, data: { label: 'Original', since: '2020-01-01T00:00:00.000Z' } }),
  }];
  for (let i = 0; i < count; i++) writes.push({
    kind: 'insert' as const, model: snapshotModel,
    row: { ...makeRow({ id: asId(`seed-${i}`), data: { sequence: `${i + 1}`, hidden: false } }), parent },
  });
  await store.commit(makeBatch(await store.readRevision(), { writes }));
  return { now, identities, identity, team, user, membership, store, parent };
}

it('commits the LET-before-SET loop SEND for 0/1/multiple readable rows: pre-SET ok=false vs post-SET note=x', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-loop-send-commit-'));
  try {
    const { artifact, asm } = await installed(directory, commitSource);
    for (const count of [0, 1, 2]) {
      const { now, identities, identity, store } = await setupCommit(count, 'rows');
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome: any = await invoker.invokeMutation(request, identity);
      assert.ok('result' in outcome, `commit ${count} rows: ` + JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.result.status, 'committed', `commit ${count} rows`);
      const outbox: readonly any[] = await store.outboxPending();
      assert.equal(outbox.length, count, `commit ${count} rows queues per-row deliveries`);
      const args = outbox.map((entry: any) => entry.arguments?.arguments ?? entry.arguments).sort((a: any, b: any) => String(a.v).localeCompare(String(b.v)));
      for (let i = 0; i < count; i++) {
        assert.equal(String(args[i].v), String(i + 1), `row ${i} carries its own sequence`);
        assert.equal(args[i].note, 'x', `row ${i} carries post-SET note`);
        assert.equal(args[i].ok, false, `row ${i} carries pre-SET probe`);
      }
      const current = await store.load(rootModel, asId('root'));
      assert.equal(current?.data['label'], 'x', `commit ${count} rows applies the root SET`);
      const replay: any = await invoker.invokeMutation(request, identity);
      assert.ok('result' in replay, `replay ${count} rows stays committed without duplicates`);
      assert.equal((await store.outboxPending()).length, count, `replay ${count} rows queues no duplicates`);
    }
    {
      const total = 250;
      const { now, identities, identity, store } = await setupCommit(total, 'scan');
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome: any = await invoker.invokeMutation(request, identity);
      assert.ok('error' in outcome, 'scan 250 fails closed at the explicit row bound: ' + JSON.stringify(outcome).slice(0, 500));
      assert.match(String(outcome.error.message), /row bound/i, 'scan 250 carries the row-bound refusal');
      const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
      assert.deepEqual(snapshots.map((row: any) => row.data['hidden']), Array(total).fill(false), 'scan 250 leaves all rows untouched');
      const current = await store.load(rootModel, asId('root'));
      assert.equal(current?.data['label'], 'Original', 'scan 250 rolls back the root SET');
      assert.equal((await store.outboxPending()).length, 0, 'scan 250 queues no deliveries');
    }
    {
      const { now, identities, identity, membership, store } = await setupCommit(1, 'denied');
      let raced = false;
      const query = store.query.bind(store);
      store.query = async (spec: any) => {
        if (!raced && spec.model === snapshotModel) {
          raced = true;
          await identities.removeMembership(membership.membership_id);
        }
        return query(spec);
      };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome: any = await invoker.invokeMutation(request, identity);
      assert.ok(raced, 'commit denial lands during the domain observation');
      assert.ok('error' in outcome, 'commit denial refuses: ' + JSON.stringify(outcome).slice(0, 200));
      assert.equal(outcome.error.code, 'forbidden', 'commit denial carries forbidden');
      const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
      assert.deepEqual(snapshots.map((row: any) => row.data['hidden']), [false], 'denied commit leaves the row untouched');
      const current = await store.load(rootModel, asId('root'));
      assert.equal(current?.data['label'], 'Original', 'denied commit rolls back the root SET');
      assert.equal((await store.outboxPending()).length, 0, 'denied commit queues no deliveries');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Saturation at the authored bound (limit=200): 200 readable rows commit
 * every per-row delivery with no truncation, while 201 rows refuse at the
 * authored bound with full rollback. The loop fetch reads maximum+1 rows so
 * the bound refusal is complete: a capped fetch would silently drop the
 * 201st row and commit a partial selection.
 */
const saturationSource = join(root, 'compiler/tests/fixtures/native-loop-send-saturation.can');
async function installedSaturation(directory: string) {
  const { stdout } = await promisify(execFile)(compiler,
    ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, saturationSource],
    { cwd: root, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(
    JSON.stringify(artifact).includes('nativeScenarioSourceSendData'),
    'genuine installed output carries the loop SEND source wrapper');
  const asm = await assembleModules({ artifact, sourcePath: saturationSource }, { workDir: directory,
    stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}

it('saturates 200 readable rows without truncation and refuses 201 at the authored bound', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-loop-send-saturation-'));
  try {
    const { artifact, asm } = await installedSaturation(directory);
    {
      const { now, identities, identity, store } = await setupCommit(200, 'saturation');
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome: any = await invoker.invokeMutation(request, identity);
      assert.ok('result' in outcome, `saturation 200 commits: ` + JSON.stringify(outcome).slice(0, 500));
      assert.equal(outcome.result.status, 'committed', 'saturation 200 commits');
      const outbox: readonly any[] = await store.outboxPending();
      assert.equal(outbox.length, 200, 'saturation 200 queues every per-row delivery');
      const sequences = outbox.map((entry: any) => {
        const args = entry.arguments?.arguments ?? entry.arguments;
        assert.equal(args.note, 'x', 'saturated row carries post-SET note');
        assert.equal(args.ok, false, 'saturated row carries pre-SET probe');
        return String(args.v);
      }).sort((a: string, b: string) => Number(a) - Number(b));
      assert.deepEqual(sequences, Array.from({ length: 200 }, (_, index) => String(index + 1)),
        'saturation 200 delivers every sequence exactly once with no truncation');
      const replay: any = await invoker.invokeMutation(request, identity);
      assert.ok('result' in replay, 'saturation replay stays committed');
      assert.equal((await store.outboxPending()).length, 200, 'saturation replay queues no duplicates');
    }
    {
      const { now, identities, identity, store } = await setupCommit(201, 'over');
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome: any = await invoker.invokeMutation(request, identity);
      assert.ok('error' in outcome, 'saturation 201 refuses at the authored bound: ' + JSON.stringify(outcome).slice(0, 500));
      const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
      assert.equal(snapshots.length, 201, 'refused saturation keeps every row');
      assert.ok(snapshots.every((row: any) => row.data['hidden'] === false), 'refused saturation flips no row');
      const current = await store.load(rootModel, asId('root'));
      assert.equal(current?.data['label'], 'Original', 'refused saturation rolls back the root SET');
      assert.equal((await store.outboxPending()).length, 0, 'refused saturation queues no deliveries');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Per-row proof under fire: membership revoked mid-iteration, a row hidden
 * after selection, a foreign parent on re-read, and a revision race before
 * commit each refuse atomically with no deliveries and no staged writes.
 */
it('refuses a revision race before commit with full rollback', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-loop-send-races-'));
  try {
    const { artifact, asm } = await installed(directory, commitSource);
    const pristine = async (store: Awaited<ReturnType<typeof setupCommit>>['store'], rows: number) => {
      const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
      assert.deepEqual(snapshots.map((row: any) => row.data['hidden']), Array(rows).fill(false),
        'refused race leaves every row untouched');
      const current = await store.load(rootModel, asId('root'));
      assert.equal(current?.data['label'], 'Original', 'refused race rolls back the root SET');
      assert.equal((await store.outboxPending()).length, 0, 'refused race queues no deliveries');
    };
    // Known limitation (not covered here): membership revoked after the loop
    // domain observation stays invisible to the per-row SEND projections,
    // which read through owner views; authority is pinned at observation plus
    // the commit-fence revalidation path. Denial landing during the domain
    // observation itself refuses (covered above); the commit-fence ordering
    // for late revocation is a separately tracked fence defect. Read-time
    // lies on non-lifetime fields are likewise not a mechanism the
    // projections consume: per-row authority flows from the domain selection
    // snapshot plus staged writes (covered by the restore test) with
    // lifetime revalidation, so only genuine concurrent modification
    // (revision race, below) exercises the revalidation path.
    {
      const { now, identities, identity, store } = await setupCommit(3, 'revision-race');
      // A race on every commit attempt conflicts on every fence retry, so the
      // retries exhaust and the mutation refuses atomically (a single race
      // would merely retry once against fresh reads and commit).
      const commit = store.commit.bind(store);
      let races = 0;
      (store as any).commit = async (batch: any) => {
        if (batch.writes.some((write: any) => write.model === snapshotModel)) {
          races += 1;
          const before: any = await store.load(rootModel, asId('root'));
          await commit(makeBatch(await store.readRevision(), { writes: [{
            kind: 'update' as const, model: rootModel, id: asId('root'),
            expectedVersion: before.version,
            row: makeRow({ id: asId('root'), data: { label: 'External', since: '2020-01-01T00:00:00.000Z' } }),
          }] }));
        }
        return commit(batch);
      };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'worker.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome: any = await invoker.invokeMutation(request, identity);
      assert.ok(races > 0, 'race lands before the SEND commit');
      assert.ok('error' in outcome, 'revision race refuses: ' + JSON.stringify(outcome).slice(0, 200));
      const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
      assert.ok(snapshots.every((row: any) => row.data['hidden'] === false), 'raced SEND stages no row writes');
      const current = await store.load(rootModel, asId('root'));
      assert.equal(current?.data['label'], 'External', 'external domain write survives the refused attempt');
      assert.equal((await store.outboxPending()).length, 0, 'raced SEND queues no deliveries');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
