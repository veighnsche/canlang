import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { ValueError, int64 as producerInt64, datetime as producerDatetime,
  compareInstant as producerCompareInstant } from '@canlang/values';
import type { StoragePort } from '@canlang/contracts';
import { createContext } from '../src/runtime/context.js';
import { app_url, int64, datetime, compareInstant } from '../src/runtime/stdlib.js';

describe('runtime pure producer exports', () => {
  it('exports ordered frozen concat through the actual installed named import', async () => {
    const nativeImport = compileFunction('return import(url)', ['url'], {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }) as (url: string) => Promise<typeof import('@canlang/values')>;
    const require = createRequire(import.meta.url);
    const facadeUrl = pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
    const source = `import { concat } from ${JSON.stringify(facadeUrl)}; export { concat };`;
    const facade = await nativeImport(`data:text/javascript,${encodeURIComponent(source)}`);
    const values = await nativeImport(pathToFileURL(require.resolve('@canlang/values')).href);
    const stdlib = await nativeImport(pathToFileURL(require.resolve('@canlang/stdlib')).href);
    expect(facade.concat).toBe(values.concat);
    expect(facade.concat).toBe(stdlib.concat);
    const left = [2n, 1n];
    const right = [2n];
    const result = facade.concat(left, right);
    expect(result).toEqual([2n, 1n, 2n]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(left).toEqual([2n, 1n]);
    expect(right).toEqual([2n]);
    expect(facade.concat([], [])).toEqual([]);
    for (const run of [
      () => facade.concat(1n as unknown as readonly bigint[], []),
      () => facade.concat([], null as unknown as readonly bigint[]),
    ]) {
      let thrown: unknown;
      try { run(); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(values.ValueError);
      expect(thrown).toMatchObject({ kind: 'value', code: 'invalid-construction' });
    }
  });

  it('exports strict choose through the actual installed named import', async () => {
    const nativeImport = compileFunction('return import(url)', ['url'], {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }) as (url: string) => Promise<typeof import('@canlang/values')>;
    const require = createRequire(import.meta.url);
    const facadeUrl = pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
    const source = `import { choose } from ${JSON.stringify(facadeUrl)}; export { choose };`;
    const facade = await nativeImport(`data:text/javascript,${encodeURIComponent(source)}`);
    const values = await nativeImport(pathToFileURL(require.resolve('@canlang/values')).href);
    expect(facade.choose).toBe(values.choose);
    const yes: Readonly<{ value: string }> = Object.freeze({ value: 'yes' });
    const no: Readonly<{ value: string }> = Object.freeze({ value: 'no' });
    expect(facade.choose(true, yes, no)).toBe(yes);
    expect(facade.choose(false, yes, no)).toBe(no);
    expect(facade.choose<unknown>(true, null, yes)).toBe(null);
    for (const condition of [undefined, null, 0, 1, '', 'false', [], {}]) {
      let thrown: unknown;
      try { facade.choose(condition as boolean, yes, no); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(values.ValueError);
      expect(thrown).toMatchObject({ kind: 'value', code: 'invalid-construction' });
    }
  });
  it('constructs app URLs only from the explicit host context', () => {
    const deps = { caller: { userId: 'u1', roles: [] }, store: {} as StoragePort };
    const c = createContext({ ...deps, deploymentBase: 'https://app.example/tenant/' });
    expect(c.deploymentBase).toBe('https://app.example/tenant/');
    expect(app_url(c, '/reports/7?view=summary#total'))
      .toBe('https://app.example/tenant/reports/7?view=summary#total');
    expect(app_url({ deploymentBase: 'http://localhost:3000/preview' }, '/'))
      .toBe('http://localhost:3000/preview/');

    const missing = createContext(deps);
    expect(Object.hasOwn(missing, 'deploymentBase')).toBe(false);
    for (const run of [
      () => app_url(missing, '/reports'),
      () => app_url({ deploymentBase: '' }, '/reports'),
      () => app_url(c, '//other.example/reports'),
      () => app_url(c, '/%2e%2e/reports'),
      () => app_url({ deploymentBase: 'https://user@app.example/tenant' }, '/reports'),
      () => app_url({ deploymentBase: 'https://app.example/tenant?redirect=other' }, '/reports'),
    ]) {
      let thrown: unknown;
      try { run(); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(ValueError);
      expect(thrown).toMatchObject({ kind: 'value', code: 'invalid-construction' });
    }
  });
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
