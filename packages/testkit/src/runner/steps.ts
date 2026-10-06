/**
 * Compiled example execution (T23a/LG02 core): table-row closure
 * evaluation, caller mapping, and causal-sequence step running over an
 * injectable invocation port.
 *
 * The L1 BDD emission pre-lowers every expression to a JS closure, so the
 * runner evaluates rather than interprets: table `inputs`/`values` /
 * `expected` / `observations` take `(callerBindings, scopeValues)`, and
 * sequence steps additionally take the let-binding map `(c, s, b)`.
 * Fixture names inside closures resolve to the module's own recipe consts;
 * `self`/`other` resolve to the factory bindings; `as`-cells lower to
 * caller strings (codegen pins `values:async(c,s)=>(["members",...])`).
 *
 * Execution plugs in through {@link ExampleHooks}: `invokeCall` runs real
 * operations (default: unsupported — real dispatch is a B/C producer
 * slice), and `observeScope` supplies the live state facade observations
 * read (default: the row's static provisioned values — live reads are a
 * B/C slice). Sequence assertions judge inside `invoke` and throw on
 * mismatch, which the runner reports as `failed` (never passed,
 * never setup-failed). What stays out, recorded as gaps: real dispatch
 * invokers, live-state observation scope, `CallOutcome` result payloads
 * for sequence `bind` (binds store the outcome object), and evaluation
 * of query-bearing cells against live state.
 */
import { diffReportValues } from "../assertions/equal.js";
import type { CallerSelection } from "../fixtures/accounts.js";
import { FixtureSetupError, scopeFacade, type RecipeSuite } from "../fixtures/recipes.js";
import type { CallOutcome, RowScope } from "./table.js";
import type { ReportValue } from "@canlang/contracts";

/** One operation invocation requested by a table row or sequence step. */
export interface StepCall {
  readonly operation: string;
  /** Evaluated inputs callback value (header bindings / call inputs). */
  readonly inputs: unknown;
  /**
   * Evaluated caller: the row `as`-cell value for tables, the step `by`
   * value for sequences. The real invoker owns caller semantics.
   */
  readonly by: unknown;
  readonly scope: RowScope;
}

/** Invocation port: real dispatch plugs in here (B/C slice). */
export type InvokeCall = (call: StepCall) => Promise<CallOutcome>;

/** Row inputs stashed at setup for invoke/observe closures. */
export interface StashedRow {
  readonly fixtures: ReadonlyMap<string, unknown>;
  readonly inputs: unknown;
  /** Evaluated row cells in selector order (`as`-cell included). */
  readonly cells: readonly unknown[];
  /** Evaluated expected values, or null when an exact error is expected. */
  readonly expectedValues: readonly unknown[] | null;
}

export interface ExampleHooks {
  readonly invokeCall?: InvokeCall;
  /**
   * Supplies the `s` argument observation callbacks read. Defaults to
   * the row's static provisioned values; a live state facade plugs in
   * here (B/C slice).
   */
  readonly observeScope?: (scope: RowScope, stashed: StashedRow) => unknown | Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Calls one emitted closure with the given arguments. Non-functions and
 * throws fail loud with step/row context; the phase decides the outcome
 * (setup evaluators surface as `setup-failed`, observers as `failed`).
 */
export async function callClosure(
  fn: unknown,
  what: string,
  args: readonly unknown[],
): Promise<unknown> {
  if (typeof fn !== "function") {
    throw new Error(`${what} is not a function`);
  }
  try {
    return await (fn as (...a: readonly unknown[]) => unknown)(...args);
  } catch (thrown) {
    throw new Error(`${what} threw: ${detailOf(thrown)}`, { cause: thrown });
  }
}

/**
 * Maps one evaluated `as`-cell value to a row caller selection. Factory
 * identities compare by value; role strings become membership callers;
 * live recipe references resolve back to user-fixture names.
 */
export function callerFromCell(
  value: unknown,
  bindings: { readonly self: unknown; readonly other: unknown },
  suite: RecipeSuite,
): CallerSelection {
  if (value === bindings.self || value === "self") {
    return { kind: "self" };
  }
  if (value === bindings.other || value === "other") {
    return { kind: "other" };
  }
  if (typeof value === "string") {
    if (value === "outsider") {
      return { kind: "outsider" };
    }
    if (value === "public") {
      return { kind: "public" };
    }
    return { kind: "membership", roles: [value] };
  }
  if (typeof value === "object" && value !== null) {
    const name = suite.rawNames.get(value);
    if (name === undefined) {
      throw new FixtureSetupError(null, "as-cell names no caller in this suite");
    }
    return { kind: "fixture", fixture: name };
  }
  throw new FixtureSetupError(null, "as-cell value is not a caller");
}

export type ClosureFn = (...args: readonly unknown[]) => unknown;

export interface SequenceCallStep {
  readonly kind: "call";
  readonly operation: string;
  readonly by: ClosureFn;
  readonly inputs: ClosureFn;
  readonly request?: ClosureFn | undefined;
  readonly bind?: string | undefined;
  readonly error?: string | undefined;
}

export interface SequenceBindingStep {
  readonly kind: "binding";
  readonly name: string;
  readonly value: ClosureFn;
}

export interface SequenceAssertionStep {
  readonly kind: "assertion";
  readonly observations: ClosureFn;
  readonly expected: ClosureFn;
}

export type SequenceStep = SequenceCallStep | SequenceBindingStep | SequenceAssertionStep;

function asClosure(step: string, value: unknown, key: string): ClosureFn {
  if (typeof value !== "function") {
    throw new FixtureSetupError(null, `${step} has ${JSON.stringify(key)} that is not a function`);
  }
  return value as ClosureFn;
}

/** Validates raw emitted steps into typed sequence steps (load loud). */
export function readSequenceSteps(rawSteps: readonly unknown[], exampleIndex: number): SequenceStep[] {
  return rawSteps.map((raw, stepIndex): SequenceStep => {
    const step = `example at index ${exampleIndex} step ${stepIndex}`;
    if (!isRecord(raw)) {
      throw new FixtureSetupError(null, `${step} is not an object`);
    }
    if (typeof raw["let"] === "string") {
      return { kind: "binding", name: raw["let"], value: asClosure(step, raw["value"], "value") };
    }
    if (typeof raw["operation"] === "string") {
      const bind: unknown = raw["bind"];
      const error: unknown = raw["error"];
      if (bind !== undefined && typeof bind !== "string") {
        throw new FixtureSetupError(null, `${step} has bind that is not a string`);
      }
      if (error !== undefined && typeof error !== "string") {
        throw new FixtureSetupError(null, `${step} has error that is not a string`);
      }
      if (bind !== undefined && error !== undefined) {
        throw new FixtureSetupError(null, `${step} binds and expects an error`);
      }
      const request: unknown = raw["request"];
      return {
        kind: "call",
        operation: raw["operation"],
        by: asClosure(step, raw["by"], "by"),
        inputs: asClosure(step, raw["inputs"], "inputs"),
        ...(request === undefined ? {} : { request: asClosure(step, request, "request") }),
        ...(bind === undefined ? {} : { bind }),
        ...(error === undefined ? {} : { error }),
      };
    }
    if ("observations" in raw || "expected" in raw) {
      return {
        kind: "assertion",
        observations: asClosure(step, raw["observations"], "observations"),
        expected: asClosure(step, raw["expected"], "expected"),
      };
    }
    throw new FixtureSetupError(null, `${step} is neither a call, binding, nor assertion`);
  });
}

export interface SequenceContext {
  readonly callerBindings: unknown;
  readonly provisioned: ReadonlyMap<string, unknown>;
  readonly invoke: InvokeCall;
  readonly scope: RowScope;
  readonly exampleIndex: number;
}

function judgeAssertion(
  observed: unknown,
  expected: unknown,
  exampleIndex: number,
  stepIndex: number,
): void {
  const pairs: Array<readonly [unknown, unknown, string]> =
    Array.isArray(observed) && Array.isArray(expected)
      ? observed.length === expected.length
        ? observed.map((o, i) => [o, expected[i] as unknown, `assertion[${i}]`] as const)
        : (() => {
            throw new Error(
              `example at index ${exampleIndex} step ${stepIndex}: assertion observed ${observed.length} values but expected ${expected.length}`,
            );
          })()
      : [[observed, expected, "assertion"] as const];
  const mismatches = pairs.flatMap(([o, e, name]) =>
    diffReportValues(name, e as ReportValue, o as ReportValue),
  );
  if (mismatches.length > 0) {
    throw new Error(
      `example at index ${exampleIndex} step ${stepIndex}: sequence assertion failed: ${JSON.stringify(mismatches).slice(0, 500)}`,
    );
  }
}

/**
 * Runs validated sequence steps in order, threading let-bindings through
 * `(c, s, b)` closures. Prior calls commit through `invoke` before later
 * steps read them; assertion/step mismatches throw (row `failed`).
 * An unsupported invocation outcome propagates so the row reports
 * `unsupported` instead of failing a missing capability.
 */
export async function runSequenceSteps(
  steps: readonly SequenceStep[],
  ctx: SequenceContext,
): Promise<CallOutcome> {
  const bound = new Map<string, unknown>();
  // Genuine closures read fixtures as scope properties (`s.task`); the
  // facade keeps the provisioned Map readable both ways.
  const scopeArg = scopeFacade(ctx.provisioned);
  for (const [stepIndex, step] of steps.entries()) {
    const what = `example at index ${ctx.exampleIndex} step ${stepIndex}`;
    if (step.kind === "binding") {
      bound.set(step.name, await callClosure(step.value, `${what} let ${step.name}`, [ctx.callerBindings, scopeArg, bound]));
      continue;
    }
    if (step.kind === "assertion") {
      const observed = await callClosure(step.observations, `${what} observations`, [
        ctx.callerBindings,
        scopeArg,
        bound,
      ]);
      const expected = await callClosure(step.expected, `${what} expected`, [
        ctx.callerBindings,
        scopeArg,
        bound,
      ]);
      judgeAssertion(observed, expected, ctx.exampleIndex, stepIndex);
      continue;
    }
    const by = await callClosure(step.by, `${what} by`, [ctx.callerBindings, scopeArg, bound]);
    const inputs = await callClosure(step.inputs, `${what} inputs`, [ctx.callerBindings, scopeArg, bound]);
    const outcome = await ctx.invoke({ operation: step.operation, inputs, by, scope: ctx.scope });
    if (!outcome.ok && "unsupported" in outcome) {
      return outcome;
    }
    if (step.error !== undefined) {
      if (outcome.ok) {
        throw new Error(`${what}: expected error(${step.error}) but the call succeeded`);
      }
      if (outcome.error !== step.error) {
        throw new Error(`${what}: expected error(${step.error}) but got error(${outcome.error})`);
      }
      continue;
    }
    if (!outcome.ok) {
      throw new Error(`${what}: unexpected rejection error(${(outcome as { error: string }).error})`);
    }
    if (step.bind !== undefined) {
      bound.set(step.bind, outcome);
    }
  }
  return { ok: true };
}
