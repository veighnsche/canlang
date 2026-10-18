import * as rowsTs from '../src/rows.js';
import { RowsKernelError, RowsStateError } from '../src/rows.js';
import type { RowsErrorFactory } from '../src/rows.js';
import * as retryTs from '../src/retry.js';
import * as everyTs from '../src/every.js';
import { RootRecurrenceNotSupportedError } from '../src/every.js';
import type { RecurringIdPort } from '../src/every.js';
import type { RandomPort } from '../src/retry.js';
import * as lifecycleTs from '../src/lifecycle.js';
import * as receiptTs from '../src/receipt.js';
import { ReceiptTableError } from '../src/receipt.js';
import * as recoveryTs from '../src/recovery.js';
import * as linkageTs from '../src/linkage.js';
import { createRecoveryPlannerFromExports } from './recovery-planner.js';

/** Startup selection is explicit. The caller compiles the producer-owned asset. */
export type WorkKernelOptions =
  | { readonly backend: 'ts' }
  // Runtime checks require a genuine compiled WebAssembly.Module. Using object
  // keeps Node consumers' declarations independent of DOM/Worker global libs.
  | { readonly backend: 'wasm'; readonly module: object };

/** Full selected Work-kernel surface with identical sync signatures. */
export interface WorkKernel {
  readonly rows: typeof rowsTs;
  readonly retry: typeof retryTs;
  readonly every: typeof everyTs;
  readonly lifecycle: typeof lifecycleTs;
  readonly receipt: typeof receiptTs;
  readonly recovery: typeof recoveryTs;
  readonly linkage: typeof linkageTs;
}

type Unary = (handle: number) => number;
interface WorkAbi {
  memory: WebAssembly.Memory;
  can_work_abi_version: () => number;
  can_work_create: () => number;
  can_work_free: Unary;
  can_work_demand: Unary;
  can_work_error_code: Unary;
  can_work_request_prepare: (handle: number, length: number) => number;
  can_work_request_ptr: Unary;
  can_work_request_len: Unary;
  can_work_request_reply: Unary;
  can_work_number_reply: (handle: number, value: number) => number;
  can_work_id_prepare: (handle: number, length: number) => number;
  can_work_id_ptr: Unary;
  can_work_id_len: Unary;
  can_work_id_reply: Unary;
  can_work_result_ptr: Unary;
  can_work_result_len: Unary;
}

const FUNCTIONS = [
  'abi_version', 'create', 'free', 'demand', 'error_code',
  'request_prepare', 'request_ptr', 'request_len', 'request_reply',
  'number_reply', 'id_prepare', 'id_ptr', 'id_len', 'id_reply',
  'result_ptr', 'result_len',
] as const;

const DONE = 0;
const NEED_REQUEST = 1;
const NEED_SAMPLE = 10;
const NEED_ID = 11;
const ERROR_PHASE = 254;

function nativeFailure(message: string): Error {
  return new Error(`work-kernel: native call ${message}`);
}

function profileRefusal(what: string): TypeError {
  return new TypeError(`work-kernel wasm profile: ${what}`);
}

function word(value: number): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) {
    throw nativeFailure('returned an invalid ABI word');
  }
  return value >>> 0;
}

function bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

function unbits(digits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${digits}`));
  return view.getFloat64(0);
}

function units(value: string): number[] {
  return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
}

function stringFromUnits(values: readonly number[]): string {
  let out = '';
  for (let offset = 0; offset < values.length; offset += 8192) {
    out += String.fromCharCode(...values.slice(offset, offset + 8192));
  }
  return out;
}

// Closed-data wire: numbers ride bit-exact, strings ride as UTF-16 units
// (lone surrogates preserved), objects ride key-ordered entries.
// `undefined` rides as an explicit tag (never silent null): the receipt
// payload rule maps it to null natively, work-profile safety refuses it,
// and state clone-only paths echo it back. Functions, symbols and bigints
// ride as tags so the NATIVE safety verdict (not a host traversal refusal)
// decides them with donor-identical faults. Containers shared across the
// graph ride with `$id`/`$ref` marks so native identity checks (cyclic
// refusal) and host thaw (alias restoration) observe the same graph.
// Per-wrapper demanded projections keep donor-unread positions out of the
// traversal entirely: those ride as `$opaque` and are restored by the
// wrapper from call-local references, never enumerated.
/**
 * Marker for one donor-unread by-reference position. A module-private class
 * so live user data shaped `{$opaque: true}` can never collide with it:
 * only markers minted here ride the opaque channel. Markers hold no props,
 * so neither traversal pass reads through them.
 */
class OpaqueMarker {
  declare readonly __workKernelOpaque: true;
}

function isOpaqueMarker(value: unknown): value is OpaqueMarker {
  return value instanceof OpaqueMarker;
}

/** Mint one donor-unread by-reference marker for this call only. */
function opaque(): OpaqueMarker {
  return new OpaqueMarker();
}

function encode(value: unknown): unknown {
  // Single observation: the first (and only) live traversal captures every
  // read exactly once, and serialization reuses those captured values. Only
  // repeated containers carry `$id`/`$ref`, so acyclic payloads keep their
  // exact historical shape. A changed second read is never consulted: the
  // donor's safety verdict comes from its first observation (a getter that
  // reads `undefined` first refuses `not JSON-safe` even when a later read
  // would see a value), and the same first observation decides here, with
  // the accessor firing exactly once. Projected views hold only scalars
  // and markers and traverse nothing live.
  const counts = new Map<object, number>();
  const firstEntries = new Map<object, Array<[string, unknown]>>();
  const firstItems = new Map<object, unknown[]>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    counts.set(node, (counts.get(node) ?? 0) + 1);
    if (counts.get(node)! > 1) return;
    if (Array.isArray(node)) {
      const items = node.map((entry) => entry);
      firstItems.set(node, items);
      for (const entry of items) visit(entry);
      return;
    }
    if (node instanceof Map) {
      const pairs = [...node];
      firstEntries.set(node, pairs as Array<[string, unknown]>);
      for (const [, entry] of pairs) visit(entry);
      return;
    }
    const entries = Object.entries(node);
    firstEntries.set(node, entries);
    for (const [, entry] of entries) visit(entry);
  };
  visit(value);
  let nextId = 0;
  const ids = new Map<object, number>();
  const build = (node: unknown): unknown => {
    // Demanded-projection markers cross verbatim: the native side carries
    // them as opaque values and echoes them back for call-local restore.
    if (isOpaqueMarker(node)) return { $opaque: true };
    if (node === undefined) return { $undefined: true };
    if (typeof node === 'number') return { $bits: bits(node) };
    if (typeof node === 'string') return { $u16: units(node) };
    if (typeof node === 'boolean' || node === null) return node;
    if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') {
      return { $fn: true };
    }
    if (typeof node === 'object') {
      const repeat = (counts.get(node) ?? 0) > 1;
      const known = ids.get(node);
      if (known !== undefined) return { $ref: known };
      const id = nextId++;
      if (repeat) ids.set(node, id);
      if (Array.isArray(node)) {
        const items = (firstItems.get(node) ?? []).map((entry) => build(entry));
        return repeat ? { $id: id, $items: items } : items;
      }
      const entries = (firstEntries.get(node) ?? []).map(
        ([key, entry]) => [units(key as string), build(entry)],
      );
      return repeat ? { $id: id, $entries: entries } : { $entries: entries };
    }
    throw profileRefusal(`${typeof node} values cannot cross the closed-data channel`);
  };
  return build(value);
}

function decodeKey(unitsValue: unknown): string {
  if (!Array.isArray(unitsValue)) throw nativeFailure('returned a malformed key channel');
  return stringFromUnits(unitsValue as number[]);
}

function defineOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  // Prototype-safe: an own `__proto__` key stays an own data property
  // (spread/structuredClone semantics), never a prototype mutation.
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function thaw(value: unknown, refs?: Map<number, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => thaw(entry, refs));
  if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (typeof node.$bits === 'string') return unbits(node.$bits);
    if (Array.isArray(node.$u16)) return stringFromUnits(node.$u16 as number[]);
    if (typeof node.$ref === 'number') {
      const target = refs?.get(node.$ref);
      if (target === undefined) throw nativeFailure('returned a dangling identity reference');
      return target;
    }
    // Opaque echoes ride through for positional restore: every wrapper
    // overwrites each echo site with its call-local reference (or discards
    // the native value outright), so echoes never reach callers. They cross
    // bare only from native Opaque carriers; live user data can never forge
    // a bare tag (the encoder wraps every object in entries).
    if (node.$opaque === true) return { $opaque: true };
    if (node.$fn === true || node.$sym === true || node.$bigint === true) {
      // State clone-only positions echo exotic tags the donor's own
      // structuredClone refuses; match its DataCloneError name loudly.
      throw new DOMException('could not be cloned', 'DataCloneError');
    }
    if (Array.isArray(node.$items) || Array.isArray(node.$entries)) {
      const table = refs ?? new Map<number, unknown>();
      const out: Record<string, unknown> | unknown[] = Array.isArray(node.$items) ? [] : {};
      if (typeof node.$id === 'number') table.set(node.$id, out);
      if (Array.isArray(node.$items)) {
        for (const entry of node.$items as unknown[]) (out as unknown[]).push(thaw(entry, table));
      } else {
        for (const entry of node.$entries as Array<[unknown, unknown]>) {
          defineOwn(out as Record<string, unknown>, decodeKey(entry[0]), thaw(entry[1], table));
        }
      }
      return out;
    }
    if ('$undefined' in node) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) defineOwn(out, key, thaw(entry, refs));
    return out;
  }
  return value;
}

/**
 * Demanded-read projection scalar: leaves cross as themselves; anything the
 * donor only references (objects, functions, symbols, bigints) rides opaque
 * so the traversal never touches donor-unread positions. `undefined` rides
 * as itself and encodes to the explicit undefined tag.
 */
function demanded(value: unknown): unknown {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
      return value;
    default:
      return value === null ? null : opaque();
  }
}

/**
 * Demanded closed-error shape view: the donor reads exactly the key set plus
 * the `code`/`message` values, so the view preserves the key count (padding
 * unread positions with opaque markers without reading them) and carries
 * only the two demanded values. Verdicts over the view equal the donor's.
 */
function shapeView(error: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    defineOwn(out, key, key === 'code' || key === 'message' ? demanded(error[key]) : opaque());
  }
  return out;
}

/**
 * Predicate argument projection for the completion-consistency twins: status
 * crosses only when it is a string (anything else decides false on both
 * sides); result crosses only as null-ness (the donor never reads further);
 * error crosses as null-ness, or as a demanded shape view exactly when the
 * status selects the shape check.
 */
function completionView(
  status: unknown,
  result: unknown,
  error: unknown,
  shaped: boolean,
): [unknown, unknown, unknown] {
  const statusView = typeof status === 'string' ? status : opaque();
  const resultView = result === undefined || result === null ? null : opaque();
  let errorView: unknown;
  if (error === undefined || error === null) errorView = null;
  else if (shaped && typeof error === 'object') errorView = shapeView(error as Record<string, unknown>);
  else errorView = opaque();
  return [statusView, resultView, errorView];
}

/** Policy projection: the guard reads exactly maxAttempts/horizonMs. */
function policyView(policy: unknown): unknown {
  if (policy === undefined || policy === null) return policy;
  if (typeof policy !== 'object') return policy;
  const source = policy as Record<string, unknown>;
  return { maxAttempts: source['maxAttempts'], horizonMs: source['horizonMs'] };
}

/**
 * Cause-kind projection: classification reads exactly kind. Sibling payload
 * fields ride as empty dummies (never read, only parsed): the native cause
 * arms require the keys present, while the donor never touches them here.
 */
function causeKindView(cause: unknown): { kind: unknown; require: string; code: string; message: string } {
  return { kind: demanded((cause as { kind: unknown }).kind), require: '', code: '', message: '' };
}

interface FaultWire {
  readonly name: string;
  readonly message: string;
  readonly codePresent: boolean;
  readonly code: unknown;
  readonly scopePresent: boolean;
  readonly scope: unknown;
}

function raiseFault(fault: FaultWire, errors?: RowsErrorFactory): never {
  const { name, message } = fault;
  let failure: Error;
  switch (name) {
    case 'KernelTableError':
      failure = errors?.kernelError(message) ?? new RowsKernelError(message);
      break;
    case 'StateError':
      failure = new RowsStateError(message);
      break;
    case 'ReceiptTableError':
      failure = new ReceiptTableError(message);
      break;
    case 'RootRecurrenceNotSupportedError':
      failure = new RootRecurrenceNotSupportedError(typeof fault.scope === 'string' ? fault.scope : '');
      break;
    case 'RangeError':
      failure = new RangeError(message);
      break;
    case 'TypeError':
      failure = new TypeError(message);
      break;
    case 'URIError':
      // Engine-variable text: the name is the contract, as in the suites.
      failure = new URIError(message);
      break;
    case 'Error':
      failure = new Error(message);
      break;
    default:
      throw nativeFailure(`returned an unknown fault ${JSON.stringify(name)}`);
  }
  if (fault.codePresent) (failure as { code?: unknown }).code = fault.code;
  throw failure;
}

interface CallDriver {
  /** Run one request; `supply` answers NEED_SAMPLE/NEED_ID demands. */
  run(leaf: string, fn: string, args: readonly unknown[], supply: {
    readonly sample?: () => number;
    readonly deriveId?: (triple: { app: string; handler: string; scope: string; owner: string; slot: number }) => string;
    readonly errors?: RowsErrorFactory | undefined;
  }): unknown;
}

function createDriver(abi: WorkAbi): CallDriver {
  const check = (handle: number, phase: number): number => {
    phase = word(phase);
    if (phase === ERROR_PHASE) {
      const code = word(abi.can_work_error_code(handle));
      if (code === 102) throw nativeFailure('rejected the request (unregistered leaf/fn or recovery planner route)');
      if (code === 101) throw nativeFailure('trapped (genuine native panic)');
      throw nativeFailure('protocol or allocation refused');
    }
    return phase;
  };
  const frame = (handle: number, ptr: number, len: number): Uint16Array => {
    const pointer = word(ptr);
    const length = word(len);
    const buffer = abi.memory.buffer;
    if (pointer % 2 !== 0 || pointer > buffer.byteLength || length > (buffer.byteLength - pointer) / 2) {
      throw nativeFailure('text frame is outside memory');
    }
    return new Uint16Array(buffer, pointer, length);
  };
  const writeText = (handle: number, prepare: (handle: number, length: number) => number, getPtr: Unary, getLen: Unary, reply: Unary, text: string): number => {
    if (text.length > 0xffffffff || word(prepare(handle, text.length)) !== 1) {
      check(handle, abi.can_work_demand(handle));
      throw nativeFailure('text allocation refused');
    }
    const view = frame(handle, getPtr(handle), getLen(handle));
    check(handle, abi.can_work_demand(handle));
    if (view.length !== text.length) throw nativeFailure('text length does not match');
    for (let index = 0; index < text.length; index++) view[index] = text.charCodeAt(index);
    return check(handle, reply(handle));
  };
  const readFrame = (handle: number): string => {
    const view = frame(handle, abi.can_work_result_ptr(handle), abi.can_work_result_len(handle));
    check(handle, abi.can_work_demand(handle));
    // Refresh after every allocation/reentrant call; never retain a view.
    return stringFromUnits(Array.from(view));
  };
  const run: CallDriver['run'] = (leaf, fn, args, supply) => {
    const handle = word(abi.can_work_create());
    if (handle === 0) throw nativeFailure('call allocation failed');
    let failed = false;
    try {
      const request = JSON.stringify({ leaf, fn, args: args.map((entry) => encode(entry)) });
      let phase = writeText(handle, abi.can_work_request_prepare.bind(abi), abi.can_work_request_ptr.bind(abi), abi.can_work_request_len.bind(abi), abi.can_work_request_reply.bind(abi), request);
      for (;;) {
        if (phase === DONE) {
          const response = JSON.parse(readFrame(handle)) as {
            outcome: { ok?: unknown; throw?: FaultWire };
            randomCalls: number;
            deriveCalls: unknown;
          };
          if (response.outcome.throw !== undefined) {
            const fault = response.outcome.throw;
            raiseFault({
              name: thaw(fault.name) as string,
              message: thaw(fault.message) as string,
              codePresent: fault.codePresent,
              code: thaw(fault.code),
              scopePresent: fault.scopePresent,
              scope: thaw(fault.scope),
            }, supply.errors);
          }
          return thaw(response.outcome.ok);
        }
        if (phase === NEED_SAMPLE) {
          if (supply.sample === undefined) throw nativeFailure('demanded an RNG sample with no supplier');
          phase = check(handle, abi.can_work_number_reply(handle, supply.sample()));
          continue;
        }
        if (phase === NEED_ID) {
          if (supply.deriveId === undefined) throw nativeFailure('demanded a recurrence id with no supplier');
          const demand = thaw(JSON.parse(readFrame(handle))) as {
            need: string; app: string; handler: string; scope: string; owner: string; slot: number;
          };
          if (demand.need !== 'id') throw nativeFailure('returned a malformed id demand');
          const minted = supply.deriveId({ app: demand.app, handler: demand.handler, scope: demand.scope, owner: demand.owner, slot: demand.slot });
          if (typeof minted !== 'string') throw profileRefusal('recurrence deriveId must mint a string id');
          phase = writeText(handle, abi.can_work_id_prepare.bind(abi), abi.can_work_id_ptr.bind(abi), abi.can_work_id_len.bind(abi), abi.can_work_id_reply.bind(abi), minted);
          continue;
        }
        throw nativeFailure('demand is unsupported');
      }
    } catch (failure) {
      failed = true;
      throw failure;
    } finally {
      if (failed) {
        try { abi.can_work_free(handle); } catch { /* Preserve the original failure. */ }
      } else if (word(abi.can_work_free(handle)) !== 1) {
        throw nativeFailure('call cleanup refused');
      }
    }
  };
  return { run };
}

function wasmRows(driver: CallDriver): typeof rowsTs {
  const rows = { ...rowsTs };
  const call = (fn: string, args: readonly unknown[], errors?: RowsErrorFactory): unknown =>
    driver.run('rows', fn, args, { errors });
  rows.readDispatchRow = ((row: unknown, errors?: RowsErrorFactory): unknown =>
    call('readDispatchRow', [row], errors)) as typeof rows.readDispatchRow;
  rows.readOccurrenceRow = ((row: unknown, errors?: RowsErrorFactory): unknown => {
    // The donor validates the fixed scalar fields and returns result by
    // reference: result rides opaque and is restored, exactly like the
    // lifecycle passthroughs. Non-record data fails closed natively.
    const source = row as { data: unknown };
    if (typeof source.data !== 'object' || source.data === null || Array.isArray(source.data)) {
      return call('readOccurrenceRow', [row], errors);
    }
    const data = source.data as Record<string, unknown>;
    // Donor read order: status, then the return-literal fields. An already
    // refused status never touches the later accessors: the native verdict
    // (not a later getter) decides, so unread positions ride dummies while
    // the refused status itself still rides for the owning status error.
    const status = data['status'];
    if (status !== 'completed' && status !== 'failed') {
      return call('readOccurrenceRow', [{
        id: '',
        version: 0,
        created: 0,
        updated: 0,
        createdBy: '',
        updatedBy: '',
        archivedAt: null,
        parent: null,
        data: { occurrenceId: '', status, result: opaque(), code: null, message: null, recordedAtMs: 0 },
      }], errors);
    }
    const occurrenceId = data['occurrenceId'];
    const result = data['result'] ?? null;
    const code = data['code'];
    const message = data['message'];
    const recordedAtMs = data['recordedAtMs'];
    const out = call('readOccurrenceRow', [{
      id: '',
      version: 0,
      created: 0,
      updated: 0,
      createdBy: '',
      updatedBy: '',
      archivedAt: null,
      parent: null,
      data: { occurrenceId, status, result: opaque(), code, message, recordedAtMs },
    }], errors) as Record<string, unknown>;
    return { ...out, result };
  }) as typeof rows.readOccurrenceRow;
  rows.readScheduleRow = ((row: unknown, errors?: RowsErrorFactory): unknown =>
    call('readScheduleRow', [row], errors)) as typeof rows.readScheduleRow;
  rows.scheduleRowScope = ((row: unknown): unknown =>
    driver.run('rows', 'scheduleRowScope', [row], {})) as typeof rows.scheduleRowScope;
  rows.readEverySlotRow = ((row: unknown, errors?: RowsErrorFactory): unknown =>
    call('readEverySlotRow', [row], errors)) as typeof rows.readEverySlotRow;
  rows.readSupersessionRow = ((row: unknown, errors?: RowsErrorFactory): unknown =>
    call('readSupersessionRow', [row], errors)) as typeof rows.readSupersessionRow;
  rows.newDispatchRow = ((input: unknown, meta: unknown, errors?: RowsErrorFactory): unknown =>
    call('newDispatchRow', [input, meta], errors)) as typeof rows.newDispatchRow;
  rows.newOccurrenceRow = ((input: unknown, meta: unknown, errors?: RowsErrorFactory): unknown =>
    call('newOccurrenceRow', [input, meta], errors)) as typeof rows.newOccurrenceRow;
  rows.newScheduleRow = ((input: unknown, meta: unknown, errors?: RowsErrorFactory): unknown =>
    call('newScheduleRow', [input, meta], errors)) as typeof rows.newScheduleRow;
  rows.newEverySlotRow = ((input: unknown, meta: unknown, errors?: RowsErrorFactory): unknown =>
    call('newEverySlotRow', [input, meta], errors)) as typeof rows.newEverySlotRow;
  rows.newSupersessionRow = ((input: unknown, meta: unknown, errors?: RowsErrorFactory): unknown =>
    call('newSupersessionRow', [input, meta], errors)) as typeof rows.newSupersessionRow;
  rows.dispatchByOriginQuery = ((originOccurrence: unknown): unknown =>
    driver.run('rows', 'dispatchByOriginQuery', [originOccurrence], {})) as typeof rows.dispatchByOriginQuery;
  rows.dispatchByStateQuery = ((state: unknown): unknown =>
    driver.run('rows', 'dispatchByStateQuery', [state], {})) as typeof rows.dispatchByStateQuery;
  rows.scheduleByKeyQuery = ((scope: unknown, key: unknown): unknown =>
    driver.run('rows', 'scheduleByKeyQuery', [scope, key], {})) as typeof rows.scheduleByKeyQuery;
  rows.checkFanoutIdentitySet = ((value: unknown, what: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('checkFanoutIdentitySet', [value, what, direction], errors)) as typeof rows.checkFanoutIdentitySet;
  rows.fanoutIntentRowId = ((sourceOccurrence: unknown, handler: unknown, cohort: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('fanoutIntentRowId', [sourceOccurrence, handler, cohort, direction], errors)) as typeof rows.fanoutIntentRowId;
  rows.fanoutCheckpointRowId = ((fanoutId: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('fanoutCheckpointRowId', [fanoutId, direction], errors)) as typeof rows.fanoutCheckpointRowId;
  rows.fanoutChildRowId = ((parentOccurrence: unknown, handler: unknown, recordId: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('fanoutChildRowId', [parentOccurrence, handler, recordId, direction], errors)) as typeof rows.fanoutChildRowId;
  rows.newFanoutIntentRow = ((input: unknown, meta: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('newFanoutIntentRow', [input, meta, direction], errors)) as typeof rows.newFanoutIntentRow;
  rows.newFanoutCheckpointRow = ((input: unknown, meta: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('newFanoutCheckpointRow', [input, meta, direction], errors)) as typeof rows.newFanoutCheckpointRow;
  rows.nextFanoutCheckpointData = ((current: unknown, addCompleted: unknown, cursor: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('nextFanoutCheckpointData', [current, addCompleted, cursor, direction], errors)) as typeof rows.nextFanoutCheckpointData;
  rows.newFanoutChildRow = ((input: unknown, meta: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('newFanoutChildRow', [input, meta, direction], errors)) as typeof rows.newFanoutChildRow;
  rows.readFanoutIntentRow = ((row: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('readFanoutIntentRow', [row, direction], errors)) as typeof rows.readFanoutIntentRow;
  rows.readFanoutCheckpointRow = ((row: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('readFanoutCheckpointRow', [row, direction], errors)) as typeof rows.readFanoutCheckpointRow;
  rows.readFanoutChildRow = ((row: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('readFanoutChildRow', [row, direction], errors)) as typeof rows.readFanoutChildRow;
  rows.fanoutChildIdOf = ((row: unknown): unknown =>
    driver.run('rows', 'fanoutChildIdOf', [row], {})) as typeof rows.fanoutChildIdOf;
  rows.fanoutChildPageQuery = ((fanoutId: unknown, opts: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('fanoutChildPageQuery', [fanoutId, opts, direction], errors)) as typeof rows.fanoutChildPageQuery;
  rows.fanoutChildPageResult = ((paged: unknown, limit: unknown, direction: unknown, errors?: RowsErrorFactory): unknown =>
    call('fanoutChildPageResult', [paged, limit, direction], errors)) as typeof rows.fanoutChildPageResult;
  // Replacement rows merge the native verdict onto the input spread: caller
  // extras and envelope references survive with donor spread timing, while
  // the safety/clone semantics stay exact. Work data crosses whole (the
  // donor safety-traverses then clones, matching the two-pass traversal);
  // state clone-only data never crosses (the donor only clones) and is
  // cloned host-side, preserving alias identity and cycles exactly.
  const storedRowEnvelope = (row: Record<string, unknown>): Record<string, unknown> => ({
    id: '',
    version: row['version'],
    created: 0,
    updated: 0,
    createdBy: '',
    updatedBy: '',
    archivedAt: null,
    parent: null,
    data: null,
  });
  rows.withRowData = ((row: unknown, data: unknown, meta: unknown, what: unknown, errors?: RowsErrorFactory): unknown => {
    const source = row as Record<string, unknown>;
    const out = call('withRowData', [storedRowEnvelope(source), data, meta, what], errors) as {
      version: unknown; updated: unknown; updatedBy: unknown; data: unknown;
    };
    return {
      ...source,
      version: out.version,
      updated: out.updated,
      updatedBy: out.updatedBy,
      data: out.data,
    };
  }) as typeof rows.withRowData;
  rows.withFanoutRowData = ((row: unknown, data: unknown, meta: unknown, errors?: RowsErrorFactory): unknown => {
    const source = row as Record<string, unknown>;
    const out = call('withFanoutRowData', [storedRowEnvelope(source), null, meta], errors) as {
      version: unknown; updated: unknown; updatedBy: unknown;
    };
    return {
      ...source,
      version: out.version,
      updated: out.updated,
      updatedBy: out.updatedBy,
      data: cloneData(data),
    };
  }) as typeof rows.withFanoutRowData;
  return rows;
}

function wasmRetry(driver: CallDriver): typeof retryTs {
  const retry = { ...retryTs };
  // Classification reads exactly kind; the code/message payload never
  // affects it, so it never crosses (and can never fault the traversal).
  retry.classifyFailure = ((cause: unknown): unknown =>
    driver.run('retry', 'classifyFailure', [causeKindView(cause)], {})) as typeof retry.classifyFailure;
  retry.assertPolicy = ((policy: unknown): unknown =>
    driver.run('retry', 'assertPolicy', [policyView(policy)], {})) as typeof retry.assertPolicy;
  retry.computeBackoff = ((input: { attempt: number; firstAttemptAtMs: number; nowMs: number; policy?: unknown; random: RandomPort }): unknown =>
    driver.run('retry', 'computeBackoff', [{
      attempt: input.attempt,
      firstAttemptAtMs: input.firstAttemptAtMs,
      nowMs: input.nowMs,
      policy: policyView(input.policy),
    }], { sample: () => input.random.nextUnit() })) as typeof retry.computeBackoff;
  return retry;
}

function wasmEvery(driver: CallDriver): typeof everyTs {
  const every = { ...everyTs };
  every.everyScopeKey = ((scope: unknown, owner: unknown): unknown =>
    driver.run('every', 'everyScopeKey', [scope, owner], {})) as typeof every.everyScopeKey;
  every.computeEverySlot = ((nowMs: unknown, periodMs: unknown): unknown =>
    driver.run('every', 'computeEverySlot', [nowMs, periodMs], {})) as typeof every.computeEverySlot;
  every.admitEveryTick = ((input: {
    nowMs: number; periodMs: number; app: string; handler: string;
    scopes: readonly { scope: string; owner: string }[];
    previousSlots: Readonly<Record<string, number>>;
  }, deriveId: RecurringIdPort): unknown => {
    // Absent and undefined-valued slots agree (new scopes admit nothing
    // until the next slot); strip the latter so the wire carries absence.
    const previousSlots: Record<string, number> = {};
    for (const [key, slot] of Object.entries(input.previousSlots)) {
      if (slot !== undefined) previousSlots[key] = slot;
    }
    return driver.run('every', 'admitEveryTick', [{
      nowMs: input.nowMs,
      periodMs: input.periodMs,
      app: input.app,
      handler: input.handler,
      scopes: input.scopes,
      previousSlots,
    }], {
      deriveId: (triple) => {
        const minted = (deriveId as (app: string, handler: string, scope: never, owner: string, slot: number) => unknown)(
          triple.app, triple.handler, triple.scope as never, triple.owner, triple.slot,
        );
        if (typeof minted !== 'string') throw profileRefusal('recurrence deriveId must mint a string id');
        return minted;
      },
    });
  }) as typeof every.admitEveryTick;
  return every;
}

function wasmLifecycle(driver: CallDriver): typeof lifecycleTs {
  const lifecycle = { ...lifecycleTs };
  lifecycle.recordOutcome = ((input: {
    item: { id: unknown; attempts: unknown; state: unknown; request: unknown };
    outcome: { kind: unknown; result?: unknown; cause?: { kind: unknown; code?: unknown; message?: unknown } };
    nowMs: unknown;
    firstAttemptAtMs: unknown;
    policy?: unknown;
  }): unknown => {
    // Demanded projection in donor read order: state, clock anchors, policy
    // fields, outcome kind, cause refs, attempts, id. The donor never reads
    // past these (request and extras ride the host spread below), so the
    // traversal cannot fire donor-unread getters or refuse valid opaques.
    const item = input.item;
    const outcome = input.outcome;
    const state = item.state;
    // Donor demand order: a refused state never touches the clock, policy,
    // outcome or counters — the owning state error decides. The refusal
    // still consults the native verdict (never whitelisted away): only the
    // donor-read refusal fields ride (state, then id for the message) while
    // every donor-unread position rides a parseable dummy the native
    // refusal never consults.
    if (state !== 'pending' && state !== 'claimed') {
      const id = item.id;
      // The donor's refusal message observes state once more after id;
      // match that access (state, id, state) while the first observation
      // keeps governing the verdict, exactly like the wire single-read rule.
      void item.state;
      return driver.run('lifecycle', 'recordOutcome', [{
        item: {
          id: typeof id === 'string' ? id : '',
          operationId: '',
          source: '',
          occurrenceIndex: 0,
          request: opaque(),
          originOccurrence: null,
          attempts: 0,
          state,
        },
        outcome: { kind: 'uncertain' },
        nowMs: 0,
        firstAttemptAtMs: 0,
        policy: policyView(undefined),
      }], {});
    }
    const nowMs = input.nowMs;
    const firstAttemptAtMs = input.firstAttemptAtMs;
    const policy = policyView(input.policy);
    const attempts = item.attempts;
    const kind = outcome.kind;
    let causeView: unknown = null;
    let causeKind: unknown;
    let causeCode: unknown;
    let causeMessage: unknown;
    if (kind === 'failed') {
      const cause = outcome.cause as { kind: unknown; code?: unknown; message?: unknown };
      causeKind = cause.kind;
      if (causeKind === 'handler-require-false') {
        causeView = { kind: causeKind, require: '', code: '', message: '' };
      } else {
        causeCode = cause.code;
        causeMessage = cause.message;
        causeView = {
          kind: demanded(causeKind),
          code: typeof causeCode === 'string' ? causeCode : '',
          message: typeof causeMessage === 'string' ? causeMessage : '',
        };
      }
    }
    const id = item.id;
    const out = driver.run('lifecycle', 'recordOutcome', [{
      item: {
        id: typeof id === 'string' ? id : '',
        operationId: '',
        source: '',
        occurrenceIndex: 0,
        request: opaque(),
        originOccurrence: null,
        attempts,
        state,
      },
      outcome: kind === 'delivered'
        ? { kind, result: opaque() }
        : kind === 'uncertain'
          ? { kind }
          : { kind: demanded(kind), cause: causeView },
      nowMs,
      firstAttemptAtMs,
      policy,
    }], {}) as {
      item: { attempts: unknown; state: unknown };
      status: unknown; result: unknown; error: { code: unknown } | null;
      retryClass: unknown; retryable: unknown;
    };
    // Host merge: the spread preserves caller extras and the request by
    // reference with donor spread timing; only the decided fields come from
    // the native verdict. A delivered result passes through by reference; a
    // terminal cause error carries the captured refs when they are exotic
    // (fixed exhaustion errors stay native).
    const merged = { ...(item as Record<string, unknown>), attempts: out.item.attempts, state: out.item.state };
    let result: unknown = null;
    if (kind === 'delivered') result = (outcome as { result?: unknown }).result;
    let error: unknown = out.error;
    const errorCode = (error as { code?: unknown } | null)?.code;
    if (kind === 'failed' && causeKind !== 'handler-require-false'
      && (typeof causeCode !== 'string' || typeof causeMessage !== 'string')
      && errorCode !== 'retry-exhausted' && errorCode !== 'retry-horizon-exceeded') {
      error = { code: causeCode, message: causeMessage };
    }
    return {
      item: merged,
      status: out.status,
      result,
      error,
      retryClass: out.retryClass,
      retryable: out.retryable,
    };
  }) as typeof lifecycle.recordOutcome;
  lifecycle.reconcileUncertain = ((item: { request: unknown }, evidence: { kind: unknown; result?: unknown; code?: unknown; message?: unknown } | null): unknown => {
    // Donor read order: item.state first; evidence is untouched (not even
    // its kind) on the non-uncertain path, so it rides null there and the
    // native no-op decides unchanged.
    const source = item as unknown as { state: unknown };
    const state = source.state;
    let evidenceView: unknown = null;
    let capturedResult: unknown;
    let capturedCode: unknown;
    let capturedMessage: unknown;
    let evidenceKind: unknown;
    // Only null evidence is a no-op: undefined evidence still reads kind
    // (and reconciles as not-found), exactly like the donor.
    if (state === 'uncertain' && evidence !== null) {
      evidenceKind = (evidence as { kind: unknown }).kind;
      if (evidenceKind === 'delivered') {
        capturedResult = evidence.result;
        evidenceView = { kind: evidenceKind, result: opaque() };
      } else if (evidenceKind === 'failed') {
        capturedCode = evidence.code;
        capturedMessage = evidence.message;
        evidenceView = {
          kind: evidenceKind,
          code: typeof capturedCode === 'string' ? capturedCode : '',
          message: typeof capturedMessage === 'string' ? capturedMessage : '',
        };
      } else {
        evidenceView = { kind: typeof evidenceKind === 'string' ? evidenceKind : '' };
      }
    }
    const out = driver.run('lifecycle', 'reconcileUncertain', [{
      id: '',
      operationId: '',
      source: '',
      occurrenceIndex: 0,
      request: opaque(),
      originOccurrence: null,
      attempts: 0,
      state,
    }, evidenceView], {}) as {
      item: { state: unknown };
      changed: boolean;
      status: unknown;
      result: unknown;
      error: unknown;
    };
    // Untouched paths return the input item itself; changed paths spread the
    // input (caller-owned request and extras by reference) with the decided
    // state; delivered/failed payloads restore call-local references.
    if (!out.changed) {
      return { item, changed: false, status: null, result: null, error: null };
    }
    const merged = { ...(item as Record<string, unknown>), state: out.item.state };
    if (evidenceKind === 'delivered') {
      return { item: merged, changed: true, status: out.status, result: capturedResult, error: null };
    }
    if (evidenceKind === 'failed'
      && (typeof capturedCode !== 'string' || typeof capturedMessage !== 'string')) {
      return {
        item: merged,
        changed: true,
        status: out.status,
        result: null,
        error: { code: capturedCode, message: capturedMessage },
      };
    }
    return { item: merged, changed: true, status: out.status, result: null, error: out.error };
  }) as typeof lifecycle.reconcileUncertain;
  return lifecycle;
}

/** Minimal global structuredClone shape (Node >= 22 runtime). */
declare const structuredClone: <T>(value: T) => T;

/** Clone-only positions reuse the donor's own clone, host-side, exactly. */
function cloneData<T>(value: T): T {
  return structuredClone(value);
}

function wasmReceipt(driver: CallDriver): typeof receiptTs {
  const receipt = { ...receiptTs };
  // Minimal item projection: the donor reads exactly id (sort) and state
  // (filter); request and extras ride the host zip below, never the wire.
  const listingItemView = (item: Record<string, unknown>): Record<string, unknown> => ({
    id: demanded(item['id']),
    operationId: '',
    source: '',
    occurrenceIndex: 0,
    request: opaque(),
    originOccurrence: null,
    attempts: 0,
    state: demanded(item['state']),
  });
  // Exact-occurrence restore: each native output row maps back to the one
  // original occurrence the native decision actually selected, in
  // selected-order. Pools hold only selectable inputs (by the
  // already-observed view values, in input order) keyed by the
  // already-observed id — never every input regardless of the decision,
  // which would hand back an unselected same-id occurrence. A native id
  // with an empty pool is skew, never silent.
  receipt.listDeadLetter = ((items: readonly { id: string }[]): unknown => {
    const pairs = items.map((item) => ({ item, view: listingItemView(item as Record<string, unknown>) }));
    const out = driver.run('receipt', 'listDeadLetter', [pairs.map((pair) => pair.view)], {}) as { id: string }[];
    const pools = new Map<unknown, { id: string }[]>();
    for (const { item, view } of pairs) {
      if (view['state'] === 'dead') {
        const key = view['id'];
        const pool = pools.get(key);
        if (pool === undefined) pools.set(key, [item]);
        else pool.push(item);
      }
    }
    return out.map((row) => {
      const original = pools.get(row.id)?.shift();
      if (original === undefined) throw nativeFailure('returned a dead-letter row outside this call');
      return original;
    });
  }) as typeof receipt.listDeadLetter;
  receipt.isConsistentCompletion = ((status: unknown, result: unknown, error: unknown): unknown =>
    driver.run('receipt', 'isConsistentCompletion',
      completionView(status, result, error, status === 'failed' || status === 'unknown'), {})) as typeof receipt.isConsistentCompletion;
  receipt.isStoredReceiptPayload = ((status: unknown, result: unknown, error: unknown): unknown =>
    driver.run('receipt', 'isStoredReceiptPayload',
      completionView(status, result, error, status === 'failed' || status === 'unknown'), {})) as typeof receipt.isStoredReceiptPayload;
  receipt.isTerminalReceiptStatus = ((status: unknown): unknown =>
    driver.run('receipt', 'isTerminalReceiptStatus', [demanded(status)], {})) as typeof receipt.isTerminalReceiptStatus;
  receipt.toReceiptObservation = ((deliveryId: string, revision: number, recorded: { status: unknown; result: unknown; error: unknown }): unknown => {
    // Donor read order: deliveryId, revision, then the recorded fields. The
    // native call validates the locator pair (the only calculation); result
    // and error pass through by host reference — the kernel never mints or
    // traverses them. Status rides only when it is a string, like the
    // native carrier requires. Locator refusal leaves recorded untouched.
    const idOk = typeof deliveryId === 'string' && deliveryId.length > 0;
    const revOk = typeof revision === 'number' && Number.isInteger(revision) && revision >= 0;
    if (!idOk || !revOk) {
      driver.run('receipt', 'toReceiptObservation', [idOk ? deliveryId : '', revOk ? revision : -1, {
        status: '',
        result: null,
        error: null,
      }], {});
      throw nativeFailure('unreachable: native locator validation must refuse');
    }
    // The donor observes recorded.status exactly once; capture it and reuse
    // the capture for the view and the merge — never re-read the accessor.
    const status = recorded.status;
    driver.run('receipt', 'toReceiptObservation', [deliveryId, revision, {
      status: typeof status === 'string' ? status : '',
      result: opaque(),
      error: null,
    }], {});
    return { id: deliveryId, revision, status, result: recorded.result, error: recorded.error };
  }) as typeof receipt.toReceiptObservation;
  receipt.associationRowId = ((model: unknown, recordId: unknown, field: unknown): unknown =>
    driver.run('receipt', 'associationRowId', [model, recordId, field], {})) as typeof receipt.associationRowId;
  receipt.readAssociationRow = ((row: unknown): unknown =>
    driver.run('receipt', 'readAssociationRow', [row], {})) as typeof receipt.readAssociationRow;
  receipt.readReceiptRow = ((row: unknown): unknown => {
    // The donor reads the envelope id plus the data's fixed scalar fields
    // and validates (never traverses) result/error: result rides opaque and
    // is restored by reference; error rides a demanded shape view exactly
    // when the status selects the shape check.
    const source = row as { id: unknown; data: unknown };
    // Non-record data fails closed natively exactly like the donor's
    // checkRecord: it crosses as-is for the native verdict.
    if (typeof source.data !== 'object' || source.data === null || Array.isArray(source.data)) {
      return driver.run('receipt', 'readReceiptRow', [row], {});
    }
    const data = source.data as Record<string, unknown>;
    const status = data['status'];
    const shaped = status === 'failed' || status === 'unknown';
    const error = data['error'];
    // Result crosses as null-ness (the donor maps missing to null and never
    // reads further); only present results ride opaque for restore.
    const resultValue = data['result'];
    const resultView = resultValue === undefined || resultValue === null ? null : opaque();
    const errorView = error === undefined || error === null
      ? null
      : shaped && typeof error === 'object'
        ? shapeView(error as Record<string, unknown>)
        : opaque();
    const out = driver.run('receipt', 'readReceiptRow', [{
      id: source.id,
      version: 0,
      created: 0,
      updated: 0,
      createdBy: '',
      updatedBy: '',
      archivedAt: null,
      parent: null,
      data: {
        deliveryId: data['deliveryId'],
        revision: data['revision'],
        status,
        result: resultView,
        error: errorView,
        contentRef: data['contentRef'],
        resultExpiresAtMs: data['resultExpiresAtMs'],
      },
    }], {}) as {
      receipt: { deliveryId: unknown; revision: unknown; status: unknown; result: unknown; error: unknown };
      contentRef: unknown;
      resultExpiresAtMs: unknown;
    };
    // Result and error are always the caller-owned references (missing
    // reads as null), exactly like the donor: the native verdict validates,
    // never mints, so the decoded clone is discarded on success. The shape
    // view already observed code/message once, matching the donor's single
    // closed-shape read — no second observation here.
    const result = resultValue === undefined ? null : resultValue;
    const observed = error === undefined ? null : error;
    return {
      receipt: {
        deliveryId: out.receipt.deliveryId,
        revision: out.receipt.revision,
        status: out.receipt.status,
        result,
        error: observed,
      },
      contentRef: out.contentRef,
      resultExpiresAtMs: out.resultExpiresAtMs,
    };
  }) as typeof receipt.readReceiptRow;
  receipt.newAssociationRow = ((input: unknown, meta: unknown): unknown =>
    driver.run('receipt', 'newAssociationRow', [{ ...(input as Record<string, unknown>) }, meta], {})) as typeof receipt.newAssociationRow;
  receipt.newReceiptRow = ((input: unknown, meta: unknown): unknown =>
    driver.run('receipt', 'newReceiptRow', [{ ...(input as Record<string, unknown>) }, meta], {})) as typeof receipt.newReceiptRow;
  // Replacement rows merge the native verdict (updated/version/data) onto
  // the input spread, so caller extras and envelope references survive with
  // donor spread timing; data crosses whole for the native safety verdict.
  // The stale check reads the current row data's revision exactly like the
  // donor (throwing on null data); the envelope id rides real for the
  // native read-back derivation check; everything else rides fixed dummies.
  const storedRowView = (row: Record<string, unknown>): Record<string, unknown> => ({
    id: demanded(row['id']),
    version: row['version'],
    created: 0,
    updated: 0,
    createdBy: '',
    updatedBy: '',
    archivedAt: null,
    parent: null,
    data: { revision: (row['data'] as Record<string, unknown>)['revision'] },
  });
  receipt.withAssociationRowData = ((row: unknown, data: unknown, meta: unknown): unknown => {
    const source = row as Record<string, unknown>;
    const out = driver.run('receipt', 'withAssociationRowData', [storedRowView(source), data, meta], {}) as {
      version: unknown; updated: unknown; updatedBy: unknown; data: unknown;
    };
    return {
      ...source,
      version: out.version,
      updated: out.updated,
      updatedBy: out.updatedBy,
      data: out.data,
    };
  }) as typeof receipt.withAssociationRowData;
  receipt.withReceiptRowData = ((row: unknown, data: unknown, meta: unknown): unknown => {
    const source = row as Record<string, unknown>;
    const out = driver.run('receipt', 'withReceiptRowData', [storedRowView(source), data, meta], {}) as {
      version: unknown; updated: unknown; updatedBy: unknown; data: unknown;
    };
    return {
      ...source,
      version: out.version,
      updated: out.updated,
      updatedBy: out.updatedBy,
      data: out.data,
    };
  }) as typeof receipt.withReceiptRowData;
  return receipt;
}

function wasmRecovery(driver: CallDriver, planRecoveryScan: (input: never) => unknown): typeof recoveryTs {
  const recovery = { ...recoveryTs };
  recovery.isClaimStale = ((claim: unknown, nowMs: unknown, maxClaimAgeMs: unknown): unknown => {
    // The donor reads exactly claimedAt; sibling locator fields are unread.
    const source = claim as Record<string, unknown>;
    return driver.run('recovery', 'isClaimStale', [{
      outboxId: '',
      claimId: '',
      claimedAt: source['claimedAt'],
    }, nowMs, maxClaimAgeMs], {});
  }) as typeof recovery.isClaimStale;
  recovery.findStaleClaims = ((claims: readonly { claimId: string }[], nowMs: unknown, maxClaimAgeMs: unknown): unknown => {
    const pairs = claims.map((claim) => ({
      claim,
      view: {
        outboxId: '',
        claimId: (claim as Record<string, unknown>)['claimId'],
        claimedAt: (claim as Record<string, unknown>)['claimedAt'],
      },
    }));
    const out = driver.run('recovery', 'findStaleClaims', [pairs.map((pair) => pair.view), nowMs, maxClaimAgeMs], {}) as { claimId: string }[];
    // Exact-occurrence restore: pools hold only the claims the native
    // decision actually selected — stale by the already-observed claimedAt
    // under the donor's own boundary expression, in input order — keyed by
    // the already-observed claim id. Pooling every input regardless of the
    // decision would hand back an unselected same-id claim. The clock pair
    // is loop-invariant (the donor threads one value through every claim),
    // so it is observed once, never once per claim.
    const pools = new Map<unknown, { claimId: string }[]>();
    const now = nowMs as number;
    const age = maxClaimAgeMs as number;
    for (const { claim, view } of pairs) {
      const stale = (view['claimedAt'] as number) + age <= now;
      if (stale) {
        const key = view['claimId'];
        const pool = pools.get(key);
        if (pool === undefined) pools.set(key, [claim]);
        else pool.push(claim);
      }
    }
    return out.map((row) => {
      const original = pools.get(row.claimId)?.shift();
      if (original === undefined) throw nativeFailure('returned a stale claim outside this call');
      return original;
    });
  }) as typeof recovery.findStaleClaims;
  // Minimal outbox projection: id/state ride demanded (the donor reads them
  // for filter/sort/output/throw); request rides opaque (never traversed);
  // every other envelope field rides a parseable dummy the host merge below
  // discards. Attempts rides real only where the donor reads it (staging).
  const outboxItemView = (item: Record<string, unknown>, withAttempts: boolean): Record<string, unknown> => ({
    id: demanded(item['id']),
    operationId: '',
    source: '',
    occurrenceIndex: 0,
    request: opaque(),
    originOccurrence: null,
    attempts: withAttempts ? item['attempts'] : 0,
    state: demanded(item['state']),
  });
  recovery.buildInventory = ((input: recoveryTs.InventoryInput): unknown => {
    // Per-occurrence demand in donor order: one callback reply per uncertain
    // occurrence (duplicates keep their own replies; the native minimum over
    // the ordered list retains the oldest). No Map collapse, no id
    // consultation beyond the callback argument itself.
    const replies: (number | null)[] = [];
    for (const item of input.outboxItems) {
      if (item.state === 'uncertain') {
        const committed = input.committedAtMs(item.id);
        replies.push(typeof committed === 'number' ? committed : null);
      }
    }
    return driver.run('recovery', 'buildInventory', [{
      outboxItems: input.outboxItems.map((item) => ({
        id: '',
        operationId: '',
        source: '',
        occurrenceIndex: 0,
        request: opaque(),
        originOccurrence: null,
        attempts: 0,
        state: demanded((item as unknown as Record<string, unknown>)['state']),
      })),
      // Length only: the donor never reads due rows.
      dueOccurrences: input.dueOccurrences.map(() => opaque()),
      committedList: replies,
    }], {});
  }) as typeof recovery.buildInventory;
  recovery.buildWorkInventory = ((input: recoveryTs.WorkInventoryInput): unknown => {
    // Donor-order pre-scan: settled items never consult the callback; an
    // unknown-state item stops consultation (no callback for it or later
    // items) and rides along for the native unknown-state refusal; every
    // other non-settled occurrence consults exactly once, duplicates
    // included. The native cursor consumes the reply list in the same order.
    const views: Record<string, unknown>[] = [];
    const replies: (string | null)[] = [];
    for (const item of input.outboxItems) {
      const source = item as unknown as Record<string, unknown>;
      const state = source['state'];
      if (state === 'delivered' || state === 'failed' || state === 'dead') continue;
      if (state !== 'pending' && state !== 'claimed' && state !== 'uncertain') {
        views.push(outboxItemView(source, false));
        break;
      }
      const contract = input.handlerContractFor(item);
      views.push(outboxItemView(source, false));
      replies.push(typeof contract === 'string' && contract !== '' ? contract : null);
    }
    return driver.run('recovery', 'buildWorkInventory', [{
      outboxItems: views,
      contractsList: replies,
    }], {});
  }) as typeof recovery.buildWorkInventory;
  recovery.releaseStaleClaims = ((outboxItems: readonly { id: string }[], claims: unknown, nowMs: unknown, maxClaimAgeMs: unknown): unknown => {
    const pairs = outboxItems.map((item) => ({
      item,
      view: outboxItemView(item as Record<string, unknown>, false),
    }));
    const out = driver.run('recovery', 'releaseStaleClaims', [pairs.map((pair) => pair.view), (claims as unknown[]).map((claim) => {
      const source = claim as Record<string, unknown>;
      return { outboxId: source['outboxId'], claimId: source['claimId'], claimedAt: source['claimedAt'] };
    }), nowMs, maxClaimAgeMs], {}) as {
      items: Record<string, unknown>[]; releasedIds: string[];
    };
    // Input order is preserved: zip decoded rows back to input references.
    // The release decision is per occurrence, not per id: only a claimed
    // occurrence the native verdict actually moved to pending is re-spread;
    // every other occurrence keeps its exact original reference. An id-set
    // heuristic would clone an untouched same-id occurrence.
    if (out.items.length !== pairs.length) throw nativeFailure('returned a release set outside this call');
    return {
      items: out.items.map((row, index) => {
        const pair = pairs[index];
        if (pair === undefined) throw nativeFailure('returned a release row outside this call');
        const original = pair.item as Record<string, unknown>;
        if (original?.['id'] !== row['id']) throw nativeFailure('returned a release row outside this call');
        if (pair.view['state'] === 'claimed' && row['state'] === 'pending') {
          return { ...original, state: 'pending' };
        }
        return pair.item;
      }),
      releasedIds: out.releasedIds,
    };
  }) as typeof recovery.releaseStaleClaims;
  recovery.recordStagingFailure = ((input: {
    item: { id: unknown; attempts: unknown; state: unknown; request: unknown };
    cause: unknown;
    nowMs: unknown;
    firstAttemptAtMs: unknown;
    policy?: unknown;
  }): unknown => {
    // Donor read order: item.state, clock anchors, policy fields, cause
    // kind, attempts, id. Cause classifies on kind alone (no error is
    // synthesized here); the output item merges decided fields onto the
    // input spread, preserving extras and the request by reference.
    const item = input.item;
    const state = item.state;
    const nowMs = input.nowMs;
    const firstAttemptAtMs = input.firstAttemptAtMs;
    const policy = policyView(input.policy);
    const kind = (input.cause as { kind: unknown }).kind;
    const attempts = item.attempts;
    const id = item.id;
    const out = driver.run('recovery', 'recordStagingFailure', [{
      item: {
        id: typeof id === 'string' ? id : '',
        operationId: '',
        source: '',
        occurrenceIndex: 0,
        request: opaque(),
        originOccurrence: null,
        attempts,
        state,
      },
      cause: causeKindView(input.cause),
      nowMs,
      firstAttemptAtMs,
      policy,
    }], {}) as {
      item: { attempts: unknown; state: unknown };
      disposition: unknown;
      retryClass: unknown;
      retryable: unknown;
    };
    return {
      item: { ...(item as Record<string, unknown>), attempts: out.item.attempts, state: out.item.state },
      disposition: out.disposition,
      retryClass: out.retryClass,
      retryable: out.retryable,
    };
  }) as typeof recovery.recordStagingFailure;
  recovery.planRecoveryScan = planRecoveryScan as typeof recovery.planRecoveryScan;
  recovery.isFanoutClaimStale = ((claimedAtMs: unknown, nowMs: unknown, maxClaimAgeMs: unknown): unknown =>
    driver.run('recovery', 'isFanoutClaimStale', [claimedAtMs, nowMs, maxClaimAgeMs], {})) as typeof recovery.isFanoutClaimStale;
  recovery.isFanoutChildExhausted = ((attempts: unknown, firstAttemptAtMs: unknown, nowMs: unknown, policy: unknown): unknown =>
    driver.run('recovery', 'isFanoutChildExhausted', [attempts, firstAttemptAtMs, nowMs, policy], {})) as typeof recovery.isFanoutChildExhausted;
  recovery.planFanoutRecoveryScan = ((input: unknown): unknown =>
    driver.run('recovery', 'planFanoutRecoveryScan', [input], {})) as typeof recovery.planFanoutRecoveryScan;
  recovery.assertKnownProgressRelation = ((relation: unknown, caller: unknown): unknown =>
    driver.run('recovery', 'assertKnownProgressRelation', [relation, caller], {})) as typeof recovery.assertKnownProgressRelation;
  recovery.planRelatedProgressResume = ((input: unknown): unknown =>
    driver.run('recovery', 'planRelatedProgressResume', [input], {})) as typeof recovery.planRelatedProgressResume;
  // Supplier-driven batch scans stay host-side (same references as ts).
  return recovery;
}

function wasmLinkage(driver: CallDriver): typeof linkageTs {
  const linkage = { ...linkageTs };
  linkage.assertDispatchJoin = ((batch: unknown): unknown =>
    driver.run('linkage', 'assertDispatchJoin', [batch], {})) as typeof linkage.assertDispatchJoin;
  linkage.assertFanoutChildJoin = ((batch: unknown): unknown =>
    driver.run('linkage', 'assertFanoutChildJoin', [batch], {})) as typeof linkage.assertFanoutChildJoin;
  linkage.assertReceiptJoin = ((batch: unknown): unknown =>
    driver.run('linkage', 'assertReceiptJoin', [batch], {})) as typeof linkage.assertReceiptJoin;
  return linkage;
}

/**
 * The TypeScript backend as a shared facade default. Owner facades select
 * it unless a caller injects another kernel; identity is stable so
 * default-routed calls keep their existing references and behavior.
 */
export const tsWorkKernel: WorkKernel = createWorkKernel({ backend: 'ts' });

/** One synchronous whole kernel; the selected backend is fixed before evaluation. */
export function createWorkKernel(options: WorkKernelOptions): WorkKernel {
  if (options?.backend === 'ts') {
    return {
      rows: rowsTs,
      retry: retryTs,
      every: everyTs,
      lifecycle: lifecycleTs,
      receipt: receiptTs,
      recovery: recoveryTs,
      linkage: linkageTs,
    };
  }
  if (options?.backend !== 'wasm') {
    throw new TypeError('createWorkKernel: explicit ts or wasm backend required');
  }
  if (WebAssembly.Module.imports(options.module).length !== 0) {
    throw nativeFailure('module must not import callbacks or host services');
  }
  const exports = new WebAssembly.Instance(options.module).exports;
  if (!(exports.memory instanceof WebAssembly.Memory)) throw nativeFailure('memory export is missing');
  for (const name of FUNCTIONS) {
    if (typeof exports[`can_work_${name}`] !== 'function') {
      throw nativeFailure(`export can_work_${name} is missing`);
    }
  }
  const abi = exports as unknown as WorkAbi;
  if (word(abi.can_work_abi_version()) !== 1) throw nativeFailure('ABI version is unsupported');
  const driver = createDriver(abi);
  // The accepted dedicated recovery planner stays the planRecoveryScan
  // route; all other recovery calculations use the selected-call ABI. The
  // planner binds to this same initialized instance (one-instance contract),
  // never a second instantiation of the supplied module.
  const planRecoveryScan = createRecoveryPlannerFromExports(
    exports as unknown as Record<string, WebAssembly.ExportValue>,
  ) as (input: never) => unknown;
  return {
    rows: wasmRows(driver),
    retry: wasmRetry(driver),
    every: wasmEvery(driver),
    lifecycle: wasmLifecycle(driver),
    receipt: wasmReceipt(driver),
    recovery: wasmRecovery(driver, planRecoveryScan),
    linkage: wasmLinkage(driver),
  };
}
