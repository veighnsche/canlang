/**
 * T19a checked-derivation tests: versioned writable inputs derived from
 * checked operation descriptors for the pilot, HTTP/MCP parity, and
 * equal-authority submission.
 *
 * Grounding (no invented operations or types):
 * - `STORE_*` fixtures are verbatim `operations[]` entries emitted by the
 *   real toolchain (`can 0.1.0`, commit aabcdfa) over the committed
 *   `tests/e2e/fixtures/compiled-shop.can` (exit 0): `can compile
 *   --format=json tests/e2e/fixtures/compiled-shop.can`.
 * - `SHOP_*` fixtures are verbatim entries emitted by the same binary
 *   (exit 0) over the T15a-shaped Shop source below, which exercises the
 *   T04a pilot vocabulary (literal/parent defaults, nullable, ordinary
 *   vs required arrays, versioned vs unversioned refs, child `parent`
 *   linkage, server-owned `by` + derived `shout` exclusion):
 *
 *   app Shop
 *   Given
 *    Gadget { title:text, stock:int=0, price:decimal,
 *      state:enum(draft,submitted)=draft, owner:Gadget?, tags:text[],
 *      ids:text[]!, by:user server=actor, code:text unique }
 *    policy Gadget read=members
 *    Team { name:text, owner:user }
 *    Member in Team { name:text, buddy:user=parent.owner }
 *    policy Team read=members
 *    policy Member read=members
 *    derive Member.shout:text = row.name
 *   When
 *    scenario review(notes:text[], limit:int=10, nick:text?) by=members
 *     do
 *      let x = 1
 *    crud Gadget by=members fields=title,stock,price,state,owner,tags,ids,code
 *    crud Member by=members fields=name,buddy
 *   Then
 *
 * - Pilot-scope note: no T02-designated pilot app exists yet (T37
 *   unstarted; the batch-70 dispatch softened the pilot-types prereq),
 *   so the pilot here is the T15a-emitted descriptor vocabulary over
 *   real emission — never hand-authored operations. Negative controls
 *   are verbatim-plus-tamper edits, which must reject (proving the
 *   tamper, not a new operation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  buildSessionCookie,
  deriveCsrfToken,
  loginWithPassword,
  registerWithEmail,
  verifyEmail,
} from '@canlang/identity';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import { buildBusinessError } from '../src/errors/envelope.js';
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

/* Verbatim emission: Shop.review (scenario). */
const REVIEW: ArtifactOperation = {
  "name": "Shop.review",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "notes", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
    {"name": "limit", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "10"}},
    {"name": "nick", "field": {"kind": "string"}, "required": false, "nullable": true},
  ]},
};

/* Verbatim emission: Shop.Gadget.create (`by` server-owned, excluded). */
const GADGET_CREATE: ArtifactOperation = {
  "name": "Shop.Gadget.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "title", "field": {"kind": "string"}, "required": true},
    {"name": "stock", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "0"}},
    {"name": "price", "field": {"kind": "decimal"}, "required": true},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "submitted"]}, "required": false, "default": {"kind": "literal", "value": "draft"}},
    {"name": "owner", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": false, "nullable": true},
    {"name": "tags", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
    {"name": "ids", "field": {"kind": "string"}, "required": true, "array": {"required": true}},
    {"name": "code", "field": {"kind": "string"}, "required": true},
  ]},
};

/* Verbatim emission: Shop.Gadget.update (partial, default-less). */
const GADGET_UPDATE: ArtifactOperation = {
  "name": "Shop.Gadget.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": true},
    {"name": "title", "field": {"kind": "string"}, "required": false},
    {"name": "stock", "field": {"kind": "integer"}, "required": false},
    {"name": "price", "field": {"kind": "decimal"}, "required": false},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "submitted"]}, "required": false},
    {"name": "owner", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": false, "nullable": true},
    {"name": "tags", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
    {"name": "ids", "field": {"kind": "string"}, "required": false, "array": {"required": true}},
    {"name": "code", "field": {"kind": "string"}, "required": false},
  ]},
};

/* Verbatim emission: Shop.Member.create (parent default + linkage). */
const MEMBER_CREATE: ArtifactOperation = {
  "name": "Shop.Member.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "name", "field": {"kind": "string"}, "required": true},
    {"name": "buddy", "field": {"kind": "string"}, "required": false, "default": {"kind": "parent", "path": "owner"}},
    {"name": "parent", "field": {"kind": "ref", "model": "Shop.Team", "requireVersion": false}, "required": true},
  ]},
};

/* Verbatim emission: Shop.Member.update (no parent: linkage immutable). */
const MEMBER_UPDATE: ArtifactOperation = {
  "name": "Shop.Member.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Shop.Member", "requireVersion": true}, "required": true},
    {"name": "name", "field": {"kind": "string"}, "required": false},
    {"name": "buddy", "field": {"kind": "string"}, "required": false},
  ]},
};

/* Verbatim emission: Shop.Gadget.read (empty inputs). */
const GADGET_READ: ArtifactOperation = {
  "name": "Shop.Gadget.read",
  "kind": "read",
  "description": "",
  "inputs": {"fields": []},
};

/* Verbatim emission: committed compiled-shop.can fixture ops. */
const STORE_CREATE: ArtifactOperation = {
  "name": "Store.Gadget.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "title", "field": {"kind": "string"}, "required": true},
  ]},
};
const STORE_UPDATE: ArtifactOperation = {
  "name": "Store.Gadget.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Store.Gadget", "requireVersion": true}, "required": true},
    {"name": "title", "field": {"kind": "string"}, "required": false},
  ]},
};
const STORE_READ: ArtifactOperation = {
  "name": "Store.Gadget.read",
  "kind": "read",
  "description": "",
  "inputs": {"fields": []},
};

const PILOT_OPS: readonly ArtifactOperation[] = [
  REVIEW,
  GADGET_CREATE,
  GADGET_UPDATE,
  MEMBER_CREATE,
  MEMBER_UPDATE,
  GADGET_READ,
  STORE_CREATE,
  STORE_UPDATE,
  STORE_READ,
];

const PILOT_SLICE: ArtifactOperationSlice = { artifact_version: 1, operations: PILOT_OPS };

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

/** Verbatim op plus one extra hand-built input (tamper control, must reject or derive per case). */
function withExtraInput(op: ArtifactOperation, extra: unknown): ArtifactOperation {
  return {
    ...op,
    inputs: { fields: [...op.inputs.fields, extra as ArtifactOperation['inputs']['fields'][number]] },
  };
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

test('derivation pins the artifact contract version', () => {
  assert.equal(ARTIFACT_VERSION, 1);
  for (const op of PILOT_OPS) {
    assert.equal(deriveOperationInputs(op).artifactVersion, ARTIFACT_VERSION, op.name);
  }
});

test('HTTP shapes match descriptor writability for every pilot operation', () => {
  assert.deepEqual(deriveOperationShape(REVIEW), {
    allowed: ['notes', 'limit', 'nick'],
    required: [],
  });
  assert.deepEqual(deriveOperationShape(GADGET_CREATE), {
    allowed: ['title', 'stock', 'price', 'state', 'owner', 'tags', 'ids', 'code'],
    required: ['title', 'price', 'ids', 'code'],
  });
  assert.deepEqual(deriveOperationShape(GADGET_UPDATE), {
    allowed: ['record', 'title', 'stock', 'price', 'state', 'owner', 'tags', 'ids', 'code'],
    required: ['record'],
  });
  assert.deepEqual(deriveOperationShape(MEMBER_CREATE), {
    allowed: ['name', 'buddy', 'parent'],
    required: ['name', 'parent'],
  });
  assert.deepEqual(deriveOperationShape(MEMBER_UPDATE), {
    allowed: ['record', 'name', 'buddy'],
    required: ['record'],
  });
  assert.deepEqual(deriveOperationShape(GADGET_READ), { allowed: [], required: [] });
  assert.deepEqual(deriveOperationShape(STORE_CREATE), { allowed: ['title'], required: ['title'] });
  assert.deepEqual(deriveOperationShape(STORE_UPDATE), {
    allowed: ['record', 'title'],
    required: ['record'],
  });
  assert.deepEqual(deriveOperationShape(STORE_READ), { allowed: [], required: [] });
});

test('derived defaults pin verbatim literal/parent fills as documented optionality', () => {
  const byName = (derived: ReturnType<typeof deriveOperationInputs>, name: string) => {
    const found = derived.inputs.find((input) => input.name === name);
    assert.ok(found !== undefined, `derived input ${name}`);
    return found;
  };
  assert.deepEqual(byName(deriveOperationInputs(REVIEW), 'limit').default, {
    kind: 'literal',
    value: '10',
  });
  assert.deepEqual(byName(deriveOperationInputs(GADGET_CREATE), 'stock').default, {
    kind: 'literal',
    value: '0',
  });
  assert.deepEqual(byName(deriveOperationInputs(GADGET_CREATE), 'state').default, {
    kind: 'literal',
    value: 'draft',
  });
  assert.deepEqual(byName(deriveOperationInputs(MEMBER_CREATE), 'buddy').default, {
    kind: 'parent',
    path: 'owner',
  });
  // Update-partial inputs carry no defaults: omission means unchanged.
  for (const input of deriveOperationInputs(GADGET_UPDATE).inputs) {
    assert.equal(input.default, undefined, `update input ${input.name} default-less`);
  }
  // Defaults never flip requiredness by invention: every defaulted input
  // is optional exactly as the descriptor declares.
  for (const op of PILOT_OPS) {
    for (const input of deriveOperationInputs(op).inputs) {
      if (input.default !== undefined) assert.equal(input.required, false, `${op.name}.${input.name}`);
    }
  }
});

test('derived versions, nullability, and array markers match the descriptors', () => {
  const byName = (op: ArtifactOperation, name: string) => {
    const found = deriveOperationInputs(op).inputs.find((input) => input.name === name);
    assert.ok(found !== undefined, `${op.name}.${name}`);
    return found;
  };
  // Versioned refs (mutation fencing) vs unversioned refs (linkage).
  assert.equal(byName(GADGET_UPDATE, 'record').versioned, true);
  assert.equal(byName(GADGET_CREATE, 'owner').versioned, true);
  assert.equal(byName(MEMBER_CREATE, 'parent').versioned, false);
  assert.equal(byName(MEMBER_CREATE, 'parent').model, 'Shop.Team');
  // Nullability.
  assert.equal(byName(REVIEW, 'nick').nullable, true);
  assert.equal(byName(GADGET_CREATE, 'owner').nullable, true);
  assert.equal(byName(GADGET_CREATE, 'title').nullable, undefined);
  // Ordinary arrays omit to empty; required arrays reject omission.
  assert.deepEqual(byName(REVIEW, 'notes').array, { required: false });
  assert.equal(byName(REVIEW, 'notes').required, false);
  assert.deepEqual(byName(GADGET_CREATE, 'tags').array, { required: false });
  assert.deepEqual(byName(GADGET_CREATE, 'ids').array, { required: true });
  assert.equal(byName(GADGET_CREATE, 'ids').required, true);
  // Enum cases pin in declaration order.
  assert.deepEqual(byName(GADGET_CREATE, 'state').enumValues, ['draft', 'submitted']);
});

test('server-owned fields are never derivable: absent from every pilot allowlist', () => {
  for (const op of PILOT_OPS) {
    const names = deriveOperationInputs(op).inputs.map((input) => input.name);
    assert.ok(!names.includes('by'), `${op.name} must not derive server-owned by`);
    assert.ok(!names.includes('shout'), `${op.name} must not derive derived shout`);
  }
  // A descriptor smuggling a server-owned input rejects fail-closed.
  const smuggledServer = withExtraInput(GADGET_CREATE, {
    name: 'by',
    field: { kind: 'string' },
    required: false,
    default: { kind: 'server', init: 'actor' },
  });
  assert.equal(rejectionReason(() => deriveOperationInputs(smuggledServer)), 'server_owned_input');
  assert.equal(rejectionReason(() => deriveOperationShape(smuggledServer)), 'server_owned_input');
  assert.equal(rejectionReason(() => toMcpInputSchema(smuggledServer)), 'server_owned_input');
  assert.equal(
    rejectionReason(() =>
      catalogFromArtifactOperations({ artifact_version: 1, operations: [smuggledServer] }),
    ),
    'server_owned_input',
  );
  const smuggledDerived = withExtraInput(MEMBER_CREATE, {
    name: 'shout',
    field: { kind: 'string' },
    required: false,
    default: { kind: 'derived' },
  });
  assert.equal(rejectionReason(() => deriveOperationInputs(smuggledDerived)), 'server_owned_input');
});

test('unknown operation, version mismatch, and malformed descriptors reject', () => {
  const catalog = catalogFromArtifactOperations(PILOT_SLICE);
  assert.equal(catalog.shapeFor('Shop.nope'), null);
  assert.equal(catalog.derivedFor('Shop.nope'), null);
  assert.equal(catalog.shapeFor('Store.Gadget.nope'), null);

  for (const artifact_version of [0, 2, '1', null]) {
    assert.equal(
      rejectionReason(() => catalogFromArtifactOperations({ artifact_version, operations: PILOT_OPS })),
      'version_mismatch',
      `artifact_version ${JSON.stringify(artifact_version)}`,
    );
    assert.equal(
      rejectionReason(() => registryFromArtifactOperations({ artifact_version, operations: PILOT_OPS })),
      'version_mismatch',
    );
    assert.equal(
      rejectionReason(() => toolsFromArtifactOperations({ artifact_version, operations: PILOT_OPS })),
      'version_mismatch',
    );
  }
  assert.equal(
    rejectionReason(() => catalogFromArtifactOperations({ operations: PILOT_OPS })),
    'version_mismatch',
  );

  // Unknown operation kind (no artifact source for list/team).
  assert.equal(
    rejectionReason(() => checkArtifactOperation({ ...GADGET_READ, kind: 'team' })),
    'unknown_operation_kind',
  );
  // (T19b) Bound provider receipts now derive their validated T13/T14
  // binding (engine-resolved, never submitted) — the T19a precise
  // reject is superseded by mandate; depth pins live in
  // t19b-depth.test.ts.
  {
    const derived = deriveOperationInputs(
      withExtraInput(REVIEW, {
        name: 'receipt',
        field: {
          kind: 'delivery',
          capability: 'std.EmailV1',
          operation: 'send',
          version: 1,
          result: { name: 'EmailAccepted', fields: [{ name: 'reference', type: 'text' }] },
        },
        required: false,
      }),
    );
    const binding = derived.inputs.find((input) => input.name === 'receipt');
    assert.ok(binding !== undefined, 'delivery input derives');
    assert.deepEqual(binding?.delivery, {
      capability: 'std.EmailV1',
      operation: 'send',
      version: 1,
      result: { name: 'EmailAccepted', leaves: [{ name: 'reference', type: 'text' }] },
      recipe: 'delivery:std.EmailV1.send',
    });
  }
  assert.equal(
    rejectionReason(() => checkArtifactOperation(withExtraInput(REVIEW, { name: 'x', field: { kind: 'union' }, required: false }))),
    'unknown_input_kind',
  );
  // Duplicates and malformed members.
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(withExtraInput(STORE_CREATE, { name: 'title', field: { kind: 'string' }, required: true })),
    ),
    'duplicate_name',
  );
  assert.equal(
    rejectionReason(() =>
      catalogFromArtifactOperations({ artifact_version: 1, operations: [STORE_CREATE, STORE_CREATE] }),
    ),
    'duplicate_name',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(withExtraInput(STORE_CREATE, { name: 'x', field: { kind: 'string' } })),
    ),
    'malformed_descriptor',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(
        withExtraInput(STORE_CREATE, {
          name: 'x',
          field: { kind: 'string' },
          required: false,
          default: { kind: 'computed' },
        }),
      ),
    ),
    'unknown_default_kind',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(
        withExtraInput(STORE_CREATE, {
          name: 'x',
          field: { kind: 'string' },
          required: false,
          default: { kind: 'parent', path: 'owner..id' },
        }),
      ),
    ),
    'malformed_descriptor',
  );
  assert.equal(
    rejectionReason(() =>
      checkArtifactOperation(
        withExtraInput(STORE_CREATE, {
          name: 'x',
          field: { kind: 'ref', model: '', requireVersion: true },
          required: true,
        }),
      ),
    ),
    'malformed_descriptor',
  );
});

test('absent operations read as no descriptors; derivation never serves stale output', () => {
  const empty = catalogFromArtifactOperations({ artifact_version: 1 });
  assert.equal(empty.shapeFor('Shop.review'), null);
  assert.equal(empty.derivedFor('Shop.review'), null);
  assert.deepEqual(toolsFromArtifactOperations({ artifact_version: 1, operations: [] }), []);

  // Derivation is a pure function of the descriptor: an edited default
  // re-derives to the edited value (no cached/stale fill), and the
  // verbatim descriptor pins the verbatim value.
  const edited: ArtifactOperation = structuredClone(GADGET_CREATE);
  const stock = edited.inputs.fields.find((field) => field.name === 'stock');
  assert.ok(stock !== undefined);
  stock.default = { kind: 'literal', value: '99' };
  const editedStock = deriveOperationInputs(edited).inputs.find((input) => input.name === 'stock');
  assert.deepEqual(editedStock?.default, { kind: 'literal', value: '99' });
  const verbatimStock = deriveOperationInputs(GADGET_CREATE).inputs.find((input) => input.name === 'stock');
  assert.deepEqual(verbatimStock?.default, { kind: 'literal', value: '0' });

  // A requiredness flip re-derives too (stale required sets impossible).
  const flipped: ArtifactOperation = structuredClone(STORE_CREATE);
  const title = flipped.inputs.fields.find((field) => field.name === 'title');
  assert.ok(title !== undefined);
  title.required = false;
  assert.deepEqual(deriveOperationShape(flipped), { allowed: ['title'], required: [] });
  assert.deepEqual(deriveOperationShape(STORE_CREATE), { allowed: ['title'], required: ['title'] });
});

test('MCP descriptors derive the same allowlist/required sets as HTTP', () => {
  for (const op of PILOT_OPS) {
    const shape = deriveOperationShape(op);
    const descriptor = toOperationDescriptor(op);
    assert.equal(descriptor.name, op.name);
    assert.equal(descriptor.kind, op.kind);
    assert.equal(descriptor.description, op.description);
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
  }
  const registry = registryFromArtifactOperations(PILOT_SLICE);
  assert.deepEqual(
    registry.list(createTestApp()).map((descriptor) => descriptor.name),
    PILOT_OPS.map((op) => op.name),
  );
  assert.deepEqual(
    toolsFromArtifactOperations(PILOT_SLICE).map((tool) => tool.name),
    PILOT_OPS.map((op) => op.name),
  );
});

test('MCP input schemas carry element types and verbatim metadata', () => {
  const schema = toMcpInputSchema(GADGET_CREATE);
  assert.deepEqual(
    schema.fields.map((field) => field.name),
    [...deriveOperationShape(GADGET_CREATE).allowed],
  );
  const owner = schema.fields.find((field) => field.name === 'owner');
  assert.deepEqual(owner?.field, { kind: 'ref', model: 'Shop.Gadget', requireVersion: true });
  const parent = toMcpInputSchema(MEMBER_CREATE).fields.find((field) => field.name === 'parent');
  assert.deepEqual(parent?.field, { kind: 'ref', model: 'Shop.Team', requireVersion: false });
});

function anyOfBranch(toolSchema: Record<string, unknown>, index: number): unknown {
  const branches: unknown = toolSchema['anyOf'];
  assert.ok(Array.isArray(branches) && branches.length === 2);
  const branch: unknown = branches[index];
  assert.ok(branch !== undefined);
  return branch;
}

test('MCP tool schemas render versioned refs, arrays, and closed shapes', () => {
  // Update: versioned record ref plus array members in the ordinary
  // branch; the handle branch seals every ref-kind member.
  const updateTool = toMcpToolFromArtifact(GADGET_UPDATE);
  assert.equal(updateTool.name, 'Shop.Gadget.update');
  assert.equal(updateTool.description, '');
  const ordinary = anyOfBranch(updateTool.inputSchema, 0);
  assert.deepEqual(requiredOf(ordinary), ['record', 'operation_id']);
  const props = propertiesOf(ordinary);
  assert.deepEqual(props['record'], {
    type: 'object',
    properties: { id: { type: 'string' }, version: { type: 'string' } },
    required: ['id', 'version'],
    additionalProperties: false,
  });
  assert.deepEqual(props['tags'], { type: 'array', items: { type: 'string' } });
  assert.deepEqual(props['ids'], { type: 'array', items: { type: 'string' } });
  assert.deepEqual(props['stock'], { type: 'string' });
  assert.deepEqual(props['price'], { type: 'string' });
  assert.deepEqual(props['state'], { type: 'string', enum: ['draft', 'submitted'] });
  const handle = anyOfBranch(updateTool.inputSchema, 1);
  assert.deepEqual(requiredOf(handle), ['action_handle', 'operation_id']);
  const handleProps = propertiesOf(handle);
  assert.ok(!('record' in handleProps) && !('owner' in handleProps), 'refs sealed by the handle');
  assert.deepEqual(handleProps['tags'], { type: 'array', items: { type: 'string' } });

  // Child create: the unversioned parent linkage renders id-only, and
  // documented defaults add no schema members.
  const memberTool = toMcpToolFromArtifact(MEMBER_CREATE);
  const memberOrdinary = anyOfBranch(memberTool.inputSchema, 0);
  assert.deepEqual(requiredOf(memberOrdinary), ['name', 'parent', 'operation_id']);
  assert.deepEqual(propertiesOf(memberOrdinary)['parent'], {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  });

  // Reads render the plain closed schema with no operation_id.
  assert.deepEqual(toMcpToolFromArtifact(STORE_READ).inputSchema, {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  });

  // Every pilot tool schema is closed at every shaped object level.
  for (const op of PILOT_OPS) {
    assertClosedEverywhere(toToolInputSchemaFromArtifact(op));
  }
});

test('derived versioned inputs fence stale record versions', () => {
  const record = deriveOperationInputs(GADGET_UPDATE).inputs.find((input) => input.name === 'record');
  assert.equal(record?.versioned, true);
  const stale = checkExpectedVersion('1', '2');
  assert.ok(stale !== null);
  assert.equal(stale.code, 'conflict');
  assert.equal(checkExpectedVersion('2', '2'), null);
  const parent = deriveOperationInputs(MEMBER_CREATE).inputs.find((input) => input.name === 'parent');
  assert.equal(parent?.versioned, false);
});

test('derived allowlists conform to the closed mutation envelope', () => {
  for (const op of PILOT_OPS) {
    const derived = deriveOperationInputs(op);
    const shape = deriveOperationShape(op);
    const names = derived.inputs.map((input) => input.name);
    assert.deepEqual([...shape.allowed], names, `${op.name} shape/derived agreement`);
    assert.equal(new Set(names).size, names.length, `${op.name} unique names`);
    for (const input of derived.inputs) assert.ok(input.name.length > 0);
    for (const req of shape.required) assert.ok(names.includes(req), `${op.name} required ⊆ allowed`);
    assert.equal(derived.operation, op.name);
    assert.equal(derived.kind, op.kind);
  }
});

test('HTTP dispatch through the derived catalog enforces the allowlist', async () => {
  const catalog = catalogFromArtifactOperations(PILOT_SLICE);
  const t = await createTestDeps({
    mutations: {
      'Shop.Gadget.create': (envelope) => ({
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

  // Valid submission with defaults omitted passes; omitted defaults are
  // NOT invented by the interface (absent from the invoked envelope).
  const operation_id = freshOperationId();
  const inputs = { title: 'wrench', price: '1.50', ids: ['a'], code: 'c' };
  const ok = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({ operation_id, inputs }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(ok.status, 200);
  const call = t.invoker.mutations.at(0);
  assert.ok(call !== undefined);
  assert.deepEqual(call.envelope, { operation: 'Shop.Gadget.create', operation_id, inputs });

  // Server-owned smuggling fails closed as an unknown input.
  const smuggled = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: { ...inputs, by: 'mallory' } }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(smuggled.status, 400);
  const smuggledBody = (await smuggled.json()) as { code: string; message: string };
  assert.equal(smuggledBody.code, 'validation');
  assert.ok(smuggledBody.message.includes("'by'"), smuggledBody.message);

  // Missing required input and unknown operation reject.
  const missing = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: { title: 'wrench' } }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as { code: string }).code, 'validation');
  const unknown = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: {} }),
    }),
    'Shop.nope',
  );
  assert.equal(unknown.status, 404);
  assert.equal(t.invoker.mutations.length, 1, 'only the valid submission invoked');
});

test('equal authority: an interface submission matches the direct call', async () => {
  const catalog = catalogFromArtifactOperations(PILOT_SLICE);
  const DENIED = 'Only the owning user may create.';
  // Caller-based policy: the fixture owner passes, anyone else fails.
  // (Membership selection is out of scope: operation dispatch resolves no
  // team, so the proof keys on the verified actor identity instead.)
  let ownerId = '';
  const t = await createTestDeps({
    mutations: {
      'Store.Gadget.create': (envelope, identity) => {
        if (identity.actor?.user_id !== ownerId) {
          return { error: buildBusinessError('forbidden', DENIED) };
        }
        return {
          result: { status: 'committed', operation_id: envelope.operation_id, result: { ok: true } },
        };
      },
    },
  });
  ownerId = t.identity.userId;
  const deps = { ...t.deps, catalog };
  const ownerCsrf = await deriveCsrfToken(t.identity.sessionToken);
  const lastCall = () => {
    const call = t.invoker.mutations.at(-1);
    assert.ok(call !== undefined);
    return call;
  };

  // Second verified user with NO membership (the disallowed caller).
  await registerWithEmail(
    t.identity.store,
    t.identity.mail,
    { email: 'mallory@test.example', password: 's3cure-password' },
    { verifyBaseUrl: 'https://test.invalid/verify' },
  );
  const invite = t.identity.mail.messages.at(-1)?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  assert.notEqual(invite, '');
  const { user_id: malloryId } = await verifyEmail(t.identity.store, { token: invite });
  const { token: mallorySession } = await loginWithPassword(
    t.identity.store,
    { email: 'mallory@test.example', password: 's3cure-password' },
  );
  const malloryCookie = buildSessionCookie(mallorySession, { maxAgeSeconds: 3600, secure: false });
  const malloryCsrf = await deriveCsrfToken(mallorySession);

  // Allowed owner passes through the interface with the resolved
  // identity delivered unchanged (no privilege added).
  const ownerOpId = freshOperationId();
  const ownerInputs = { title: 'allowed' };
  const ownerRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf: ownerCsrf,
      body: JSON.stringify({ operation_id: ownerOpId, inputs: ownerInputs }),
    }),
    'Store.Gadget.create',
  );
  assert.equal(ownerRes.status, 200);
  const ownerPayload = (await ownerRes.json()) as { status: string; operation_id: string };
  const ownerCall = lastCall();
  assert.equal(ownerCall.identity.actor?.user_id, t.identity.userId);
  assert.equal(ownerCall.identity.binding.kind, 'session');
  assert.deepEqual(ownerCall.envelope, {
    operation: 'Store.Gadget.create',
    operation_id: ownerOpId,
    inputs: ownerInputs,
  });
  // The direct call with the same identity and envelope succeeds identically.
  const ownerDirect = await t.invoker.invokeMutation(
    { operation: 'Store.Gadget.create', operation_id: ownerOpId, inputs: ownerInputs },
    ownerCall.identity,
  );
  assert.ok('result' in ownerDirect);
  assert.deepEqual(ownerDirect.result, ownerPayload);

  // Disallowed caller fails through the interface with the non-member
  // identity delivered intact (the interface added nothing).
  const malloryOpId = freshOperationId();
  const malloryInputs = { title: 'denied' };
  const malloryRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: malloryCookie,
      csrf: malloryCsrf,
      body: JSON.stringify({ operation_id: malloryOpId, inputs: malloryInputs }),
    }),
    'Store.Gadget.create',
  );
  assert.equal(malloryRes.status, 403);
  const malloryPayload = (await malloryRes.json()) as { code: string; message: string };
  assert.equal(malloryPayload.code, 'forbidden');
  assert.equal(malloryPayload.message, DENIED);
  const malloryCall = lastCall();
  assert.equal(malloryCall.identity.actor?.user_id, malloryId);
  assert.equal(malloryCall.identity.membership, null);
  // The direct call with the same identity and envelope fails identically.
  const malloryDirect = await t.invoker.invokeMutation(
    { operation: 'Store.Gadget.create', operation_id: malloryOpId, inputs: malloryInputs },
    malloryCall.identity,
  );
  assert.ok('error' in malloryDirect);
  assert.equal(malloryDirect.error.code, malloryPayload.code);
  assert.equal(malloryDirect.error.message, malloryPayload.message);
});
