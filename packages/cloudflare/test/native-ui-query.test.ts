import { describe, expect, it } from 'vitest';
import type { RowQueryRunner, RowView } from '@canlang/contracts';
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

  it('keeps the original wire row and lazily supplies native source fields as the private third argument', async () => {
    const trace: string[] = [], wire: RowView = { id: 'one', version: '7', fields: { count: '9007199254740993' } };
    const childContext = {}, factoryReceiver = {}, extra = {};
    const query: RowQueryRunner = async () => { trace.push('query'); return { rows: [wire], columns: [] }; };
    const native = Object.freeze({ id: wire.id, version: 7n, get count() {
      trace.push('count'); return BigInt(wire.fields.count as string);
    }, get unused() { throw new Error('unused native field read'); } });
    registerNativeUiQueryBinder(query, () => { trace.push('bind'); }, async actual => {
      expect(actual).toBe(wire); trace.push('decode'); await Promise.resolve(); return native;
    });
    let getterReads = 0;
    const renderRow = async function (this: unknown, actual: RowView, view: unknown, source?: Readonly<Record<string, unknown>>) {
      trace.push('render'); expect(this).toBe(props); expect(actual).toBe(wire); expect(view).toBe(childContext);
      expect(actual.fields.count).toBe('9007199254740993'); expect(source).toBe(native);
      expect(source?.id).toBe(wire.id); expect(source?.version).toBe(7n);
      expect(trace).not.toContain('count');
      return () => { expect(source?.count).toBe(9007199254740993n); expect(source?.count).toBe(9007199254740993n); return 'children'; };
    };
    const props = Object.freeze({ context: { query }, where: () => true, renderRow, get unrelated() {
      expect(this).toBe(props); getterReads++; return extra;
    } });
    const factory = async function (this: unknown, received: typeof props, tail: unknown) {
      trace.push('factory'); expect(this).toBe(factoryReceiver); expect(tail).toBe(extra);
      expect(getterReads).toBe(0); expect(received.unrelated).toBe(extra); expect(getterReads).toBe(1);
      expect(Object.isFrozen(received)).toBe(true); expect(received.context).toBe(props.context);
      const result = await received.context.query(null, 'Item', {});
      const deferred = await received.renderRow(result.rows[0]!, childContext);
      expect(trace).not.toContain('count'); return deferred();
    };
    expect(await wrapNativeUiQueryFactory(factory).call(factoryReceiver, props, extra)).toBe('children');
    expect(trace).toEqual(['bind', 'factory', 'query', 'decode', 'render', 'count', 'count']);
    expect(props.renderRow).toBe(renderRow); expect(wire.fields.count).toBe('9007199254740993');
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it('decodes through the selected physical query and preserves an explicitly supplied callback receiver', async () => {
    const row: RowView = { id: 'selected', version: '2', fields: { active: true } }, native = { id: 'selected', version: 2n, active: true };
    const order: string[] = [], callbackReceiver = {}, context = {};
    const actual: RowQueryRunner = async () => { order.push('query'); return { rows: [row], columns: [] }; };
    registerNativeUiQueryBinder(actual, () => {}, async original => {
      order.push('decode'); expect(original).toBe(row); return native;
    });
    const selected = async () => { order.push('select'); return actual; };
    const outer: RowQueryRunner = async (invocation, model, args) => (await selected())(invocation, model, args);
    forwardNativeUiQueryBinder(outer, selected);
    const renderRow = function (this: unknown, original: RowView, child: unknown, source?: Readonly<Record<string, unknown>>) {
      order.push('render'); expect(this).toBe(callbackReceiver); expect(original).toBe(row); expect(child).toBe(context);
      expect(source).toBe(native); return 'child';
    };
    const props = { context: { query: outer }, renderRow };
    const factory = async (received: typeof props) => {
      const result = await received.context.query(null, 'Item', {});
      return received.renderRow.call(callbackReceiver, result.rows[0]!, context);
    };
    expect(await wrapNativeUiQueryFactory(factory)(props)).toBe('child');
    expect(order).toEqual(['select', 'query', 'select', 'decode', 'render']);
  });

  it('refuses an unregistered selected decoder and propagates closed or foreign-row refusal before the callback', async () => {
    const wire: RowView = { id: 'one', fields: {} };
    const unregistered: RowQueryRunner = async () => ({ rows: [wire], columns: [] });
    const outer: RowQueryRunner = async () => ({ rows: [wire], columns: [] });
    forwardNativeUiQueryBinder(outer, async () => unregistered);
    let calls = 0;
    const factory = async (props: { context: { query: RowQueryRunner }; renderRow: (row: RowView, child: unknown) => unknown }) =>
      props.renderRow(wire, {});
    const renderRow = () => { calls++; return 'child'; };
    await expect(wrapNativeUiQueryFactory(factory)({ context: { query: outer }, renderRow }))
      .rejects.toThrow('original canonical query decoder');
    const owned: RowQueryRunner = async () => ({ rows: [wire], columns: [] });
    const denial = new Error('scope no longer owns this exact row');
    registerNativeUiQueryBinder(owned, () => {}, () => { throw denial; });
    await expect(wrapNativeUiQueryFactory(factory)({ context: { query: owned }, renderRow })).rejects.toBe(denial);
    let getterReads = 0;
    const accessor = { context: { query: owned }, get renderRow() { getterReads++; return renderRow; } };
    await expect(wrapNativeUiQueryFactory(factory)(accessor)).rejects.toThrow('original own-data renderRow');
    expect(getterReads).toBe(0); expect(calls).toBe(0);
  });

  it('retains the generic two-argument callback and original props when no source decoder is registered', async () => {
    const wire: RowView = { id: 'generic', fields: {} }, child = {};
    const query: RowQueryRunner = async () => ({ rows: [wire], columns: [] });
    registerNativeUiQueryBinder(query, () => {});
    const renderRow = function (this: unknown, row: RowView, context: unknown, native?: unknown) {
      expect(this).toBe(props); expect(row).toBe(wire); expect(context).toBe(child); expect(native).toBeUndefined(); return 'generic';
    };
    const props = { context: { query }, renderRow };
    expect(await wrapNativeUiQueryFactory(async (received: typeof props) => {
      expect(received).toBe(props); return received.renderRow(wire, child);
    })(props)).toBe('generic');
  });

  it('covers every actual catalog query collection export and leaves other UI exports direct', () => {
    const names = nativeUiQueryFactoryNames(ui);
    expect(names).toEqual(ui.UI_CATALOG.entries.filter(entry => entry.availability === 'implemented' &&
      entry.profile === 'collection' && entry.header === 'query').map(entry => entry.js));
    expect(names).toEqual(['list', 'gallery', 'table', 'board', 'calendar']);
    const source = nativeUiQueryFacadeSource(ui, './original-ui.js', './native-ui-query.js');
    expect(source).toContain('export * from "./original-ui.js";');
    for (const name of names) expect(source).toContain(`export const ${name}=$can$wrap($can$ui.${name});`);
    expect(source).not.toContain('export const renderPage=');
    expect(source).not.toContain('export const carousel=');
  });

});
