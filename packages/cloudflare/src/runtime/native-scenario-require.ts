/** Generated Require calls can enter only their genuine mutation's private reader. */
import { StateError } from '@canlang/state/errors';

type Evaluate = (predicate: Function, inputs: Readonly<Record<string, unknown>>) => Promise<boolean>;
const readers = new WeakMap<object, Evaluate>();

export function bindNativeScenarioRequire(context: object, evaluate: Evaluate): void {
  if (readers.has(context)) throw new StateError('validation', 'Scenario Require reader cannot be rebound.');
  readers.set(context, evaluate);
}

export async function nativeScenarioRequire(context: unknown, predicate: Function,
  inputs: Readonly<Record<string, unknown>>): Promise<boolean> {
  const evaluate = typeof context === 'object' && context !== null ? readers.get(context) : undefined;
  if (evaluate === undefined || typeof predicate !== 'function') {
    throw new StateError('validation', 'Scenario Require needs its actual installed mutation reader.');
  }
  return evaluate(predicate, inputs);
}
