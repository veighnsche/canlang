/**
 * FP.INSTRUMENTATION intake tests: versioned ErrorsV1 admission over
 * `POST /errors/{key}` — happy path to 202, fail-closed unknown keys
 * (no oracle), unknown versions/members, bounds, allowlists, rate
 * throttle, oversize, and sink-fault mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_BODY_MAX_BYTES,
  INTAKE_MESSAGE_MAX_CHARS,
  INTAKE_STACK_MAX_CHARS,
  admitIntakeReport,
  handleIntakeRequest,
} from '../src/instrumentation/intake.js';
import type { AdmittedReport, IntakeBindings, IntakeSink } from '../src/instrumentation/intake.js';
import { createTestDeps, testRequest } from '../src/testing.js';
import type { HttpDeps } from '../src/ports.js';

const KEY = 'browser-key-1';
const PROJECT = 'project-catch';

function bindingsFor(extra: Record<string, { projectId: string; environments?: string[]; releases?: string[] }> = {}): IntakeBindings {
  const table: Record<string, { projectId: string; environments?: string[]; releases?: string[] }> = {
    [KEY]: { projectId: PROJECT },
    ...extra,
  };
  return { resolveKey: (key: string) => table[key] ?? null };
}

function recordingSink(): IntakeSink & { reports: AdmittedReport[] } {
  const reports: AdmittedReport[] = [];
  return {
    reports,
    store: async (report: AdmittedReport) => {
      reports.push(report);
      return { reference: `evt-${reports.length}` };
    },
  };
}

function intakeRequest(key: string, body: string, method = 'POST'): Request {
  return testRequest(`/errors/${key}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function validBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'evt-client-1',
    occurred_at: new Date(Date.now() - 1000).toISOString(),
    message: 'TypeError: undefined is not a function',
    ...extra,
  };
}

async function setup() {
  const t = await createTestDeps({});
  return t;
}

test('intake: valid v1 report admits to 202 with the sink reference', async () => {
  const t = await setup();
  const sink = recordingSink();
  const res = await handleIntakeRequest(
    t.deps,
    bindingsFor(),
    sink,
    intakeRequest(KEY, JSON.stringify(validBody({ stack: 'at f (app.js:1:2)', environment: 'prod' }))),
  );
  assert.equal(res.status, 202);
  const body = (await res.json()) as { reference: string };
  assert.equal(body.reference, 'evt-1');
  assert.equal(sink.reports.length, 1);
  const report = sink.reports[0]!;
  assert.equal(report.projectId, PROJECT);
  assert.equal(report.id, 'evt-client-1');
  assert.equal(report.environment, 'prod');
});

test('intake: unknown and revoked keys share one safe 403 (no oracle)', async () => {
  const t = await setup();
  const sink = recordingSink();
  const bindings = bindingsFor();
  const bodies = new Set<string>();
  for (const key of ['no-such-key', 'revoked-key']) {
    const res = await handleIntakeRequest(t.deps, bindings, sink, intakeRequest(key, JSON.stringify(validBody())));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'forbidden');
    bodies.add(JSON.stringify(body));
  }
  assert.equal(bodies.size, 1);
  assert.equal(sink.reports.length, 0);
});

test('intake: unknown versions reject; version must be exactly 1', async () => {
  const t = await setup();
  const sink = recordingSink();
  const bindings = bindingsFor();
  for (const version of [2, '1', 0, null]) {
    const res = await handleIntakeRequest(
      t.deps,
      bindings,
      sink,
      intakeRequest(KEY, JSON.stringify(validBody({ version }))),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'validation');
  }
  const missing = { ...validBody() };
  delete missing['version'];
  const res = await handleIntakeRequest(t.deps, bindings, sink, intakeRequest(KEY, JSON.stringify(missing)));
  assert.equal(res.status, 400);
  assert.equal(sink.reports.length, 0);
});

test('intake: unknown members reject — bodies never nominate project/quota/health', async () => {
  const t = await setup();
  const sink = recordingSink();
  for (const extra of [{ project: 'other' }, { quota: 99 }, { health: {} }, { viewer: 'x' }, { grouping: 2 }]) {
    const res = await handleIntakeRequest(
      t.deps,
      bindingsFor(),
      sink,
      intakeRequest(KEY, JSON.stringify(validBody(extra))),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'validation');
  }
  assert.equal(sink.reports.length, 0);
});

test('intake: occurrence bounds pin CanCatch windows', () => {
  const binding = { projectId: PROJECT };
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  const base = {
    version: 1,
    id: 'evt-1',
    message: 'boom',
  };
  // Inside the window (edges inclusive): admits.
  for (const occurred_at of [
    new Date(now + 5 * 60_000).toISOString(),
    new Date(now - 7 * 86_400_000).toISOString(),
  ]) {
    const report = admitIntakeReport(binding, { ...base, occurred_at }, now);
    assert.equal(report.occurredAt, occurred_at);
  }
  // Outside: rejects.
  for (const occurred_at of [
    new Date(now + 5 * 60_000 + 1).toISOString(),
    new Date(now - 7 * 86_400_000 - 1).toISOString(),
    'not-a-date',
  ]) {
    assert.throws(() => admitIntakeReport(binding, { ...base, occurred_at }, now), /occurred_at/);
  }
});

test('intake: message/stack length bounds enforced', () => {
  const binding = { projectId: PROJECT };
  const now = Date.now();
  const base = { version: 1, id: 'evt-1', occurred_at: new Date(now).toISOString() };
  assert.equal(
    admitIntakeReport(binding, { ...base, message: 'x'.repeat(INTAKE_MESSAGE_MAX_CHARS) }, now).message.length,
    INTAKE_MESSAGE_MAX_CHARS,
  );
  assert.throws(
    () => admitIntakeReport(binding, { ...base, message: 'x'.repeat(INTAKE_MESSAGE_MAX_CHARS + 1) }, now),
    /too long/,
  );
  assert.throws(() => admitIntakeReport(binding, { ...base, message: '' }, now), /non-empty/);
  assert.throws(
    () => admitIntakeReport(binding, { ...base, message: 'm', stack: 'x'.repeat(INTAKE_STACK_MAX_CHARS + 1) }, now),
    /too long/,
  );
  assert.throws(
    () => admitIntakeReport(binding, { ...base, message: 'm', stack: 42 }, now),
    /must be a string/,
  );
});

test('intake: environment/release allowlists apply before grouping', async () => {
  const t = await setup();
  const sink = recordingSink();
  const bindings = bindingsFor({ [KEY]: { projectId: PROJECT, environments: ['prod'], releases: ['r1'] } });
  const ok = await handleIntakeRequest(
    t.deps,
    bindings,
    sink,
    intakeRequest(KEY, JSON.stringify(validBody({ environment: 'prod', release: 'r1' }))),
  );
  assert.equal(ok.status, 202);
  for (const extra of [{ environment: 'staging' }, { release: 'r2' }]) {
    const res = await handleIntakeRequest(t.deps, bindings, sink, intakeRequest(KEY, JSON.stringify(validBody(extra))));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'validation');
  }
  assert.equal(sink.reports.length, 1);
});

test('intake: oversize bodies reject with limit before parsing', async () => {
  const t = await setup();
  const sink = recordingSink();
  const big = JSON.stringify(validBody({ message: 'x'.repeat(INTAKE_BODY_MAX_BYTES) }));
  assert.ok(big.length > INTAKE_BODY_MAX_BYTES);
  const res = await handleIntakeRequest(t.deps, bindingsFor(), sink, intakeRequest(KEY, big));
  assert.equal(res.status, 429);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'limit');
  assert.equal(sink.reports.length, 0);
});

test('intake: per-key throttle answers 429 with Retry-After', async () => {
  const t = await setup();
  const sink = recordingSink();
  const throttled: HttpDeps = {
    ...t.deps,
    limiter: { check: async () => ({ allowed: false, retryAfterMs: 30_000 }) },
  };
  const res = await handleIntakeRequest(throttled, bindingsFor(), sink, intakeRequest(KEY, JSON.stringify(validBody())));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.equal(sink.reports.length, 0);
});

test('intake: paths and methods fail closed without oracle', async () => {
  const t = await setup();
  const sink = recordingSink();
  const bindings = bindingsFor();
  const cases: Array<[string, string]> = [
    ['GET', `/errors/${KEY}`],
    ['POST', '/errors/'],
    ['POST', '/errors/a/b'],
    ['POST', '/errors/%zz'],
    ['POST', '/other'],
  ];
  for (const [method, path] of cases) {
    const res = await handleIntakeRequest(
      t.deps,
      bindings,
      sink,
      method === 'GET'
        ? testRequest(path, { method })
        : testRequest(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody()) }),
    );
    assert.equal(res.status, 404);
  }
  assert.equal(sink.reports.length, 0);
});

test('intake: malformed and non-object bodies reject as validation', async () => {
  const t = await setup();
  const sink = recordingSink();
  for (const body of ['{oops', '[1,2]', '"str"', '']) {
    const res = await handleIntakeRequest(t.deps, bindingsFor(), sink, intakeRequest(KEY, body));
    assert.equal(res.status, 400);
    const payload = (await res.json()) as { code: string };
    assert.equal(payload.code, 'validation');
  }
  assert.equal(sink.reports.length, 0);
});

test('intake: sink faults map to generic rule_failed (never recursive reports)', async () => {
  const t = await setup();
  const failing: IntakeSink = {
    store: async () => {
      throw new Error('queue exploded');
    },
  };
  const res = await handleIntakeRequest(t.deps, bindingsFor(), failing, intakeRequest(KEY, JSON.stringify(validBody())));
  assert.equal(res.status, 422);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, 'rule_failed');
  assert.ok(!body.message.includes('queue'));
});
