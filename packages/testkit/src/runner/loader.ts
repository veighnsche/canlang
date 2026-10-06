import type { CallerSelection, NamedUserFixture } from "../fixtures/accounts.js";
import {
  FixtureSetupError,
  extractSuiteUsers,
  normalizeDependencies,
  normalizeSuiteDependencies,
  provisionFixtureValues,
  readRecipeSuite,
  resolveFixtureOrder,
  scopeFacade,
} from "../fixtures/recipes.js";
import {
  callClosure,
  callerFromCell,
  readSequenceSteps,
  runSequenceSteps,
  type ExampleHooks,
  type SequenceStep,
  type StashedRow,
} from "./steps.js";
import { unsupportedInvoker, type RowScope, type TableRowSpec } from "./table.js";
import type { ReportValue } from "@canlang/contracts";

/** Bindings passed to the L1 `exampleFixtures` factory. */
export interface FixtureBindings {
  self: unknown;
  other: unknown;
  imported: unknown;
}

export interface LoadedExampleSuite {
  readonly rows: Array<TableRowSpec<RowScope>>;
  /** User fixtures declared by the artifact (roles for row accounts). */
  readonly userFixtures: readonly NamedUserFixture[];
}

/**
 * Provisioned fixture values per executed row scope. The row `setup`
 * closure stores them; LG02 invoke/observe closures read them back. A
 * `WeakMap` keeps disposed scopes collectable; absence means the row
 * never ran setup (or provisioned nothing).
 */
const fixtureValues = new WeakMap<object, ReadonlyMap<string, unknown>>();

export function fixtureValuesOf(scope: RowScope): ReadonlyMap<string, unknown> | undefined {
  return fixtureValues.get(scope);
}

/** Row inputs stashed at setup (see {@link StashedRow}). */
const stashedRows = new WeakMap<object, StashedRow>();

export function stashedRowOf(scope: RowScope): StashedRow | undefined {
  return stashedRows.get(scope);
}

const EMPTY_PROVISIONED: ReadonlyMap<string, unknown> = new Map();

const EMPTY_STASH: StashedRow = { fixtures: EMPTY_PROVISIONED, inputs: null, cells: [], expectedValues: [] };

function detailOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function fail(moduleUrl: string, reason: string): never {
  throw new Error(`loadExampleFixtures: ${moduleUrl}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies one row's input cells to the evaluated table inputs along the
 * header selector paths (`selectors[i]` is the dotted source spelling of
 * `cells[i]`, e.g. `task.done`; see `BehaviorTable.inputs`). Genuine
 * suites always resolve every non-`as` selector inside the inputs, so an
 * unresolvable path fails loud instead of silently dropping the cell.
 * Clones along each written path: the provisioned fixture values the
 * inputs were built from are never mutated.
 */
function applyInputCells(
  where: string,
  inputs: unknown,
  selectors: readonly string[],
  cells: readonly unknown[],
): unknown {
  if (cells.length !== selectors.length) {
    throw new Error(
      `${where}: values evaluate to ${cells.length} cells but the table has ${selectors.length} selectors`,
    );
  }
  let applied: unknown = inputs;
  for (const [index, selector] of selectors.entries()) {
    if (selector === "as") {
      continue;
    }
    applied = setPath(applied, selector, cells[index] as unknown, where);
  }
  return applied;
}

function setPath(root: unknown, selector: string, value: unknown, where: string): unknown {
  const segments = selector.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error(`${where}: selector ${JSON.stringify(selector)} is not a dotted path`);
  }
  const set = (node: unknown, at: number): unknown => {
    const head = segments[at] as string;
    const last = at === segments.length - 1;
    if (Array.isArray(node)) {
      const index = Number(head);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        throw new Error(
          `${where}: selector ${JSON.stringify(selector)} does not resolve (no array index ${head})`,
        );
      }
      const next = [...node];
      next[index] = last ? value : set(next[index] as unknown, at + 1);
      return next;
    }
    if (!isRecord(node)) {
      throw new Error(
        `${where}: selector ${JSON.stringify(selector)} does not resolve (${JSON.stringify(head)} is not an object)`,
      );
    }
    if (!(head in node)) {
      throw new Error(
        `${where}: selector ${JSON.stringify(selector)} does not resolve (no ${JSON.stringify(head)})`,
      );
    }
    const next = { ...node };
    next[head] = last ? value : set(next[head] as unknown, at + 1);
    return next;
  };
  return set(root, 0);
}

function setupError(fixture: string | null, reason: string, options?: { cause?: unknown }): FixtureSetupError {
  return new FixtureSetupError(fixture, reason, options);
}

interface EmittedRow {
  readonly seeds: string[];
  readonly valuesFn: (...args: readonly unknown[]) => unknown;
  readonly expectedFn: ((...args: readonly unknown[]) => unknown) | null;
  readonly error: string | null;
}

function readEmittedRow(
  row: unknown,
  exampleIndex: number,
  rowPosition: number,
  exampleDeps: readonly unknown[],
  suite: Parameters<typeof normalizeDependencies>[1],
): { seeds: string[]; valuesFn: (...args: readonly unknown[]) => unknown; expectedFn: ((...args: readonly unknown[]) => unknown) | null; error: string | null } {
  const where = `example at index ${exampleIndex} row ${rowPosition}`;
  if (!isRecord(row)) {
    throw setupError(null, `${where} is not an object`);
  }
  const rowDeps: unknown = row["dependencies"] ?? [];
  if (!Array.isArray(rowDeps)) {
    throw setupError(null, `${where} has dependencies that are not an array`);
  }
  const valuesFn: unknown = row["values"];
  if (typeof valuesFn !== "function") {
    throw setupError(null, `${where} has values that are not a function`);
  }
  const expectedFn: unknown = row["expected"];
  const error: unknown = row["error"];
  if (expectedFn !== undefined && typeof expectedFn !== "function") {
    throw setupError(null, `${where} has expected that is not a function`);
  }
  if (error !== undefined && typeof error !== "string") {
    throw setupError(null, `${where} has error that is not a string`);
  }
  if ((expectedFn === undefined) === (error === undefined)) {
    // Lowering keeps malformed rows silent (analysis owns E5xxx); the
    // loader refuses them loud instead of guessing an expectation.
    throw setupError(null, `${where} has both or neither expected and error`);
  }
  let seeds: string[];
  try {
    seeds = normalizeDependencies([...exampleDeps, ...rowDeps], suite);
  } catch (thrown) {
    if (thrown instanceof FixtureSetupError) {
      throw setupError(thrown.fixture, `${where}: ${thrown.reason}`, { cause: thrown });
    }
    throw thrown;
  }
  return {
    seeds,
    valuesFn: valuesFn as (...args: readonly unknown[]) => unknown,
    expectedFn: (expectedFn ?? null) as ((...args: readonly unknown[]) => unknown) | null,
    error: (error ?? null) as string | null,
  };
}

/**
 * Loads one L1 BDD suite module into executable row specs plus the suite's
 * user fixtures. Pure load+validate+map: dynamic-imports `moduleUrl`, calls
 * its `exampleFixtures` export with `bindings`, validates the fixture graph
 * (unknown references and genuine cycles fail the load loud), and maps each
 * emitted example to row specs:
 *
 * - Behavior tables with `rows[]` expand to one {@link TableRowSpec} per
 *   emitted row (running `rowIndex`; inputs/cells/expected evaluate from
 *   the pre-lowered closures at setup; `as`-cells map to row callers).
 * - Causal sequences map to one spec whose `invoke` runs the steps
 *   (calls commit through `hooks.invokeCall`, bindings thread, assertions
 *   throw on mismatch).
 * - Examples with neither stay the LG01 single-spec shape (setup
 *   provisions the closure; invoke unsupported; empty expectations).
 *
 * `setup` provisions the row's fixture closure and stashes inputs/cells/
 * expectations for invoke/observe; any validation/provisioning/evaluation
 * failure throws `FixtureSetupError`, which the runner reports as
 * `setup-failed` — never a business outcome. Without `hooks.invokeCall`,
 * invocations report `unsupported`; without `hooks.observeScope`,
 * observations read the static provisioned values (live state is a B/C
 * slice). `seed` carries the provisioned closure (report-indexed by the
 * artifact digest + `rowIndex`, not echoed per row).
 */
export async function loadExampleSuite(
  moduleUrl: string,
  bindings: FixtureBindings,
  hooks: ExampleHooks = {},
): Promise<LoadedExampleSuite> {
  let module_: Record<string, unknown>;
  try {
    module_ = (await import(moduleUrl)) as Record<string, unknown>;
  } catch (thrown) {
    throw new Error(`loadExampleFixtures: cannot import ${moduleUrl}: ${detailOf(thrown)}`, {
      cause: thrown,
    });
  }

  const factory: unknown = module_.exampleFixtures;
  if (factory === undefined) {
    fail(moduleUrl, "module does not export exampleFixtures");
  }
  if (typeof factory !== "function") {
    fail(moduleUrl, "exampleFixtures export is not a function");
  }

  const loaded: unknown = await (
    factory as (bindings: FixtureBindings) => unknown
  )(bindings);
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    fail(moduleUrl, "exampleFixtures must return {fixtures, examples}");
  }
  const { fixtures, examples } = loaded as Record<string, unknown>;
  if (typeof fixtures !== "object" || fixtures === null || Array.isArray(fixtures)) {
    fail(moduleUrl, "exampleFixtures must return {fixtures, examples} with fixtures an object");
  }
  if (!Array.isArray(examples)) {
    fail(moduleUrl, "exampleFixtures must return {fixtures, examples} with examples an array");
  }

  const suite = readRecipeSuite(fixtures);
  const adjacency = normalizeSuiteDependencies(suite);
  // Any dependency cycle anywhere fails the suite, used or not (LG00 R20:
  // genuine cycles fail; no silent reinterpretation).
  resolveFixtureOrder([...suite.recipes.keys()], adjacency);
  const { users, values } = await extractSuiteUsers(suite, bindings);
  const invoke = hooks.invokeCall;
  const observeScope = hooks.observeScope;

  const rows: Array<TableRowSpec<RowScope>> = [];
  let rowIndex = 0;
  for (const [exampleIndex, example] of examples.entries()) {
    if (typeof example !== "object" || example === null || Array.isArray(example)) {
      fail(moduleUrl, `example at index ${exampleIndex} is not an object`);
    }
    const record = example as Record<string, unknown>;
    const dependencies: unknown = record["dependencies"] ?? [];
    if (!Array.isArray(dependencies)) {
      fail(moduleUrl, `example at index ${exampleIndex} has dependencies that are not an array`);
    }
    const sequenceRaw: unknown = record["sequence"];
    const tableRows: unknown = record["rows"];
    if (sequenceRaw !== undefined && tableRows !== undefined) {
      fail(moduleUrl, `example at index ${exampleIndex} has both sequence and rows`);
    }
    if (sequenceRaw !== undefined) {
      if (!Array.isArray(sequenceRaw)) {
        fail(moduleUrl, `example at index ${exampleIndex} has sequence that is not an array`);
      }
      rows.push(await mapSequenceRow(moduleUrl, bindings, suite, adjacency, values, exampleIndex, rowIndex, record, sequenceRaw, invoke));
      rowIndex += 1;
      continue;
    }
    if (tableRows === undefined) {
      rows.push(mapLegacyRow(bindings, suite, adjacency, values, exampleIndex, rowIndex, dependencies));
      rowIndex += 1;
      continue;
    }
    if (!Array.isArray(tableRows)) {
      fail(moduleUrl, `example at index ${exampleIndex} has rows that are not an array`);
    }
    const operation: unknown = record["operation"];
    if (typeof operation !== "string" || operation.length === 0) {
      fail(moduleUrl, `example at index ${exampleIndex} has no operation identity`);
    }
    const inputsFn: unknown = record["inputs"];
    if (typeof inputsFn !== "function") {
      fail(moduleUrl, `example at index ${exampleIndex} has inputs that are not a function`);
    }
    const selectorsRaw: unknown = record["selectors"] ?? [];
    if (!Array.isArray(selectorsRaw) || selectorsRaw.some((s) => typeof s !== "string")) {
      fail(moduleUrl, `example at index ${exampleIndex} has selectors that are not strings`);
    }
    const selectors = selectorsRaw as string[];
    const observationsRaw: unknown = record["observations"] ?? [];
    if (!Array.isArray(observationsRaw) || observationsRaw.some((o) => typeof o !== "function")) {
      fail(moduleUrl, `example at index ${exampleIndex} has observations that are not functions`);
    }
    const observations = observationsRaw as Array<(...args: readonly unknown[]) => unknown>;
    for (const [position, row] of tableRows.entries()) {
      const mapped = readEmittedRow(row, exampleIndex, position, dependencies, suite);
      rows.push(
        await mapTableRow(
          bindings, suite, adjacency, values, exampleIndex, rowIndex, position,
          operation, inputsFn as (...args: readonly unknown[]) => unknown,
          selectors, observations, mapped, invoke, observeScope,
        ),
      );
      rowIndex += 1;
    }
  }
  return { rows, userFixtures: users };
}

function mapLegacyRow(
  bindings: FixtureBindings,
  suite: Parameters<typeof normalizeDependencies>[1],
  adjacency: Parameters<typeof resolveFixtureOrder>[1],
  userValues: ReadonlyMap<string, unknown>,
  exampleIndex: number,
  rowIndex: number,
  dependencies: readonly unknown[],
): TableRowSpec<RowScope> {
  let seeds: string[];
  try {
    seeds = normalizeDependencies(dependencies, suite);
  } catch (thrown) {
    if (thrown instanceof FixtureSetupError) {
      throw setupError(thrown.fixture, `example at index ${exampleIndex}: ${thrown.reason}`, {
        cause: thrown,
      });
    }
    throw thrown;
  }
  const order = resolveFixtureOrder(seeds, adjacency);
  return {
    rowIndex,
    caller: { kind: "self" },
    seed: [...order],
    setup: async (scope) => {
      const provisioned = await provisionFixtureValues(order, suite, bindings, userValues);
      fixtureValues.set(scope, provisioned);
      stashedRows.set(scope, { fixtures: provisioned, inputs: null, cells: [], expectedValues: [] });
    },
    invoke: unsupportedInvoker,
    expected: { values: [], observations: [] },
    observe: async () => [],
  };
}

async function mapTableRow(
  bindings: FixtureBindings,
  suite: Parameters<typeof normalizeDependencies>[1],
  adjacency: Parameters<typeof resolveFixtureOrder>[1],
  userValues: ReadonlyMap<string, unknown>,
  exampleIndex: number,
  rowIndex: number,
  position: number,
  operation: string,
  inputsFn: (...args: readonly unknown[]) => unknown,
  selectors: readonly string[],
  observations: ReadonlyArray<(...args: readonly unknown[]) => unknown>,
  mapped: EmittedRow,
  invoke: ExampleHooks["invokeCall"],
  observeScope: ExampleHooks["observeScope"],
): Promise<TableRowSpec<RowScope>> {
  const where = `example at index ${exampleIndex} row ${position}`;
  const order = resolveFixtureOrder(mapped.seeds, adjacency);
  // Caller probe at load: `as`-cells lower to literals/identifiers, always
  // load-evaluable; probe failure fails the load loud (never a defaulted
  // caller that could false-pass).
  let caller: CallerSelection = { kind: "self" };
  const asIndex = selectors.indexOf("as");
  if (asIndex >= 0) {
    let probe: unknown;
    try {
      probe = await mapped.valuesFn(bindings, scopeFacade(EMPTY_PROVISIONED));
    } catch (thrown) {
      throw setupError(null, `${where}: caller probe failed: ${detailOf(thrown)}`, { cause: thrown });
    }
    if (!Array.isArray(probe)) {
      throw setupError(null, `${where}: values must evaluate to an array`);
    }
    try {
      caller = callerFromCell(probe[asIndex] as unknown, bindings, suite);
    } catch (thrown) {
      if (thrown instanceof FixtureSetupError) {
        throw setupError(thrown.fixture, `${where}: ${thrown.reason}`, { cause: thrown });
      }
      throw thrown;
    }
  }
  const spec: TableRowSpec<RowScope> = {
    rowIndex,
    caller,
    seed: [...order],
    setup: async (scope) => {
      const provisioned = await provisionFixtureValues(order, suite, bindings, userValues);
      const scopeArg = scopeFacade(provisioned);
      const baseline = await callClosure(inputsFn, `${where} inputs`, [bindings, scopeArg]);
      const cellsRaw = await callClosure(mapped.valuesFn, `${where} values`, [bindings, scopeArg]);
      if (!Array.isArray(cellsRaw)) {
        throw new Error(`${where}: values must evaluate to an array`);
      }
      const inputs = applyInputCells(where, baseline, selectors, cellsRaw);
      let expectedValues: readonly unknown[] | null;
      if (mapped.error !== null) {
        expectedValues = null;
        spec.expected = { error: mapped.error };
      } else if (mapped.expectedFn !== null) {
        const evaluated = await callClosure(mapped.expectedFn, `${where} expected`, [bindings, scopeArg]);
        if (!Array.isArray(evaluated)) {
          throw new Error(`${where}: expected must evaluate to an array`);
        }
        expectedValues = evaluated;
        spec.expected = { values: evaluated as ReportValue[], observations: [] };
      } else {
        throw new Error(`${where}: row has neither expected nor error`);
      }
      fixtureValues.set(scope, provisioned);
      stashedRows.set(scope, { fixtures: provisioned, inputs, cells: cellsRaw, expectedValues });
    },
    invoke: async (scope, rowCaller) => {
      if (invoke === undefined) {
        return unsupportedInvoker();
      }
      const stashed = stashedRows.get(scope) ?? EMPTY_STASH;
      return invoke({
        operation,
        inputs: stashed.inputs,
        by: asIndex >= 0 ? (stashed.cells[asIndex] as unknown) : null,
        scope,
      });
    },
    expected: { values: [], observations: [] },
    observe: async (scope) => {
      const stashed = stashedRows.get(scope) ?? EMPTY_STASH;
      const observed: ReportValue[] = [];
      // The loader guarantees the property convention for every Map a
      // hook returns (non-Map scope args pass through verbatim).
      const hookScope = observeScope === undefined ? stashed.fixtures : await observeScope(scope, stashed);
      const scopeArg = hookScope instanceof Map ? scopeFacade(hookScope) : hookScope;
      for (const [index, fn] of observations.entries()) {
        observed.push(
          (await callClosure(fn, `${where} observation ${index}`, [bindings, scopeArg])) as ReportValue,
        );
      }
      return observed;
    },
  };
  return spec;
}

async function mapSequenceRow(
  moduleUrl: string,
  bindings: FixtureBindings,
  suite: Parameters<typeof normalizeDependencies>[1],
  adjacency: Parameters<typeof resolveFixtureOrder>[1],
  userValues: ReadonlyMap<string, unknown>,
  exampleIndex: number,
  rowIndex: number,
  record: Record<string, unknown>,
  sequenceRaw: readonly unknown[],
  invoke: ExampleHooks["invokeCall"],
): Promise<TableRowSpec<RowScope>> {
  const operation: unknown = record["operation"];
  if (typeof operation !== "string" || operation.length === 0) {
    fail(moduleUrl, `example at index ${exampleIndex} has no operation identity`);
  }
  const dependencies: unknown = record["dependencies"] ?? [];
  if (!Array.isArray(dependencies)) {
    fail(moduleUrl, `example at index ${exampleIndex} has dependencies that are not an array`);
  }
  let seeds: string[];
  try {
    seeds = normalizeDependencies(dependencies, suite);
  } catch (thrown) {
    if (thrown instanceof FixtureSetupError) {
      throw setupError(thrown.fixture, `example at index ${exampleIndex}: ${thrown.reason}`, {
        cause: thrown,
      });
    }
    throw thrown;
  }
  const steps: SequenceStep[] = readSequenceSteps(sequenceRaw, exampleIndex);
  void operation;
  const order = resolveFixtureOrder(seeds, adjacency);
  return {
    rowIndex,
    caller: { kind: "self" },
    seed: [...order],
    setup: async (scope) => {
      const provisioned = await provisionFixtureValues(order, suite, bindings, userValues);
      fixtureValues.set(scope, provisioned);
      stashedRows.set(scope, { fixtures: provisioned, inputs: null, cells: [], expectedValues: [] });
    },
    invoke: async (scope, rowCaller) => {
      if (invoke === undefined) {
        return unsupportedInvoker();
      }
      const stashed = stashedRows.get(scope) ?? EMPTY_STASH;
      return runSequenceSteps(steps, {
        callerBindings: bindings,
        provisioned: stashed.fixtures,
        invoke,
        scope,
        exampleIndex,
      });
    },
    expected: { values: [], observations: [] },
    observe: async () => [],
  };
}

/**
 * Loads one L1 BDD suite module into executable row specs (rows only; use
 * {@link loadExampleSuite} when the suite's user fixtures are also needed).
 */
export async function loadExampleFixtures(
  moduleUrl: string,
  bindings: FixtureBindings,
  hooks: ExampleHooks = {},
): Promise<Array<TableRowSpec<RowScope>>> {
  return (await loadExampleSuite(moduleUrl, bindings, hooks)).rows;
}
