/**
 * Fixture-recipe validation and provisioning (T22a/LG01 core).
 *
 * Consumes the `fixtures` map of an L1 `exampleFixtures` factory exactly as
 * emitted (`compiler/src/codegen/bdd.rs`: `{model?, dependencies, value}`
 * model recipes, `{dependencies, user}` user recipes, `{dependencies, file}`
 * file recipes, `{dependencies, delivery, values}` delivery recipes), plus the
 * string-dependency doubles the loader contract historically pinned. Both
 * dependency spellings validate identically: names must resolve, genuine
 * cycles fail (LG00 R20), and every failure carries the fixture identity so
 * the runner reports `setup-failed`, never a business outcome.
 *
 * Load-time work (validate the whole graph, extract user fixtures) throws
 * `FixtureSetupError` to fail the suite import loud. Row-time work
 * (`provisionFixtureValues`) throws the same class from inside the row
 * `setup` closure, which the runner maps to `setup-failed`.
 *
 * File/delivery recipes evaluate their provisioner like any other recipe;
 * materializing real finalized files / provider bindings is T22b/c (LG02)
 * work that plugs into the same closure.
 */
import type { NamedUserFixture } from "./accounts.js";

/** Fixture validation/provisioning failure. The runner maps it to `setup-failed`. */
export class FixtureSetupError extends Error {
  readonly fixture: string | null;
  readonly reason: string;

  constructor(fixture: string | null, reason: string, options?: { cause?: unknown }) {
    super(
      fixture === null
        ? `fixture setup: ${reason}`
        : `fixture setup ${JSON.stringify(fixture)}: ${reason}`,
      options,
    );
    this.name = "FixtureSetupError";
    this.fixture = fixture;
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Emitted provisioner: `async (callerBindings, provisionedSoFar) => value`.
 * Model/file/delivery recipes receive the values their dependencies already
 * produced; user recipes conventionally ignore both and return `{roles}`.
 */
export type RecipeProvisioner = (
  caller: unknown,
  provisioned: ReadonlyMap<string, unknown>,
) => unknown | Promise<unknown>;

/**
 * Closure scope facade: genuine L1 suites read fixtures as PROPERTIES on
 * the scope argument (`s.open_task`, `member_of("s", ...)` in
 * compiler/src/codegen/ir.rs) while the harness accumulates and probes
 * them as a Map. The facade IS the same Map (identity, iteration, and
 * bound methods preserved) with fixture-name property reads added, so
 * both conventions hold. A fixture literally named like a Map member
 * (`get`, `size`, …) shadows that member on property reads only.
 */
export function scopeFacade(map: ReadonlyMap<string, unknown>): ReadonlyMap<string, unknown> {
  return new Proxy(map, {
    get(target, property, _receiver) {
      if (typeof property === "string" && target.has(property)) {
        return target.get(property);
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return (typeof property === "string" && target.has(property)) || Reflect.has(target, property);
    },
  });
}

export type FixtureRecipeKind = "model" | "user" | "file" | "delivery";

export interface FixtureRecipe {
  readonly dependencies: readonly unknown[];
  readonly kind: FixtureRecipeKind;
  readonly provision: RecipeProvisioner;
  /** Model/delivery identity for reports, when the recipe declares one. */
  readonly label?: string | undefined;
}

export interface RecipeSuite {
  readonly recipes: ReadonlyMap<string, FixtureRecipe>;
  /** Raw recipe object identity -> fixture name (live-ref dependencies). */
  readonly rawNames: ReadonlyMap<object, string>;
}

const PROVISIONERS: ReadonlyArray<readonly [FixtureRecipeKind, string]> = [
  ["model", "value"],
  ["user", "user"],
  ["file", "file"],
  ["delivery", "values"],
];

/** Validate a factory `fixtures` map into normalized recipes. */
export function readRecipeSuite(fixtures: unknown): RecipeSuite {
  if (!isRecord(fixtures)) {
    throw new FixtureSetupError(
      null,
      "exampleFixtures must return {fixtures, examples} with fixtures an object",
    );
  }
  const recipes = new Map<string, FixtureRecipe>();
  const rawNames = new Map<object, string>();
  for (const [name, raw] of Object.entries(fixtures)) {
    if (!isRecord(raw)) {
      throw new FixtureSetupError(name, "fixture recipe is not an object");
    }
    const dependencies: unknown = raw["dependencies"] ?? [];
    if (!Array.isArray(dependencies)) {
      throw new FixtureSetupError(name, "fixture dependencies is not an array");
    }
    let kind: FixtureRecipeKind | null = null;
    let provision: RecipeProvisioner | null = null;
    for (const [candidate, key] of PROVISIONERS) {
      const fn: unknown = raw[key];
      if (fn === undefined) {
        continue;
      }
      if (typeof fn !== "function") {
        throw new FixtureSetupError(name, `provisioner ${JSON.stringify(key)} is not a function`);
      }
      if (kind !== null) {
        throw new FixtureSetupError(name, "recipe has more than one provisioner");
      }
      kind = candidate;
      provision = fn as RecipeProvisioner;
    }
    if (kind === null || provision === null) {
      throw new FixtureSetupError(name, "recipe has no provisioner (one of value/user/file/values)");
    }
    if (kind === "delivery") {
      const operation: unknown = raw["delivery"];
      if (typeof operation !== "string" || operation.length === 0) {
        throw new FixtureSetupError(name, "delivery recipe must declare its operation identity");
      }
    }
    const model: unknown = raw["model"];
    const delivery: unknown = raw["delivery"];
    const label =
      typeof model === "string" ? model : typeof delivery === "string" ? delivery : undefined;
    recipes.set(name, { dependencies, kind, provision, label });
    rawNames.set(raw, name);
  }
  return { recipes, rawNames };
}

/**
 * Resolve one dependency list to fixture names. String names must exist;
 * live recipe references (emitted `dependencies:[author,claim]`) match by
 * object identity against the suite's own recipes.
 */
export function normalizeDependencies(
  dependencies: readonly unknown[],
  suite: RecipeSuite,
): string[] {
  return dependencies.map((dep) => {
    if (typeof dep === "string") {
      if (!suite.recipes.has(dep)) {
        throw new FixtureSetupError(dep, `unknown fixture dependency ${JSON.stringify(dep)}`);
      }
      return dep;
    }
    if (typeof dep === "object" && dep !== null) {
      const name = suite.rawNames.get(dep);
      if (name === undefined) {
        throw new FixtureSetupError(
          null,
          "dependency is an object that matches no recipe in this suite",
        );
      }
      return name;
    }
    throw new FixtureSetupError(
      null,
      "dependency is neither a fixture name nor a recipe reference",
    );
  });
}

/** Normalize every recipe's dependencies; unknown references fail the suite. */
export function normalizeSuiteDependencies(
  suite: RecipeSuite,
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, readonly string[]>();
  for (const [name, recipe] of suite.recipes) {
    try {
      adjacency.set(name, normalizeDependencies(recipe.dependencies, suite));
    } catch (thrown) {
      if (thrown instanceof FixtureSetupError) {
        throw new FixtureSetupError(name, thrown.reason, { cause: thrown });
      }
      throw thrown;
    }
  }
  return adjacency;
}

/**
 * Order the transitive closure of `seeds` dependencies-first. Unknown seeds
 * and genuine cycles fail; cycles name the full path (LG00 R20: no silent
 * reinterpretation).
 */
export function resolveFixtureOrder(
  seeds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[] {
  for (const seed of seeds) {
    if (!adjacency.has(seed)) {
      throw new FixtureSetupError(seed, "example depends on an unknown fixture");
    }
  }
  const order: string[] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (done.has(name)) {
      return;
    }
    const cycleAt = stack.indexOf(name);
    if (cycleAt >= 0) {
      const cycle = [...stack.slice(cycleAt), name].map((n) => JSON.stringify(n)).join(" -> ");
      throw new FixtureSetupError(name, `fixture dependency cycle: ${cycle}`);
    }
    const deps = adjacency.get(name);
    if (deps === undefined) {
      throw new FixtureSetupError(name, "fixture recipe went missing during ordering");
    }
    stack.push(name);
    for (const dep of deps) {
      visit(dep);
    }
    stack.pop();
    done.add(name);
    order.push(name);
  };
  for (const seed of seeds) {
    visit(seed);
  }
  return order;
}

/**
 * Validates one evaluated recipe value against its kind contract (T22b/c
 * slice): models and files provision fields records, deliveries provision
 * `{request, ...}`, users provision `{roles}`. Structural only —
 * finalized-file materialization (D2/T20b) and delivery nominal
 * membership (L1/L4 allowlist) are recorded gaps, not silent passes.
 */
function validateProvisionedValue(name: string, kind: FixtureRecipeKind, value: unknown): void {
  if (kind === "user") {
    readUserRoles(name, value);
    return;
  }
  if (!isRecord(value)) {
    const what = kind === "delivery" ? "{request, ...}" : "a fields record";
    throw new FixtureSetupError(name, `${kind} fixture must provision ${what}`);
  }
  if (kind === "delivery" && !("request" in value)) {
    throw new FixtureSetupError(name, "delivery fixture must provision {request, ...}");
  }
}

function readUserRoles(name: string, value: unknown): string[] {
  if (!isRecord(value)) {
    throw new FixtureSetupError(name, "user fixture must provision {roles: string[]}");
  }
  const roles: unknown = value["roles"];
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) {
    throw new FixtureSetupError(name, "user fixture must provision {roles: string[]}");
  }
  return roles as string[];
}

/**
 * Evaluate `order` (dependencies first), threading provisioned values through.
 * `seeded` values (load-time user fixtures) are reused, never re-evaluated.
 * Any provisioner throw becomes a fixture-identified `FixtureSetupError`.
 */
export async function provisionFixtureValues(
  order: readonly string[],
  suite: RecipeSuite,
  caller: unknown,
  seeded: ReadonlyMap<string, unknown> = new Map(),
): Promise<ReadonlyMap<string, unknown>> {
  const provisioned = new Map<string, unknown>();
  for (const name of order) {
    if (seeded.has(name)) {
      provisioned.set(name, seeded.get(name));
      continue;
    }
    const recipe = suite.recipes.get(name);
    if (recipe === undefined) {
      throw new FixtureSetupError(name, "fixture recipe went missing during provisioning");
    }
    let value: unknown;
    try {
      value = await recipe.provision(caller, scopeFacade(provisioned));
    } catch (thrown) {
      throw new FixtureSetupError(name, `fixture provisioning failed: ${detailOf(thrown)}`, {
        cause: thrown,
      });
    }
    validateProvisionedValue(name, recipe.kind, value);
    provisioned.set(name, value);
  }
  return provisioned;
}

export interface SuiteUsers {
  readonly users: readonly NamedUserFixture[];
  /**
   * Evaluated user values, seeded into every row setup (single evaluation;
   * emitted user recipes are pure `{roles}` literals).
   */
  readonly values: ReadonlyMap<string, unknown>;
}

/**
 * Evaluate user-kind recipes once at load and extract their
 * `{name, roles}` grants for row-account provisioning. Non-`{roles}`
 * results and provisioner throws fail the suite loud.
 */
export async function extractSuiteUsers(
  suite: RecipeSuite,
  caller: unknown,
): Promise<SuiteUsers> {
  const users: NamedUserFixture[] = [];
  const values = new Map<string, unknown>();
  for (const [name, recipe] of suite.recipes) {
    if (recipe.kind !== "user") {
      continue;
    }
    let value: unknown;
    try {
      value = await recipe.provision(caller, scopeFacade(values));
    } catch (thrown) {
      throw new FixtureSetupError(name, `user fixture provisioning failed: ${detailOf(thrown)}`, {
        cause: thrown,
      });
    }
    const roles = readUserRoles(name, value);
    users.push({ name, roles });
    values.set(name, value);
  }
  return { users, values };
}
