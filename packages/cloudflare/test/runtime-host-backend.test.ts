import { expect, it } from 'vitest';
import { startLocalDev } from '../src/runtime/native-preview.test-support.js';

it('exposes only a secret backend, preserves the owner URL, preserves refusal responses, and releases real Workerd', async () => {
  const dev = await startLocalDev({ workerName: 'runtime-bridge-smoke', compatibilityDate: '2026-07-30', mainModule: 'main.js',
    modules: { 'main.js': `export default { async fetch(request, env) {
      const ready = await env.DB.prepare('SELECT 1 AS ready').first();
      if (new URL(request.url).pathname === '/refusal') return Response.json({ error: { code: 'forbidden', message: 'PRIVATE DRAFT', retryable: false } }, {status:403});
      return Response.json({url:request.url, leaked:request.headers.has('x-can-local-dispatch') || request.headers.has('x-can-local-url'), ready:ready.ready});
    }};` }, d1Databases: [{ binding: 'DB', id: 'runtime-bridge-test' }] });
  const backend = dev.backend;
  try {
    expect((await fetch(backend.origin)).status).toBe(403);
    const headers = { [backend.header]: backend.secret, [backend.urlHeader]: 'http://127.0.0.1:43217/app' };
    const response = await fetch(backend.origin, { headers });
    expect(await response.json()).toEqual({ url: 'http://127.0.0.1:43217/app', leaked: false, ready: 1 });
    const refusal = await fetch(backend.origin, { headers: { ...headers, [backend.urlHeader]: 'http://127.0.0.1:43217/refusal' } });
    expect(refusal.status).toBe(403);
    // Closed refusal projection and draft exclusion are covered by the native gateway/refusals tests.
  } finally { await dev.dispose(); }
  await expect(fetch(backend.origin)).rejects.toThrow();
}, 30000);
