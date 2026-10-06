/**
 * T19b depth tests: delivery bindings, exact decimals, file claims,
 * bound arguments, and list/team underivability — HTTP/MCP parity
 * throughout, equal authority retained.
 *
 * Grounding tiers (no invented descriptors or types):
 * - Tier 1 (CLI verbatim): `LEDGER_*` fixtures are verbatim
 *   `operations[]` entries emitted by the real toolchain
 *   (`can 0.1.0`, commit c2006bb, exit 0, diagnostics null) over this
 *   source (`can compile --format=json`, descriptors ride
 *   `modules[0].js` `operations:[...]`):
 *
 *   app Ledger
 *   Given
 *    Gadget { title:text, stock:int=0, price:decimal, fee:money=money(500,"USD"), whole:decimal=2, delta:int=-5, doc:file }
 *    policy Gadget read=members
 *   When
 *    crud Gadget by=members fields=title,stock,price,fee,whole,delta,doc
 *    scenario review(limit:int=10) by=members
 *     do
 *      let x = 1
 *    scenario bigdec_probe(big:decimal=99999999999999999999999) by=members
 *     do
 *      let x = 1
 *   Then
 *
 *   The R16 star: `whole:decimal=2` and the 23-digit (>int64)
 *   `big:decimal=99999999999999999999999` render verbatim on decimal
 *   inputs (no int64 narrowing); computed defaults (`money(...)`,
 *   `-5`) leave their inputs default-less, verbatim.
 * - Tier 2 (test-only artifact pins, re-verified green on HEAD):
 *   delivery descriptor JSON is the T15b pin (`t15b_*`, 8/8 green);
 *   `"1.50"`/`"-0.5"`/`"-3"`/money-literal descriptor shapes are the
 *   T15a pins (`t15a_*`, 15/15 green). The CLI cannot emit these
 *   (E6008 lowering posture) — the suites are the current-compiler
 *   verification. `RETRY` mirrors the T15b end-to-end source pattern
 *   (`scenario retry(note:text, attempt:delivery(Mail.send)?)`).
 * - Tier 3 (contract grammar): T11 `parseDecimal` accept/reject, L2
 *   wire shapes, and the T13c leaf tables (mechanically
 *   cross-checked char-for-char against `catalog.rs`; see report).
 *   Negative controls are verbatim-plus-tamper edits, which must
 *   reject (proving the tamper, not a new operation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveCsrfToken } from '@canlang/identity';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type { ArtifactOperation } from '@canlang/contracts';
import type { DerivedOperationInputs, DerivedWritableInput } from '@canlang/contracts';
import { checkExpectedVersion } from '../src/envelope/versions.js';
import {
  catalogFromArtifactOperations,
  deriveOperationInputs,
  deriveOperationShape,
  handleOperationRequest,
} from '../src/http/operations.js';
import {
  IncompatibleDescriptorError,
  checkArtifactOperation,
  checkBoundArgument,
  checkBoundArguments,
  toMcpInputSchema,
  toToolInputSchemaFromArtifact,
} from '../src/mcp/schemas.js';
import type {
  ArtifactOperationSlice,
  IncompatibleDescriptorReason,
} from '../src/mcp/schemas.js';
import {
  registryFromArtifactOperations,
  toMcpToolFromArtifact,
  toOperationDescriptor,
  toolsFromArtifactOperations,
} from '../src/mcp/tools.js';
import { createTestApp, createTestDeps, testRequest } from '../src/testing.js';

/* Verbatim emission: Ledger.Gadget.create (R16 whole, default-less fee/delta, file doc). */
const LEDGER_CREATE: ArtifactOperation = {
  "name": "Ledger.Gadget.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "title", "field": {"kind": "string"}, "required": true},
    {"name": "stock", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "0"}},
    {"name": "price", "field": {"kind": "decimal"}, "required": true},
    {"name": "fee", "field": {"kind": "money"}, "required": false},
    {"name": "whole", "field": {"kind": "decimal"}, "required": false, "default": {"kind": "literal", "value": "2"}},
    {"name": "delta", "field": {"kind": "integer"}, "required": false},
    {"name": "doc", "field": {"kind": "file"}, "required": true},
  ]},
};

/* Verbatim emission: Ledger.Gadget.update (partial, default-less). */
const LEDGER_UPDATE: ArtifactOperation = {
  "name": "Ledger.Gadget.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Ledger.Gadget", "requireVersion": true}, "required": true},
    {"name": "title", "field": {"kind": "string"}, "required": false},
    {"name": "stock", "field": {"kind": "integer"}, "required": false},
    {"name": "price", "field": {"kind": "decimal"}, "required": false},
    {"name": "fee", "field": {"kind": "money"}, "required": false},
    {"name": "whole", "field": {"kind": "decimal"}, "required": false},
    {"name": "delta", "field": {"kind": "integer"}, "required": false},
    {"name": "doc", "field": {"kind": "file"}, "required": false},
  ]},
};

/* Verbatim emission: Ledger.Gadget.delete (record only). */
const LEDGER_DELETE: ArtifactOperation = {
  "name": "Ledger.Gadget.delete",
  "kind": "delete",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Ledger.Gadget", "requireVersion": true}, "required": true},
  ]},
};

/* Verbatim emission: Ledger.Gadget.read (empty inputs). */
const LEDGER_READ: ArtifactOperation = {
  "name": "Ledger.Gadget.read",
  "kind": "read",
  "description": "",
  "inputs": {"fields": []},
};

/* Verbatim emission: Ledger.review (integer literal default). */
const LEDGER_REVIEW: ArtifactOperation = {
  "name": "Ledger.review",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "limit", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "10"}},
  ]},
};

/* Verbatim emission: Ledger.bigdec_probe (R16 23-digit integral on decimal). */
const LEDGER_BIGDEC: ArtifactOperation = {
  "name": "Ledger.bigdec_probe",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "big", "field": {"kind": "decimal"}, "required": false, "default": {"kind": "literal", "value": "99999999999999999999999"}},
  ]},
};

/* Tier-2 delivery scenario (T15b end-to-end pattern): ordinary note plus a
 * nullable EmailAccepted receipt binding (the T15b-pinned descriptor JSON). */
const RETRY: ArtifactOperation = {
  "name": "Receipts.retry",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "note", "field": {"kind": "string"}, "required": true},
    {"name": "attempt", "field": {"kind": "delivery", "capability": "std.EmailV1", "operation": "send", "version": 1, "result": {"name": "EmailAccepted", "fields": [{"name": "reference", "type": "text"}]}}, "required": false, "nullable": true},
  ]},
};

/** One Tier-2 delivery case: T13 target plus its verbatim T13c result leaves. */
interface DeliveryCase {
  readonly capability: string;
  readonly operation: string;
  readonly nominal: string;
  readonly leaves: ReadonlyArray<{ readonly name: string; readonly type: string }>;
}

const DELIVERY_CASES: readonly DeliveryCase[] = [
  { capability: 'std.EmailV1', operation: 'send', nominal: 'EmailAccepted', leaves: [
    { name: 'reference', type: 'text' },
  ] },
  { capability: 'std.ErrorsV1', operation: 'report', nominal: 'ErrorAccepted', leaves: [
    { name: 'reference', type: 'text' },
  ] },
  { capability: 'std.PaymentsV1', operation: 'collect', nominal: 'PaymentState', leaves: [
    { name: 'reference', type: 'text' },
    { name: 'revision', type: 'int' },
    { name: 'provider_reference', type: 'text?' },
    { name: 'amount', type: 'money' },
    { name: 'status', type: 'enum(pending,unknown,succeeded,failed)' },
    { name: 'checkout_url', type: 'url?' },
    { name: 'failure', type: 'enum(transient,action_required,permanent,cancelled)?' },
  ] },
  { capability: 'std.TextGenerationV1', operation: 'generate', nominal: 'TextRun', leaves: [
    { name: 'source', type: 'text' },
    { name: 'revision', type: 'int' },
    { name: 'sequence', type: 'int' },
    { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' },
    { name: 'content', type: 'text' },
    { name: 'used_tokens', type: 'int?' },
    { name: 'detail', type: 'text?' },
  ] },
  { capability: 'std.ImagesV1', operation: 'inspect', nominal: 'WorkflowInspection', leaves: [
    { name: 'fields', type: 'WorkflowField[]' },
  ] },
  { capability: 'std.ImagesV1', operation: 'validate', nominal: 'WorkflowValidation', leaves: [
    { name: 'valid', type: 'bool' },
    { name: 'digest', type: 'text?' },
    { name: 'detail', type: 'text?' },
  ] },
  { capability: 'std.ImagesV1', operation: 'submit', nominal: 'ImageRun', leaves: [
    { name: 'source', type: 'text' },
    { name: 'revision', type: 'int' },
    { name: 'sequence', type: 'int' },
    { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' },
    { name: 'outputs', type: 'GeneratedImage[]' },
    { name: 'charged_jobs', type: 'int?' },
    { name: 'detail', type: 'text?' },
  ] },
  { capability: 'std.MailboxV1', operation: 'reply', nominal: 'MailReplyOutcome', leaves: [
    { name: 'source', type: 'text' },
    { name: 'state', type: 'enum(accepted,not_sent,unknown)' },
    { name: 'reference', type: 'text?' },
    { name: 'detail', type: 'text?' },
  ] },
];

/** Wrap one delivery case as a single-receipt scenario operation. */
function deliveryOp(index: number): ArtifactOperation {
  const kase = DELIVERY_CASES[index];
  assert.ok(kase !== undefined);
  return {
    name: `Receipts.notify_${kase.nominal}`,
    kind: 'scenario',
    description: '',
    inputs: { fields: [
      {
        name: 'receipt',
        field: {
          kind: 'delivery',
          capability: kase.capability,
          operation: kase.operation,
          version: 1,
          result: {
            name: kase.nominal,
            fields: kase.leaves.map((leaf) => ({ name: leaf.name, type: leaf.type })),
          },
        },
        required: true,
      },
    ] },
  };
}

const T19B_OPS: readonly ArtifactOperation[] = [
  LEDGER_READ,
  LEDGER_CREATE,
  LEDGER_UPDATE,
  LEDGER_DELETE,
  LEDGER_REVIEW,
  LEDGER_BIGDEC,
  RETRY,
  ...DELIVERY_CASES.map((_, index) => deliveryOp(index)),
];

const T19B_SLICE: ArtifactOperationSlice = { artifact_version: 1, operations: T19B_OPS };

/** Run a derivation and return its rejection reason (fails when it derives). */
function rejectionReason(fn: () => unknown): IncompatibleDescriptorReason {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof IncompatibleDescriptorError, `expected derivation rejection, got ${String(err)}`);
    return err.reason;
  }
  assert.fail('expected IncompatibleDescriptorError');
}

/** Run a derivation and return its rejection message (fails when it derives). */
function rejectionMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof IncompatibleDescriptorError, `expected derivation rejection, got ${String(err)}`);
    return err.message;
  }
  assert.fail('expected IncompatibleDescriptorError');
}

/** Verbatim op plus one extra hand-built input (tamper control). */
function withExtraInput(op: ArtifactOperation, extra: unknown): ArtifactOperation {
  return {
    ...op,
    inputs: { fields: [...op.inputs.fields, extra as ArtifactOperation['inputs']['fields'][number]] },
  };
}

/** Verbatim op with one input's literal default replaced (Tier-2 positive or tamper). */
function withLiteral(op: ArtifactOperation, name: string, value: unknown): ArtifactOperation {
  const edited: ArtifactOperation = structuredClone(op);
  const found = edited.inputs.fields.find((field) => field.name === name);
  assert.ok(found !== undefined, `input ${name}`);
  found.default = { kind: 'literal', value };
  return edited;
}

/** Mutable delivery-descriptor view for tamper controls. */
interface TamperDelivery {
  capability: unknown;
  operation: unknown;
  version: unknown;
  result: { name: unknown; fields: Array<{ name: unknown; type: unknown }> };
}

/** Verbatim RETRY with the receipt descriptor mutated (tamper control). */
function tamperAttempt(mut: (field: TamperDelivery) => void): ArtifactOperation {
  const edited: ArtifactOperation = structuredClone(RETRY);
  const attempt = edited.inputs.fields.find((field) => field.name === 'attempt');
  assert.ok(attempt !== undefined);
  mut(attempt.field as unknown as TamperDelivery);
  return edited;
}

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

function opRequest(opts: { cookie?: string; csrf?: string; body: string }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
  return testRequest('/operations/x', {
    method: 'POST',
    headers,
    ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    body: opts.body,
  });
}

/** Assert every shaped object node in a schema tree is explicitly closed. */
function assertClosedEverywhere(node: unknown): void {
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (record['type'] === 'object' && 'properties' in record) {
    assert.equal(record['additionalProperties'], false, 'object level must be closed');
  }
  if (record['type'] === 'array' && 'items' in record) {
    assertClosedEverywhere(record['items']);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach(assertClosedEverywhere);
    else if (typeof value === 'object' && value !== null) assertClosedEverywhere(value);
  }
}

function anyOfBranch(toolSchema: Record<string, unknown>, index: number): unknown {
  const branches: unknown = toolSchema['anyOf'];
  assert.ok(Array.isArray(branches) && branches.length === 2);
  const branch: unknown = branches[index];
  assert.ok(branch !== undefined);
  return branch;
}

function requiredOf(schema: unknown): readonly unknown[] {
  assert.ok(typeof schema === 'object' && schema !== null);
  const required: unknown = (schema as Record<string, unknown>)['required'];
  assert.ok(Array.isArray(required));
  return required;
}

function propertiesOf(schema: unknown): Record<string, unknown> {
  assert.ok(typeof schema === 'object' && schema !== null);
  const properties: unknown = (schema as Record<string, unknown>)['properties'];
  assert.ok(typeof properties === 'object' && properties !== null && !Array.isArray(properties));
  return properties as Record<string, unknown>;
}

function derivedInput(derived: DerivedOperationInputs, name: string): DerivedWritableInput {
  const found = derived.inputs.find((input) => input.name === name);
  assert.ok(found !== undefined, `derived input ${name}`);
  return found;
}

test('T19b pins the artifact contract version across depth fixtures', () => {
  assert.equal(ARTIFACT_VERSION, 1);
  for (const op of T19B_OPS) {
    assert.equal(deriveOperationInputs(op).artifactVersion, ARTIFACT_VERSION, op.name);
  }
});

test('delivery inputs derive their validated provider-receipt binding', () => {
  const derived = deriveOperationInputs(RETRY);
  assert.equal(derived.operation, 'Receipts.retry');
  assert.equal(derived.kind, 'scenario');
  assert.deepEqual(derivedInput(derived, 'note'), { name: 'note', kind: 'string', required: true });
  assert.deepEqual(derivedInput(derived, 'attempt'), {
    name: 'attempt',
    kind: 'delivery',
    required: false,
    nullable: true,
    delivery: {
      capability: 'std.EmailV1',
      operation: 'send',
      version: 1,
      result: { name: 'EmailAccepted', leaves: [{ name: 'reference', type: 'text' }] },
      recipe: 'delivery:std.EmailV1.send',
    },
  });
  // The binding object is frozen: derivation output is never mutated downstream.
  const binding = derivedInput(derived, 'attempt').delivery;
  assert.ok(binding !== undefined);
  assert.ok(Object.isFrozen(binding));
  assert.ok(Object.isFrozen(binding.result));
  assert.ok(Object.isFrozen(binding.result.leaves));
});

test('all eight result nominals derive with verbatim declared leaves', () => {
  assert.equal(DELIVERY_CASES.length, 8);
  DELIVERY_CASES.forEach((kase, index) => {
    const derived = deriveOperationInputs(deliveryOp(index));
    const receipt = derivedInput(derived, 'receipt');
    assert.equal(receipt.kind, 'delivery');
    assert.equal(receipt.required, true);
    assert.deepEqual(receipt.delivery, {
      capability: kase.capability,
      operation: kase.operation,
      version: 1,
      result: {
        name: kase.nominal,
        leaves: kase.leaves.map((leaf) => ({ name: leaf.name, type: leaf.type })),
      },
      recipe: `delivery:${kase.capability}.${kase.operation}`,
    });
  });
});

test('delivery derivation byte-pins the T15b descriptor JSON', () => {
  const attempt = RETRY.inputs.fields.find((field) => field.name === 'attempt');
  assert.ok(attempt !== undefined);
  // The T15b-pinned descriptor rendering, char-for-char.
  assert.equal(
    JSON.stringify(attempt.field),
    '{"kind":"delivery","capability":"std.EmailV1","operation":"send",' +
      '"version":1,"result":{"name":"EmailAccepted","fields":[{"name":"reference","type":"text"}]}}',
  );
});

test('delivery descriptors reject precisely: identity, version, result, leaves', () => {
  // Unknown capability: no T13 identity (bound-local shape alike).
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.capability = 'std.NopeV1'; }))),
    'unknown_capability',
  );
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.capability = 'Mail'; }))),
    'unknown_capability',
  );
  // Unknown operation of a known capability (the T14c wrong association).
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.operation = 'bogus'; }))),
    'unknown_capability',
  );
  assert.ok(
    rejectionMessage(() => checkArtifactOperation(tamperAttempt((field) => { field.operation = 'bogus'; }))).includes(
      '"std.EmailV1" has no sendable operation "bogus"',
    ),
  );
  // Frozen version fenced exact: mismatch rejects, non-numbers malform.
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.version = 2; }))),
    'version_mismatch',
  );
  assert.ok(
    rejectionMessage(() => checkArtifactOperation(tamperAttempt((field) => { field.version = 2; }))).includes(
      'frozen std.EmailV1 contract version 1',
    ),
  );
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.version = '1'; }))),
    'malformed_descriptor',
  );
  // Result nominal must be the operation's declared result.
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.result.name = 'PaymentState'; }))),
    'undeclared_result',
  );
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.result.name = 'Nope'; }))),
    'undeclared_result',
  );
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.result.name = ''; }))),
    'malformed_descriptor',
  );
  // Leaves: extras, renames, and retypings are undeclared; drops are malformed.
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields.push({ name: 'extra', type: 'text' });
      })),
    ),
    'undeclared_leaf',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields[0] = { name: 'renamed', type: 'text' };
      })),
    ),
    'undeclared_leaf',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields[0] = { name: 'reference', type: 'text?' };
      })),
    ),
    'undeclared_leaf',
  );
  assert.ok(
    rejectionMessage(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields[0] = { name: 'reference', type: 'text?' };
      })),
    ).includes('declares type "text"'),
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields = [];
      })),
    ),
    'malformed_descriptor',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields.push({ name: 'reference', type: 'text' });
      })),
    ),
    'duplicate_name',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields[0] = { name: '', type: 'text' };
      })),
    ),
    'malformed_descriptor',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(tamperAttempt((field) => {
        field.result.fields[0] = { name: 'reference', type: '' };
      })),
    ),
    'malformed_descriptor',
  );
  // Descriptor shape violations.
  assert.equal(
    rejectionReason(() => checkArtifactOperation(tamperAttempt((field) => { field.capability = ''; }))),
    'malformed_descriptor',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(
        withExtraInput(LEDGER_REVIEW, {
          name: 'receipt',
          field: { kind: 'delivery' },
          required: false,
        }),
      ),
    ),
    'malformed_descriptor',
  );
  // The server-owned bar applies to receipt inputs too.
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(
        withExtraInput(LEDGER_REVIEW, {
          name: 'receipt',
          field: {
            kind: 'delivery',
            capability: 'std.EmailV1',
            operation: 'send',
            version: 1,
            result: { name: 'EmailAccepted', fields: [{ name: 'reference', type: 'text' }] },
          },
          required: false,
          default: { kind: 'server', init: 'now' },
        }),
      ),
    ),
    'server_owned_input',
  );
  // Every builder rejects the same tamper through the shared rule.
  const tampered = tamperAttempt((field) => { field.version = 2; });
  assert.equal(rejectionReason(() => deriveOperationInputs(tampered)), 'version_mismatch');
  assert.equal(rejectionReason(() => deriveOperationShape(tampered)), 'version_mismatch');
  assert.equal(rejectionReason(() => toMcpInputSchema(tampered)), 'version_mismatch');
  assert.equal(
    rejectionReason(() => catalogFromArtifactOperations({ artifact_version: 1, operations: [tampered] })),
    'version_mismatch',
  );
  assert.equal(
    rejectionReason(() => registryFromArtifactOperations({ artifact_version: 1, operations: [tampered] })),
    'version_mismatch',
  );
  assert.equal(
    rejectionReason(() => toolsFromArtifactOperations({ artifact_version: 1, operations: [tampered] })),
    'version_mismatch',
  );
});

test('delivery members stay out of submittable shapes on both transports', () => {
  // HTTP dispatch shape: the receipt binding is not submittable.
  assert.deepEqual(deriveOperationShape(RETRY), { allowed: ['note'], required: ['note'] });
  // MCP framing descriptor: same submittable names.
  const descriptor = toOperationDescriptor(RETRY);
  assert.deepEqual(
    descriptor.inputs.fields.map((field) => field.name),
    ['note'],
  );
  // MCP tool schema: no receipt member on either branch.
  const tool = toMcpToolFromArtifact(RETRY);
  assert.equal(tool.name, 'Receipts.retry');
  const ordinary = anyOfBranch(tool.inputSchema, 0);
  assert.deepEqual(requiredOf(ordinary), ['note', 'operation_id']);
  assert.ok(!('attempt' in propertiesOf(ordinary)), 'ordinary branch carries no receipt member');
  const handle = anyOfBranch(tool.inputSchema, 1);
  assert.deepEqual(requiredOf(handle), ['action_handle', 'operation_id']);
  assert.ok(!('attempt' in propertiesOf(handle)), 'handle branch carries no receipt member');
  // The single-receipt ops derive empty submittable shapes but full bindings.
  DELIVERY_CASES.forEach((_, index) => {
    const op = deliveryOp(index);
    assert.deepEqual(deriveOperationShape(op), { allowed: [], required: [] }, op.name);
    assert.deepEqual(toMcpInputSchema(op).fields, [], op.name);
    assert.equal(deriveOperationInputs(op).inputs.length, 1, op.name);
  });
  assertClosedEverywhere(toToolInputSchemaFromArtifact(RETRY));
});

test('exact decimal defaults derive: canonical strings, R16, T15a spellings', () => {
  // Tier-1 verbatim: R16 integral spellings on decimal inputs, no int64 narrowing.
  assert.deepEqual(derivedInput(deriveOperationInputs(LEDGER_CREATE), 'whole').default, {
    kind: 'literal',
    value: '2',
  });
  assert.deepEqual(derivedInput(deriveOperationInputs(LEDGER_BIGDEC), 'big').default, {
    kind: 'literal',
    value: '99999999999999999999999',
  });
  assert.deepEqual(derivedInput(deriveOperationInputs(LEDGER_CREATE), 'stock').default, {
    kind: 'literal',
    value: '0',
  });
  assert.deepEqual(derivedInput(deriveOperationInputs(LEDGER_REVIEW), 'limit').default, {
    kind: 'literal',
    value: '10',
  });
  // Tier-2 T15a-pinned spellings: scale preserved verbatim, negatives, money.
  assert.deepEqual(derivedInput(deriveOperationInputs(withLiteral(LEDGER_CREATE, 'whole', '1.50')), 'whole').default, {
    kind: 'literal',
    value: '1.50',
  });
  assert.deepEqual(derivedInput(deriveOperationInputs(withLiteral(LEDGER_CREATE, 'whole', '-0.5')), 'whole').default, {
    kind: 'literal',
    value: '-0.5',
  });
  assert.deepEqual(derivedInput(deriveOperationInputs(withLiteral(LEDGER_CREATE, 'delta', '-3')), 'delta').default, {
    kind: 'literal',
    value: '-3',
  });
  assert.deepEqual(
    derivedInput(
      deriveOperationInputs(withLiteral(LEDGER_CREATE, 'fee', { minor: '100', currency: 'EUR' })),
      'fee',
    ).default,
    { kind: 'literal', value: { minor: '100', currency: 'EUR' } },
  );
  // int64 edges bind exactly (greatest/least int64, never through Number).
  for (const edge of ['9223372036854775807', '-9223372036854775808']) {
    assert.deepEqual(
      derivedInput(deriveOperationInputs(withLiteral(LEDGER_CREATE, 'delta', edge)), 'delta').default,
      { kind: 'literal', value: edge },
      edge,
    );
  }
});

test('inexact numeric defaults reject: no Number, malformed, out-of-range', () => {
  // JSON numbers are never exact (the T11 ambiguity negative).
  for (const [op, name, value] of [
    [LEDGER_CREATE, 'delta', 5],
    [LEDGER_CREATE, 'whole', 1.5],
    [LEDGER_CREATE, 'fee', 100],
  ] as const) {
    assert.equal(
      rejectionReason(() => deriveOperationInputs(withLiteral(op, name, value))),
      'malformed_descriptor',
      `${name}=${JSON.stringify(value)}`,
    );
  }
  assert.ok(
    rejectionMessage(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'whole', 1.5))).includes(
      'never JSON numbers',
    ),
  );
  // Malformed spellings reject (no exponent, separators, plus, blanks).
  for (const bad of ['1.50.2', 'abc', '', ' 5', '0x1A', '1e3', '+5', '5.', '.5', '--5']) {
    assert.equal(
      rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'whole', bad))),
      'malformed_descriptor',
      `decimal ${JSON.stringify(bad)}`,
    );
  }
  for (const bad of ['10.5', '', ' 5', '0x1A', '1e3', '+5']) {
    assert.equal(
      rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'delta', bad))),
      'malformed_descriptor',
      `integer ${JSON.stringify(bad)}`,
    );
  }
  // Range negatives retained: 39 digits / 19 places reject on decimals.
  assert.equal(
    rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'whole', '9'.repeat(39)))),
    'malformed_descriptor',
  );
  assert.ok(
    rejectionMessage(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'whole', '9'.repeat(39)))).includes(
      '38 significant digits',
    ),
  );
  assert.equal(
    rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'whole', `1.${'0'.repeat(18)}1`))),
    'malformed_descriptor',
  );
  // The R16 contrast: the 23-digit integral binds on decimal, fences on integer.
  assert.equal(deriveOperationInputs(LEDGER_BIGDEC).inputs.length, 1);
  assert.equal(
    rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'delta', '99999999999999999999999'))),
    'malformed_descriptor',
  );
  assert.ok(
    rejectionMessage(() =>
      deriveOperationInputs(withLiteral(LEDGER_CREATE, 'delta', '99999999999999999999999')),
    ).includes('int64 range'),
  );
  assert.equal(
    rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'delta', '9223372036854775808'))),
    'malformed_descriptor',
  );
  assert.equal(
    rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'delta', '-9223372036854775809'))),
    'malformed_descriptor',
  );
  // Money shape: exact keys, int64 minor string, string currency.
  for (const bad of [
    { minor: 100, currency: 'EUR' },
    { minor: '1.5', currency: 'EUR' },
    { minor: '99999999999999999999999', currency: 'EUR' },
    { minor: '100' },
    { currency: 'EUR' },
    { minor: '100', currency: 'EUR', extra: 1 },
    { minor: '100', currency: 5 },
    '100',
    100,
    null,
  ]) {
    assert.equal(
      rejectionReason(() => deriveOperationInputs(withLiteral(LEDGER_CREATE, 'fee', bad))),
      'malformed_descriptor',
      `money ${JSON.stringify(bad)}`,
    );
  }
});

test('money and file inputs derive with their wire boundaries', () => {
  const derived = deriveOperationInputs(LEDGER_CREATE);
  // Money: default-less, verbatim (computed source defaults leave no descriptor trace).
  assert.deepEqual(derivedInput(derived, 'fee'), { name: 'fee', kind: 'money', required: false });
  // File: the slot plus the interface-claimable provenance boundary.
  assert.deepEqual(derivedInput(derived, 'doc'), {
    name: 'doc',
    kind: 'file',
    required: true,
    file: { valueShape: 'opaque-file-id', format: 'can-file' },
  });
  const update = deriveOperationInputs(LEDGER_UPDATE);
  assert.deepEqual(derivedInput(update, 'doc'), {
    name: 'doc',
    kind: 'file',
    required: false,
    file: { valueShape: 'opaque-file-id', format: 'can-file' },
  });
  // MCP renders the file slot as the opaque-string format; HTTP carries the same claim.
  const tool = toMcpToolFromArtifact(LEDGER_CREATE);
  assert.deepEqual(propertiesOf(anyOfBranch(tool.inputSchema, 0))['doc'], {
    type: 'string',
    format: 'can-file',
  });
  assert.deepEqual(propertiesOf(anyOfBranch(tool.inputSchema, 1))['doc'], {
    type: 'string',
    format: 'can-file',
  });
  assert.deepEqual(
    toMcpInputSchema(LEDGER_CREATE).fields.find((field) => field.name === 'doc')?.field,
    { kind: 'file' },
  );
});

test('bound arguments: refs bind shape and canonical versions', () => {
  const record = derivedInput(deriveOperationInputs(LEDGER_UPDATE), 'record');
  assert.equal(record.kind, 'ref');
  assert.equal(record.versioned, true);
  // Versioned refs bind {id, version} with a canonical digit-string version.
  assert.equal(checkBoundArgument(record, { id: 'g-1', version: '2' }), null);
  assert.equal(checkBoundArgument(record, { id: 'g-1', version: '007' }), null);
  for (const bad of [
    { id: 'g-1' },
    { id: 'g-1', version: '1.5' },
    { id: 'g-1', version: '' },
    { id: 'g-1', version: 2 },
    { id: 'g-1', version: '-1' },
    { id: '', version: '2' },
    { id: 5, version: '2' },
    { version: '2' },
    'g-1',
    5,
    [],
  ]) {
    const failure = checkBoundArgument(record, bad);
    assert.ok(failure !== null, `ref ${JSON.stringify(bad)}`);
    assert.equal(failure.code, 'validation');
    assert.equal(failure.fields?.[0]?.path, '/record');
    assert.equal(failure.fields?.[0]?.code, 'binding_mismatch');
  }
  // Unversioned refs bind {id}; extra members read lenient (L3 owns admission).
  const unversioned: DerivedWritableInput = {
    name: 'parent',
    kind: 'ref',
    required: true,
    model: 'Shop.Team',
    versioned: false,
  };
  assert.equal(checkBoundArgument(unversioned, { id: 't-1' }), null);
  assert.equal(checkBoundArgument(unversioned, { id: 't-1', version: '9' }), null);
  assert.ok(checkBoundArgument(unversioned, { id: '' }) !== null);
  assert.ok(checkBoundArgument(unversioned, 't-1') !== null);
});

test('bound arguments: enums, files, numerics bind; delivery never binds', () => {
  const enumInput: DerivedWritableInput = {
    name: 'state',
    kind: 'enum',
    required: false,
    enumValues: ['draft', 'submitted'],
  };
  assert.equal(checkBoundArgument(enumInput, 'draft'), null);
  for (const bad of ['DRAFT', 'archived', '', 0, null, ['draft']]) {
    const failure = checkBoundArgument(enumInput, bad);
    assert.ok(failure !== null, `enum ${JSON.stringify(bad)}`);
    assert.equal(failure.code, 'validation');
  }
  assert.ok((checkBoundArgument(enumInput, 'archived')?.message ?? '').includes('"draft", "submitted"'));

  const fileInput = derivedInput(deriveOperationInputs(LEDGER_CREATE), 'doc');
  assert.equal(checkBoundArgument(fileInput, 'file-opaque-1'), null);
  for (const bad of ['', 5, null, {}, []]) {
    assert.ok(checkBoundArgument(fileInput, bad) !== null, `file ${JSON.stringify(bad)}`);
  }

  const price = derivedInput(deriveOperationInputs(LEDGER_CREATE), 'price');
  assert.equal(checkBoundArgument(price, '1.50'), null);
  assert.equal(checkBoundArgument(price, '99999999999999999999999'), null);
  assert.ok(checkBoundArgument(price, 1.5) !== null);
  assert.ok(checkBoundArgument(price, '9'.repeat(39)) !== null);
  const stock = derivedInput(deriveOperationInputs(LEDGER_CREATE), 'stock');
  assert.equal(checkBoundArgument(stock, '-3'), null);
  assert.ok(checkBoundArgument(stock, 5) !== null);
  assert.ok(checkBoundArgument(stock, '99999999999999999999999') !== null);
  const fee = derivedInput(deriveOperationInputs(LEDGER_CREATE), 'fee');
  assert.equal(checkBoundArgument(fee, { minor: '100', currency: 'EUR' }), null);
  assert.ok(checkBoundArgument(fee, { minor: '100', currency: 'EUR', extra: 1 }) !== null);

  // Delivery binds to nothing: any submitted value rejects precisely.
  const attempt = derivedInput(deriveOperationInputs(RETRY), 'attempt');
  for (const bad of [{ id: 'd-1' }, 'd-1', 0, false, [], {}]) {
    const failure = checkBoundArgument(attempt, bad);
    assert.ok(failure !== null, `delivery ${JSON.stringify(bad)}`);
    assert.equal(failure.code, 'validation');
    assert.ok(failure.message.includes('never submitted'), failure.message);
  }
  // Whole-envelope binding: first failure wins; unknown members stay framing-owned.
  const derived = deriveOperationInputs(RETRY);
  assert.equal(checkBoundArguments(derived, { note: 'hi' }), null);
  const failure = checkBoundArguments(derived, { note: 'hi', attempt: { id: 'd-1' } });
  assert.ok(failure !== null);
  assert.equal(failure.code, 'validation');
  assert.equal(checkBoundArguments(derived, { note: 'hi', unknown: 1 }), null);
});

test('bound arguments: arrays, nullability, and L3 pass-throughs', () => {
  const tags: DerivedWritableInput = { name: 'tags', kind: 'string', required: false, array: { required: false } };
  assert.equal(checkBoundArgument(tags, []), null);
  assert.equal(checkBoundArgument(tags, ['a', 'b']), null);
  const notArray = checkBoundArgument(tags, 'a');
  assert.ok(notArray !== null && notArray.message.includes('take arrays'));
  const states: DerivedWritableInput = {
    name: 'states',
    kind: 'enum',
    required: false,
    array: { required: false },
    enumValues: ['draft', 'submitted'],
  };
  assert.equal(checkBoundArgument(states, ['draft', 'submitted']), null);
  const badElement = checkBoundArgument(states, ['draft', 'archived']);
  assert.ok(badElement !== null);
  assert.equal(badElement.fields?.[0]?.path, '/states/1');
  // Element nulls pass through: element-level null acceptance is L3 admission detail.
  assert.equal(checkBoundArgument(states, ['draft', null]), null);

  const nick: DerivedWritableInput = { name: 'nick', kind: 'string', required: false, nullable: true };
  assert.equal(checkBoundArgument(nick, null), null);
  const title = derivedInput(deriveOperationInputs(LEDGER_CREATE), 'title');
  assert.ok(checkBoundArgument(title, null) !== null);

  // Strings and booleans carry no declared set: L3 admission owns them.
  assert.equal(checkBoundArgument(title, 'anything'), null);
  assert.equal(checkBoundArgument(title, 5), null);
  // Datetimes decode through the canonical values-wire form (E2b/F-R4):
  // L3 admission judges presence only, so the dispatcher owns the shape.
  const when: DerivedWritableInput = { name: 'when', kind: 'datetime', required: false };
  assert.equal(checkBoundArgument(when, '2026-10-06T06:00:00.000Z'), null);
  const noMillis = checkBoundArgument(when, '2026-10-06T06:00:00Z');
  assert.ok(noMillis !== null);
  assert.equal(noMillis.fields?.[0]?.path, '/when');
  assert.equal(noMillis.fields?.[0]?.code, 'binding_mismatch');
  assert.ok(checkBoundArgument(when, 'not-a-datetime') !== null);
  assert.ok(checkBoundArgument(when, 1728192000000) !== null);
  const flag: DerivedWritableInput = { name: 'flag', kind: 'boolean', required: false };
  assert.equal(checkBoundArgument(flag, 'yes'), null);
});

test('derived versioned inputs fence stale record versions at admission', () => {
  const record = derivedInput(deriveOperationInputs(LEDGER_UPDATE), 'record');
  assert.equal(record.versioned, true);
  // Binding passes the canonical version; admission fences staleness.
  assert.equal(checkBoundArgument(record, { id: 'g-1', version: '1' }), null);
  const stale = checkExpectedVersion('1', '2');
  assert.ok(stale !== null);
  assert.equal(stale.code, 'conflict');
  assert.equal(checkExpectedVersion('2', '2'), null);
});

test('list/team kinds have no artifact source and never derive', () => {
  // The emitter renders exactly read/create/update/delete/scenario
  // (`JsOperationKind`); list reads and team management travel fixed
  // schemas (`CollectionRequest`, `SystemTeam*Input`) — derivation
  // rejects both kinds instead of inventing them.
  assert.equal(
    rejectionReason(() => checkArtifactOperation({ ...LEDGER_READ, kind: 'list' })),
    'unknown_operation_kind',
  );
  assert.equal(
    rejectionReason(() => checkArtifactOperation({ ...LEDGER_READ, kind: 'team' })),
    'unknown_operation_kind',
  );
});

test('HTTP dispatch through the derived catalog excludes delivery members', async () => {
  const catalog = catalogFromArtifactOperations(T19B_SLICE);
  assert.deepEqual(catalog.shapeFor('Receipts.retry'), { allowed: ['note'], required: ['note'] });
  assert.equal(catalog.derivedFor('Receipts.retry')?.inputs.length, 2);
  const t = await createTestDeps({
    mutations: {
      'Receipts.retry': (envelope) => ({
        result: {
          status: 'committed',
          operation_id: envelope.operation_id,
          result: { echoed: envelope.inputs },
        },
      }),
    },
  });
  const deps = { ...t.deps, catalog };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);

  // Valid submission without the receipt member passes.
  const operation_id = freshOperationId();
  const inputs = { note: 'try again' };
  const ok = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, csrf, body: JSON.stringify({ operation_id, inputs }) }),
    'Receipts.retry',
  );
  assert.equal(ok.status, 200);
  const call = t.invoker.mutations.at(0);
  assert.ok(call !== undefined);
  assert.deepEqual(call.envelope, { operation: 'Receipts.retry', operation_id, inputs });

  // A submitted receipt member fails closed as an unknown input.
  const smuggled = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: { ...inputs, attempt: { id: 'd-1' } } }),
    }),
    'Receipts.retry',
  );
  assert.equal(smuggled.status, 400);
  const smuggledBody = (await smuggled.json()) as { code: string; message: string };
  assert.equal(smuggledBody.code, 'validation');
  assert.ok(smuggledBody.message.includes("'attempt'"), smuggledBody.message);
  assert.equal(t.invoker.mutations.length, 1, 'only the valid submission invoked');
});

test('HTTP/MCP parity across every T19b operation', () => {
  for (const op of T19B_OPS) {
    const shape = deriveOperationShape(op);
    const descriptor = toOperationDescriptor(op);
    const derived = deriveOperationInputs(op);
    assert.deepEqual(
      descriptor.inputs.fields.map((field) => field.name),
      [...shape.allowed],
      `${op.name} allowlist parity`,
    );
    assert.deepEqual(
      descriptor.inputs.fields.filter((field) => field.required).map((field) => field.name),
      [...shape.required],
      `${op.name} required parity`,
    );
    // The documented channel carries the submittable names plus exactly
    // the engine-resolved receipt bindings.
    const documented = derived.inputs.map((input) => input.name);
    assert.deepEqual(
      documented.filter((name) => !shape.allowed.includes(name)),
      derived.inputs.filter((input) => input.kind === 'delivery').map((input) => input.name),
      `${op.name} documented/submittable agreement`,
    );
    for (const input of derived.inputs) {
      if (input.kind === 'delivery') {
        assert.ok(input.delivery !== undefined, `${op.name}.${input.name} carries its binding`);
      }
      if (input.kind === 'file') {
        assert.deepEqual(input.file, { valueShape: 'opaque-file-id', format: 'can-file' }, op.name);
      }
    }
    assertClosedEverywhere(toToolInputSchemaFromArtifact(op));
  }
  const registry = registryFromArtifactOperations(T19B_SLICE);
  assert.deepEqual(
    registry.list(createTestApp()).map((descriptor) => descriptor.name),
    T19B_OPS.map((op) => op.name),
  );
  assert.deepEqual(
    toolsFromArtifactOperations(T19B_SLICE).map((tool) => tool.name),
    T19B_OPS.map((op) => op.name),
  );
  const catalog = catalogFromArtifactOperations(T19B_SLICE);
  for (const op of T19B_OPS) {
    assert.deepEqual(catalog.shapeFor(op.name), deriveOperationShape(op), op.name);
    assert.deepEqual(catalog.derivedFor(op.name), deriveOperationInputs(op), op.name);
  }
});
