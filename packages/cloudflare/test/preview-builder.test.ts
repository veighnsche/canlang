import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompileArtifact } from '@canlang/contracts';
import type { SingleFileCapture } from '../src/dev/source-capture.js';

const mocks = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/dev/local-run.js', () => ({ startLocalDev: mocks.start }));
vi.mock('../src/dev/preview-bridge.js', () => ({ startProtectedPreview: async () => ({
  url: 'http://127.0.0.1:43217', close: mocks.close,
}) }));
vi.mock('../src/dev/source-capture.js', () => ({ captureIsCurrent: async () => true,
  verifyCompilerSources: () => ({ ok: true }) }));
vi.mock('../src/deploy/bundle.js', () => ({ assertLinksResolve: () => {}, assertWorkerdLoadable: () => {},
  bundleMixedSha256: () => 'mixed', inventorizeAssets: () => [] }));
import { createLocalPreviewBuilder } from '../src/dev/preview-builder.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
afterEach(() => vi.clearAllMocks());

async function setup(models: unknown[] | undefined, active = true) {
  const artifact = { ...(models === undefined ? {} : { models }), sources: [], operations: [{}], pages: [{}], callables: [], requires: [] } as unknown as CompileArtifact;
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
  const probeReached = new Error('probe reached');
  mocks.start.mockImplementation(async () => ({ getD1Database, dispose: mocks.dispose,
    dispatchUrl: () => { throw probeReached; } }));
  // DB readiness is deliberately the first post-activation probe.
  dbs.set('DB', { prepare: () => ({ first: () => { throw probeReached; } }) });
  const owners = [{ owner: '00000000-0000-4000-8000-000000000001', binding: 'STATE_CEDAR_DB' },
    { owner: '00000000-0000-4000-8000-000000000002', binding: 'STATE_OAK_DB' }];
  const confirm = vi.fn(async (..._args: Parameters<NonNullable<Parameters<typeof createLocalPreviewBuilder>[0]['confirmRunningActivation']>>) => active ? ({ active: true as const }) : ({ active: false as const, reasons: [] }));
  const build = createLocalPreviewBuilder({
    resources: { d1: { binding: 'DB', availability: 'real_local' }, identity: { backingBinding: 'DB', availability: 'real_local' } },
    activationVerdict: async () => ({ active: true }), confirmRunningActivation: confirm,
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
  return { failure, probeReached, confirm, getD1Database, dbs, owners };
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

it('model-free preview refuses inactive serving global DB', async () => {
  const result = await setup([], false);
  expect(result.failure.code).toBe('ACTIVATION_REFUSED');
  expect(result.failure.message).toContain('global D1');
});

it('model-backed preview keeps separate owner DBs and both owner activation checks', async () => {
  const result = await setup([{}]);
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
  const result = await setup([{}], false);
  expect(result.failure.code).toBe('ACTIVATION_REFUSED');
  expect(result.failure.message).toContain('owner D1');
  expect(result.confirm).toHaveBeenCalledTimes(1);
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
