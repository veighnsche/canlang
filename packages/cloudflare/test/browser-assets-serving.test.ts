import { afterEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { CompileArtifact } from "@canlang/contracts";
import { ARTIFACT_MODULE, DEPLOY_MAIN_MODULE, HTTP_ASSETS_MODULE, buildDeployBundleWithAssets } from "../src/deploy/bundle.js";

/** These explicit route controls supplement the separate real .can consumer. */
function fixture(path = "/assets/authored"): CompileArtifact {
  return {
    artifact_version: 1, language_version: "1.0.0", tool_version: "0.1.0",
    sources: [], callables: [], operations: [], requires: [], tests: [],
    pages: [{ owner: "fixture", path, module: "app/page.js", export: "page" }],
    modules: [{ path: "app/page.js", js: `export const page = { owner: "fixture", path: ${JSON.stringify(path)}, admit: async () => ({}), render: async () => "ordinary" };`,
      map: { version: 3, file: "fixture.can", sources: [], sourcesContent: [], names: [], mappings: "" } }],
  };
}

const workers: Miniflare[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map((worker) => worker.dispose())); });

function start(modules: Record<string, string>, binding = true): Miniflare {
  const worker = new Miniflare({ compatibilityDate: "2026-07-15", modulesRoot: "/",
    modules: [DEPLOY_MAIN_MODULE, ...Object.keys(modules).filter((key) => key !== DEPLOY_MAIN_MODULE)].map((path) => ({
      type: "ESModule" as const, path: `/${path}`, contents: modules[path]!,
    })),
    ...(binding ? { d1Databases: { DB: "browser-assets-test" } } : {}),
  });
  workers.push(worker);
  return worker;
}

describe("actual default Worker static asset dispatch", () => {
  it("serves exact bytes, HEAD, query and conditional 200 while retaining ordinary authored paths", async () => {
    const bundle = buildDeployBundleWithAssets(fixture(), { verdict: { active: true }, assets: { browser: true } });
    const worker = start(bundle.modules);
    for (const [key, row] of Object.entries(bundle.resources)) {
      const url = `https://example.test/assets/${key}`;
      const response = await worker.dispatchFetch(`${url}?ignored=true`);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(row.bytes);
      expect(response.headers.get("content-type")).toBe(row.contentType);
      expect(response.headers.get("cache-control")).toBe("public, max-age=0");
      const head = await worker.dispatchFetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(row.bytes.length));
      expect(await head.text()).toBe("");
      const conditional = await worker.dispatchFetch(url, { headers: { "if-none-match": '"old"', "if-modified-since": "Wed, 01 Jan 2020 00:00:00 GMT" } });
      expect(conditional.status).toBe(200);
      expect(conditional.headers.has("etag")).toBe(false);
      expect(await worker.dispatchFetch(url, { method: "POST" }).then((value) => value.status)).toBe(404);
    }
    expect(await worker.dispatchFetch("https://example.test/assets/authored").then((value) => value.text())).toBe("ordinary");
    expect(await worker.dispatchFetch("https://example.test/assets/browser/%62ootstrap.js").then((value) => value.status)).toBe(404);
  }, 30_000);

  it("preserves required bindings and inactive refusal without loading selected resources", async () => {
    const active = buildDeployBundleWithAssets(fixture(), { verdict: { active: true }, assets: { browser: true } });
    const missingBinding = start(active.modules, false);
    const response = await missingBinding.dispatchFetch("https://example.test/assets/browser/bootstrap.js");
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("missing-binding");
    const inactive = buildDeployBundleWithAssets(fixture(), { verdict: { active: false, reasons: [] }, assets: { browser: true } });
    delete inactive.modules[HTTP_ASSETS_MODULE];
    const refused = await start(inactive.modules).dispatchFetch("https://example.test/assets/browser/bootstrap.js");
    expect(refused.status).toBe(500);
    expect(await refused.text()).toContain("activation-refused");
  }, 30_000);

  it.each(["/assets/browser/bootstrap.js", "/assets/browser/{Name}"])("refuses collision %s through the defining page matcher", async (path) => {
    const bundle = buildDeployBundleWithAssets(fixture(path), { verdict: { active: true }, assets: { browser: true } });
    const response = await start(bundle.modules).dispatchFetch("https://example.test/assets/browser/bootstrap.js");
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("collides");
  }, 30_000);

  it("refuses missing selected code and a corrupt staged resource manifest", async () => {
    const missing = buildDeployBundleWithAssets(fixture(), { verdict: { active: true }, assets: { browser: true } });
    delete missing.modules[HTTP_ASSETS_MODULE];
    const first = await start(missing.modules).dispatchFetch("https://example.test/assets/browser/bootstrap.js");
    expect(first.status).toBe(500);
    expect(await first.text()).toContain("selected browser assets");
    const corrupt = buildDeployBundleWithAssets(fixture(), { verdict: { active: true }, assets: { browser: true } });
    corrupt.modules[ARTIFACT_MODULE] = corrupt.modules[ARTIFACT_MODULE]!.replace(corrupt.resourcesSha256, "0".repeat(64));
    const second = await start(corrupt.modules).dispatchFetch("https://example.test/assets/browser/bootstrap.js");
    expect(second.status).toBe(500);
    expect(await second.text()).toContain("manifest mismatch");
  }, 30_000);

  it("retains authored dispatch without selected browser resources", async () => {
    const bundle = buildDeployBundleWithAssets(fixture(), { verdict: { active: true } });
    const worker = start(bundle.modules);
    expect(await worker.dispatchFetch("https://example.test/assets/authored").then((value) => value.text())).toBe("ordinary");
    expect(await worker.dispatchFetch("https://example.test/assets/browser/bootstrap.js").then((value) => value.status)).toBe(404);
  }, 30_000);

  it.each(["version", "module", "shape", "bytes", "handler"])("refuses selected %s corruption", async (kind) => {
    const bundle = buildDeployBundleWithAssets(fixture(), { verdict: { active: true }, assets: { browser: true } });
    if (kind === "handler") {
      bundle.modules[HTTP_ASSETS_MODULE] = "export const createHandler = null;";
    } else if (kind === "bytes") {
      const encoded = Buffer.from(bundle.resources["browser/bootstrap.js"]!.bytes).toString("base64");
      const damaged = (encoded[0] === "A" ? "B" : "A") + encoded.slice(1);
      expect(bundle.modules[HTTP_ASSETS_MODULE]).toContain(encoded);
      bundle.modules[HTTP_ASSETS_MODULE] = bundle.modules[HTTP_ASSETS_MODULE]!.replace(encoded, damaged);
    } else {
      const marker = bundle.modules[ARTIFACT_MODULE]!;
      const start = marker.lastIndexOf("export const browserAssets = ");
      const selected = JSON.parse(marker.slice(start + "export const browserAssets = ".length).trim().replace(/;$/, "")) as Record<string, unknown>;
      if (kind === "version") selected["version"] = 2;
      if (kind === "module") selected["module"] = "./other.js";
      if (kind === "shape") selected["extra"] = true;
      bundle.modules[ARTIFACT_MODULE] = marker.slice(0, start) + `export const browserAssets = ${JSON.stringify(selected)};\n`;
    }
    const response = await start(bundle.modules).dispatchFetch("https://example.test/assets/browser/bootstrap.js");
    expect(response.status).toBe(500);
    expect(await response.text()).toContain(kind === "bytes" ? "integrity mismatch" : kind === "handler" ? "no createHandler" : "invalid selected browser assets marker");
  }, 30_000);
});
