/**
 * V02.5 owned-MCP pins: the prepared ordinary-MCP framing/binding plan
 * (`mcp/prepared.ts`) reproduces the exact dispatch evaluation for
 * profile `mcp-ordinary/v1` — host mutation-ID framing first, then
 * closed inputs, then the MCP-SPECIFIC ref/shape checks in descriptor
 * order (exact keys, id ≤ 256 UTF-16 units, arbitrary-digit versions,
 * explicit nulls on derived-declared refs deferred to binding), then
 * derived binding in declaration order. Reads carry no `operation_id`
 * (a present one stays an unknown business member); failures project
 * to `InvalidParams` (-32602); the sealed handle-mode path is
 * preserved untouched; SDK argument provenance stays deferred.
 *
 * Grounding (no invented operations or types): fixture ops follow the
 * t19a/t19b/D3b vocabulary verbatim (versioned/unversioned `ref`
 * shapes, enum, string); plans derive through the real checked
 * derivation (`registryFromArtifactOperations` +
 * `catalogFromArtifactOperations`), and projection pins dispatch
 * through the real `createMcpHandler`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import { catalogFromArtifactOperations } from '../src/http/operations.js';
import { prepareMcpPlan, runPreparedMcpPlan } from '../src/mcp/prepared.js';
import type { PreparedMcpPlan } from '../src/mcp/prepared.js';
import { createMcpHandler } from '../src/mcp/server.js';
import { registryFromArtifactOperations } from '../src/mcp/tools.js';
import {
  createTestApp,
  createTestMcpDeps,
  testRequest,
} from '../src/testing.js';

/* Fixture mutation: unversioned + versioned refs, enum, string. */
const MCP_CREATE: ArtifactOperation = {
  "name": "Billing.Invoice.issue",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "customer", "field": {"kind": "ref", "model": "Shop.Customer", "requireVersion": false}, "required": true},
    {"name": "owner", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": false, "nullable": true},
    {"name": "memo", "field": {"kind": "string"}, "required": false},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "sent"]}, "required": false, "default": {"kind": "literal", "value": "draft"}},
  ]},
};

/* Fixture read: unversioned ref only; carries no operation_id. */
const MCP_READ: ArtifactOperation = {
  "name": "Billing.Invoice.read",
  "kind": "read",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": false}, "required": true},
  ]},
};

const SLICE = { artifact_version: ARTIFACT_VERSION, operations: [MCP_CREATE, MCP_READ] };

function testPlan(name: string): PreparedMcpPlan {
  const registry = registryFromArtifactOperations(SLICE);
  const catalog = catalogFromArtifactOperations(SLICE);
  const descriptor = registry.list(createTestApp()).find((d) => d.name === name);
  const shape = catalog.shapeFor(name);
  const derived = catalog.derivedFor(name);
  assert.ok(descriptor !== undefined && shape !== null && derived !== null);
  return prepareMcpPlan(descriptor, shape, derived);
}

/** Fresh canonical UUIDv7 operation_id (E1 pattern). */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

const VALID_MUTATION = { customer: { id: 'c-1' } };
const VALID_READ = { record: { id: 'r-1' } };

type McpHandler = (request: Request) => Promise<Response>;

interface RpcBody {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

async function mcpCall(
  handler: McpHandler,
  method: string,
  params: Record<string, unknown>,
  grant: string,
): Promise<{ status: number; body: RpcBody }> {
  const res = await handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${grant}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcBody };
}

async function mcpSetup() {
  const t = await createTestMcpDeps({
    descriptors: registryFromArtifactOperations(SLICE).list(createTestApp()),
    mutations: {
      'Billing.Invoice.issue': (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id, result: { echoed: envelope.inputs } },
      }),
    },
    reads: {
      'Billing.Invoice.read': (envelope) => ({ result: envelope.inputs }),
    },
  });
  const deps = { ...t.deps, catalog: catalogFromArtifactOperations(SLICE) };
  return { t, deps, handler: createMcpHandler(deps), grant: t.grantToken };
}

test('V02.5 owned-mcp: plan freezes mutation flags, ref rules, order, and deferrals', () => {
  const mutation = testPlan('Billing.Invoice.issue');
  assert.equal(mutation.mutation, true);
  assert.deepEqual(mutation.refs.map((rule) => rule.name), ['customer', 'owner']);
  assert.deepEqual(mutation.refs[0], {
    name: 'customer',
    versioned: false,
    idMaxUtf16: 256,
    versionRule: 'arbitrary-digits',
    exactKeys: ['id'],
  });
  assert.deepEqual(mutation.refs[1], {
    name: 'owner',
    versioned: true,
    idMaxUtf16: 256,
    versionRule: 'arbitrary-digits',
    exactKeys: ['id', 'version'],
  });
  assert.deepEqual(mutation.binding.map((entry) => entry.name), ['customer', 'owner', 'memo', 'state']);
  assert.equal(mutation.defaults, 'never-applied');
  assert.equal(mutation.sdkProvenance, 'deferred');
  assert.ok(!('default' in mutation.binding[3]!));
  const read = testPlan('Billing.Invoice.read');
  assert.equal(read.mutation, false);
  assert.equal(read.refs.length, 1);
});

test('V02.5 owned-mcp: operation_id framing precedes unknown/missing/ref-shape/binding', () => {
  const plan = testPlan('Billing.Invoice.issue');
  /* Host mutation-ID framing first — even with an unknown member present. */
  const noId = runPreparedMcpPlan(plan, { zzz: 1 });
  assert.equal(noId.ok, false);
  assert.match(noId.error.message, /^Missing operation_id\./);
  const id = freshOperationId();
  /* ...then unknown, then missing, in the canonical orders. */
  const unknown = runPreparedMcpPlan(plan, { operation_id: id, zzz: 1 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.message, /^Unknown input 'zzz'\./);
  const missing = runPreparedMcpPlan(plan, { operation_id: id });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /^Missing required input 'customer'\./);
  /* ...then the MCP ref-shape stage, before derived binding. */
  const badRef = runPreparedMcpPlan(plan, {
    operation_id: id,
    ...VALID_MUTATION,
    customer: { id: 1 },
    state: 'bogus',
  });
  assert.equal(badRef.ok, false);
  assert.match(badRef.error.message, /^Invalid record id\./);
  /* ...then first binding failure in derived order. */
  const badBinding = runPreparedMcpPlan(plan, { operation_id: id, ...VALID_MUTATION, state: 'bogus' });
  assert.equal(badBinding.ok, false);
  assert.match(badBinding.error.message, /"state"/);
  /* Success strips operation_id and returns business inputs verbatim. */
  const ok = runPreparedMcpPlan(plan, { operation_id: id, ...VALID_MUTATION });
  assert.equal(ok.ok, true);
  assert.equal(ok.operation_id, id);
  assert.ok(!('operation_id' in ok.inputs) && !('state' in ok.inputs));
});

test('V02.5 owned-mcp: ref keys exact, ids bounded in UTF-16 units, versions arbitrary digits', () => {
  const plan = testPlan('Billing.Invoice.issue');
  const id = freshOperationId();
  const run = (args: Record<string, unknown>) => runPreparedMcpPlan(plan, { operation_id: id, ...args });
  /* Extra ref members fail — keys are exact. */
  const extra = run({ ...VALID_MUTATION, customer: { id: 'c-1', version: '3' } });
  assert.equal(extra.ok, false);
  assert.match(extra.error.message, /^Unknown member 'version'\./);
  /* Empty and over-long ids fail; the boundary passes. */
  assert.match((run({ ...VALID_MUTATION, customer: { id: '' } }) as { ok: false; error: { message: string } }).error.message, /^Invalid record id\./);
  const over = run({ ...VALID_MUTATION, customer: { id: 'x'.repeat(257) } });
  assert.equal(over.ok, false);
  assert.match(over.error.message, /^Invalid record id\./);
  assert.equal(run({ ...VALID_MUTATION, customer: { id: 'x'.repeat(256) } }).ok, true);
  /* The unit is UTF-16 code units: 128 astral chars (256 units) pass, 129 (258) fail. */
  assert.equal(run({ ...VALID_MUTATION, customer: { id: '𐀀'.repeat(128) } }).ok, true);
  const astralOver = run({ ...VALID_MUTATION, customer: { id: '𐀀'.repeat(129) } });
  assert.equal(astralOver.ok, false);
  /* Versions are arbitrary-digit strings: length unbounded, numbers rejected. */
  const longVersion = run({ ...VALID_MUTATION, owner: { id: 'g-1', version: '9'.repeat(400) } });
  assert.equal(longVersion.ok, true);
  const numberVersion = run({ ...VALID_MUTATION, owner: { id: 'g-1', version: 3 } });
  assert.equal(numberVersion.ok, false);
  assert.match(numberVersion.error.message, /^Invalid record version\./);
  /* Unversioned shape stays unversioned even on a mutation tool. */
  const versionedRead = run({ ...VALID_MUTATION, customer: { id: 'c-1', version: '3' } });
  assert.equal(versionedRead.ok, false);
});

test('V02.5 owned-mcp: query operation_id stays an unknown business member', () => {
  const plan = testPlan('Billing.Invoice.read');
  const clean = runPreparedMcpPlan(plan, { ...VALID_READ });
  assert.equal(clean.ok, true);
  assert.equal(clean.operation_id, '');
  const withId = runPreparedMcpPlan(plan, { ...VALID_READ, operation_id: freshOperationId() });
  assert.equal(withId.ok, false);
  assert.match(withId.error.message, /^Unknown input 'operation_id'\./);
});

test('V02.5 owned-mcp: explicit null on derived refs defers to binding', () => {
  const plan = testPlan('Billing.Invoice.issue');
  const id = freshOperationId();
  /* Nullable versioned ref: null skips shape framing, binds below. */
  assert.equal(runPreparedMcpPlan(plan, { operation_id: id, ...VALID_MUTATION, owner: null }).ok, true);
  /* Non-nullable ref: null skips shape framing, binding rejects. */
  const badNull = runPreparedMcpPlan(plan, { operation_id: id, ...VALID_MUTATION, customer: null });
  assert.equal(badNull.ok, false);
  assert.match(badNull.error.message, /null is not accepted/);
});

test('V02.5 owned-mcp: InvalidParams projection preserved; sealed handle path untouched', async () => {
  const { t, handler, grant } = await mcpSetup();
  const id = freshOperationId();
  /* Plan verdicts project to InvalidParams (-32602) with the same message. */
  const plan = testPlan('Billing.Invoice.issue');
  const planned = runPreparedMcpPlan(plan, { operation_id: id, zzz: 1 });
  assert.equal(planned.ok, false);
  const projected = await mcpCall(handler, 'tools/call', {
    name: 'Billing.Invoice.issue',
    arguments: { operation_id: id, zzz: 1 },
  }, grant);
  assert.equal(projected.body.error?.code, -32602);
  assert.ok(projected.body.error?.message.includes(planned.error.message));
  /* Query operation_id projects the same way on reads. */
  const readPlan = testPlan('Billing.Invoice.read');
  const readPlanned = runPreparedMcpPlan(readPlan, { ...VALID_READ, operation_id: id });
  assert.equal(readPlanned.ok, false);
  const readProjected = await mcpCall(handler, 'tools/call', {
    name: 'Billing.Invoice.read',
    arguments: { ...VALID_READ, operation_id: id },
  }, grant);
  assert.equal(readProjected.body.error?.code, -32602);
  assert.ok(readProjected.body.error?.message.includes(readPlanned.error.message));
  assert.equal(t.invoker.reads.length, 0);
  /* Sealed handle calls still take the preserved handle-mode path. */
  const sealed = await mcpCall(handler, 'tools/call', {
    name: 'Billing.Invoice.issue',
    arguments: { action_handle: { sealed: true }, operation_id: id, customer: { id: 'c-1' } },
  }, grant);
  assert.equal(sealed.body.error?.code, -32602);
  assert.match(sealed.body.error?.message ?? '', /Record input 'customer' is sealed by the action handle\./);
  /* ...and never route through the ordinary plan. */
  assert.throws(
    () => runPreparedMcpPlan(plan, { action_handle: { sealed: true }, operation_id: id }),
    /handle-mode path/,
  );
});
