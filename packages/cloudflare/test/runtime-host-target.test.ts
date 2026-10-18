import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DevCleanupError } from '../src/dev/cleanup.js';
import { RUNTIME_PROTOCOL, writeRuntimeFile, type RuntimeRequest } from '../src/dev/runtime-host-protocol.js';
const mocks = vi.hoisted(() => ({ build: vi.fn(), beginStop: vi.fn(), disposeBuilder: vi.fn(), options: undefined as any }));
vi.mock('../src/dev/preview-host.js', () => ({ createInstalledLocalPreviewBuilder: (_roles: unknown, _runtime: unknown, options: unknown) => {
  mocks.options = options; return Object.assign(mocks.build, { beginStop: mocks.beginStop, dispose: mocks.disposeBuilder });
} }));
vi.mock('../src/runtime/artifact.js', () => ({ parseArtifactText: () => ({ artifact: {} }) }));
import { RuntimeTargets } from '../src/dev/runtime-host-target.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.resetAllMocks(); });
function request(command: string, operationId: string, payload: Record<string, unknown> = {}, generationId = 'g'): RuntimeRequest {
  return { protocol: RUNTIME_PROTOCOL, sessionId: 'session', operationId, generationId, command, payload };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-target-test-')); roots.push(root);
  const capture = { requestedRoot: root, root, requestedAppPath: 'a.can', appPath: 'a.can', compilerOperand: 'a.can',
    sourceText: 'app A', sourceBytes: 5, sourceSha256: createHash('sha256').update('app A').digest('hex'), sourceRevision: 'r', epochMaterial: 'e',
    profile: 'local-d1-identity', inputs: [], semanticOptions: {} };
  return { targets: new RuntimeTargets(root), payload: { origin: 'http://127.0.0.1:43217',
    capture: await writeRuntimeFile(root, capture), artifact: await writeRuntimeFile(root, {}) } };
}
function preview(dispose = vi.fn(async () => {})) {
  return { origin: 'http://127.0.0.1:43217', runtimeBackend: () => ({ origin: 'http://127.0.0.1:1234', secret: 'private' }),
    dispose, observeRefusals: () => () => {}, issueLocalActors: vi.fn(() => ['private actor']), probeRuntime: async () => {} };
}
it('keeps actor disclosure explicit and preserves failed cleanup handles until retry', async () => {
  const { targets, payload } = await setup(); const runtime = preview();
  mocks.build.mockResolvedValue(runtime);
  const ready = await targets.execute(request('prepare', 'prepare', payload));
  expect(ready).toMatchObject({ id: 'g', readiness: true, backend: { secret: 'private' } });
  expect(runtime.issueLocalActors).not.toHaveBeenCalled();
  expect(await targets.execute(request('actors', 'actors'))).toEqual({ actors: ['private actor'] });
  runtime.dispose.mockRejectedValueOnce(new Error('still running'));
  await expect(targets.execute(request('release', 'release'))).rejects.toThrow('still running');
  expect(targets.allocation('g')).toBe('release_failed');
  await expect(targets.execute(request('prepare', 'another', payload, 'other'))).rejects.toThrow('released prior work');
  expect(await targets.execute(request('retry', 'retry'))).toEqual({ released: true });
  expect(targets.allocation('g')).toBe('released');
  await targets.close();
});
it('releases a pending runtime before waiting for preparation to settle and retains late cleanup facts', async () => {
  const { targets, payload } = await setup();
  let finish!: () => void, allocated!: () => void;
  const allocation = new Promise<void>(resolve => { allocated = resolve; });
  const drain = new Promise<void>(resolve => { finish = resolve; });
  const dispose = vi.fn(async () => { finish(); });
  mocks.build.mockImplementation(async (_artifact: unknown, _capture: unknown, _bytes: unknown, context: { signal: AbortSignal }) => {
    mocks.options.onAllocated(dispose); allocated(); await drain;
    context.signal.throwIfAborted();
    return preview(dispose);
  });
  const pending = targets.execute(request('prepare', 'prepare', payload));
  await allocation;
  await expect(targets.execute(request('prepare', 'second', payload, 'second'))).rejects.toThrow('released prior work');
  const cancelled = pending.catch(error => error);
  expect(await targets.execute(request('release', 'release'))).toEqual({ released: true });
  expect(dispose).toHaveBeenCalled(); expect(await cancelled).toBeInstanceOf(Error);
  expect(targets.allocation('g')).toBe('released'); await targets.close();
});
it('retains failed-startup release ownership through explicit retry', async () => {
  const { targets, payload } = await setup(); const dispose = vi.fn(async () => {});
  mocks.build.mockRejectedValue(new DevCleanupError(new Error('startup failed'), new Error('release failed'), dispose));
  await expect(targets.execute(request('prepare', 'prepare', payload))).rejects.toBeInstanceOf(DevCleanupError);
  expect(targets.allocation('g')).toBe('release_failed');
  await targets.execute(request('retry', 'retry')); expect(dispose).toHaveBeenCalled();
  await targets.close();
});
