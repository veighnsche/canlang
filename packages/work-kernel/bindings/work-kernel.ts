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
import { createRecoveryPlanner } from './recovery-planner.js';

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
// (lone surrogates preserved), objects ride key-ordered entries. Missing
// (`undefined`) reads as null, matching the receipt payload rule; delivered
// `undefined` results therefore normalize to null. Functions, symbols and
// bigints cannot cross and refuse loudly; cyclic graphs refuse loudly (the
// leaf's path-specific cyclic refusal stays TS-proven in the family suites).
function encode(value: unknown, seen?: Set<object>): unknown {
  if (value === undefined) return null;
  if (typeof value === 'number') return { $bits: bits(value) };
  if (typeof value === 'string') return { $u16: units(value) };
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'object') {
    seen ??= new Set();
    if (seen.has(value)) throw profileRefusal('cyclic graphs cannot cross the closed-data channel');
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => encode(entry, seen));
      // Materialized host tables (committedAtMs/contract lookups) cross as
      // key-ordered entries; absent keys stay absent on the native side.
      if (value instanceof Map) {
        return {
          $entries: [...value].map(([key, entry]) => [units(key as string), encode(entry, seen)]),
        };
      }
      return {
        $entries: Object.entries(value).map(([key, entry]) => [units(key), encode(entry, seen)]),
      };
    } finally {
      seen.delete(value);
    }
  }
  throw profileRefusal(`${typeof value} values cannot cross the closed-data channel`);
}

function decodeKey(unitsValue: unknown): string {
  if (!Array.isArray(unitsValue)) throw nativeFailure('returned a malformed key channel');
  return stringFromUnits(unitsValue as number[]);
}

function thaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(thaw);
  if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (typeof node.$bits === 'string') return unbits(node.$bits);
    if (Array.isArray(node.$u16)) return stringFromUnits(node.$u16 as number[]);
    if (Array.isArray(node.$entries)) {
      const out: Record<string, unknown> = {};
      for (const entry of node.$entries as Array<[unknown, unknown]>) {
        out[decodeKey(entry[0])] = thaw(entry[1]);
      }
      return out;
    }
    if ('$undefined' in node) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) out[key] = thaw(entry);
    return out;
  }
  return value;
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
  rows.readOccurrenceRow = ((row: unknown, errors?: RowsErrorFactory): unknown =>
    call('readOccurrenceRow', [row], errors)) as typeof rows.readOccurrenceRow;
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
  rows.withRowData = ((row: unknown, data: unknown, meta: unknown, what: unknown, errors?: RowsErrorFactory): unknown =>
    call('withRowData', [row, data, meta, what], errors)) as typeof rows.withRowData;
  rows.withFanoutRowData = ((row: unknown, data: unknown, meta: unknown, errors?: RowsErrorFactory): unknown =>
    call('withFanoutRowData', [row, data, meta], errors)) as typeof rows.withFanoutRowData;
  return rows;
}

function wasmRetry(driver: CallDriver): typeof retryTs {
  const retry = { ...retryTs };
  retry.classifyFailure = ((cause: unknown): unknown =>
    driver.run('retry', 'classifyFailure', [cause], {})) as typeof retry.classifyFailure;
  retry.assertPolicy = ((policy: unknown): unknown =>
    driver.run('retry', 'assertPolicy', [policy], {})) as typeof retry.assertPolicy;
  retry.computeBackoff = ((input: { attempt: number; firstAttemptAtMs: number; nowMs: number; policy?: unknown; random: RandomPort }): unknown =>
    driver.run('retry', 'computeBackoff', [{
      attempt: input.attempt,
      firstAttemptAtMs: input.firstAttemptAtMs,
      nowMs: input.nowMs,
      policy: input.policy,
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
    item: { request: unknown };
    outcome: { kind: string; result?: unknown };
  }): unknown => {
    const out = driver.run('lifecycle', 'recordOutcome', [input], {}) as {
      item: Record<string, unknown>; result: unknown;
    };
    // The spread item keeps the caller-owned request by reference; a
    // delivered result passes through by reference. Decoded scalars match.
    out.item = { ...out.item, request: input.item.request };
    if (input.outcome.kind === 'delivered') out.result = input.outcome.result;
    return out;
  }) as typeof lifecycle.recordOutcome;
  lifecycle.reconcileUncertain = ((item: { request: unknown }, evidence: { kind: string; result?: unknown } | null): unknown => {
    const out = driver.run('lifecycle', 'reconcileUncertain', [item, evidence], {}) as {
      item: Record<string, unknown>; changed: boolean; result: unknown;
    };
    // Untouched paths return the input item itself; spreads keep the
    // caller-owned request; delivered evidence passes through by reference.
    if (!out.changed) out.item = item as Record<string, unknown>;
    else out.item = { ...out.item, request: item.request };
    if (out.changed && evidence?.kind === 'delivered') out.result = evidence.result;
    return out;
  }) as typeof lifecycle.reconcileUncertain;
  return lifecycle;
}

function wasmReceipt(driver: CallDriver): typeof receiptTs {
  const receipt = { ...receiptTs };
  receipt.listDeadLetter = ((items: readonly { id: string }[]): unknown => {
    const out = driver.run('receipt', 'listDeadLetter', [items], {}) as { id: string }[];
    // Reference restoration only: the native order and membership decide;
    // every returned id must resolve to an input reference of this call.
    const byId = new Map(items.map((item) => [item.id, item]));
    return out.map((row) => {
      const original = byId.get(row.id);
      if (original === undefined) throw nativeFailure('returned a dead-letter row outside this call');
      return original;
    });
  }) as typeof receipt.listDeadLetter;
  receipt.isConsistentCompletion = ((status: unknown, result: unknown, error: unknown): unknown =>
    driver.run('receipt', 'isConsistentCompletion', [status, result, error], {})) as typeof receipt.isConsistentCompletion;
  receipt.isStoredReceiptPayload = ((status: unknown, result: unknown, error: unknown): unknown =>
    driver.run('receipt', 'isStoredReceiptPayload', [status, result, error], {})) as typeof receipt.isStoredReceiptPayload;
  receipt.isTerminalReceiptStatus = ((status: unknown): unknown =>
    driver.run('receipt', 'isTerminalReceiptStatus', [status], {})) as typeof receipt.isTerminalReceiptStatus;
  receipt.toReceiptObservation = ((deliveryId: string, revision: number, recorded: { status: unknown; result: unknown; error: unknown }): unknown => {
    // Validated natively; result and error pass through by host reference —
    // the kernel never mints them.
    driver.run('receipt', 'toReceiptObservation', [deliveryId, revision, recorded], {});
    return { id: deliveryId, revision, status: recorded.status, result: recorded.result, error: recorded.error };
  }) as typeof receipt.toReceiptObservation;
  receipt.associationRowId = ((model: unknown, recordId: unknown, field: unknown): unknown =>
    driver.run('receipt', 'associationRowId', [model, recordId, field], {})) as typeof receipt.associationRowId;
  receipt.readAssociationRow = ((row: unknown): unknown =>
    driver.run('receipt', 'readAssociationRow', [row], {})) as typeof receipt.readAssociationRow;
  receipt.readReceiptRow = ((row: unknown): unknown =>
    driver.run('receipt', 'readReceiptRow', [row], {})) as typeof receipt.readReceiptRow;
  receipt.newAssociationRow = ((input: unknown, meta: unknown): unknown =>
    driver.run('receipt', 'newAssociationRow', [input, meta], {})) as typeof receipt.newAssociationRow;
  receipt.newReceiptRow = ((input: unknown, meta: unknown): unknown =>
    driver.run('receipt', 'newReceiptRow', [input, meta], {})) as typeof receipt.newReceiptRow;
  receipt.withAssociationRowData = ((row: unknown, data: unknown, meta: unknown): unknown =>
    driver.run('receipt', 'withAssociationRowData', [row, data, meta], {})) as typeof receipt.withAssociationRowData;
  receipt.withReceiptRowData = ((row: unknown, data: unknown, meta: unknown): unknown =>
    driver.run('receipt', 'withReceiptRowData', [row, data, meta], {})) as typeof receipt.withReceiptRowData;
  return receipt;
}

function wasmRecovery(driver: CallDriver, planRecoveryScan: (input: never) => unknown): typeof recoveryTs {
  const recovery = { ...recoveryTs };
  recovery.isClaimStale = ((claim: unknown, nowMs: unknown, maxClaimAgeMs: unknown): unknown =>
    driver.run('recovery', 'isClaimStale', [claim, nowMs, maxClaimAgeMs], {})) as typeof recovery.isClaimStale;
  recovery.findStaleClaims = ((claims: readonly { claimId: string }[], nowMs: unknown, maxClaimAgeMs: unknown): unknown => {
    const out = driver.run('recovery', 'findStaleClaims', [claims, nowMs, maxClaimAgeMs], {}) as { claimId: string }[];
    // Reference restoration only: the native order and membership decide.
    const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
    return out.map((row) => {
      const original = byId.get(row.claimId);
      if (original === undefined) throw nativeFailure('returned a stale claim outside this call');
      return original;
    });
  }) as typeof recovery.findStaleClaims;
  recovery.releaseStaleClaims = ((outboxItems: readonly { id: string }[], claims: unknown, nowMs: unknown, maxClaimAgeMs: unknown): unknown => {
    const out = driver.run('recovery', 'releaseStaleClaims', [outboxItems, claims, nowMs, maxClaimAgeMs], {}) as {
      items: Record<string, unknown>[]; releasedIds: string[];
    };
    // Input order is preserved: zip decoded rows back to input references;
    // released rows are shallow spreads, exactly like the donor.
    if (out.items.length !== outboxItems.length) throw nativeFailure('returned a release set outside this call');
    const released = new Set(out.releasedIds);
    return {
      items: out.items.map((row, index) => {
        const original = outboxItems[index] as Record<string, unknown>;
        if (original?.['id'] !== row['id']) throw nativeFailure('returned a release row outside this call');
        return released.has(row['id'] as string) ? { ...original, state: 'pending' } : original;
      }),
      releasedIds: out.releasedIds,
    };
  }) as typeof recovery.releaseStaleClaims;
  recovery.buildInventory = ((input: recoveryTs.InventoryInput): unknown => {
    // Materialize the commit lookup at the original demand: once per
    // uncertain item, in iteration order, exactly like the donor.
    const committedAt = new Map<string, number | null>();
    for (const item of input.outboxItems) {
      if (item.state === 'uncertain') committedAt.set(item.id, input.committedAtMs(item.id));
    }
    return driver.run('recovery', 'buildInventory', [{
      outboxItems: input.outboxItems,
      dueOccurrences: input.dueOccurrences,
      committedAt,
    }], {});
  }) as typeof recovery.buildInventory;
  recovery.buildWorkInventory = ((input: recoveryTs.WorkInventoryInput): unknown => {
    // Materialize the contract lookup at the original demand: once per
    // non-settled item, in iteration order; settled items never consult it.
    const contracts = new Map<string, string | null>();
    for (const item of input.outboxItems) {
      if (item.state === 'delivered' || item.state === 'failed' || item.state === 'dead') continue;
      contracts.set(item.id, input.handlerContractFor(item));
    }
    return driver.run('recovery', 'buildWorkInventory', [{
      outboxItems: input.outboxItems,
      contracts,
    }], {});
  }) as typeof recovery.buildWorkInventory;
  recovery.recordStagingFailure = ((input: { item: { request: unknown } }): unknown => {
    const out = driver.run('recovery', 'recordStagingFailure', [input], {}) as {
      item: Record<string, unknown>;
    };
    // The spread item keeps the caller-owned request by reference.
    out.item = { ...out.item, request: input.item.request };
    return out;
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
  // route; all other recovery calculations use the selected-call ABI.
  const planRecoveryScan = createRecoveryPlanner(options) as (input: never) => unknown;
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
