import type { NamedUserFixture } from "../fixtures/accounts.js";
import {
  FixtureSetupError,
  extractSuiteUsers,
  normalizeDependencies,
  normalizeSuiteDependencies,
  provisionFixtureValues,
  readRecipeSuite,
  resolveFixtureOrder,
} from "../fixtures/recipes.js";
import { unsupportedInvoker, type RowScope, type TableRowSpec } from "./table.js";

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
 * Loads one L1 BDD suite module into executable row specs plus the suite's
 * user fixtures. Pure load+validate+map: dynamic-imports `moduleUrl`, calls
 * its `exampleFixtures` export with `bindings`, validates the fixture graph
 * (unknown references and genuine cycles fail the load loud), and maps each
 * emitted example to one {@link TableRowSpec}.
 *
 * `setup` provisions the row's fixture closure (example dependencies plus
 * real-table row dependencies, dependencies first) and stashes the values
 * for {@link fixtureValuesOf}; any validation/provisioning failure throws
 * `FixtureSetupError`, which the runner reports as `setup-failed` — never
 * a business outcome. `invoke` stays {@link unsupportedInvoker} and
 * `expected`/`observe` stay empty until LG02 wires example callbacks; row
 * expansion of real tables (values/expected/error mapping) is likewise an
 * LG02 remainder — LG01 provisions fixture closures without executing rows.
 * `seed` carries the provisioned closure (report-indexed by the artifact
 * digest + `rowIndex`, not echoed per row).
 */
export async function loadExampleSuite(
  moduleUrl: string,
  bindings: FixtureBindings,
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

  const rows = examples.map((example, rowIndex): TableRowSpec<RowScope> => {
    if (typeof example !== "object" || example === null || Array.isArray(example)) {
      fail(moduleUrl, `example at index ${rowIndex} is not an object`);
    }
    const dependencies: unknown = (example as Record<string, unknown>)["dependencies"] ?? [];
    if (!Array.isArray(dependencies)) {
      fail(moduleUrl, `example at index ${rowIndex} has dependencies that are not an array`);
    }
    const raw: unknown[] = [...dependencies];
    // Real emitted tables carry per-row dependencies; LG01 provisions their
    // closure (row expansion itself is LG02).
    const tableRows: unknown = (example as Record<string, unknown>)["rows"];
    if (tableRows !== undefined) {
      if (!Array.isArray(tableRows)) {
        fail(moduleUrl, `example at index ${rowIndex} has rows that are not an array`);
      }
      for (const row of tableRows) {
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
          fail(moduleUrl, `example at index ${rowIndex} has a row that is not an object`);
        }
        const rowDeps: unknown = (row as Record<string, unknown>)["dependencies"] ?? [];
        if (!Array.isArray(rowDeps)) {
          fail(moduleUrl, `example at index ${rowIndex} has row dependencies that are not an array`);
        }
        raw.push(...rowDeps);
      }
    }
    let seeds: string[];
    try {
      seeds = normalizeDependencies(raw, suite);
    } catch (thrown) {
      if (thrown instanceof FixtureSetupError) {
        throw new FixtureSetupError(
          thrown.fixture,
          `example at index ${rowIndex}: ${thrown.reason}`,
          { cause: thrown },
        );
      }
      throw thrown;
    }
    const order = resolveFixtureOrder(seeds, adjacency);
    return {
      rowIndex,
      caller: { kind: "self" },
      seed: [...order],
      setup: async (scope) => {
        fixtureValues.set(scope, await provisionFixtureValues(order, suite, bindings, values));
      },
      invoke: unsupportedInvoker,
      expected: { values: [], observations: [] },
      observe: async () => [],
    };
  });
  return { rows, userFixtures: users };
}

/**
 * Loads one L1 BDD suite module into executable row specs (rows only; use
 * {@link loadExampleSuite} when the suite's user fixtures are also needed).
 */
export async function loadExampleFixtures(
  moduleUrl: string,
  bindings: FixtureBindings,
): Promise<Array<TableRowSpec<RowScope>>> {
  return (await loadExampleSuite(moduleUrl, bindings)).rows;
}
