import { expect, it } from 'vitest';
import { startLocalDev } from '../src/dev/local-run.js';

it('exposes only a secret backend, preserves the owner URL, reports safe refusals, and releases real Workerd', async () => {
  const dev = await startLocalDev({ workerName: 'runtime-bridge-smoke', compatibilityDate: '2026-07-30', mainModule: 'main.js',
    modules: { 'main.js': `export default { async fetch(request, env) {
      const ready = await env.DB.prepare('SELECT 1 AS ready').first();
      if (new URL(request.url).pathname === '/refusal') return Response.json({ error: { code: 'forbidden', message: 'PRIVATE DRAFT', retryable: false } }, {status:403});
      return Response.json({url:request.url, leaked:request.headers.has('x-can-local-dispatch') || request.headers.has('x-can-local-url'), ready:ready.ready});
    }};` }, d1Databases: [{ binding: 'DB', id: 'runtime-bridge-test' }] });
  const backend = dev.backend, events: unknown[] = [];
  const unsubscribe = dev.observeRefusals(event => events.push(event));
  try {
    expect((await fetch(backend.origin)).status).toBe(403);
    const headers = { [backend.header]: backend.secret, [backend.urlHeader]: 'http://127.0.0.1:43217/app' };
    const response = await fetch(backend.origin, { headers });
    expect(await response.json()).toEqual({ url: 'http://127.0.0.1:43217/app', leaked: false, ready: 1 });
    const refusal = await fetch(backend.origin, { headers: { ...headers, [backend.urlHeader]: 'http://127.0.0.1:43217/refusal' } });
    expect(refusal.status).toBe(403);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('PRIVATE DRAFT');
    expect(events[0]).toMatchObject({ status: 403, error: { code: 'forbidden', retryable: false } });
  } finally { unsubscribe(); await dev.dispose(); }
  await expect(fetch(backend.origin)).rejects.toThrow();
}, 30000);
