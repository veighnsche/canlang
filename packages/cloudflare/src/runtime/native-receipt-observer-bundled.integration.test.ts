/**
 * D3b Q4-C (B-owned): the real produced deploy bundle serves
 * `invokeSelectedReceiptRead` with NO observer injection through B's
 * worker-safe observer module.
 *
 * Split under test: the serving path (`runtime/invoke.js` +
 * `vendor/state/receipt/*` + `vendor/work/receipt/*`) executes from
 * produced bundle bytes written to disk and imported by file URL;
 * the store, identity, assembly, and seeds arrive from the workspace
 * dists as structural ports and plain data (the read path asserts
 * them structurally, never by brand). The positive proof is B's own
 * `selectedReceiptObserverLoads` record read from the same realm —
 * output equality alone cannot distinguish the observer leg from the
 * work-loader fallback — controlled by the observer-bytes-removed
 * variant, which must still succeed without writing the record.
 *
 * Seeds reuse the checked `typed-delivery-observer` fixture
 * (recompiled fresh): `Entry.notification` delivery field, viewer +
 * delivery_reader read grants, one succeeded Email receipt.
 *
 * The assembly is hand-built from the written bundle (an anticipated
 * test shape per `AssembledModules`): module URLs point at the staged
 * app bytes and the bundle's own assembler registry issues the
 * capability with a closure that re-checks staged bytes against the
 * in-memory produced modules. No node_modules assembler stands in
 * for the bundle anywhere on the serving path.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { associationRowId, withAssociationRowData, withReceiptRowData } from '@canlang/state/receipt/tables';
import { loadWorkReceiptFns } from '@canlang/work/receipt';
import { buildDeployBundle, writeDeployBundle } from '../deploy/bundle.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/typed-delivery-observer.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const now = Date.parse('2026-10-28T00:00:00.000Z');

const ENTRY_MODEL = 'TypedDeliveryObserver.Entry';
const ENTRY_ID = 'entry-1';
const BARE_ID = 'entry-2';
const DELIVERY_ID = 'delivery-1';
const DELIVERY_SOURCE = 'std.EmailV1.send';

async function seedStore() {
  const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const reader = await identities.createUser({
    email: 'reader@receipt-observer.test', password_hash: 'unused', email_verified: true,
  });
  const viewer = await identities.createUser({
    email: 'viewer@receipt-observer.test', password_hash: 'unused', email_verified: true,
  });
  const outsider = await identities.createUser({
    email: 'outsider@receipt-observer.test', password_hash: 'unused', email_verified: true,
  });
  const grant = (role: string) => ({
    role, granted_at: new Date(now).toISOString(), granted_by: reader.user_id,
  });
  await identities.createMembership({
    team_id: team.team_id, user_id: reader.user_id, is_owner: false,
    roles: [grant('TypedDeliveryObserver.delivery_reader')],
  });
  await identities.createMembership({
    team_id: team.team_id, user_id: viewer.user_id, is_owner: false,
    roles: [grant('TypedDeliveryObserver.viewer')],
  });
  await identities.createMembership({
    team_id: team.team_id, user_id: outsider.user_id, is_owner: false, roles: [],
  });
  const sessionFor = async (userId: string, token: string) => {
    await identities.createSession({
      user_id: userId, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString(),
    });
    return resolveIdentity(identities, { session_token: token }, { clock: createFrozenClock(now) });
  };
  const authority: FileRetirementAuthority = {
    app: 'TypedDeliveryObserver', stateOwner: 'TypedDeliveryObserver',
    stateStoreId: 'receipt-observer-state', fileStoreId: 'receipt-observer-files',
    receiver: { app: 'TypedDeliveryObserver', owner: team.team_id, team: team.team_id },
  };
  const { store } = createTestMemoryStorage(authority, []);
  const meta = { nowMs: now, actor: 'test:receipt-observer' };
  const entry = {
    ...makeRow({
      id: asId(ENTRY_ID),
      data: {
        label: 'Notification',
        notification: { id: DELIVERY_ID, operation: DELIVERY_SOURCE },
      },
    }),
    parent: null,
  };
  const bare = {
    ...makeRow({ id: asId(BARE_ID), data: { label: 'Bare', notification: null } }),
    parent: null,
  };
  const assocId = associationRowId(ENTRY_MODEL, ENTRY_ID, 'notification');
  const association = withAssociationRowData(
    { ...makeRow({ id: asId(assocId) }), parent: null },
    {
      recordModel: ENTRY_MODEL, recordId: ENTRY_ID, field: 'notification',
      deliveryId: DELIVERY_ID, source: DELIVERY_SOURCE, revision: 1,
    },
    meta,
  );
  const receipt = withReceiptRowData(
    { ...makeRow({ id: asId(DELIVERY_ID) }), parent: null },
    {
      deliveryId: DELIVERY_ID, revision: 1, status: 'succeeded',
      result: { reference: 'mail-1' }, error: null,
      contentRef: null, resultExpiresAtMs: null,
    },
    meta,
  );
  await store.commit(makeBatch(await store.readRevision(), {
    writes: [
      { kind: 'insert', model: asModel(ENTRY_MODEL), row: entry },
      { kind: 'insert', model: asModel(ENTRY_MODEL), row: bare },
      { kind: 'insert', model: asModel('work.receipt_association'), row: association },
      { kind: 'insert', model: asModel('work.receipt'), row: receipt },
    ],
  }));
  return {
    identities,
    store,
    reader: await sessionFor(reader.user_id, 'receipt-observer-reader'),
    viewer: await sessionFor(viewer.user_id, 'receipt-observer-viewer'),
    outsider: await sessionFor(outsider.user_id, 'receipt-observer-outsider'),
  };
}

it('serves bundled receipt reads with no injection through the B observer module', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-receipt-observer-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const bundle = buildDeployBundle(artifact, { verdict: { active: true } });
    assert.ok('vendor/state/receipt/observer.js' in bundle.modules, 'bundle stages the B observer');
    const fullDir = join(directory, 'full');
    writeDeployBundle(bundle, fullDir);

    // Bundle-owned assembly: hand-build the module map over the staged
    // app bytes and issue the capability through the staged dir's own
    // assembler registry, verified against the produced bytes.
    const assembleBundleDir = async (dir: string, modules: Record<string, string>) => {
      const verifier = await import(pathToFileURL(join(dir, 'runtime/assembly-verification.js')).href) as {
        registerAssemblerModuleCapability(
          asm: unknown,
          artifactJson: string,
          staged: ReadonlyArray<{ path: string; url: string }>,
          verifyClosure: () => Promise<void>,
        ): void;
      };
      const appPaths = artifact.modules.map(module => module.path);
      const moduleUrls = Object.fromEntries(
        appPaths.map(path => [path, pathToFileURL(join(dir, path)).href] as const),
      );
      const asm = { dir, entryUrl: moduleUrls[artifact.modules[0]!.path]!, moduleUrls };
      verifier.registerAssemblerModuleCapability(asm, JSON.stringify(artifact),
        appPaths.map(path => ({ path, url: moduleUrls[path]! })),
        async () => {
          for (const path of appPaths) {
            const staged = await readFile(join(dir, path), 'utf8');
            if (staged !== modules[path]) {
              throw new Error('importVerifiedAssemblyModule: staged module bytes changed');
            }
          }
        });
      return asm;
    };

    const asm = await assembleBundleDir(fullDir, bundle.modules);
    const invoked = await import(pathToFileURL(join(fullDir, 'runtime/invoke.js')).href) as typeof import('./invoke.js');
    const observerMod = await import(pathToFileURL(join(fullDir, 'vendor/state/receipt/observer.js')).href) as {
      selectedReceiptObserverLoads: string[];
    };
    assert.deepEqual(observerMod.selectedReceiptObserverLoads, []);

    const seeds = await seedStore();
    const revision = await seeds.store.readRevision();
    const enrolled: Array<{ model: string; id: string; version: number }> = [];
    const fence = {
      revision,
      enroll(dependency: { kind: 'record'; model: string; id: string; version: number }) {
        assert.equal(dependency.kind, 'record');
        enrolled.push({ model: dependency.model, id: dependency.id, version: dependency.version });
      },
    };
    const base = {
      asm,
      artifact,
      operation: 'Receipt.read',
      identity: seeds.reader,
      store: seeds.store,
      memberships: seeds.identities,
      fence,
      now: () => now,
    };

    // Authorized read with NO injection: B serves. (`id` stays
    // unselected: the fixture deliberately withholds the opaque
    // delivery identity from every read grant.)
    const served = await invoked.invokeSelectedReceiptRead({
      ...base,
      inputs: { recordId: ENTRY_ID, field: 'notification', selected: ['status', 'result'] },
    });
    assert.equal(served.outcome, 'observed');
    assert.deepEqual((served as { projection: unknown }).projection, {
      status: 'succeeded',
      result: { reference: 'mail-1' },
    });
    assert.deepEqual(observerMod.selectedReceiptObserverLoads, ['B']);
    assert.deepEqual(enrolled, [
      { model: ENTRY_MODEL, id: ENTRY_ID, version: 1 },
      // The receipt row writer bumps its base row to version 2.
      { model: 'work.receipt', id: DELIVERY_ID, version: 2 },
    ]);

    // Injected run agrees byte-for-byte and never touches B's loader.
    const { observeSelectedReceipt: injectedObserve } = await loadWorkReceiptFns();
    const injected = await invoked.invokeSelectedReceiptRead({
      ...base,
      observer: { observeSelectedReceipt: injectedObserve as (input: unknown) => unknown },
      inputs: { recordId: ENTRY_ID, field: 'notification', selected: ['status', 'result'] },
    });
    assert.deepEqual(injected, served);
    assert.deepEqual(observerMod.selectedReceiptObserverLoads, ['B']);

    // Viewer (label grant only) is denied the status leaf as data, not an error.
    const denied = await invoked.invokeSelectedReceiptRead({
      ...base,
      identity: seeds.viewer,
      inputs: { recordId: ENTRY_ID, field: 'notification', selected: ['status'] },
    });
    assert.equal(denied.outcome, 'denied');
    assert.deepEqual((denied as { denied: unknown }).denied, ['status']);

    // No grant at all hides behind the identical missing-row text.
    await assert.rejects(
      () => invoked.invokeSelectedReceiptRead({
        ...base,
        identity: seeds.outsider,
        inputs: { recordId: ENTRY_ID, field: 'notification', selected: ['status'] },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'not_found' &&
        (error as Error).message === 'Receipt owner record not found.',
    );
    await assert.rejects(
      () => invoked.invokeSelectedReceiptRead({
        ...base,
        inputs: { recordId: 'entry-missing', field: 'notification', selected: ['status'] },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'not_found' &&
        (error as Error).message === 'Receipt owner record not found.',
    );

    // Null delivery observes the null association, never a denial.
    const bare = await invoked.invokeSelectedReceiptRead({
      ...base,
      inputs: { recordId: BARE_ID, field: 'notification', selected: ['status'] },
    });
    assert.equal(bare.outcome, 'null-association');

    // A moved fence checkpoint conflicts before any row is consulted.
    await assert.rejects(
      () => invoked.invokeSelectedReceiptRead({
        ...base,
        fence: { revision: revision + 1, enroll: () => {} },
        inputs: { recordId: ENTRY_ID, field: 'notification', selected: ['status'] },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === 'conflict' &&
        /Fence checkpoint moved/.test((error as Error).message),
    );

    // The serving envelope is closed: server-bound and unknown members refuse.
    for (const inputs of [
      { recordId: ENTRY_ID, field: 'notification', selected: ['status'], model: ENTRY_MODEL },
      { recordId: ENTRY_ID, field: 'notification', selected: ['status'], extra: 1 },
      { recordId: ENTRY_ID, field: 'notification', selected: ['bogus'] },
      { recordId: ENTRY_ID, field: 'label', selected: ['status'] },
    ]) {
      await assert.rejects(
        () => invoked.invokeSelectedReceiptRead({ ...base, inputs }),
        (error: unknown) => (error as { code?: string }).code === 'validation',
      );
    }

    // Bundle variants bypass the digest-verifying writer (their bytes
    // intentionally differ) with a plain module dump.
    const dumpModules = async (dir: string, modules: Record<string, string>) => {
      for (const [key, text] of Object.entries(modules)) {
        const file = join(dir, key);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      }
    };

    // Dropped receipt-join bytes break the bundle link (the receipt
    // index re-exports the join statically): loud at boot, never a
    // silent serving fallback.
    const joinDroppedDir = join(directory, 'join-dropped');
    await dumpModules(
      joinDroppedDir,
      Object.fromEntries(
        Object.entries(bundle.modules).filter(([key]) => key !== 'vendor/state/receipt/join.js'),
      ),
    );
    await assert.rejects(
      () => import(pathToFileURL(join(joinDroppedDir, 'runtime/invoke.js')).href),
      (error: unknown) =>
        (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' &&
        /vendor\/state\/receipt\/join\.js/.test((error as Error).message),
    );

    // The whole receipt tree dropped likewise refuses to link.
    const droppedDir = join(directory, 'dropped');
    await dumpModules(
      droppedDir,
      Object.fromEntries(
        Object.entries(bundle.modules).filter(([key]) => !key.startsWith('vendor/state/receipt/')),
      ),
    );
    await assert.rejects(
      () => import(pathToFileURL(join(droppedDir, 'runtime/invoke.js')).href),
      (error: unknown) =>
        (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' &&
        /vendor\/state\/receipt\//.test((error as Error).message),
    );

    // Present-but-broken observer bytes stay loud through the seam:
    // an evaluating throw is never masked by the fallback leg, and a
    // wrong-shaped module trips the seam's own loud refusal.
    for (const [label, bytes, match] of [
      ['evaluating-throw', 'throw new Error("observer boom-marker");\n', /boom-marker/],
      ['missing-export', 'export const nothingHere = 1;\n', /t16b/],
    ] as const) {
      const brokenDir = join(directory, `broken-${label}`);
      await dumpModules(brokenDir, bundle.modules);
      await writeFile(join(brokenDir, 'vendor/state/receipt/observer.js'), bytes);
      const brokenAsm = await assembleBundleDir(brokenDir, bundle.modules);
      const broken = await import(pathToFileURL(join(brokenDir, 'runtime/invoke.js')).href) as typeof import('./invoke.js');
      await assert.rejects(
        () => broken.invokeSelectedReceiptRead({
          ...base,
          asm: brokenAsm,
          inputs: { recordId: ENTRY_ID, field: 'notification', selected: ['status'] },
        }),
        match,
        label,
      );
    }

    // The observer file alone removed falls back to the work leg and
    // succeeds — the control proving the loads record discriminates legs.
    const fallbackDir = join(directory, 'fallback');
    const fallbackModules = Object.fromEntries(
      Object.entries(bundle.modules).filter(([key]) => key !== 'vendor/state/receipt/observer.js'),
    );
    await dumpModules(fallbackDir, fallbackModules);
    const fallbackAsm = await assembleBundleDir(fallbackDir, fallbackModules);
    const fallback = await import(pathToFileURL(join(fallbackDir, 'runtime/invoke.js')).href) as typeof import('./invoke.js');
    const fallen = await fallback.invokeSelectedReceiptRead({
      ...base,
      asm: fallbackAsm,
      inputs: { recordId: ENTRY_ID, field: 'notification', selected: ['status'] },
    });
    assert.equal(fallen.outcome, 'observed');
    assert.deepEqual((fallen as { projection: unknown }).projection, { status: 'succeeded' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
