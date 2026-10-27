/** Partitioned native receipt plan-sets and constructor COUNT stages.
 *
 * Genuine end-to-end proofs against the real compiler and the real runtime:
 * a partitioned scenario owner installs as one ordered copy set, executions
 * resolve returns from different copies through the installed index, tamper
 * variants refuse, and constructor COUNT stages reconcile sealed loop-prefix
 * writes without trusting caller stages.
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
import type { AssembledModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fixture = (name: string) => join(root, 'packages/cloudflare/test/fixtures', name);
const compiler = process.env['CAN_COMPILER_BIN'] ?? join(root, 'compiler/target/debug/can');
const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');
function operationId(now: number): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}
async function installed(source: string, directory: string) {
  const { stdout } = await promisify(execFile)(compiler,
    ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
    { cwd: root, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
    stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}
/** Compiles and checks the compiler's native precedingArmWrites publication for
 * the looped_after_arm COUNT profiles. When `census` parses equal to the
 * natively published census the artifact ships unchanged, proving the genuine
 * native path end to end. Otherwise every native census entry is rewritten to
 * `census` before module assembly, so the assembly fence still covers the
 * shipped bytes and a mispublished census exercises the runtime fail-closed
 * path on the same bytes the old test-only splice used to publish. */
async function installedWithArmCensus(source: string, directory: string, census: string) {
  const { stdout } = await promisify(execFile)(compiler,
    ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
    { cwd: root, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.keys(nested).sort().map(key => [key, (nested as Record<string, unknown>)[key]]))
      : nested);
  const wanted = canonical([JSON.parse(census)]);
  let found = 0;
  for (const module of artifact.modules ?? []) {
    if (typeof module.js !== 'string' || !module.js.includes('loop_shapes.looped_after_arm')) continue;
    module.js = module.js.replace(
      /("owner":"loop_shapes\.looped_after_arm".*?"precedingArmWrites":)(\[[^\]]*\])/g,
      (whole, head: string, body: string) => {
        found += 1;
        return canonical(JSON.parse(body)) === wanted ? whole : `${head}[${census}]`;
      });
  }
  assert.equal(found, 2, 'both looped_after_arm COUNT profiles carry a native arm census');
  const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
    stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}
/** Compiles then strips the natively published precedingArmWrites census from
 * the looped_after_arm COUNT profiles, yielding a genuine pre-census artifact:
 * the runtime must keep refusing a preceding taken-arm write instead of
 * trusting a missing publication. */
async function installedWithoutArmCensus(source: string, directory: string) {
  const { stdout } = await promisify(execFile)(compiler,
    ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
    { cwd: root, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  let stripped = 0;
  for (const module of artifact.modules ?? []) {
    if (typeof module.js !== 'string' || !module.js.includes('loop_shapes.looped_after_arm')) continue;
    module.js = module.js.replace(
      /("owner":"loop_shapes\.looped_after_arm".*?),"precedingArmWrites":\[[^\]]*\]/g,
      (_whole, head: string) => {
        stripped += 1;
        return head;
      });
  }
  assert.equal(stripped, 2, 'both looped_after_arm COUNT profiles lose their census');
  const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
    stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}
async function member(mode: string) {
  const now = Date.now(), identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const user = await identities.createUser({ email: `${mode}@partitioned.test`, password_hash: 'unused', email_verified: true });
  const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
  const token = `partitioned-${mode}-${randomBytes(8).toString('hex')}`;
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
  return { now, identities, team, user, membership,
    identity: await resolveIdentity(identities, { session_token: token }, { clock: createFrozenClock(now) }) };
}
type Disclosure = NonNullable<NonNullable<CompileArtifact['operations']>[number]['result']>['disclosure'];
function copiesOf(disclosure: Disclosure): readonly NonNullable<Exclude<Disclosure, readonly unknown[]>>[] {
  assert.ok(Array.isArray(disclosure), 'expected a partitioned copy-plan array');
  return disclosure as unknown as readonly NonNullable<Exclude<Disclosure, readonly unknown[]>>[];
}

it('installs a partitioned plan set and resolves returns from different copies', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-partitioned-set-'));
  try {
    const source = fixture('partitioned-wide-source.can');
    const { artifact, asm } = await installed(source, directory);
    const operation = artifact.operations?.find(item => item.name === 'wide_shapes.wide');
    assert.ok(operation);
    const copies = copiesOf(operation.result?.disclosure);
    assert.equal(copies.length, 2);
    assert.deepEqual(copies.map(copy => copy.returns.length), [200, 56]);
    assert.equal(copies[0]!.version, 1);
    assert.deepEqual(copies[0]!.source, copies[1]!.source);
    const seen = new Set<string>();
    for (const copy of copies) for (const returned of copy.returns) {
      assert.ok(!seen.has(returned.id), 'installed union keeps globally unique return ids');
      seen.add(returned.id);
    }
    assert.equal(seen.size, 256);
    const { now, identities, identity, team, user } = await member('wide-install');
    const { store } = createTestMemoryStorage();
    const rootModel = asModel('wide_shapes.Root');
    await store.commit(makeBatch(await store.readRevision(), { writes: [{
      kind: 'insert' as const, model: rootModel, row: makeRow({ id: asId('root'), data: { label: 'Original' } }),
    }] }));
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
    const flags = (value: readonly boolean[]) => Object.fromEntries(value.map((flag, index) => [`f${index}`, flag]));
    const combos: ReadonlyArray<readonly boolean[]> = [
      [false, false, false, false, false, false, false, false],
      [true, true, true, true, true, true, true, true],
      [true, false, false, false, false, false, false, false],
      [false, true, true, true, true, true, true, true],
      [true, false, true, false, true, false, true, false],
      [false, true, false, true, false, true, false, true],
    ];
    const hit = [false, false];
    let replayed: { operationId: string; returnId: string } | undefined;
    for (const combo of combos) {
      const current = await store.load(rootModel, asId('root'));
      assert.ok(current);
      const request = { operation: 'wide_shapes.wide', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: String(current.version) }, ...flags(combo) } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok('result' in outcome, 'genuine partitioned execution commits: ' + JSON.stringify(outcome).slice(0, 300));
      const saved = await store.readReceipt({ app: 'Partitioned', owner: team.team_id,
        principal: user.user_id, operation: request.operation, operationId: request.operation_id } as Parameters<typeof store.readReceipt>[0]);
      assert.ok(saved);
      assert.ok(saved.outcome.status === 'committed' && saved.outcome.scenario);
      const association = saved.outcome.scenario;
      const index = copies.findIndex(copy => copy.returns.some(returned => returned.id === association.returnId));
      assert.ok(index >= 0, 'executed return resolves into exactly one installed copy');
      hit[index] = true;
      // The saved receipt carries the exact bound copy, never a caller shard.
      assert.deepEqual(JSON.parse(JSON.stringify(association.plan)), JSON.parse(JSON.stringify(copies[index])));
      const replay = await invoker.invokeMutation(request, identity);
      assert.ok('result' in replay && replay.result.status === 'replayed', 'same installed set replays: ' + JSON.stringify(replay).slice(0, 200));
      replayed = { operationId: request.operation_id, returnId: association.returnId };
    }
    assert.deepEqual(hit, [true, true], 'genuine executions resolve returns from different copies');
    assert.ok(replayed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('refuses tampered partitioned plan sets while the prior set still verifies', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-partitioned-tamper-'));
  try {
    const source = fixture('partitioned-wide-source.can');
    const { artifact, asm } = await installed(source, directory);
    const operation = artifact.operations?.find(item => item.name === 'wide_shapes.wide');
    assert.ok(operation?.result?.disclosure && Array.isArray(operation.result.disclosure));
    const genuine = JSON.parse(JSON.stringify(operation.result.disclosure)) as unknown[];
    const clone = () => JSON.parse(JSON.stringify(artifact)) as CompileArtifact;
    const tampered = (mutate: (copies: any[]) => void): CompileArtifact => {
      const next = clone();
      const target = next.operations?.find(item => item.name === 'wide_shapes.wide');
      assert.ok(target?.result?.disclosure && Array.isArray(target.result.disclosure));
      mutate(target.result.disclosure as unknown[]);
      return next;
    };
    const combos: ReadonlyArray<readonly boolean[]> = [
      [false, false, false, false, false, false, false, false],
      [true, true, true, true, true, true, true, true],
      [true, false, false, false, false, false, false, false],
      [false, true, true, true, true, true, true, true],
    ];
    const flags = (value: readonly boolean[]) => Object.fromEntries(value.map((flag, index) => [`f${index}`, flag]));
    // Discover one combo per installed copy against the genuine artifact.
    const probe = await (async () => {
      const { now, identities, identity, team, user } = await member('tamper-probe');
      const { store } = createTestMemoryStorage();
      const rootModel = asModel('wide_shapes.Root');
      await store.commit(makeBatch(await store.readRevision(), { writes: [{
        kind: 'insert' as const, model: rootModel, row: makeRow({ id: asId('root'), data: { label: 'Original' } }),
      }] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const found: Array<readonly boolean[] | undefined> = [undefined, undefined];
      for (const combo of combos) {
        const current = await store.load(rootModel, asId('root'));
        assert.ok(current);
        const request = { operation: 'wide_shapes.wide', operation_id: operationId(now),
          inputs: { root: { id: 'root', version: String(current.version) }, ...flags(combo) } };
        const outcome = await invoker.invokeMutation(request, identity);
        assert.ok('result' in outcome);
        const saved = await store.readReceipt({ app: 'Partitioned', owner: team.team_id,
          principal: user.user_id, operation: request.operation, operationId: request.operation_id } as Parameters<typeof store.readReceipt>[0]);
        assert.ok(saved);
        assert.ok(saved.outcome.status === 'committed' && saved.outcome.scenario);
        const probed = saved.outcome.scenario;
        const index = (genuine as any[]).findIndex((copy: any) =>
          copy.returns.some((returned: any) => returned.id === probed.returnId));
        assert.ok(index >= 0);
        found[index] ??= combo;
        if (found[0] !== undefined && found[1] !== undefined) break;
      }
      assert.ok(found[0] !== undefined && found[1] !== undefined, 'probe reaches both installed copies');
      return found as [readonly boolean[], readonly boolean[]];
    })();
    // Each mutated transport is reassembled once so the assembly fence passes
    // on identical bytes and State's own custody validation decides genuinely.
    // The assembly stays fixed per candidate: reassembly would trip the
    // original-assembly fence independently of the disclosure under test.
    const assembled = new Map<CompileArtifact, Awaited<ReturnType<typeof assembleModules>>>();
    const attempt = async (candidate: CompileArtifact, combo: readonly boolean[], label: string) => {
      const { now, identities, identity } = await member(`tamper-${label}`);
      const { store } = createTestMemoryStorage();
      const rootModel = asModel('wide_shapes.Root');
      await store.commit(makeBatch(await store.readRevision(), { writes: [{
        kind: 'insert' as const, model: rootModel, row: makeRow({ id: asId('root'), data: { label: 'Original' } }),
      }] }));
      let candidateAsm = assembled.get(candidate);
      if (candidateAsm === undefined) {
        candidateAsm = await assembleModules({ artifact: candidate, sourcePath: source }, { workDir: join(directory, `asm-${assembled.size}`),
          stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
        assembled.set(candidate, candidateAsm);
      }
      const invoker = buildInvoker(candidate, candidateAsm, store, { memberships: identities, now: () => now });
      const request = { operation: 'wide_shapes.wide', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, ...flags(combo) } };
      return invoker.invokeMutation(request, identity);
    };
    const flip = (text: string) => (text[0] === 'a' ? 'b' : 'a') + text.slice(1);
    const variants: ReadonlyArray<{ label: string; mutate: (copies: any[]) => void }> = [
      { label: 'mutated-copy-shell', mutate: copies => { copies[1]!.source.path = 'tampered.can'; } },
      { label: 'reordered-set', mutate: copies => { copies.reverse(); } },
      { label: 'duplicate-return-id', mutate: copies => { copies[1]!.returns[0]!.id = copies[0]!.returns[0]!.id; } },
      { label: 'header-drift', mutate: copies => { copies[1]!.source.sha256 = flip(copies[1]!.source.sha256); } },
    ];
    for (const variant of variants) {
      for (const copyIndex of [0, 1] as const) {
        const outcome = await attempt(tampered(variant.mutate), probe[copyIndex], `${variant.label}-${copyIndex}`);
        assert.ok('error' in outcome, `${variant.label} copy ${copyIndex} must refuse: ` + JSON.stringify(outcome).slice(0, 200));
      }
    }
    // A mutated return identity refuses exactly its own path while the installed set stays intact.
    const probeId = await (async () => {
      const { now, identities, identity, team, user } = await member('tamper-id-probe');
      const { store } = createTestMemoryStorage();
      const rootModel = asModel('wide_shapes.Root');
      await store.commit(makeBatch(await store.readRevision(), { writes: [{
        kind: 'insert' as const, model: rootModel, row: makeRow({ id: asId('root'), data: { label: 'Original' } }),
      }] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const combo = combos[0]!;
      const current = await store.load(rootModel, asId('root'));
      assert.ok(current);
      const request = { operation: 'wide_shapes.wide', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: String(current.version) }, ...flags(combo) } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok('result' in outcome);
      const saved = await store.readReceipt({ app: 'Partitioned', owner: team.team_id,
        principal: user.user_id, operation: request.operation, operationId: request.operation_id } as Parameters<typeof store.readReceipt>[0]);
      assert.ok(saved);
      assert.ok(saved.outcome.status === 'committed' && saved.outcome.scenario);
      return saved.outcome.scenario.returnId;
    })();
    const idMutated = tampered(copies => {
      const owner = (copies as any[]).find((copy: any) => copy.returns.some((returned: any) => returned.id === probeId));
      assert.ok(owner);
      owner.returns.find((returned: any) => returned.id === probeId)!.id = flip(probeId);
    });
    const hit = await attempt(idMutated, combos[0]!, 'mutated-return-id');
    assert.ok('error' in hit, 'mutated return identity must refuse its own path: ' + JSON.stringify(hit).slice(0, 200));
    const spared = await attempt(idMutated, probe[probe[0] === combos[0] ? 1 : 0], 'mutated-return-id-spared');
    assert.ok('result' in spared, 'unrelated paths still verify after a localized mutation: ' + JSON.stringify(spared).slice(0, 200));
    // Dropped copy installs as a smaller set, then refuses the missing shard while the kept shard verifies.
    const reduced = tampered(copies => { copies.splice(1, 1); });
    const missing = await attempt(reduced, probe[1], 'dropped-copy-missing');
    assert.ok('error' in missing, 'dropped copy must refuse its missing shard: ' + JSON.stringify(missing).slice(0, 200));
    const kept = await attempt(reduced, probe[0], 'dropped-copy-kept');
    assert.ok('result' in kept, 'kept shard still verifies: ' + JSON.stringify(kept).slice(0, 200));
    // Rollback to the prior bound set re-presents identical transport and verifies genuinely.
    const { now, identities, identity } = await member('tamper-rollback');
    const { store } = createTestMemoryStorage();
    const rootModel = asModel('wide_shapes.Root');
    await store.commit(makeBatch(await store.readRevision(), { writes: [{
      kind: 'insert' as const, model: rootModel, row: makeRow({ id: asId('root'), data: { label: 'Original' } }),
    }] }));
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
    const current = await store.load(rootModel, asId('root'));
    assert.ok(current);
    const request = { operation: 'wide_shapes.wide', operation_id: operationId(now),
      inputs: { root: { id: 'root', version: String(current.version) }, ...flags(probe[1]) } };
    const outcome = await invoker.invokeMutation(request, identity);
    assert.ok('result' in outcome, 'rollback to the prior set verifies: ' + JSON.stringify(outcome).slice(0, 200));
    const replay = await invoker.invokeMutation(request, identity);
    assert.ok('result' in replay && replay.result.status === 'replayed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('admits genuine constructor COUNT over 0/1/multiple loop rows and both branches', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-partitioned-count-'));
  try {
    const source = fixture('partitioned-loop-count-source.can');
    const { artifact, asm } = await installed(source, directory);
    const operation = artifact.operations?.find(item => item.name === 'loop_shapes.looped');
    assert.ok(operation?.result?.disclosure && !Array.isArray(operation.result.disclosure));
    for (const rows of [0, 1, 3]) {
      for (const flag of [true, false]) {
        const { now, identities, identity, team, user } = await member(`looped-${rows}-${flag}`);
        const { store } = createTestMemoryStorage();
        const rootModel = asModel('loop_shapes.Root'), snapshotModel = asModel('loop_shapes.Snapshot');
        const parent = { model: rootModel, id: asId('root') };
        const siblings = Array.from({ length: rows },
          (_, index) => ({ kind: 'insert' as const, model: snapshotModel,
            row: { ...makeRow({ id: asId(`seed-${index}`), data: { sequence: String(index + 1), hidden: false } }), parent } }));
        await store.commit(makeBatch(await store.readRevision(), { writes: [{
          kind: 'insert' as const, model: rootModel, row: makeRow({ id: parent.id, data: { label: 'Original' } }),
        }, ...siblings] }));
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const request = { operation: 'loop_shapes.looped', operation_id: operationId(now),
          inputs: { root: { id: 'root', version: '1' }, flag } };
        const outcome = await invoker.invokeMutation(request, identity);
        assert.ok('result' in outcome, `looped rows=${rows} flag=${flag} commits: ` + JSON.stringify(outcome).slice(0, 300));
        const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
        assert.equal(snapshots.length, rows + 1, `looped rows=${rows} flag=${flag} creates exactly one snapshot`);
        const created = snapshots.filter(row => ![...Array(rows).keys()].some(index => row.id === `seed-${index}`));
        assert.equal(created.length, 1);
        assert.equal(created[0]!.data['sequence'], String(rows + 1), 'constructor COUNT consumes the genuine sealed prefix');
        const saved = await store.readReceipt({ app: 'LoopCount', owner: team.team_id,
          principal: user.user_id, operation: request.operation, operationId: request.operation_id } as Parameters<typeof store.readReceipt>[0]);
        assert.ok(saved);
      assert.ok(saved.outcome.status === 'committed' && saved.outcome.scenario);
        assert.deepEqual(JSON.parse(JSON.stringify(saved.outcome.scenario.plan)),
          JSON.parse(JSON.stringify(operation!.result!.disclosure)), 'saved receipt carries the installed single plan');
        const replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay && replay.result.status === 'replayed', `looped rows=${rows} flag=${flag} replays`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps constructor COUNT fail-closed on preceding taken-arm writes, late denial and revision races', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-partitioned-count-race-'));
  try {
    const source = fixture('partitioned-loop-count-source.can');
    const { artifact, asm } = await installedWithoutArmCensus(source, directory);
    const rootModel = asModel('loop_shapes.Root'), snapshotModel = asModel('loop_shapes.Snapshot');
    const setup = async (mode: string) => {
      const { now, identities, identity, team, user, membership } = await member(`count-race-${mode}`);
      const { store } = createTestMemoryStorage();
      const parent = { model: rootModel, id: asId('root') };
      await store.commit(makeBatch(await store.readRevision(), { writes: [{
        kind: 'insert' as const, model: rootModel, row: makeRow({ id: parent.id, data: { label: 'Original' } }),
      }, { kind: 'insert' as const, model: snapshotModel,
        row: { ...makeRow({ id: asId('seed-0'), data: { sequence: '1', hidden: false } }), parent },
      }] }));
      return { now, identities, identity, team, user, membership, store, parent };
    };
    // A preceding taken arm that writes shifts the sealed stage; with the
    // natively published per-arm static counts stripped (a genuine pre-census
    // artifact) the runtime keeps refusing.
    {
      const { now, identities, identity, store } = await setup('arm-taken');
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'loop_shapes.looped_after_arm', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: true, pre: true } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok('error' in outcome, 'preceding taken-arm writes fail closed: ' + JSON.stringify(outcome).slice(0, 200));
      assert.equal((await store.query({ model: snapshotModel, authority: 'owner' })).length, 1);
    }
    {
      const { now, identities, identity, store } = await setup('arm-skipped');
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'loop_shapes.looped_after_arm', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false, pre: false } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok('result' in outcome, 'skipped preceding arm still verifies: ' + JSON.stringify(outcome).slice(0, 200));
    }
    // Late denial landing mid-execution (during sealed observation reads) refuses atomically.
    {
      const { now, identities, identity, membership, store } = await setup('denial');
      const query = store.query.bind(store);
      let denied = false;
      store.query = async spec => {
        const rows = await query(spec);
        if (spec.model === snapshotModel && !denied) { denied = true; await identities.removeMembership(membership.membership_id); }
        return rows;
      };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'loop_shapes.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: true } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok(denied, 'denial lands during the COUNT observation');
      assert.ok('error' in outcome, 'late denial refuses: ' + JSON.stringify(outcome).slice(0, 200));
      assert.equal((await query({ model: snapshotModel, authority: 'owner' })).length, 1, 'denied COUNT rolls back atomically');
    }
    // A revision race between COUNT consumption and commit conflicts on every
    // attempt, so fence retries exhaust and the mutation refuses atomically.
    {
      const { now, identities, identity, store } = await setup('revision');
      const commit = store.commit.bind(store);
      let races = 0;
      store.commit = async batch => {
        if (batch.writes.some(write => write.kind === 'insert' && write.model === snapshotModel)) {
          races++;
          await commit(makeBatch(await store.readRevision(), { writes: [{
            kind: 'insert' as const, model: snapshotModel,
            row: { ...makeRow({ id: asId(`external-${races}`), data: { sequence: '9', hidden: false } }),
              parent: { model: rootModel, id: asId('root') } },
          }] }));
        }
        return commit(batch);
      };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'loop_shapes.looped', operation_id: operationId(now),
        inputs: { root: { id: 'root', version: '1' }, flag: false } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.ok(races > 0, 'race lands before the COUNT commit');
      assert.ok('error' in outcome, 'revision race refuses: ' + JSON.stringify(outcome).slice(0, 200));
      const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
      assert.ok(snapshots.some(row => String(row.id).startsWith('external-')), 'external domain writes survive the refused attempt');
      assert.ok(!snapshots.some(row => row.id !== 'seed-0' && !String(row.id).startsWith('external-')), 'raced COUNT rolls back atomically');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('admits preceding taken-arm writes against a published static arm census', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-partitioned-count-arm-'));
  try {
    const source = fixture('partitioned-loop-count-source.can');
    const rootModel = asModel('loop_shapes.Root'), snapshotModel = asModel('loop_shapes.Snapshot');
    const setup = async (mode: string) => {
      const { now, identities, identity, team, user } = await member(`count-arm-${mode}`);
      const { store } = createTestMemoryStorage();
      const parent = { model: rootModel, id: asId('root') };
      await store.commit(makeBatch(await store.readRevision(), { writes: [{
        kind: 'insert' as const, model: rootModel, row: makeRow({ id: parent.id, data: { label: 'Original' } }),
      }, { kind: 'insert' as const, model: snapshotModel,
        row: { ...makeRow({ id: asId('seed-0'), data: { sequence: '1', hidden: false } }), parent },
      }] }));
      return { now, identities, identity, team, user, store };
    };
    const attempt = async (artifact: CompileArtifact, asm: AssembledModules,
        mode: string, inputs: Record<string, unknown>) => {
      const { now, identities, identity, store } = await setup(mode);
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'loop_shapes.looped_after_arm', operation_id: operationId(now), inputs };
      return { outcome: await invoker.invokeMutation(request, identity), store };
    };
    const inputs = { root: { id: 'root', version: '1' }, flag: true, pre: true };
    // The genuine static census (then-arm writes once, else-arm writes nothing)
    // admits the taken preceding arm; the skipped arm still verifies.
    {
      const { artifact, asm } = await installedWithArmCensus(source, await mkdtemp(join(directory, 'exact-')), '{"then":1,"else":0}');
      const { outcome, store } = await attempt(artifact, asm, 'exact-taken', inputs);
      assert.ok('result' in outcome, 'published arm census admits the taken arm: ' + JSON.stringify(outcome).slice(0, 200));
      const snapshots = await store.query({ model: snapshotModel, authority: 'owner' });
      assert.equal(snapshots.length, 2, 'taken-arm COUNT still creates exactly one snapshot');
      const { outcome: skipped } = await attempt(artifact, asm, 'exact-skipped',
        { ...inputs, flag: false, pre: false });
      assert.ok('result' in skipped, 'skipped preceding arm still verifies: ' + JSON.stringify(skipped).slice(0, 200));
    }
    // A mispublished census that cannot decompose the sealed delta refuses.
    {
      const { artifact, asm } = await installedWithArmCensus(source, await mkdtemp(join(directory, 'wrong-')), '{"then":5,"else":0}');
      const { outcome, store } = await attempt(artifact, asm, 'wrong-taken', inputs);
      assert.ok('error' in outcome, 'undecomposable census fails closed: ' + JSON.stringify(outcome).slice(0, 200));
      assert.equal((await store.query({ model: snapshotModel, authority: 'owner' })).length, 1);
    }
    // A complex marker admits only the zero-delta (skipped) execution.
    {
      const { artifact, asm } = await installedWithArmCensus(source, await mkdtemp(join(directory, 'complex-')), '{"complex":true}');
      const { outcome, store } = await attempt(artifact, asm, 'complex-taken', inputs);
      assert.ok('error' in outcome, 'complex census with a taken arm fails closed: ' + JSON.stringify(outcome).slice(0, 200));
      assert.equal((await store.query({ model: snapshotModel, authority: 'owner' })).length, 1);
      const { outcome: skipped } = await attempt(artifact, asm, 'complex-skipped', { ...inputs, flag: false, pre: false });
      assert.ok('result' in skipped, 'complex census with a skipped arm still verifies: ' + JSON.stringify(skipped).slice(0, 200));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
