/** Private bridge for checked boolean source reads. Public context/markers do
 * not create a reader; the request's original canonical owner installs it. */
import { StateError } from '@canlang/state/errors';

type Evaluate = (fn: Function, subject: unknown) => Promise<boolean>;
const contexts = new WeakMap<object, Evaluate>();
const readers = new WeakMap<Function, Evaluate>();
const references = new WeakMap<object, (record: unknown, field?: string) => Promise<unknown>>();

/** Only the actual installed source evaluator binds lazy reference access. */
export function bindNativeSourceReferenceReader(context: object,
  read: (record: unknown, field?: string) => Promise<unknown>): void {
  if (references.has(context)) throw new StateError('validation', 'Native source reference context cannot be rebound.');
  references.set(context, read);
}
export async function nativeReadReference(context: unknown, record: unknown, field?: string): Promise<unknown> {
  const read = typeof context === 'object' && context !== null ? references.get(context) : undefined;
  if (read === undefined) throw new StateError('validation', 'Native reference read requires its actual installed source context.');
  return read(record, field);
}

export function bindNativeReadBooleanContext(context: object, evaluate: Evaluate): void {
  if (contexts.has(context)) throw new StateError('validation', 'Native boolean source context cannot be rebound.');
  contexts.set(context, evaluate);
}
export function bindNativeReadBooleanReader(reader: Function, evaluate: Evaluate): void {
  if (readers.has(reader)) throw new StateError('validation', 'Native boolean source reader cannot be rebound.');
  readers.set(reader, evaluate);
}
/** Selected physical-owner wrappers retain the original reader's binding. */
export function forwardNativeReadBooleanReader(reader: Function, selected: () => Promise<Function>): void {
  bindNativeReadBooleanReader(reader, async (fn, subject) => {
    const evaluate = readers.get(await selected());
    if (evaluate === undefined) throw new StateError('validation', 'Native boolean read requires its selected original reader.');
    return evaluate(fn, subject);
  });
}

/** Generated source only; the defining reader validates the actual function,
 * selected record, complete original source census and current permissions. */
export async function nativeReadBoolean(context: unknown, fn: Function, subject: unknown): Promise<boolean> {
  if (typeof context !== 'object' || context === null || typeof fn !== 'function') {
    throw new StateError('validation', 'Native boolean read requires its original context and function.');
  }
  let evaluate = contexts.get(context);
  if (evaluate === undefined) {
    const canonical = Object.getOwnPropertyDescriptor(context, 'canonical');
    const reader = canonical !== undefined && 'value' in canonical && typeof canonical.value === 'object' && canonical.value !== null
      ? Object.getOwnPropertyDescriptor(canonical.value, 'readRecords') : undefined;
    if (reader !== undefined && 'value' in reader && typeof reader.value === 'function') evaluate = readers.get(reader.value);
  }
  if (evaluate === undefined) throw new StateError('validation', 'Native boolean read requires its installed request reader.');
  return evaluate(fn, subject);
}
