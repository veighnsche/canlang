// Full-family TS=Wasm differential over frozen independent originals.
//
// Oracle inputs: packages/work-kernel/conformance/fixtures/{rows,receipts,
// policy}/*.json captured from the live donors. Every case whose fn is in
// the selected-call exposure set runs through BOTH the TS kernel facade and
// the Wasm kernel facade with identical argv; ok-values must agree exactly
// (bit-exact numbers, UTF-16 strings, null/presence identity), faults must
// agree on name/message/code/scope (URIError by name only: engine-variable
// text), RNG samples must fire 0-or-1 times on the same paths, recurrence
// ids must mint in the same order, and host-reference passthroughs
// (toReceiptObservation result/error, spread-request aliasing, dead-letter
// input refs) must hold on both sides.
//
// Skipped cases keep their reason: supplier-driven batch scans
// (scan/drain), the dedicated planRecoveryScan route, and exotic channels
// ($fn/$sym/$bigint/$ref) outside the closed-data profile stay TS-proven
// in the family suites; the wasm profile refuses them loudly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkKernel } from '../src/index.js';
import type { WorkKernel } from '../src/index.js';
import { distribution } from '../src/distribution.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Fixtures ship with sources; the dist fixtures root only carries the
// numeric-text oracle, so select the root that holds the family corpus.
const FIXDIR = [join(HERE, 'fixtures'), join(HERE, '..', '..', 'conformance', 'fixtures')]
  .find((p) => existsSync(join(p, 'rows'))) ?? join(HERE, 'fixtures');

type FrozenCase = {
  id: string;
  direction?: 'work' | 'state';
  fn: string;
  input: unknown;
  expect: { ok?: unknown; throw?: { name: string; code?: unknown; message: string; scope?: unknown } };
};

/**
 * Fns taking an appended `direction` argument in rows.ts. `withRowData`
 * (work-fixed) and `withFanoutRowData` (state-fixed) take none, even
 * though the family suite threads one through uniformly.
 */
const DIRECTIONED = new Set([
  'checkFanoutIdentitySet', 'fanoutIntentRowId', 'fanoutCheckpointRowId', 'fanoutChildRowId',
  'newFanoutIntentRow', 'newFanoutCheckpointRow', 'nextFanoutCheckpointData', 'newFanoutChildRow',
  'readFanoutIntentRow', 'readFanoutCheckpointRow', 'readFanoutChildRow',
  'fanoutChildPageQuery', 'fanoutChildPageResult',
]);

/** Selected-call exposure set: (leaf, fn) routed through the Wasm ABI. */
const EXPOSED: Record<string, Set<string>> = {
  rows: new Set(['readDispatchRow', 'readOccurrenceRow', 'readScheduleRow', 'scheduleRowScope',
    'readEverySlotRow', 'readSupersessionRow', 'newDispatchRow', 'newOccurrenceRow',
    'newScheduleRow', 'newEverySlotRow', 'newSupersessionRow', 'dispatchByOriginQuery',
    'dispatchByStateQuery', 'scheduleByKeyQuery', 'checkFanoutIdentitySet', 'fanoutIntentRowId',
    'fanoutCheckpointRowId', 'fanoutChildRowId', 'newFanoutIntentRow', 'newFanoutCheckpointRow',
    'nextFanoutCheckpointData', 'newFanoutChildRow', 'readFanoutIntentRow',
    'readFanoutCheckpointRow', 'readFanoutChildRow', 'fanoutChildIdOf', 'fanoutChildPageQuery',
    'fanoutChildPageResult', 'withRowData', 'withFanoutRowData', 'everySlotRowId']),
  retry: new Set(['classifyFailure', 'assertPolicy', 'computeBackoff']),
  every: new Set(['everyScopeKey', 'computeEverySlot', 'admitEveryTick']),
  lifecycle: new Set(['recordOutcome', 'reconcileUncertain']),
  receipt: new Set(['listDeadLetter', 'isConsistentCompletion', 'isStoredReceiptPayload',
    'isTerminalReceiptStatus', 'toReceiptObservation', 'associationRowId', 'readAssociationRow',
    'readReceiptRow', 'newAssociationRow', 'newReceiptRow', 'withAssociationRowData',
    'withReceiptRowData']),
  recovery: new Set(['isClaimStale', 'findStaleClaims', 'releaseStaleClaims', 'buildInventory',
    'buildWorkInventory', 'recordStagingFailure', 'isFanoutClaimStale', 'isFanoutChildExhausted',
    'planFanoutRecoveryScan', 'assertKnownProgressRelation', 'planRelatedProgressResume']),
  linkage: new Set(['assertDispatchJoin', 'assertFanoutChildJoin', 'assertReceiptJoin']),
};

/** Host-side only: supplier closures cannot cross the channel. */
const HOST_SIDE = new Set(['scanDueBatch', 'drainDueScan', 'planRecoveryScan']);

/**
 * Null-for-number inputs outside the typed f64 fact channel (the same
 * exclusion the registered differential documents): the native number
 * channel traps instead of refusing, so these stay TS-proven in the
 * family suites.
 */
const NULL_NUMBER_CASES = new Set(['policy/retry.json/backoff-nan-now']);

function isTag(node: unknown, tag: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === tag;
}

function hasExotic(node: unknown): boolean {
  if (node !== null && typeof node === 'object') {
    if (isTag(node, '$fn') || isTag(node, '$sym') || isTag(node, '$bigint') || isTag(node, '$ref')) return true;
    return Object.values(node).some(hasExotic);
  }
  return false;
}

/** Revive frozen tags to live values; lookup tables record their calls. */
function thaw(node: unknown, calls?: unknown[]): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    if (isTag(node, '$num')) {
      const t = (node as Record<string, unknown>).$num;
      if (t === 'NaN') return NaN;
      if (t === 'Infinity') return Infinity;
      if (t === '-Infinity') return -Infinity;
      if (t === '-0') return -0;
      throw new Error(`bad $num tag: ${JSON.stringify(t)}`);
    }
    if (isTag(node, '$undef')) return undefined;
    if (isTag(node, '$randomSample')) {
      const sample = thaw((node as Record<string, unknown>).$randomSample);
      return { nextUnit: () => { (calls as number[] | undefined)?.push(1); return sample as number; } };
    }
    if (isTag(node, '$resolver')) {
      const table = thaw((node as Record<string, unknown>).$resolver) as Record<string, unknown>;
      return (idOrItem: unknown): unknown => {
        const id = typeof idOrItem === 'string' ? idOrItem : (idOrItem as { id: string }).id;
        (calls as { id: unknown }[] | undefined)?.push({ id });
        return table[id] ?? null;
      };
    }
    const o: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(node)) o[k] = thaw(e, calls);
    return o;
  }
  if (Array.isArray(node)) return node.map((e) => thaw(e, calls));
  return node;
}

function leafOf(kernel: WorkKernel, leaf: string): Record<string, (...args: never[]) => unknown> {
  return (kernel as unknown as Record<string, Record<string, (...args: never[]) => unknown>>)[leaf]!;
}

const nativeModule = new WebAssembly.Module(readFileSync(distribution.recoveryWasm));
const tsKernel = createWorkKernel({ backend: 'ts' });
const wasmKernel = createWorkKernel({ backend: 'wasm', module: nativeModule });

function faultOf(error: unknown): { name: unknown; code: unknown; codePresent: boolean; scope: unknown; scopePresent: boolean; message: unknown } {
  const err = error as { name?: unknown; code?: unknown; scope?: unknown; message?: unknown };
  return {
    name: err?.name,
    code: (err as Record<string, unknown>)?.code,
    codePresent: err !== null && typeof err === 'object' && 'code' in err,
    scope: (err as Record<string, unknown>)?.scope,
    scopePresent: err !== null && typeof err === 'object' && 'scope' in err,
    message: err?.message,
  };
}

describe('work-kernel full-family TS=Wasm differential', () => {
  const files = ['rows', 'receipts', 'policy'].flatMap((dir) =>
    readdirSync(join(FIXDIR, dir)).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)));
  const ran: Record<string, string[]> = {};
  const skipped: { id: string; reason: string }[] = [];
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(FIXDIR, file), 'utf8')) as { cases: FrozenCase[] };
    const leaf = file.startsWith('rows/') ? 'rows'
      : file.startsWith('receipts/linkage') ? 'linkage'
      : file.startsWith('receipts/receipt') ? 'receipt'
      : file.startsWith('receipts/recovery') ? 'recovery'
      : file.startsWith('policy/retry') ? 'retry'
      : file.startsWith('policy/every') ? 'every'
      : file.startsWith('policy/lifecycle') ? 'lifecycle'
      : 'unknown';
    for (const c of fixture.cases) {
      const key = `${file}/${c.id}`;
      if (NULL_NUMBER_CASES.has(key)) {
        skipped.push({ id: `${leaf}/${key}`, reason: 'null-for-number outside typed f64 fact channel (registered exclusion)' });
        continue;
      }
      if (HOST_SIDE.has(c.fn)) {
        skipped.push({ id: `${leaf}/${key}`, reason: `host-side fn ${c.fn}` });
        continue;
      }
      if (!EXPOSED[leaf]?.has(c.fn)) {
        skipped.push({ id: `${leaf}/${key}`, reason: `fn ${c.fn} outside selected-call exposure` });
        continue;
      }
      if (hasExotic(c.input)) {
        skipped.push({ id: `${leaf}/${key}`, reason: 'exotic channel ($fn/$sym/$bigint/$ref) outside closed-data profile' });
        continue;
      }
      it(`${leaf}/${key}`, () => {
        (ran[`${leaf}.${c.fn}`] ??= []).push(c.id);
        // Identical argv shape for both backends; direction appended like
        // the suites. Each side thaws its own argv so callback recorders
        // and object identities stay per-side.
        const buildArgs = (calls: unknown[], deriveCalls: unknown[]) => {
          const args = thaw(c.input, calls) as unknown[];
          if (leaf === 'rows' && DIRECTIONED.has(c.fn)) args.push(c.direction ?? 'work');
          if (c.fn === 'admitEveryTick') {
            args.push((app: string, handler: string, scope: string, owner: string, slot: number) => {
              (deriveCalls as { app: string; handler: string; scope: string; owner: string; slot: number }[]).push({ app, handler, scope, owner, slot });
              return `stub:${app}:${handler}:${scope}:${owner}:${slot}`;
            });
          }
          return args;
        };
        const tsCalls: unknown[] = [];
        const tsDerive: unknown[] = [];
        const wasmCalls: unknown[] = [];
        const wasmDerive: unknown[] = [];
        const tsArgs = buildArgs(tsCalls, tsDerive);
        const wasmArgs = buildArgs(wasmCalls, wasmDerive);
        let tsActual: unknown = null;
        let tsThrew: unknown = null;
        try {
          tsActual = leafOf(tsKernel, leaf)[c.fn]!(...(tsArgs as never[]));
        } catch (error) { tsThrew = error; }
        let wasmActual: unknown = null;
        let wasmThrew: unknown = null;
        try {
          wasmActual = leafOf(wasmKernel, leaf)[c.fn]!(...(wasmArgs as never[]));
        } catch (error) { wasmThrew = error; }
        if (tsThrew !== null || wasmThrew !== null) {
          assert.ok(tsThrew !== null, `${key}: TS must throw where Wasm throws (${(wasmThrew as Error)?.message})`);
          assert.ok(wasmThrew !== null, `${key}: Wasm must throw where TS throws (${(tsThrew as Error)?.message})`);
          const t = faultOf(tsThrew);
          const w = faultOf(wasmThrew);
          assert.equal(w.name, t.name, `${key}: fault name`);
          if (t.name !== 'URIError') assert.equal(w.message, t.message, `${key}: fault message`);
          assert.equal(w.codePresent, t.codePresent, `${key}: fault code presence`);
          if (t.codePresent) assert.deepStrictEqual(w.code, t.code, `${key}: fault code`);
          assert.equal(w.scopePresent, t.scopePresent, `${key}: fault scope presence`);
          if (t.scopePresent) assert.deepStrictEqual(w.scope, t.scope, `${key}: fault scope`);
          // Frozen oracle pins the fault too.
          assert.ok(c.expect.throw !== undefined, `${key}: frozen oracle must pin the throw`);
          assert.equal(t.name, c.expect.throw.name, `${key}: frozen fault name`);
          return;
        }
        assert.deepStrictEqual(wasmActual, tsActual, `${key}: Wasm ok-value must equal TS ok-value`);
        // Demand-order traces: RNG samples and recurrence mints fire on the
        // same paths in the same order with the same values.
        assert.deepStrictEqual(wasmCalls.length, tsCalls.length, `${key}: supplied-callback call count`);
        assert.deepStrictEqual(wasmDerive, tsDerive, `${key}: deriveId call order`);
        // Host-reference passthroughs hold on both sides, against the same
        // argv each side ran with.
        if (c.fn === 'toReceiptObservation') {
          for (const [actual, side, argv] of [[tsActual, 'TS', tsArgs], [wasmActual, 'Wasm', wasmArgs]] as const) {
            const recorded = (argv[2] ?? {}) as { result?: unknown; error?: unknown };
            const out = actual as { result?: unknown; error?: unknown };
            assert.strictEqual(out.result, recorded.result, `${key} ${side} result passes by host reference`);
            assert.strictEqual(out.error, recorded.error, `${key} ${side} error passes by host reference`);
          }
        }
        if (c.fn === 'recordOutcome' || c.fn === 'recordStagingFailure') {
          for (const [actual, side, argv] of [[tsActual, 'TS', tsArgs], [wasmActual, 'Wasm', wasmArgs]] as const) {
            const out = actual as { item: Record<string, unknown> };
            const inputItem = (argv[0] as { item: { request?: unknown } }).item;
            assert.strictEqual(out.item.request, inputItem.request, `${key} ${side} spread keeps request by reference`);
          }
        }
        if (c.fn === 'reconcileUncertain') {
          for (const [actual, side, argv] of [[tsActual, 'TS', tsArgs], [wasmActual, 'Wasm', wasmArgs]] as const) {
            const out = actual as { item: Record<string, unknown>; changed: boolean };
            if (!out.changed) {
              assert.strictEqual(out.item, argv[0], `${key} ${side} untouched path returns the input item`);
            } else {
              assert.strictEqual(out.item.request, (argv[0] as { request?: unknown }).request, `${key} ${side} spread keeps request by reference`);
            }
          }
        }
        if (c.fn === 'listDeadLetter' || c.fn === 'findStaleClaims') {
          const inputs = wasmArgs[0] as unknown[];
          for (const row of wasmActual as unknown[]) {
            assert.ok(inputs.includes(row), `${key} Wasm listing returns input references`);
          }
        }
      });
    }
  }
  it('assertPolicy refusal parity (direct probe, no fixture)', () => {
    (ran['retry.assertPolicy'] ??= []).push('direct-probe');
    for (const kernel of [tsKernel, wasmKernel]) {
      assert.throws(() => kernel.retry.assertPolicy({ maxAttempts: 0, horizonMs: 10 }), /maxAttempts/);
      assert.doesNotThrow(() => kernel.retry.assertPolicy({ maxAttempts: 8, horizonMs: 86_400_000 }));
    }
  });
  it('fanoutCheckpointRowId parity (direct probe, no fixture)', () => {
    (ran['rows.fanoutCheckpointRowId'] ??= []).push('direct-probe');
    for (const direction of ['work', 'state'] as const) {
      assert.equal(
        wasmKernel.rows.fanoutCheckpointRowId('fanout/v1/o/h/model', direction),
        tsKernel.rows.fanoutCheckpointRowId('fanout/v1/o/h/model', direction),
      );
    }
    for (const kernel of [tsKernel, wasmKernel]) {
      assert.throws(() => kernel.rows.fanoutCheckpointRowId('', 'work'), /non-empty/);
    }
  });
  it('assertKnownProgressRelation parity (direct probe, no fixture)', () => {
    (ran['recovery.assertKnownProgressRelation'] ??= []).push('direct-probe');
    for (const kernel of [tsKernel, wasmKernel]) {
      assert.equal(kernel.recovery.assertKnownProgressRelation('std.EmailV1.send', 'probe'), 'std.EmailV1.send');
      assert.throws(() => kernel.recovery.assertKnownProgressRelation('bogus', 'probe'), /unknown progress relation/);
      assert.throws(() => kernel.recovery.assertKnownProgressRelation('', 'probe'), TypeError);
      assert.throws(() => kernel.recovery.assertKnownProgressRelation(null, 'probe'), TypeError);
    }
  });
  it('withReceiptRowData parity (direct probe; frozen case carries $ref)', () => {
    (ran['receipt.withReceiptRowData'] ??= []).push('direct-probe');
    const row = {
      id: 'd1', version: 1, created: 100, updated: 100, createdBy: 't', updatedBy: 't',
      archivedAt: null, parent: null,
      data: { deliveryId: 'd1', revision: 0, status: 'pending', result: null, error: null, contentRef: null, resultExpiresAtMs: null },
    };
    const data = {
      deliveryId: 'd1', revision: 1, status: 'succeeded', result: { ok: true }, error: null,
      contentRef: null, resultExpiresAtMs: null,
    };
    const meta = { nowMs: 200, actor: 't' };
    const tsOut = tsKernel.receipt.withReceiptRowData(structuredClone(row) as never, structuredClone(data) as never, meta);
    const wasmOut = wasmKernel.receipt.withReceiptRowData(structuredClone(row) as never, structuredClone(data) as never, meta);
    assert.deepStrictEqual(wasmOut, tsOut);
  });
  it('every exposed fn ran at least once; skips are classified', () => {
    for (const [leaf, fns] of Object.entries(EXPOSED)) {
      for (const fn of fns) {
        assert.ok((ran[`${leaf}.${fn}`]?.length ?? 0) > 0, `${leaf}.${fn} ran zero cases`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ran: Object.fromEntries(Object.entries(ran).map(([k, v]) => [k, v.length])), skipped }));
  });
  it('ABI refuses misuse visibly: unknown fn, planner route, wrong phase, freed handle', () => {
    const exports = new WebAssembly.Instance(nativeModule).exports as unknown as Record<string, (...args: number[]) => number>;
    const demand = exports.can_work_demand!;
    const create = exports.can_work_create!;
    const free = exports.can_work_free!;
    const errorCode = exports.can_work_error_code!;
    const reqPrepare = exports.can_work_request_prepare!;
    const reqPtr = exports.can_work_request_ptr!;
    const reqLen = exports.can_work_request_len!;
    const reqReply = exports.can_work_request_reply!;
    const numReply = exports.can_work_number_reply!;
    const memory = exports.memory as unknown as WebAssembly.Memory;
    const send = (handle: number, text: string): number => {
      assert.equal(reqPrepare(handle, text.length), 1);
      const view = new Uint16Array(memory.buffer, reqPtr(handle), reqLen(handle));
      for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i);
      return reqReply(handle);
    };
    // Unknown leaf/fn refuses with BAD_REQUEST and never decides.
    {
      const handle = create();
      assert.equal(send(handle, JSON.stringify({ leaf: 'rows', fn: 'nope', args: [] })), 254);
      assert.equal(errorCode(handle), 102);
      assert.equal(free(handle), 1);
    }
    // The accepted planner route stays on its dedicated ABI.
    {
      const handle = create();
      assert.equal(send(handle, JSON.stringify({ leaf: 'recovery', fn: 'planRecoveryScan', args: [] })), 254);
      assert.equal(errorCode(handle), 102);
      assert.equal(free(handle), 1);
    }
    // Wrong-phase replies poison the handle; freed handles stay dead.
    {
      const handle = create();
      assert.equal(numReply(handle, 0.5), 254);
      assert.equal(errorCode(handle), 100);
      assert.equal(free(handle), 1);
      assert.equal(demand(handle), 254);
      assert.equal(free(handle), 0);
    }
  });
});
