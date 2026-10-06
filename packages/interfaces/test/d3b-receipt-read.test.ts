/**
 * D3b wire-half seam tests (E): the serving read `Receipt.read` binds
 * through the established MCP read pipeline — closed framing against
 * the catalog shape, derived array-of-enum binding with located paths,
 * then ReadEnvelope dispatch with 1:1 outcome carriage and uniform
 * gates. No new dispatch engine: these seams prove the generic chain
 * (ordinary-mode framing + E1 binding + ReadEnvelope routing) serves
 * the adopted joint contract (op `Receipt.read`, closed inputs,
 * MCP-first, Revisions-as-numbers).
 *
 * Fixture grounding: `RECEIPT_READ` is E-authored per the adopted
 * D3b joint contract (no compiler emission exists for a system read);
 * the shape still derives through the real checked derivation, so
 * only the operation's existence is authored (E2b REMIND_AT precedent).
 * Kernel expectations (collapse order, denied-before-presence, fence
 * revision, error classes) are D's proved mechanics on main (5edc3ba);
 * B approved state-side. These tests pin the wire side only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import type { ReadEnvelope, ResolvedIdentity } from '@canlang/contracts';
import type { ReadOutcome } from '../src/ports.js';
import { buildBusinessError } from '../src/errors/envelope.js';
import { catalogFromArtifactOperations } from '../src/http/operations.js';
import { registryFromArtifactOperations } from '../src/mcp/tools.js';
import { createMcpHandler } from '../src/mcp/server.js';
import {
  createTestApp,
  createTestMcpDeps,
  testRequest,
} from '../src/testing.js';

/* Adopted D3b joint contract: closed serving inputs for receipt reads. */
const RECEIPT_READ: ArtifactOperation = {
  "name": "Receipt.read",
  "kind": "read",
  "description": "Serve selected receipt leaves for an owner record field.",
  "inputs": {"fields": [
    {"name": "recordId", "field": {"kind": "string"}, "required": true},
    {"name": "field", "field": {"kind": "string"}, "required": true},
    {"name": "selected", "field": {"kind": "enum", "values": ["id", "status", "result", "error"]}, "required": true, "array": {"required": true}},
  ]},
};

const D3B_SLICE = { artifact_version: ARTIFACT_VERSION, operations: [RECEIPT_READ] };
const OP = 'Receipt.read';

const VALID_ARGS = { recordId: 'r-1', field: 'delivery', selected: ['status'] };

type McpHandler = (request: Request) => Promise<Response>;

interface RpcBody {
  readonly result?: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

async function mcpCall(
  handler: McpHandler,
  method: string,
  params: Record<string, unknown>,
  grant?: string,
): Promise<{ status: number; body: RpcBody }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (grant !== undefined) headers['authorization'] = `Bearer ${grant}`;
  const res = await handler(
    testRequest('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcBody };
}

async function readSetup(
  reads?: Record<string, (envelope: ReadEnvelope, identity: ResolvedIdentity) => ReadOutcome | Promise<ReadOutcome>>,
  opts?: { call?: Record<string, boolean> },
) {
  const t = await createTestMcpDeps({
    descriptors: registryFromArtifactOperations(D3B_SLICE).list(createTestApp()),
    reads: reads ?? { [OP]: (envelope) => ({ result: envelope.inputs }) },
    ...(opts?.call === undefined ? {} : { call: opts.call }),
  });
  const deps = { ...t.deps, catalog: catalogFromArtifactOperations(D3B_SLICE) };
  return { t, deps, handler: createMcpHandler(deps), grant: t.grantToken };
}

test('D3b wire: Receipt.read binds as kind:read with closed inputs', async () => {
  const { t, handler, grant } = await readSetup();
  const descriptor = t.deps.registry.list(createTestApp()).find((d) => d.name === OP);
  assert.equal(descriptor?.kind, 'read');

  const unknown = await mcpCall(
    handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_ARGS, model: 'Shop.Gadget' } },
    grant,
  );
  assert.equal(unknown.body.error?.code, -32602);
  assert.ok(unknown.body.error?.message.includes("Unknown input 'model'"));

  const missing = await mcpCall(
    handler,
    'tools/call',
    { name: OP, arguments: { recordId: 'r-1', field: 'delivery' } },
    grant,
  );
  assert.equal(missing.body.error?.code, -32602);
  assert.ok(missing.body.error?.message.includes("Missing required input 'selected'"));

  // Reads carry no operation_id: a present one fails closed (never dispatched).
  const withId = await mcpCall(
    handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_ARGS, operation_id: '0190b3b0-0000-7000-8000-000000000000' } },
    grant,
  );
  assert.equal(withId.body.error?.code, -32602);
  assert.equal(t.invoker.reads.length, 0);
});

test('D3b wire: selected binds as array-of-enum with located paths', async () => {
  const { t, handler, grant } = await readSetup();
  const badLeaf = await mcpCall(
    handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_ARGS, selected: ['id', 'bogus'] } },
    grant,
  );
  assert.equal(badLeaf.body.error?.code, -32602);
  assert.ok(badLeaf.body.error?.message.includes('"id", "status", "result", "error"'));

  const notArray = await mcpCall(
    handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_ARGS, selected: 'status' } },
    grant,
  );
  assert.equal(notArray.body.error?.code, -32602);
  assert.ok(notArray.body.error?.message.includes('array inputs take arrays'));
  assert.equal(t.invoker.reads.length, 0);

  // Binding judges shape, not kernel contents: an empty selection
  // dispatches (the kernel owns non-emptiness) with verbatim inputs.
  const empty = await mcpCall(
    handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_ARGS, selected: [] } },
    grant,
  );
  assert.equal(empty.body.error, undefined);
  assert.equal(t.invoker.reads.length, 1);
  assert.deepEqual(t.invoker.reads[0]?.envelope.inputs, { ...VALID_ARGS, selected: [] });
});

test('D3b wire: observed outcome rides success 1:1 with numeric revisions', async () => {
  const observed = {
    outcome: 'observed',
    projection: { status: 'done' },
    fenceRevision: 7,
    readRevision: 9,
  };
  const { t, handler, grant } = await readSetup({ [OP]: () => ({ result: observed }) });
  const res = await mcpCall(handler, 'tools/call', { name: OP, arguments: VALID_ARGS }, grant);
  assert.equal(res.status, 200);
  assert.equal(res.body.error, undefined);
  assert.equal(res.body.result?.isError, undefined);
  assert.deepEqual(res.body.result?.structuredContent, observed);
  const structured = res.body.result?.structuredContent as { readRevision: unknown; fenceRevision: unknown };
  assert.equal(typeof structured.readRevision, 'number');
  assert.equal(typeof structured.fenceRevision, 'number');
  assert.equal(t.invoker.reads.length, 1);
});

test('D3b wire: null-association rides success with its discriminator', async () => {
  const outcome = { outcome: 'null-association', readRevision: 9 };
  const { handler, grant } = await readSetup({ [OP]: () => ({ result: outcome }) });
  const res = await mcpCall(handler, 'tools/call', { name: OP, arguments: VALID_ARGS }, grant);
  assert.equal(res.body.error, undefined);
  // Never a bare null: the discriminator always crosses.
  assert.deepEqual(res.body.result?.structuredContent, outcome);
  assert.ok(res.body.result?.content[0]?.text.includes('null-association'));
});

test('D3b wire: denied rides success with its leaf list, never isError', async () => {
  const outcome = { outcome: 'denied', denied: ['status'], readRevision: 9 };
  const { handler, grant } = await readSetup({ [OP]: () => ({ result: outcome }) });
  const res = await mcpCall(handler, 'tools/call', { name: OP, arguments: VALID_ARGS }, grant);
  assert.equal(res.body.error, undefined);
  assert.equal(res.body.result?.isError, undefined);
  assert.deepEqual(res.body.result?.structuredContent, outcome);
});

test('D3b wire: invoker not_found/conflict ride isError on reads', async () => {
  const { handler, grant } = await readSetup({
    [OP]: (envelope) => ({
      error:
        (envelope.inputs['field'] as string) === 'missing'
          ? buildBusinessError('not_found', 'Receipt owner record not found.')
          : buildBusinessError('conflict', 'Fence checkpoint moved before this read.'),
    }),
  });
  const missing = await mcpCall(
    handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_ARGS, field: 'missing' } },
    grant,
  );
  assert.equal(missing.body.result?.isError, true);
  assert.deepEqual(missing.body.result?.structuredContent, {
    code: 'not_found',
    message: 'Receipt owner record not found.',
    retryable: false,
  });
  const conflicted = await mcpCall(handler, 'tools/call', { name: OP, arguments: VALID_ARGS }, grant);
  assert.equal(conflicted.body.result?.isError, true);
  const structured = conflicted.body.result?.structuredContent as { code: string };
  assert.equal(structured.code, 'conflict');
});

test('D3b wire: anonymous and permission-denied reads never dispatch', async () => {
  const { handler } = await readSetup();
  const anon = await mcpCall(handler, 'tools/call', { name: OP, arguments: VALID_ARGS });
  assert.equal(anon.status, 401);

  const { t, handler: deniedHandler, grant } = await readSetup(undefined, {
    call: { [OP]: false },
  });
  const denied = await mcpCall(deniedHandler, 'tools/call', { name: OP, arguments: VALID_ARGS }, grant);
  assert.equal(denied.body.result?.isError, true);
  const structured = denied.body.result?.structuredContent as { code: string; message: string };
  assert.equal(structured.code, 'forbidden');
  assert.equal(structured.message, 'You do not have permission to perform this action.');
  assert.equal(t.invoker.reads.length, 0);
});
