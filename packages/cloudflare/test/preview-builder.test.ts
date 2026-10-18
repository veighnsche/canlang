import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArtifactRuntimeBinding, CompileArtifact } from '@canlang/contracts';
import type { SingleFileCapture } from '../src/dev/source-capture.js';

const mocks = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(), dispose: vi.fn(), activate: vi.fn() }));
vi.mock('../src/dev/local-run.js', () => ({ startLocalDev: mocks.start }));
vi.mock('../src/dev/preview-bridge.js', () => ({ startProtectedPreview: async () => ({
  url: 'http://127.0.0.1:43217', close: mocks.close,
}) }));
vi.mock('../src/dev/source-capture.js', () => ({ captureIsCurrent: async () => true,
  verifyCompilerSources: () => ({ ok: true }) }));
vi.mock('../src/deploy/bundle.js', () => ({ assertLinksResolve: () => {}, assertWorkerdLoadable: () => {},
  bundleMixedSha256: () => 'mixed', inventorizeAssets: () => [], generatedStyleResources: () => ({}) }));
import { createLocalPreviewBuilder } from '../src/dev/preview-builder.js';
import { DevCleanupError } from '../src/dev/cleanup.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
afterEach(() => vi.resetAllMocks());

async function setup(models: unknown[] | undefined, active = true, operations: unknown[] = [{}], pages: unknown[] = [{}], runtimeBindings?: ArtifactRuntimeBinding[]) {
  const sourceBindings = runtimeBindings === undefined ? {} : { runtimeBindings, modules: [{ path: 'app.js', js:
    `export const appDefinition={id:"Office",runtimeBindingOwners:["Office"],runtimeBindings:${JSON.stringify(runtimeBindings)}};` }] };
  const artifact = { ...sourceBindings, ...(models === undefined ? {} : { models }), sources: [], operations, pages, callables: [], requires: [] } as unknown as CompileArtifact;
  const capture = { profile: 'local-d1-identity', epochMaterial: 'epoch', inputs:
    ['compiler', 'catalog', 'help-index', 'package:worker'].map(name => ({ name, state: 'present', canonicalPath: '/fixture', sha256: hash('input'), bytes: 5 }))
  } as unknown as SingleFileCapture;
  const resources = Object.fromEntries(['browser/bootstrap.js', 'browser/can-style.css', 'browser/polling.js'].map(key =>
    [key, { bytes: new Uint8Array([1]), contentType: key.endsWith('.css') ? 'text/css' : 'application/javascript' }]));
  const resourcesSha256 = hash(JSON.stringify({ version: 1, resources: Object.keys(resources).sort().map(key => ({
    key, contentType: resources[key]!.contentType, bytes: 1, sha256: hash(resources[key]!.bytes),
  })) }));
  const modules = { 'worker/main.js': 'main', 'worker/http-assets.js': 'assets', 'worker/mcp-handler.js': 'mcp',
    'worker/http-operations.js': 'ops', 'worker/artifact.js': `export const artifact = ${JSON.stringify(artifact)};\nexport const verdict = {"active":true};\n${JSON.stringify({ resourcesSha256 })}` };
  const sorted = Object.fromEntries(Object.entries(modules).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const dbs = new Map<string, object>();
  const getD1Database = vi.fn(async (binding: string) => {
    if (!dbs.has(binding)) dbs.set(binding, { binding });
    return dbs.get(binding);
  });
  const r2Objects = new Map<string, string>();
  const bucket = { put: vi.fn(async (key: string, value: string) => { r2Objects.set(key, value); }),
    get: vi.fn(async (key: string) => r2Objects.has(key) ? { text: async () => r2Objects.get(key)! } : null),
    delete: vi.fn(async (key: string) => { r2Objects.delete(key); }) };
  const probeReached = new Error('probe reached');
  mocks.start.mockImplementation(async () => ({ getD1Database, getR2Bucket: async () => bucket, dispose: mocks.dispose,
    dispatchUrl: () => { throw probeReached; } }));
  // DB readiness is deliberately the first post-activation probe.
  dbs.set('DB', { prepare: () => ({ first: () => { throw probeReached; } }) });
  const owners = [{ owner: '00000000-0000-4000-8000-000000000001', binding: 'STATE_CEDAR_DB' },
    { owner: '00000000-0000-4000-8000-000000000002', binding: 'STATE_OAK_DB' }];
  const confirm = vi.fn(async (..._args: Parameters<NonNullable<Parameters<typeof createLocalPreviewBuilder>[0]['confirmRunningActivation']>>) => active ? ({ active: true as const }) : ({ active: false as const, reasons: [] }));
  const build = createLocalPreviewBuilder({
    resources: { d1: { binding: 'DB', availability: 'real_local' }, identity: { backingBinding: 'DB', availability: 'real_local' } },
    activationVerdict: mocks.activate.mockImplementation(async () => ({ active: true })), confirmRunningActivation: confirm,
    seedLocalActors: async () => ({ owners, actors: Array.from({ length: 4 }, (_, i) => ({
      label: String(i), email: `a${i}`, password: 'password', teams: [],
    })), probe: { email: 'a0', password: 'password', teamId: owners[0]!.owner } }),
    produceBundle: async () => ({ captureEpochMaterial: 'epoch', artifactJsonSha256: hash(JSON.stringify(artifact)),
      consumedInputs: capture.inputs.filter(input => input.name.startsWith('package:')),
      bundle: { mainModule: 'worker/main.js', modules, binaries: {}, resources, resourcesSha256,
        moduleCount: 5, sha256: hash(JSON.stringify({ mainModule: 'worker/main.js', modules: sorted })),
        mixedSha256: 'mixed', mcpBundleBytes: 3, httpOperationsBytes: 3 } as never }),
  });
  const failure = await build(artifact, capture, new TextEncoder().encode(JSON.stringify(artifact))).catch(error => error);
  return { failure, probeReached, confirm, getD1Database, dbs, owners, bucket, r2Objects };
}

it('model-free preview configures only global DB and confirms its real activation before probes', async () => {
  const result = await setup([]);
  expect(result.failure).toBe(result.probeReached);
  const options = mocks.start.mock.calls[1]![0];
  expect(options.d1Databases).toHaveLength(1);
  expect(options.vars).not.toHaveProperty('CAN_STATE_OWNERS');
  expect(result.confirm).toHaveBeenCalledTimes(1);
  expect(result.confirm.mock.calls[0]![2]).toBe(result.dbs.get('DB'));
  expect(result.confirm.mock.calls[0]).toHaveLength(4);
});

it('retains failed provisioning cleanup and backing files until release succeeds', async () => {
  mocks.dispose.mockRejectedValue(new Error('provisioning still alive'));
  const result = await setup([]);
  const persistence = mocks.start.mock.calls[0]![0].d1Persist;
  try {
    expect(result.failure).toBeInstanceOf(DevCleanupError);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
    expect(existsSync(persistence)).toBe(true);
  } finally {
    mocks.dispose.mockResolvedValue(undefined);
    await result.failure.dispose();
  }
  expect(mocks.dispose).toHaveBeenCalledTimes(3);
  expect(existsSync(persistence)).toBe(false);
});

it('retains failed serving startup cleanup and retries only unreleased resources', async () => {
  mocks.dispose.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('serving still alive'));
  const result = await setup([]);
  const persistence = mocks.start.mock.calls[1]![0].d1Persist;
  try {
    expect(result.failure).toBeInstanceOf(DevCleanupError);
    expect(result.failure.cause).toBe(result.probeReached);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(existsSync(persistence)).toBe(true);
  } finally {
    mocks.dispose.mockResolvedValue(undefined);
    await result.failure.dispose();
  }
  expect(mocks.dispose).toHaveBeenCalledTimes(3);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(existsSync(persistence)).toBe(false);
});

it('model-free preview refuses inactive serving global DB', async () => {
  const result = await setup([], false);
  expect(result.failure.code).toBe('ACTIVATION_REFUSED');
  expect(result.failure.message).toContain('global D1');
});

it('model-backed preview keeps separate owner DBs and both owner activation checks', async () => {
  const result = await setup([{ name: 'Office.Supply' }, { name: 'Office.Item', parent: 'Office.Supply' }]);
  expect(result.failure).toBe(result.probeReached);
  const options = mocks.start.mock.calls[1]![0];
  expect(options.d1Databases).toHaveLength(3);
  expect(options.vars.CAN_STATE_OWNERS.owners).toEqual(result.owners.map(owner => ({ ...owner, initializeFresh: true })));
  expect(result.confirm).toHaveBeenCalledTimes(2);
  result.confirm.mock.calls.forEach((call, i) => {
    expect(call[2]).toBe(result.dbs.get(result.owners[i]!.binding));
    expect(call[4]).toBe(result.owners[i]!.owner);
    expect(call[5]).toBe(result.dbs.get('DB'));
    expect(call[2]).not.toBe(call[5]);
  });
});

it('model-backed preview still refuses inactive owner activation', async () => {
  const result = await setup([{ name: 'Office.Supply' }], false);
  expect(result.failure.code).toBe('ACTIVATION_REFUSED');
  expect(result.failure.message).toContain('owner D1');
  expect(result.confirm).toHaveBeenCalledTimes(1);
});

it('a typed File declaration uses the current local Files receiver and implicit R2 binding', async () => {
  const result = await setup([{ name: 'Office.Attachment', fields: [{ name: 'content', field: { kind: 'file' } }] }],
    true, [{}], [{}], [{ owner: 'Office', name: 'FILES', binding: 'FILES', kind: 'r2', implicit: true }]);
  expect(result.failure).toBe(result.probeReached);
  const configured = mocks.start.mock.calls[1]![0];
  expect(configured.vars.CAN_LOCAL_FILES).toBe(true);
  expect(configured.r2Buckets).toEqual([{ binding: 'FILES', id: expect.any(String) }]);
  expect(configured.r2Persist).toContain('/r2');
  expect(result.confirm).toHaveBeenCalledTimes(2);
  expect(result.bucket.put).toHaveBeenCalledTimes(1);
  expect(result.bucket.delete).toHaveBeenCalledTimes(1);
});

it('omitted models use global DB activation without owner configuration', async () => {
  const result = await setup(undefined);
  expect(result.failure).toBe(result.probeReached);
  const options = mocks.start.mock.calls[1]![0];
  expect(options.d1Databases).toHaveLength(1);
  expect(options.vars).not.toHaveProperty('CAN_STATE_OWNERS');
  expect(result.confirm).toHaveBeenCalledTimes(1);
  expect(result.confirm.mock.calls[0]![2]).toBe(result.dbs.get('DB'));
  expect(result.confirm.mock.calls[0]).toHaveLength(4);
});

it('app roots and their contained children use existing global DB activation without team routes', async () => {
  const result = await setup([{ name: 'Office.Child', parent: 'Office.Config' },
    { name: 'Office.Config', scope: 'app' }, { name: 'Office.Settings', scope: 'app' }]);
  expect(result.failure).toBe(result.probeReached);
  const options = mocks.start.mock.calls[1]![0];
  expect(options.d1Databases).toHaveLength(1);
  expect(options.vars).not.toHaveProperty('CAN_STATE_OWNERS');
  expect(result.confirm).toHaveBeenCalledTimes(1);
  expect(result.confirm.mock.calls[0]![2]).toBe(result.dbs.get('DB'));
  expect(result.confirm.mock.calls[0]).toHaveLength(4);
});

it('app-scoped preview still refuses inactive serving global DB', async () => {
  const result = await setup([{ name: 'Office.Config', scope: 'app' }], false);
  expect(result.failure.code).toBe('ACTIVATION_REFUSED');
  expect(result.failure.message).toContain('global D1');
});

it('mixed app/team roots refuse before activation or Worker allocation', async () => {
  const result = await setup([{ name: 'Office.Config', scope: 'app' }, { name: 'Office.Supply' }]);
  expect(result.failure).toMatchObject({ name: 'PreviewAdmissionError', code: 'MIXED_OWNER_PROFILE_UNSUPPORTED' });
  expect(result.failure.message).toContain('storage-selection API');
  expect(mocks.activate).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(result.confirm).not.toHaveBeenCalled();
});

it.each([
  [[{ name: 'Office.Supply' }, { name: 'Office.Supply' }]],
  [[{ name: 'Office.Child', parent: 'Office.Missing' }]],
  [[{ name: 'Office.Child', parent: 'Office.Child' }]],
  [[{ name: 'Office.A', parent: 'Office.B' }, { name: 'Office.B', parent: 'Office.A' }]],
  [[{ name: 'Office.Config', scope: 'team' }]],
  [[{ name: 'Office.Child', parent: 'Office.Config', scope: 'app' }, { name: 'Office.Config', scope: 'app' }]],
  [[{ name: 'Office.Child', parent: '' }]],
  [[{ name: '' }]],
  [[{}]],
  [[null]],
])('malformed containment refuses before activation or Worker allocation: %j', async models => {
  const result = await setup(models);
  expect(result.failure).toMatchObject({ name: 'PreviewAdmissionError', code: 'MODEL_OWNERSHIP_INVALID' });
  expect(mocks.activate).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(result.confirm).not.toHaveBeenCalled();
});


it('page-only preview with no models or operations reaches the existing global activation and D1 probe', async () => {
  const result = await setup([], true, []);
  expect(result.failure).toBe(result.probeReached);
  const options = mocks.start.mock.calls[1]![0];
  expect(options.d1Databases).toHaveLength(1);
  expect(options.vars).not.toHaveProperty('CAN_STATE_OWNERS');
  expect(options.vars.CAN_DEPLOYMENT_BASE).toBe('http://127.0.0.1:43217');
  expect(result.confirm).toHaveBeenCalledTimes(1);
  expect(result.confirm.mock.calls[0]![2]).toBe(result.dbs.get('DB'));
});

it('page-only preview still refuses inactive serving global D1', async () => {
  const result = await setup([], false, []);
  expect(result.failure.code).toBe('ACTIVATION_REFUSED');
  expect(result.failure.message).toContain('global D1');
  expect(result.confirm).toHaveBeenCalledTimes(1);
});

it('an app without any page or operation refuses before activation or Worker allocation', async () => {
  const result = await setup([], true, [], []);
  expect(result.failure).toMatchObject({ name: 'PreviewAdmissionError', code: 'PROFILE_UNSUPPORTED' });
  expect(result.failure.message).toContain('at least one page');
  expect(mocks.activate).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(result.confirm).not.toHaveBeenCalled();
});

it('an API-only app reaches the real activation and runtime probes without a dummy page', async () => {
  const result = await setup([], true, [{}], []);
  expect(result.failure).toBe(result.probeReached);
  expect(mocks.activate).toHaveBeenCalledOnce();
  expect(mocks.start).toHaveBeenCalledTimes(2);
  expect(result.confirm).toHaveBeenCalledOnce();
});

it('provisions the selected implicit FILES bucket and probes it before offering a preview', async () => {
  const result = await setup([], true, [], [{}], [{owner:'Office',name:'FILES',binding:'FILES',kind:'r2',implicit:true}]);
  expect(result.failure).toBe(result.probeReached);
  const configured = mocks.start.mock.calls[1]![0];
  expect(configured.r2Buckets).toEqual([{binding:'FILES',id:expect.any(String)}]);
  expect(configured.r2Persist).toContain('/r2');
  expect(result.bucket.put).toHaveBeenCalledTimes(1);
  expect(result.bucket.get).toHaveBeenCalledTimes(2);
  expect(result.bucket.delete).toHaveBeenCalledTimes(1);
  expect(result.r2Objects.size).toBe(0);
});

it('reports a missing real service implementation before activation or Worker allocation', async () => {
  const result = await setup([], true, [], [{}], [{owner:'Office',name:'Mailer',binding:'Office.Mailer',kind:'service',from:'mail-service',capability:'Mail.send'}]);
  expect(result.failure).toMatchObject({ code:'SERVICE_IMPLEMENTATION_UNAVAILABLE' });
  expect(mocks.activate).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
