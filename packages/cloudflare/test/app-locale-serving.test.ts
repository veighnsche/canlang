import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CompileArtifact, StoragePort } from "@canlang/contracts";
import { assembleWorker, type PageHttpDeps } from "../src/worker/assembly.js";

// Handwritten metadata-boundary fixtures, not compiler output or durable /
// installed-runtime qualification. The page factory observes the real assembly handoff.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(definition: string, sourcePath = "unrelated/fr-FR.can") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-app-locale-")));
  dirs.push(dir);
  const js = `export const appDefinition = ${definition};
    export const home = { owner: "AuthoredApp", path: "/", title: "Home",
      admit: async () => ({}), render: async () => "fixture" };`;
  const selected = join(dir, "unrelated-entry.mjs");
  writeFileSync(selected, js);
  const other = join(dir, "other.mjs");
  writeFileSync(other, 'export const appDefinition = { id: "OtherApp", appDefaultLocale: "fr-FR" };');
  const artifact: CompileArtifact = {
    artifact_version: 1, language_version: "app-locale-fixture/0",
    tool_version: "app-locale-fixture/0 (handwritten)",
    sources: [{ path: sourcePath, sha256: "fixture-not-a-digest" }],
    modules: [
      { path: "unrelated-entry.mjs", js, map: { version: 3, file: "unrelated-entry.mjs",
        sources: [sourcePath], sourcesContent: [null], names: [], mappings: "" } },
      { path: "other.mjs", js: "", map: { version: 3, file: "other.mjs",
        sources: [], sourcesContent: [], names: [], mappings: "" } },
    ],
    pages: [{ owner: "AuthoredApp", path: "/", module: "unrelated-entry.mjs", export: "home" }],
    callables: [], requires: [], tests: [],
  };
  const asm = { dir, entryUrl: pathToFileURL(selected).href, moduleUrls: {
    "unrelated-entry.mjs": pathToFileURL(selected).href, "other.mjs": pathToFileURL(other).href,
  } };
  let handedOff: PageHttpDeps | undefined;
  const assemble = () => assembleWorker(artifact, asm, {
    store: { readRevision: async () => 0 } as unknown as StoragePort,
    identityStore: {},
    http: { createPageHandler: deps => {
      handedOff = deps;
      return async () => Response.json({ appId: deps.app.appId, locale: deps.app.appDefaultLocale });
    } },
  }, { active: true });
  return { assemble, handoff: () => handedOff };
}

describe("selected app locale at the page factory", () => {
  it("hands off selected metadata and serves it regardless of source filename or other modules", async () => {
    const selected = fixture('{ id: "AuthoredApp", appDefaultLocale: "de-DE" }');
    const worker = await selected.assemble();
    expect(selected.handoff()?.app).toMatchObject({ appId: "AuthoredApp", brand: "AuthoredApp", appDefaultLocale: "de-DE" });
    expect(selected.handoff()?.pages.descriptors()).toHaveLength(1);
    expect(worker.pageCount).toBe(1);
    const response = await worker.fetch(new Request("https://example.test/"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appId: "AuthoredApp", locale: "de-DE" });
  });

  it("keeps the pinned en fallback only for omitted legacy metadata", async () => {
    const legacy = fixture('{ id: "AuthoredApp" }', "unrelated/de-DE.can");
    await legacy.assemble();
    expect(legacy.handoff()?.app).toMatchObject({ appId: "AuthoredApp", appDefaultLocale: "en" });
  });

  it.each(['""', '"en_US"', '"not a locale"', "null", "undefined", "42", '["fr-FR"]', "{}"])(
    "refuses a present invalid locale claim %s before the factory sees it", async claim => {
      const invalid = fixture(`{ id: "AuthoredApp", appDefaultLocale: ${claim} }`);
      await expect(invalid.assemble()).rejects.toThrow("invalid appDefinition.appDefaultLocale");
      expect(invalid.handoff()).toBeUndefined();
    },
  );

  it("refuses missing authored identity instead of deriving it from a source filename", async () => {
    const invalid = fixture('{ appDefaultLocale: "fr-FR" }', "AuthoredApp.can");
    await expect(invalid.assemble()).rejects.toThrow("no defining appDefinition.id");
    expect(invalid.handoff()).toBeUndefined();
  });
});
