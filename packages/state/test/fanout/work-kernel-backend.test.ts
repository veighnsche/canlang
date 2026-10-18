/** State fanout tables route the selected kernel: default and Wasm agree. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkKernel } from '@canlang/work-kernel';
import { distribution } from '@canlang/work-kernel/distribution';
import { StateError } from '../../src/errors.js';
import {
  checkFanoutIdentitySet, fanoutChildPageResult, fanoutIntentRowId,
  newFanoutChildRow, newFanoutIntentRow, nextFanoutCheckpointData,
  readFanoutChildRow, readFanoutIntentRow,
} from '../../src/fanout/tables.js';

const wasmKernel = createWorkKernel({
  backend: 'wasm',
  module: new WebAssembly.Module(readFileSync(distribution.recoveryWasm)),
});
const meta = { nowMs: 1_700_000_000_000, actor: 'kernel-join' };

describe('state fanout tables: selected kernel parity', () => {
  it('intent roundtrip and ids agree', () => {
    const input = { sourceOccurrence: 'o1', handler: 'h', cohort: 'model', members: ['r1'] };
    const tsRow = newFanoutIntentRow(input as never, meta);
    const wasmRow = newFanoutIntentRow(input as never, meta, wasmKernel);
    assert.deepStrictEqual(wasmRow, tsRow);
    assert.deepStrictEqual(readFanoutIntentRow(wasmRow, wasmKernel), readFanoutIntentRow(tsRow));
    assert.equal(
      fanoutIntentRowId('o1', 'h', 'model', wasmKernel),
      fanoutIntentRowId('o1', 'h', 'model'),
    );
  });

  it('checkpoint advance and child rows agree', () => {
    const current = { fanoutId: 'fanout/v1/o1/h/model', completed: ['r1'], cursor: null };
    assert.deepStrictEqual(
      nextFanoutCheckpointData(current as never, ['r2'], null, wasmKernel),
      nextFanoutCheckpointData(current as never, ['r2'], null),
    );
    const child = {
      fanoutId: 'fanout/v1/o1/h/model', parentOccurrence: 'o1', handler: 'h', recordId: 'r1',
    };
    const tsChild = newFanoutChildRow(child as never, meta);
    const wasmChild = newFanoutChildRow(child as never, meta, wasmKernel);
    assert.deepStrictEqual(wasmChild, tsChild);
    assert.deepStrictEqual(readFanoutChildRow(wasmChild, wasmKernel), readFanoutChildRow(tsChild));
    assert.deepStrictEqual(
      fanoutChildPageResult([wasmChild], 10, wasmKernel),
      fanoutChildPageResult([tsChild], 10),
    );
  });

  it('faults keep the owning StateError through the Wasm backend', () => {
    for (const kernel of [undefined, wasmKernel] as const) {
      try {
        readFanoutIntentRow({ id: 'x', version: 1, created: 1, updated: 1, createdBy: 't', updatedBy: 't', archivedAt: null, parent: null, data: { nope: 1 } } as never, kernel as never);
        assert.fail('must throw');
      } catch (error) {
        assert.ok(error instanceof StateError, `StateError kept (${kernel === undefined ? 'ts' : 'wasm'})`);
        assert.equal((error as StateError).code, 'validation');
      }
    }
    const tsFault = (() => {
      try { checkFanoutIdentitySet(['a', 'a'], 'members'); } catch (error) { return error as Error; }
      throw new Error('must throw');
    })();
    const wasmFault = (() => {
      try { checkFanoutIdentitySet(['a', 'a'], 'members', wasmKernel); } catch (error) { return error as Error; }
      throw new Error('must throw');
    })();
    assert.ok(wasmFault instanceof StateError);
    assert.equal(wasmFault.message, tsFault.message);
  });
});
