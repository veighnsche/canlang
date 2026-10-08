import { describe, expect, it } from "vitest";
import type { CompileArtifact } from "@canlang/contracts";
import { ARTIFACT_MODULE, HTTP_ASSETS_MODULE, buildDeployBundleWithAssets } from "../src/deploy/bundle.js";

/** A route-control fixture, not an authored compiler-producer receipt. */
function fixture(): CompileArtifact {
  return {
    artifact_version: 1, language_version: "1.0.0", tool_version: "0.1.0",
    sources: [], callables: [], operations: [], requires: [], tests: [],
    pages: [{ owner: "fixture", path: "/ordinary", module: "app/page.js", export: "page" }],
    modules: [{ path: "app/page.js", js: 'export const page = { owner: "fixture", path: "/ordinary", admit: async () => ({}), render: async () => "ordinary" };',
      map: { version: 3, file: "fixture.can", sources: [], sourcesContent: [], names: [], mappings: "" } }],
  };
}

describe("selected browser resource transport", () => {
  it("links generated write imports to the defining runtime without replacing the public facade", () => {
    const artifact = fixture();
    artifact.modules[0]!.js = 'import { require as check, create, deleteRecord, hasRole, set, transition } from "@canlang/stdlib";\n' + artifact.modules[0]!.js;
    const bundle = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } });
    expect(bundle.modules["app/page.js"]).toContain('from "../runtime/stdlib.js"');
    const runtime = bundle.modules["runtime/stdlib.js"]!;
    for (const name of ["create", "set", "deleteRecord"]) expect(runtime).toContain(`export async function ${name}(`);
    expect(runtime).toContain("../vendor/state/effects/guards.js");
    expect(runtime).toContain("../vendor/state/effects/transition.js");
    expect(runtime).toContain("../vendor/values/index.js");
    expect(bundle.modules["vendor/stdlib/index.js"]).toContain("../values/index.js");
    expect(bundle.modules["vendor/stdlib/index.js"]).not.toContain("export async function create(");
  }, 30_000);

  it("builds deterministic defining-owner transport tied to the resource inventory", () => {
    const artifact = fixture();
    const first = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } });
    const second = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } });
    expect(first).toEqual(second);
    expect(Object.keys(first.resources).sort()).toEqual(["browser/bootstrap.js", "browser/can-style.css", "browser/polling.js"]);
    expect(first.modules[ARTIFACT_MODULE]).toContain(`"resourcesSha256":"${first.resourcesSha256}"`);
    expect(first.modules[HTTP_ASSETS_MODULE]).toContain("browser assets: selected resource integrity mismatch");
    expect(first.modules[HTTP_ASSETS_MODULE]).toContain("browser assets: selected page collides");
    for (const key of Object.keys(first.resources)) expect(first.modules[key]).toBeUndefined();
  }, 30_000);

  it("does not manufacture a mount when browser resources are unselected", () => {
    const bundle = buildDeployBundleWithAssets(fixture(), { verdict: { active: true } });
    expect(bundle.modules[HTTP_ASSETS_MODULE]).toBeUndefined();
    expect(bundle.modules[ARTIFACT_MODULE]).not.toContain("export const browserAssets");
    expect(bundle.resources).toEqual({});
  }, 30_000);

  it("refuses an authored module occupying the generated sibling", () => {
    const artifact = fixture();
    artifact.modules.push({ path: HTTP_ASSETS_MODULE, js: "export const unwanted = true;", map: artifact.modules[0]!.map });
    expect(() => buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } })).toThrow();
  }, 30_000);
});
