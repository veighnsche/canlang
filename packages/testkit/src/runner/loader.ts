import { unsupportedInvoker, type RowScope, type TableRowSpec } from "./table.js";

/** Bindings passed to the L1 `exampleFixtures` factory. */
export interface FixtureBindings {
  self: unknown;
  other: unknown;
  imported: unknown;
}

function detailOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function fail(moduleUrl: string, reason: string): never {
  throw new Error(`loadExampleFixtures: ${moduleUrl}: ${reason}`);
}

/**
 * Loads one L1 BDD suite module into executable row specs. Pure load+map:
 * dynamic-imports `moduleUrl`, calls its `exampleFixtures` export with
 * `bindings`, and maps each emitted example to one {@link TableRowSpec}.
 * Nothing executes here: `setup` is a no-op, `invoke` is
 * {@link unsupportedInvoker} (the lane-1/3 join owns real invocation), and
 * `expected`/`observe` stay empty until a later lane wires example
 * callbacks. `seed` carries the example's fixture dependency names.
 */
export async function loadExampleFixtures(
  moduleUrl: string,
  bindings: FixtureBindings,
): Promise<TableRowSpec<RowScope>[]> {
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

  const loaded: unknown = await factory(bindings);
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

  return examples.map((example, rowIndex): TableRowSpec<RowScope> => {
    if (typeof example !== "object" || example === null || Array.isArray(example)) {
      fail(moduleUrl, `example at index ${rowIndex} is not an object`);
    }
    const dependencies: unknown = (example as Record<string, unknown>).dependencies ?? [];
    if (!Array.isArray(dependencies)) {
      fail(moduleUrl, `example at index ${rowIndex} has dependencies that are not an array`);
    }
    const seed: string[] = [];
    for (const dependency of dependencies) {
      if (typeof dependency !== "string") {
        fail(moduleUrl, `example at index ${rowIndex} has a non-string dependency`);
      }
      seed.push(dependency);
    }
    return {
      rowIndex,
      caller: { kind: "self" },
      seed,
      setup: async () => {},
      invoke: unsupportedInvoker,
      expected: { values: [], observations: [] },
      observe: async () => [],
    };
  });
}
