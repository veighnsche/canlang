/**
 * V02.3 owned-HTTP pins: the prepared HTTP framing/binding plan
 * (`envelope/prepared.ts`) reproduces the exact dispatch evaluation
 * for profile `http-input/v1` — framing first (first unknown key in
 * JS enumeration order, then first missing required field in shape
 * order, both own-presence), then derived binding (first failure in
 * derived-input declaration order, present members only). Deferrals
 * stay distinct (string-values, boolean-values, currency-code), and
 * defaults are never manufactured (raw submitted inputs out).
 *
 * Grounding (no invented operations or types): `OWNED_HTTP` follows
 * the t19a/t19b fixture vocabulary verbatim (`GADGET_CREATE` string/
 * integer/decimal/enum/ref shapes, e2 `fee` money + `doc` file,
 * e2b `at` datetime); the plan derives through the real checked
 * derivation (`catalogFromArtifactOperations`), and the differential
 * pin dispatches through the real `handleOperationRequest`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveCsrfToken } from '@canlang/identity';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import {
  catalogFromArtifactOperations,
  handleOperationRequest,
} from '../src/http/operations.js';
import { prepareHttpPlan, runPreparedHttpPlan } from '../src/envelope/prepared.js';
import type { PreparedHttpPlan } from '../src/envelope/prepared.js';
import { createTestDeps, testRequest } from '../src/testing.js';

/* Fixture op in the t19a/t19b vocabulary: every binding-relevant kind. */
const OWNED_HTTP: ArtifactOperation = {
  "name": "Billing.Invoice.issue",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "customer", "field": {"kind": "string"}, "required": true},
    {"name": "memo", "field": {"kind": "string"}, "required": false},
    {"name": "urgent", "field": {"kind": "boolean"}, "required": false},
    {"name": "total", "field": {"kind": "money"}, "required": true},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "sent"]}, "required": false, "default": {"kind": "literal", "value": "draft"}},
    {"name": "count", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "0"}},
    {"name": "ratio", "field": {"kind": "decimal"}, "required": false},
    {"name": "due", "field": {"kind": "datetime"}, "required": false},
    {"name": "owner", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": false, "nullable": true},
    {"name": "doc", "field": {"kind": "file"}, "required": false},
    {"name": "tags", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
  ]},
};

const SLICE = { artifact_version: ARTIFACT_VERSION, operations: [OWNED_HTTP] };

function testPlan(): PreparedHttpPlan {
  const catalog = catalogFromArtifactOperations(SLICE);
  const shape = catalog.shapeFor('Billing.Invoice.issue');
  const derived = catalog.derivedFor('Billing.Invoice.issue');
  assert.ok(shape !== null && derived !== null);
  return prepareHttpPlan('Billing.Invoice.issue', shape, derived);
}

/** Minimal framing+binding-valid business inputs for the fixture op. */
const VALID = { customer: 'c-1', total: { minor: '100', currency: 'USD' } };

function fieldCode(outcome: { ok: false; error: { fields?: ReadonlyArray<{ code: string }> } }): string | undefined {
  return outcome.error.fields?.[0]?.code;
}

test('V02.3 owned-http: plan freezes shape order, derived order, flags, and never-applied defaults', () => {
  const plan = testPlan();
  assert.deepEqual([...plan.allowed], [
    'customer', 'memo', 'urgent', 'total', 'state', 'count', 'ratio', 'due', 'owner', 'doc', 'tags',
  ]);
  assert.deepEqual([...plan.required], ['customer', 'total']);
  assert.deepEqual(plan.binding.map((entry) => entry.name), [...plan.allowed]);
  assert.equal(plan.defaults, 'never-applied');
  assert.ok(!('default' in plan.binding[4]!) && !('default' in plan.binding[5]!));
  const owner = plan.binding[8]!;
  assert.equal(owner.nullable, true);
  assert.equal(owner.versioned, true);
  assert.equal(plan.binding[4]!.enumValues?.join(','), 'draft,sent');
  assert.equal(plan.binding[10]!.array, true);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.binding));
});

test('V02.3 owned-http: first unknown (JS enumeration) beats missing beats binding, in order', () => {
  const plan = testPlan();
  /* Unknown beats missing required. */
  const unknown = runPreparedHttpPlan(plan, { zzz: 1 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.message, /^Unknown input 'zzz'\./);
  assert.equal(fieldCode(unknown), 'unknown');
  /* First unknown follows JS enumeration (insertion) order, not sorted. */
  const twoUnknown = runPreparedHttpPlan(plan, { ...VALID, b_unknown: 1, a_unknown: 2 });
  assert.equal(twoUnknown.ok, false);
  assert.match(twoUnknown.error.message, /^Unknown input 'b_unknown'\./);
  /* Missing follows shape order: customer precedes total. */
  const missing = runPreparedHttpPlan(plan, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /^Missing required input 'customer'\./);
  assert.equal(fieldCode(missing), 'required');
  /* Binding follows derived declaration order: state (index 4) precedes count (index 5). */
  const bound = runPreparedHttpPlan(plan, { ...VALID, state: 'bogus', count: 'bogus' });
  assert.equal(bound.ok, false);
  assert.match(bound.error.message, /"state"/);
  assert.equal(fieldCode(bound), 'binding_mismatch');
});

test('V02.3 owned-http: explicit own null/undefined differ from omission', () => {
  const plan = testPlan();
  /* Explicit null binds to nullable only. */
  const nullOk = runPreparedHttpPlan(plan, { ...VALID, owner: null });
  assert.equal(nullOk.ok, true);
  const nullBad = runPreparedHttpPlan(plan, { ...VALID, customer: null });
  assert.equal(nullBad.ok, false);
  assert.match(nullBad.error.message, /null is not accepted/);
  /* Present-undefined counts as present for framing (no missing error). */
  const undefString = runPreparedHttpPlan(plan, { ...VALID, customer: undefined });
  assert.equal(undefString.ok, true);
  /* ...but still binds by kind: undefined money mismatches. */
  const undefMoney = runPreparedHttpPlan(plan, { ...VALID, total: undefined });
  assert.equal(undefMoney.ok, false);
  assert.match(undefMoney.error.message, /"total"/);
  /* Array-element nulls pass binding through to L3. */
  const elementNull = runPreparedHttpPlan(plan, { ...VALID, tags: ['a', null] });
  assert.equal(elementNull.ok, true);
});

test('V02.3 owned-http: string/boolean/currency deferrals stay distinct', () => {
  const plan = testPlan();
  const byName = new Map(plan.binding.map((entry) => [entry.name, entry.deferral]));
  assert.equal(byName.get('memo'), 'string-values');
  assert.equal(byName.get('urgent'), 'boolean-values');
  assert.equal(byName.get('total'), 'currency-code');
  assert.equal(byName.get('customer'), 'string-values');
  assert.equal(byName.get('state'), 'bound');
  assert.equal(byName.get('count'), 'bound');
  /* String-kind values pass binding untouched, whatever the spelling. */
  assert.equal(runPreparedHttpPlan(plan, { ...VALID, memo: 42 }).ok, true);
  /* Boolean-kind values pass binding untouched — even string spellings. */
  assert.equal(runPreparedHttpPlan(plan, { ...VALID, urgent: 'yes' }).ok, true);
  /* Money binds shape/minor only: an odd currency CODE still passes. */
  assert.equal(runPreparedHttpPlan(plan, { ...VALID, total: { minor: '100', currency: 'XXX' } }).ok, true);
  /* ...while a non-string currency fails the bound shape check. */
  const badCurrency = runPreparedHttpPlan(plan, { ...VALID, total: { minor: '100', currency: 42 } });
  assert.equal(badCurrency.ok, false);
  assert.match(badCurrency.error.message, /money\.currency is a string/);
});

test('V02.3 owned-http: success returns submitted inputs raw — defaults never manufactured', () => {
  const plan = testPlan();
  const submitted = { ...VALID };
  const outcome = runPreparedHttpPlan(plan, submitted);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.inputs, submitted);
  assert.ok(!('state' in outcome.inputs) && !('count' in outcome.inputs));
});

/** Fresh canonical UUIDv7 operation_id (E1 pattern). */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

test('V02.3 owned-http: plan verdicts agree with dispatched handleOperationRequest', async () => {
  const plan = testPlan();
  const t = await createTestDeps({
    mutations: {
      'Billing.Invoice.issue': (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id, result: { echoed: envelope.inputs } },
      }),
    },
  });
  const deps = { ...t.deps, catalog: catalogFromArtifactOperations(SLICE) };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const cases: Array<{ inputs: Record<string, unknown>; status: 200 | 400 }> = [
    { inputs: { ...VALID }, status: 200 },
    { inputs: { zzz: 1 }, status: 400 },
    { inputs: {}, status: 400 },
    { inputs: { ...VALID, state: 'bogus' }, status: 400 },
  ];
  for (const kase of cases) {
    const planned = runPreparedHttpPlan(plan, kase.inputs);
    assert.equal(planned.ok, kase.status === 200);
    const res = await handleOperationRequest(
      deps,
      testRequest('/api/operations/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cookie: t.identity.cookie,
        body: JSON.stringify({
          operation_id: freshOperationId(),
          inputs: { ...kase.inputs, _csrf: csrf },
        }),
      }),
      'Billing.Invoice.issue',
    );
    assert.equal(res.status, kase.status);
    const body = (await res.json()) as { message?: string };
    if (!planned.ok) assert.equal(body.message, planned.error.message);
  }
});
