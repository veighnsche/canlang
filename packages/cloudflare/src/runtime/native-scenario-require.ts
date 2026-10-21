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

type EventEvaluate = (descriptor: unknown, predicate: Function) => Promise<boolean>;
const eventReaders = new WeakMap<object, EventEvaluate>();

/** Only the live due-handler context can evaluate its checked private IF. */
export function bindNativeScenarioEventDecision(context: object, evaluate: EventEvaluate): void {
  if (eventReaders.has(context)) throw new StateError('validation', 'Event decision reader cannot be rebound.');
  eventReaders.set(context, evaluate);
}

export async function nativeScenarioEventDecision(context: unknown, descriptor: unknown,
  predicate: Function): Promise<boolean> {
  const evaluate = typeof context === 'object' && context !== null ? eventReaders.get(context) : undefined;
  if (evaluate === undefined || typeof predicate !== 'function') {
    throw new StateError('validation', 'Event decision needs its actual admitted due owner.');
  }
  return evaluate(descriptor, predicate);
}
