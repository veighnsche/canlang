/**
 * Owned HTTP validation gate: ONE JSON op path genuinely executes the
 * owned values/v1 pipeline
 * (parseOwnedJsonBody -> ownedFrameFor -> begin -> resolve -> execute
 * -> dispose) through the catalog's owned handle before the invoker
 * runs. Valid inputs invoke with the legacy envelope unchanged;
 * invalid inputs deny as validation without invoking. Operations
 * without a handle keep their exact legacy behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { deriveCsrfToken } from '@canlang/identity';
import { decodeValue, encodeValue } from '@canlang/values';
import { initSync } from '@canlang/values/bindings/generated/values_semantics.js';
import {
  loadOwnerPlan,
  validationBackend,
  type ExactCodecCapability,
  type ValidationBackend,
  type ValidationGlue,
} from '@canlang/values/bindings/validation';
import { structural_abi_version, validation_call } from '@canlang/values/bindings/generated/values_semantics.js';
import { handleOperationRequest } from '../src/http/operations.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const OP = 'acme.refund';

function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

const glueJs = fileURLToPath(import.meta.resolve('@canlang/values/bindings/generated/values_semantics.js'));
const wasmBytes = () =>
  new Uint8Array(readFileSync(join(dirname(glueJs), 'values_semantics_bg.wasm')));

function backend(): ValidationBackend {
  initSync({ module: wasmBytes() });
  const glue: ValidationGlue = { structural_abi_version, validation_call };
  return validationBackend(glue);
}

function ownedSchema(): Record<string, unknown> {
  return {
    t: 'normalized',
    contracts: [],
    enums: [],
    operations: [
      {
        name: OP,
        mutation: true,
        inputs: [
          {
            name: 'amount',
            type_id: 'money',
            base: { t: 'scalar', name: 'money' },
            required: true,
          },
          {
            name: 'note',
            type_id: 'text',
            base: { t: 'scalar', name: 'text' },
            required: false,
          },
        ],
      },
    ],
  };
}

async function setup() {
  const t = await createTestDeps({
    shapes: { [OP]: { allowed: ['amount', 'note'], required: ['amount'] } },
    mutations: {
      [OP]: (envelope) => ({
        result: {
          status: 'committed',
          operation_id: envelope.operation_id,
          result: { echoed: envelope.inputs },
        },
      }),
    },
  });
  const via = backend();
  const loaded = loadOwnerPlan(via, {
    abi: 'v1',
    profile: 'values',
    planProfile: 'values/v1',
    backend: 'native',
    owner_rev: 'artifact-1',
    bound: 8,
    schema: ownedSchema(),
    provenance: { factory: 'normalizeSchema', owner_rev: 'artifact-1' },
  });
  const exact: ExactCodecCapability = {
    decode: (leaf: string, wire: unknown) => decodeValue(leaf, wire) as never,
    encode: (leaf: string, value: unknown) => encodeValue(leaf, value as never) as never,
  };
  const selection = { kind: 'native', join: true, detail: 'test-installed money/text operation' } as const;
  const deps = {
    ...t.deps,
    catalog: {
      ...t.deps.catalog,
      ownedValidationFor: (operation: string) =>
        operation === OP
          ? {
            backend: via,
            exact,
            owner: loaded.owner,
            plan: loaded.id,
            budgets: { nodes: 1000, depth: 50, text: 1000, entries: 100 },
            selection,
          }
          : null,
    },
  };
  return { ...t, deps, csrf: await deriveCsrfToken(t.identity.sessionToken) };
}

function opRequest(opts: { cookie?: string; csrf?: string; body: string }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
  return testRequest(`/operations/${OP}`, {
    method: 'POST',
    headers,
    ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    body: opts.body,
  });
}

test('owned gate admits valid exact inputs to the invoker unchanged', async () => {
  const t = await setup();
  const operation_id = freshOperationId();
  const inputs = { amount: { minor: '100', currency: 'USD' }, note: 'hi' };
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf: t.csrf,
      body: JSON.stringify({ operation: OP, operation_id, inputs }),
    }),
    OP,
  );
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { status: string; operation_id: string };
  assert.equal(payload.status, 'committed');
  assert.equal(payload.operation_id, operation_id);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]!.envelope.inputs, inputs);
});

test('owned gate denies invalid exact inputs before the invoker runs', async () => {
  const t = await setup();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf: t.csrf,
      body: JSON.stringify({
        operation: OP,
        operation_id: freshOperationId(),
        inputs: { amount: { minor: 'xx', currency: 'USD' } },
      }),
    }),
    OP,
  );
  assert.equal(res.status, 400);
  const payload = (await res.json()) as {
    code: string;
    fields?: Array<{ path: string; code: string; message: string }>;
  };
  assert.equal(payload.code, 'validation');
  assert.deepEqual(payload.fields?.map((field) => field.path), ['/amount/minor']);
  assert.equal(t.invoker.mutations.length, 0);
});

test('owned gate projects out inputs._csrf like the canonical submitted inputs', async () => {
  // VALIDATION-012 D: `_csrf` is transport (consumed by the check,
  // stripped before the closed-inputs check), so the native call must
  // see the protected projection — never an unknown-argument denial
  // once a production handle exists.
  const t = await setup();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf: t.csrf,
      body: JSON.stringify({
        operation: OP,
        operation_id: freshOperationId(),
        inputs: { amount: { minor: '100', currency: 'USD' }, _csrf: t.csrf },
      }),
    }),
    OP,
  );
  assert.equal(res.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
});

test('operations without an owned handle keep legacy behavior', async () => {
  const t = await createTestDeps({
    shapes: { [OP]: { allowed: ['amount'], required: ['amount'] } },
    mutations: {
      [OP]: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id, result: {} },
      }),
    },
  });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: { amount: 'anything' } }),
    }),
    OP,
  );
  assert.equal(res.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
});
