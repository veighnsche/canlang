/** Private native UI correspondence bridge. The canonical reader checks the
 * complete source census and binds State; metadata alone grants nothing. */
import type { RowQueryRunner, RowView } from '@canlang/contracts';
import { AssemblyCorrespondenceError } from './assembly-verification.js';

export type NativeUiWhereBinder = (where: Function, whereSource?: unknown) => void | Promise<void>;
export type NativeUiSourceRowDecoder = (row: RowView) =>
  Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
const binders = new WeakMap<RowQueryRunner, {
  where: NativeUiWhereBinder;
  sourceRow?: NativeUiSourceRowDecoder;
}>();

/** Trusted scope producer only; retain the actual request/physical-owner query. */
export function registerNativeUiQueryBinder(query: RowQueryRunner, binder: NativeUiWhereBinder,
  sourceRow?: NativeUiSourceRowDecoder): void {
  if (binders.has(query)) throw new AssemblyCorrespondenceError('Native UI query cannot be rebound.');
  binders.set(query, { where: binder, ...(sourceRow === undefined ? {} : { sourceRow }) });
}

/** Selected-owner scope resolves its original query before any UI delegation. */
export function forwardNativeUiQueryBinder(
  query: RowQueryRunner, selectedQuery: () => Promise<RowQueryRunner>,
): void {
  registerNativeUiQueryBinder(query, async (where, whereSource) => {
    await bindNativeUiWhere(await selectedQuery(), where, whereSource);
  }, async row => {
    const decoder = binders.get(await selectedQuery())?.sourceRow;
    if (decoder === undefined) {
      throw new AssemblyCorrespondenceError('Native UI source row requires its original canonical query decoder.');
    }
    return decoder(row);
  });
}

export async function bindNativeUiWhere(query: RowQueryRunner, where: Function, whereSource?: unknown): Promise<void> {
  const bind = binders.get(query)?.where;
  if (bind === undefined) throw new AssemblyCorrespondenceError('Native UI where requires its original canonical query scope.');
  await bind(where, whereSource);
}

/** Capture the original callable even when lower_ui_expr emitted no sibling
 * metadata. The registered canonical scope consults its verified original getter;
 * public props never decide whether the callable is a native source predicate. */
interface FactoryQueryParts {
  hasSource: boolean;
  source: PropertyDescriptor | undefined;
  where: PropertyDescriptor | undefined;
  context: PropertyDescriptor | undefined;
  actualQuery: RowQueryRunner | undefined;
}

function resolveFactoryQuery(props: object): FactoryQueryParts {
  const hasSource = Object.hasOwn(props, 'whereSource');
  const source = Object.getOwnPropertyDescriptor(props, 'whereSource');
  const where = Object.getOwnPropertyDescriptor(props, 'where');
  const context = Object.getOwnPropertyDescriptor(props, 'context');
  const query = context !== undefined && 'value' in context &&
    typeof context.value === 'object' && context.value !== null
    ? Object.getOwnPropertyDescriptor(context.value, 'query') : undefined;
  const actualQuery = query !== undefined && 'value' in query && typeof query.value === 'function'
    ? query.value as RowQueryRunner : undefined;
  return { hasSource, source, where, context, actualQuery };
}

async function bindFactoryWhere(parts: FactoryQueryParts): Promise<void> {
  const { hasSource, source, where, context, actualQuery } = parts;
  // Unchanged generic factories retain their original function ABI. The
  // owning canonical scope separately refuses unbound original predicates.
  if (hasSource || actualQuery !== undefined && binders.has(actualQuery) &&
      where !== undefined && 'value' in where && typeof where.value === 'function') {
    if (hasSource && (source === undefined || !('value' in source)) ||
        where === undefined || !('value' in where) || typeof where.value !== 'function' ||
        context === undefined || !('value' in context) ||
        typeof context.value !== 'object' || context.value === null) {
      throw new AssemblyCorrespondenceError('Native UI where requires original own-data factory props.');
    }
    if (actualQuery === undefined) {
      throw new AssemblyCorrespondenceError('Native UI where requires its original factory query.');
    }
    await bindNativeUiWhere(actualQuery, where.value, source?.value);
  }
}

function wrapFactoryRenderRow(props: object, decoder: NativeUiSourceRowDecoder): object {
  const render = Object.getOwnPropertyDescriptor(props, 'renderRow');
  if (render === undefined || !('value' in render) || typeof render.value !== 'function') {
    throw new AssemblyCorrespondenceError('Native UI source row requires an original own-data renderRow callback.');
  }
  const original = render.value;
  const descriptors = Object.getOwnPropertyDescriptors(props);
  // Do not read unrelated getters while wrapping. Preserve their original
  // receiver as well as the factory/callback receiver and argument order.
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    if (descriptor.get !== undefined) {
      const get = descriptor.get;
      descriptor.get = () => Reflect.apply(get, props, []);
    }
    if (descriptor.set !== undefined) {
      const set = descriptor.set;
      descriptor.set = value => { Reflect.apply(set, props, [value]); };
    }
  }
  let forwarded: object;
  descriptors.renderRow = { ...render, value: async function (this: unknown, row: RowView, childContext: unknown) {
    const native = await decoder(row);
    if (typeof native !== 'object' || native === null || Array.isArray(native)) {
      throw new AssemblyCorrespondenceError('Native UI source row decoder did not return its checked record.');
    }
    return Reflect.apply(original, this === forwarded ? props : this, [row, childContext, native]);
  } };
  forwarded = Object.create(Object.getPrototypeOf(props), descriptors) as object;
  if (!Object.isExtensible(props)) Object.preventExtensions(forwarded);
  return forwarded;
}

export function wrapNativeUiQueryFactory<T extends (...args: any[]) => any>(factory: T): T {
  return (async function (this: unknown, ...args: Parameters<T>) {
    const props: unknown = args[0];
    if (typeof props === 'object' && props !== null) {
      const parts = resolveFactoryQuery(props);
      await bindFactoryWhere(parts);
      const decoder = parts.actualQuery === undefined ? undefined : binders.get(parts.actualQuery)?.sourceRow;
      if (decoder !== undefined && Object.hasOwn(props, 'renderRow')) {
        args[0] = wrapFactoryRenderRow(props, decoder);
      }
    }
    return Reflect.apply(factory, this, args);
  }) as T;
}

/** Derive the complete checked query factory set from the actual owning UI
 * namespace. Neither this selection nor the facade issues source authority. */
export function nativeUiQueryFactoryNames(ui: typeof import('@canlang/ui')): readonly string[] {
  const names = ui.UI_CATALOG.entries.filter(entry => entry.availability === 'implemented' &&
    entry.profile === 'collection' && entry.header === 'query').map(entry => entry.js);
  if (names.length === 0 || new Set(names).size !== names.length || names.some(name =>
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || name === 'default' ||
      typeof Reflect.get(ui, name) !== 'function')) {
    throw new AssemblyCorrespondenceError('Native UI facade requires its complete actual catalog query exports.');
  }
  return Object.freeze(names);
}

/** Immutable module text for the installed producer. All remaining exports
 * delegate directly; explicit host/test UI injection does not use this facade. */
export function nativeUiQueryFacadeSource(ui: typeof import('@canlang/ui'),
  uiSpecifier: string, bridgeSpecifier: string): string {
  const original = JSON.stringify(uiSpecifier), bridge = JSON.stringify(bridgeSpecifier);
  return [
    `export * from ${original};`,
    `import * as $can$ui from ${original};`,
    `import {wrapNativeUiQueryFactory as $can$wrap} from ${bridge};`,
    ...nativeUiQueryFactoryNames(ui).map(name => `export const ${name}=$can$wrap($can$ui.${name});`),
    '',
  ].join('\n');
}
