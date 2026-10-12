import { describe, expect, it } from 'vitest';
import type { RowQueryRunner } from '@canlang/contracts';
import * as ui from '@canlang/ui';
import { bindNativeUiWhere, forwardNativeUiQueryBinder, registerNativeUiQueryBinder,
  wrapNativeUiQueryFactory, nativeUiQueryFactoryNames, nativeUiQueryFacadeSource } from '../src/runtime/native-ui-query.js';

describe('private native UI query binding', () => {
  it('binds original factory function before UI drops metadata and forwards the same function', async () => {
    const order: string[] = [];
    const where = (_row: unknown, _context: unknown) => true;
    const whereSource = { source: { path: 'page.can' }, owner: 'app' };
    const query: RowQueryRunner = async (_identity, _model, args) => {
      order.push('query'); expect(args.where).toBe(where);
      expect(Object.hasOwn(args, 'whereSource')).toBe(false);
      return { rows: [], columns: [] };
    };
    registerNativeUiQueryBinder(query, async (actual, source) => {
      order.push('bind'); expect(actual).toBe(where); expect(source).toBe(whereSource);
    });
    const props = { context: { query }, where, whereSource };
    const original = async (received: typeof props) => {
      order.push('factory'); expect(received).toBe(props);
      await received.context.query(null, 'Item', { where: received.where });
      return 'html';
    };
    expect(await wrapNativeUiQueryFactory(original)(props)).toBe('html');
    expect(order).toEqual(['bind', 'factory', 'query']);
  });

  it('forwards binding to the selected actual owner query before delegating', async () => {
    const where = () => true, source = {}, identity = {};
    const order: string[] = [];
    const actual: RowQueryRunner = async invocation => {
      expect(invocation).toBe(identity); order.push('read'); return { rows: [], columns: [] };
    };
    registerNativeUiQueryBinder(actual, (predicate, marker) => {
      expect(predicate).toBe(where); expect(marker).toBe(source); order.push('selected-bind');
    });
    const selected = async () => { order.push('resolve-owner'); return actual; };
    const outer: RowQueryRunner = async (_invocation, model, args) => (await selected())(identity, model, args);
    forwardNativeUiQueryBinder(outer, selected);
    await bindNativeUiWhere(outer, where, source);
    await outer(null, 'Item', { where });
    expect(order).toEqual(['resolve-owner', 'selected-bind', 'resolve-owner', 'read']);
  });

  it('refuses copied markers without the canonical query and prevents rebinding', async () => {
    let delegated = false;
    const query: RowQueryRunner = async () => ({ rows: [], columns: [] });
    const wrapped = wrapNativeUiQueryFactory(async (_props: unknown) => { delegated = true; });
    await expect(wrapped({ context: { query }, where: () => true, whereSource: {} }))
      .rejects.toThrow('original canonical query scope');
    expect(delegated).toBe(false);
    registerNativeUiQueryBinder(query, () => { throw new Error('census refused'); });
    await expect(wrapped({ context: { query }, where: () => true, whereSource: {} }))
      .rejects.toThrow('census refused');
    expect(delegated).toBe(false);
    expect(() => registerNativeUiQueryBinder(query, () => {})).toThrow('cannot be rebound');
  });

  it('keeps ordinary factory props and behavior without a native carrier', async () => {
    const props = { where: { op: 'eq' }, context: {} };
    expect(await wrapNativeUiQueryFactory(async (input: typeof props) => input)(props)).toBe(props);
  });

  it('binds an original function without sibling metadata before delegation', async () => {
    const where = (_row: unknown, _context: unknown) => true;
    const query: RowQueryRunner = async () => ({ rows: [], columns: [] });
    const order: string[] = [];
    registerNativeUiQueryBinder(query, (actual, source) => {
      expect(actual).toBe(where); expect(source).toBeUndefined(); order.push('bind');
    });
    const props = { where, context: { query } };
    expect(await wrapNativeUiQueryFactory(async (original: typeof props) => {
      order.push('factory'); expect(original).toBe(props); return original.where;
    })(props)).toBe(where);
    expect(order).toEqual(['bind', 'factory']);
  });

  it('retains generic function props and this when no canonical binder is installed', async () => {
    const props = { where: () => true, context: { query: async () => ({ rows: [], columns: [] }) } };
    const receiver = {};
    const original = async function (this: unknown, actual: typeof props) {
      expect(this).toBe(receiver); expect(actual).toBe(props); return actual.where;
    };
    expect(await wrapNativeUiQueryFactory(original).call(receiver, props)).toBe(props.where);
  });

  it('covers every actual catalog query collection export and leaves other UI exports direct', () => {
    const names = nativeUiQueryFactoryNames(ui);
    expect(names).toEqual(ui.UI_CATALOG.entries.filter(entry => entry.availability === 'implemented' &&
      entry.profile === 'collection' && entry.header === 'query').map(entry => entry.js));
    expect(names).toEqual(['list', 'table', 'board', 'calendar']);
    const source = nativeUiQueryFacadeSource(ui, './original-ui.js', './native-ui-query.js');
    expect(source).toContain('export * from "./original-ui.js";');
    for (const name of names) expect(source).toContain(`export const ${name}=$can$wrap($can$ui.${name});`);
    expect(source).not.toContain('export const renderPage=');
    expect(source).not.toContain('export const carousel=');
  });

});
