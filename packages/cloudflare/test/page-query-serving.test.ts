import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import type { CompileArtifact } from "@canlang/contracts";
import { buildDeployBundleWithAssets, writeDeployBundleWithAssets, DEPLOY_MAIN_MODULE } from "../src/deploy/bundle.js";

// The released authored producer is supplied by the focused integration run.
// A handwritten page cannot stand in for the compiler/production join.
const producer = process.env["CANLANG_PAGE_ARTIFACT"];
const workers: Miniflare[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const loadStagedModule = (url: string): Promise<any> => import(/* @vite-ignore */ url);

describe.skipIf(producer === undefined)("authored Images page through defining default Worker", () => {
  it("serves full/HX/HEAD with authorized rows, real assets and explicit query refusals", async () => {
    const artifact = JSON.parse(readFileSync(producer!, "utf8")) as CompileArtifact;
    const bundle = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: (artifact.pages?.length ?? 0) > 0 } });
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "can-page-query-")); dirs.push(dir);
    writeDeployBundleWithAssets(bundle, dir);
    const worker = new Miniflare({ compatibilityDate: "2026-07-15", modulesRoot: "/",
      modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
        type: "ESModule" as const, path: `/${path}`, contents: bundle.modules[path]!,
      })), d1Databases: { DB: "actual-images-page" } }); workers.push(worker);
    const DB = await worker.getD1Database("DB");
    const nodeWorker = (await loadStagedModule(pathToFileURL(join(dir, DEPLOY_MAIN_MODULE)).href)).default;
    const callers = [
      (path: string, init?: RequestInit) => worker.dispatchFetch(`https://example.test${path}`, init),
      (path: string, init?: RequestInit) => nodeWorker.fetch(new Request(`https://example.test${path}`, init), { DB }, { waitUntil() {} }),
    ];
    // First request creates real schemas through the actual production owner.
    const initial = await callers[0]!("/");
    expect(initial.status, await initial.clone().text()).toBe(200);
    await DB.prepare("INSERT INTO records(model,id,version,created,updated,created_by,updated_by,data) VALUES (?,?,?,?,?,?,?,?)")
      .bind("Images.Job", "job-1", 1, 1, 1, "fixture", "fixture", JSON.stringify({ title: "Actual row", status: "generating", privateUndeclared: "must not leak" })).run();
    for (const fetch of callers) {
      const full = await fetch("/"); expect(full.status).toBe(200);
      const html = await full.text();
      expect(html.toLowerCase()).toContain("<!doctype html>"); expect(html).toContain("Generating");
      expect(html.match(/id="can-main"/g)).toHaveLength(1);
      expect(html).toContain('href="/assets/browser/can-style.css"');
      expect(html).toContain('src="/assets/browser/bootstrap.js"');
      expect(html).toContain("data-can-poll"); expect(html).not.toContain("must not leak");
      const hx = await fetch("/?poll=yes", { headers: { "HX-Request": "true" } });
      expect(hx.status).toBe(200); const fragment = await hx.text();
      expect(fragment.match(/id="can-main"/g)).toHaveLength(1); expect(fragment.toLowerCase()).not.toContain("<!doctype");
      const head = await fetch("/", { method: "HEAD" }); expect(head.status).toBe(200); expect(await head.text()).toBe("");
      expect((await fetch("/", { headers: { cookie: "can_session=not-an-issued-token" } })).status).toBe(403);
      for (const [key, resource] of Object.entries(bundle.resources)) {
        const response = await fetch(`/assets/${key}?ignored=yes`); expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(resource.bytes);
      }
    }
    // Query controls use the exact same staged canonical runtime, store and identity owner.
    const { buildProductionDeps } = await loadStagedModule(pathToFileURL(join(dir, "runtime/env-assembly.js")).href);
    const deps = await buildProductionDeps({ DB });
    const { queryPageRowsCanonical } = await loadStagedModule(pathToFileURL(join(dir, "runtime/invoke.js")).href);
    const asm = { dir, entryUrl: pathToFileURL(join(dir, artifact.modules[0]!.path)).href,
      moduleUrls: Object.fromEntries(artifact.modules.map(module => [module.path, pathToFileURL(join(dir, module.path)).href])) };
    const identity = { actor: null, team: null, membership: null, resolved_at: new Date().toISOString() };
    const options = { artifact, asm, identity, store: deps.store, memberships: deps.identityStore, model: "Images.Job" };
    const projected = await queryPageRowsCanonical({ ...options, args: { where: { op: "eq", field: "status", value: "generating" }, limit: 1 } });
    expect(projected.rows).toHaveLength(1); expect(projected.rows[0].fields).not.toHaveProperty("privateUndeclared");
    expect(projected.columns.map((column: { field: string }) => column.field)).toEqual(["title", "status"]);
    for (const args of [{ limit: 0 }, { limit: 101 }, { cursor: "opaque" }, { parent: { id: "parent" } }, { where: () => true }, { where: { op: "invented" } }]) {
      await expect(queryPageRowsCanonical({ ...options, args })).rejects.toMatchObject({ code: "validation" });
    }
    await DB.prepare("INSERT INTO records(model,id,version,created,updated,created_by,updated_by,data) VALUES (?,?,?,?,?,?,?,?)")
      .bind("Images.Job", "job-2", 1, 2, 2, "fixture", "fixture", JSON.stringify({ title: "Overflow", status: "ready" })).run();
    await expect(queryPageRowsCanonical({ ...options, args: { limit: 1 } })).rejects.toMatchObject({ code: "validation" });
  }, 60_000);
});
