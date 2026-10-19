/** Standard-library façade driven through the real producer: the canonical date builtins behind `@canlang/stdlib`. */
import { describe, expect, it } from 'vitest';
import { abs, add_days, date } from '@canlang/stdlib';

describe('stdlib date builtins', () => {
  it('constructs strict civil dates and rejects malformed text', () => {
    expect(date('2026-01-15')).toEqual(add_days(date('2026-01-05'), 10n));
    expect(() => date('not-a-date')).toThrow(/invalid date text/);
    expect(() => date('0000-01-01')).toThrow(/outside 0001-9999/);
    expect(() => date('2026-02-30')).toThrow(/invalid civil date/);
  });

  it('adds days across month boundaries', () => {
    expect(add_days(date('2026-01-31'), 1n)).toEqual(date('2026-02-01'));
    expect(add_days(date('2026-03-01'), -1n)).toEqual(date('2026-02-28'));
  });
});

describe('stdlib numeric builtins', () => {
  it('takes absolute values without changing kin', () => {
    expect(abs(-5n)).toBe(5n);
    expect(abs(5n)).toBe(5n);
  });
});
