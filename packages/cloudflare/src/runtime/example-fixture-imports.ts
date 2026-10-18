import type { ArtifactTestModule } from "@canlang/contracts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(detail: string): never {
  throw new Error(`example fixture imports: ${detail}`);
}

/** Link checked test-only recipe providers once for this suite's binding context. */
export async function resolveExampleFixtureImports(
  tests: readonly ArtifactTestModule[],
  moduleUrls: Readonly<Record<string, string>>,
  root: ArtifactTestModule,
  bindings: { readonly imported: unknown },
  load: (url: string) => Promise<Record<string, unknown>> = url => import(url),
): Promise<unknown> {
  const recipes = new Map<string, object>();
  const owners = new WeakMap<object, string>();
  const closures = new Map<string, Readonly<Record<string, object>>>();
  const active = new Set<string>();
  const modules = new Map<string, Record<string, unknown>>();
  async function moduleOf(test: ArtifactTestModule): Promise<Record<string, unknown>> {
    const prior = modules.get(test.module.path);
    if (prior !== undefined) return prior;
    const url = moduleUrls[test.module.path];
    if (url === undefined) fail(`module ${test.module.path} was not staged`);
    const loaded = await load(url);
    modules.set(test.module.path, loaded);
    return loaded;
  }
  function descriptors(module: Record<string, unknown>): readonly string[] {
    const imports = module["exampleImports"];
    if (imports === undefined) return [];
    if (!Array.isArray(imports)) fail("exampleImports must be an array");
    const keys = new Set<string>();
    for (const entry of imports) {
      if (!record(entry) || Object.keys(entry).length !== 3 ||
          !["provider", "member", "alias"].every(key => Object.hasOwn(entry, key)) ||
          typeof entry["provider"] !== "string" || entry["provider"] === "" ||
          typeof entry["member"] !== "string" || entry["member"] === "" ||
          entry["alias"] !== `${entry["provider"]}.${entry["member"]}`) {
        fail("invalid canonical import descriptor");
      }
      const key = entry["alias"] as string;
      if (keys.has(key)) fail(`duplicate import ${key}`);
      keys.add(key);
    }
    return [...keys];
  }
  async function importsOf(module: Record<string, unknown>): Promise<Record<string, object>> {
    const keys = descriptors(module);
    const imported: Record<string, object> = Object.create(null) as Record<string, object>;
    for (const key of keys) {
      await resolve(key);
      Object.assign(imported, closures.get(key));
    }
    // Include transitive dependencies: the existing testkit validates and
    // provisions one complete canonical recipe graph, with live identities.
    return imported;
  }
  async function resolve(key: string): Promise<object> {
    const cached = recipes.get(key);
    if (cached !== undefined) return cached;
    if (active.has(key)) fail(`cyclic provider dependency ${[...active, key].join(" -> ")}`);
    const providers = tests.filter(test => test.scope === key && test.fixtures.includes(key));
    if (providers.length !== 1) fail(`expected one provider for ${key}, found ${providers.length}`);
    const provider = providers[0]!;
    active.add(key);
    try {
      const module = await moduleOf(provider);
      const imported = await importsOf(module);
      const factory = module["exampleFixtures"];
      if (typeof factory !== "function") fail(`provider ${key} has no exampleFixtures factory`);
      // Preserve live actor/clock bindings; only the imported recipe map is
      // local to this provider invocation.
      const providerBindings = new Proxy(bindings, { get(target, property, receiver) {
        return property === "imported" ? imported : Reflect.get(target, property, receiver);
      } });
      const result: unknown = await factory(providerBindings);
      if (!record(result) || !record(result["fixtures"]) || !Array.isArray(result["examples"]) ||
          result["examples"].length !== 0) fail(`invalid recipe-only provider ${key}`);
      const fixtures = result["fixtures"];
      for (const [name, recipe] of Object.entries(fixtures)) {
        if (name !== key && imported[name] !== recipe) fail(`provider ${key} returned foreign recipe ${name}`);
      }
      for (const [name, recipe] of Object.entries(imported)) {
        if (fixtures[name] !== recipe) fail(`provider ${key} did not retain imported recipe ${name}`);
      }
      const recipe = fixtures[key];
      if (!record(recipe)) fail(`provider ${key} did not return its canonical recipe`);
      const owner = owners.get(recipe);
      if (owner !== undefined && owner !== key) fail(`recipe object for ${key} already belongs to ${owner}`);
      if (recipes.has(key)) fail(`conflicting recipe ${key}`);
      recipes.set(key, recipe);
      owners.set(recipe, key);
      closures.set(key, { ...imported, [key]: recipe });
      return recipe;
    } finally {
      active.delete(key);
    }
  }
  const module = await moduleOf(root);
  if (module["exampleImports"] === undefined) return bindings.imported;
  const imported = await importsOf(module);
  if (!record(bindings.imported)) fail("canonical imports require an imported binding object");
  for (const [key, recipe] of Object.entries(bindings.imported)) {
    if (imported[key] !== recipe) fail(`caller binding conflicts with checked provider ${key}`);
  }
  return imported;
}
