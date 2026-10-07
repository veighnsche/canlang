import { describe, expect, it } from 'vitest';
import { ValueError, int64 as producerInt64, datetime as producerDatetime,
  compareInstant as producerCompareInstant } from '@canlang/values';
import { int64, datetime, compareInstant } from '../src/runtime/stdlib.js';

describe('runtime pure producer exports', () => {
  it('retains the exact producer functions', () => {
    expect(int64).toBe(producerInt64);
    expect(datetime).toBe(producerDatetime);
    expect(compareInstant).toBe(producerCompareInstant);
  });
  it('keeps exact int64 boundaries and ValueError identity', () => {
    expect(int64(-(2n ** 63n))).toBe(-(2n ** 63n));
    expect(int64(2n ** 63n - 1n)).toBe(2n ** 63n - 1n);
    for (const [value, code] of [[2n ** 63n, 'overflow'],
      [-(2n ** 63n) - 1n, 'overflow'], [1, 'invalid-construction']] as const) {
      let thrown: unknown;
      try { int64(value as bigint); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(ValueError);
      expect(thrown).toMatchObject({ kind: 'value', code });
    }
  });
  it('compares constructed UTC instants with offset and order semantics', () => {
    const zero = datetime('2026-10-08T00:00:00.000Z');
    const same = datetime('2026-10-08T02:00:00.000+02:00');
    const later = datetime('2026-10-08T00:00:00.001Z');
    expect(zero).toEqual({ kind: 'datetime', ms: 1791417600000n });
    expect(Object.isFrozen(zero)).toBe(true);
    expect(compareInstant(zero, same)).toBe(0);
    expect(compareInstant(zero, later)).toBe(-1);
    expect(compareInstant(later, zero)).toBe(1);
  });
  it('preserves invalid temporal input failures', () => {
    for (const run of [
      () => datetime('2026-10-08T00:00:00.0001Z'),
      () => datetime('2026-02-30T00:00:00Z'),
      () => compareInstant('2026-10-08T00:00:00Z' as never,
        datetime('2026-10-08T00:00:00Z')),
    ]) {
      let thrown: unknown;
      try { run(); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(ValueError);
      expect(thrown).toMatchObject({ kind: 'value', code: 'invalid-construction' });
    }
  });
});
